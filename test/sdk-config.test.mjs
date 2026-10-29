import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Putered } from '../dist/client/sdk.js';
import { loadSdkConfig, SDK_CONFIG_FILE } from '../dist/client/config.js';

test('SDK config rejects malformed, oversized, missing and unknown settings before requests', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'putered-sdk-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'config.json');
  let requests = 0;
  const options = { baseUrl: 'http://localhost:3000', apiKey: 'x'.repeat(32), config: path,
    fetch: async () => { requests++; return new Response('{}'); } };

  assert.throws(() => new Putered(options), error => error.code === 'INVALID_INPUT');
  for (const text of ['{', '{"network":{"mode":"typo"}}', '{"typo":false}',
    '{"execution":{"default":"other"}}', '{"execution":{"programs":{"Python":"v8"}}}', ' '.repeat(65537)]) {
    await writeFile(path, text);
    assert.throws(() => new Putered(options), error => error.code === 'INVALID_INPUT');
  }
  assert.throws(() => loadSdkConfig({ network: { mode: 'disabled', maxBytesPerExecution: 1 } }),
    error => error.code === 'INVALID_INPUT');
  assert.deepEqual(loadSdkConfig({ network: { mode: 'disabled' } }), { network: { mode: 'disabled' } });
  assert.deepEqual(loadSdkConfig({ execution: { default: 'native', programs: { python: 'v8' } } }),
    { execution: { default: 'native', programs: { python: 'v8' } } });
  assert.equal(SDK_CONFIG_FILE, 'putered.config.json');
  assert.equal(requests, 0);
});

test('execution preferences from config apply to creates and explicit options override them', async () => {
  const requests = [];
  const configured = { default: 'native', programs: { python: 'v8' } };
  const explicit = { default: 'auto', programs: { node: 'native' } };
  const partial = { programs: { git: 'v8' } };
  const sdk = new Putered({ apiKey: 'x'.repeat(32), config: { execution: configured },
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body.execution);
      return Response.json({ id: `env_${requests.length}`, tools: [], settings: {},
        execution: body.execution ? { default: body.execution.default ?? 'native', ...body.execution } : undefined });
    } });
  await sdk.environments.create();
  await sdk.environments.create({ execution: explicit });
  await sdk.environments.create({ execution: partial });
  assert.deepEqual(requests, [configured, explicit, partial]);
});
