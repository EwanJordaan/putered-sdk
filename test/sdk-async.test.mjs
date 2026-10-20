import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Putered } from '../dist/client/sdk.js';

const id = 'env_test', jobId = '6ab8dedc-1c8b-4eed-ae76-c0a9a462bb11';
const result = { stdout: 'hello', stdoutBase64: 'aGVsbG8=', stderr: 'warning\n', exitCode: 0, durationMs: 125000, hostDurationMs: 126000 };
const completed = { id: jobId, environmentId: id, state: 'completed', httpStatus: 200, result };
async function fixture(reply) {
  const requests = [];
  const client = new Putered({ baseUrl: 'https://putered.invalid', apiKey: 'x'.repeat(32), config: {}, fetch: async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/environments/' + id)) return Response.json({ id, tools: [], settings: {} });
    if (options.method === 'POST') return Response.json({ jobId, state: 'running' }, { status: 202 });
    return reply(requests);
  } });
  return { env: await client.environments.connect(id), requests };
}

test('async SDK dispatches once, polls and returns the same complete execution contract', async () => {
  let polls = 0;
  const { env, requests } = await fixture(() => Response.json(++polls === 1 ? { id: jobId, environmentId: id, state: 'running' } : completed));
  assert.deepEqual(await env.exec('echo hello', { async: true, timeoutMs: 300000 }), result);
  assert.equal(requests.filter(r => r.options.method === 'POST').length, 1);
  const submission = requests.find(r => r.options.method === 'POST');
  assert.ok(submission.url.endsWith('/exec?async=1'));
  assert.deepEqual(JSON.parse(submission.options.body), { command: 'echo hello', timeoutMs: 300000 });
});

test('async results validate identity, payload, unknown outcomes and upstream failures without replay', async () => {
  for (const [value, code] of [
    [{ ...completed, id: '6ab8dedc-1c8b-4eed-ae76-c0a9a462bb12' }, 'PROTOCOL_ERROR'],
    [{ ...completed, environmentId: 'env_other' }, 'PROTOCOL_ERROR'],
    [{ ...completed, result: { ...result, stdout: 'substituted' } }, 'PROTOCOL_ERROR'],
    [{ ...completed, httpStatus: undefined }, 'PROTOCOL_ERROR'],
    [{ ...completed, state: 'unknown', error: 'Gateway restarted' }, 'CONFLICT'],
    [{ ...completed, state: 'failed', httpStatus: 504, result: { error: 'Timed out', code: 'TIMEOUT' } }, 'TIMEOUT'],
  ]) {
    const { env, requests } = await fixture(() => Response.json(value));
    await assert.rejects(env.exec('echo hello', { async: true }), error => error.code === code && error.message.includes(jobId));
    assert.equal(requests.filter(r => r.options.method === 'POST').length, 1);
  }
  const { env, requests } = await fixture(() => Response.json({ error: 'Temporarily unavailable' }, { status: 503 }));
  await assert.rejects(env.exec('echo hello', { async: true }), error => error.code === 'NETWORK_ERROR' && error.message.includes(jobId));
  assert.equal(requests.filter(r => r.options.method === 'POST').length, 1);
});

test('async cancellation stops polling, preserves execution ID and never cancels by replay', async () => {
  const controller = new AbortController();
  const { env, requests } = await fixture(() => { controller.abort(); return Response.json({ id: jobId, environmentId: id, state: 'running' }); });
  await assert.rejects(env.exec('echo hello', { async: true, signal: controller.signal }), error => error.code === 'CANCELLED' && error.status === 499 && error.message.includes(jobId));
  assert.equal(requests.filter(r => r.options.method === 'POST').length, 1);
});

test('direct servers returning an ordinary result remain compatible with opt-in async execution', async () => {
  const client = new Putered({ baseUrl: 'https://putered.invalid', apiKey: 'x'.repeat(32), config: {}, fetch: async (url, options) =>
    Response.json(options.method === 'POST' ? result : { id, tools: [], settings: {} }) });
  const env = await client.environments.connect(id);
  assert.deepEqual(await env.exec('echo hello', { async: true }), result);
  await assert.rejects(env.exec('echo hello', { async: 'yes' }), error => error.code === 'INVALID_INPUT');
});
