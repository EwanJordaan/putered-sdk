import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Writable } from 'node:stream';
import { Putered } from '../dist/client/sdk.js';

const id = 'env_recovery', jobId = '6ab8dedc-1c8b-4eed-ae76-c0a9a462bb11';
const path = `/environments/${id}/commands/${jobId}`;
const result = { stdout: 'ok', stdoutBase64: 'b2s=', stderr: '', exitCode: 0, durationMs: 1, hostDurationMs: 2 };
const snapshot = (cursor, output, extra = {}) => ({ id: jobId, environmentId: id,
  state: 'completed', createdAt: 1, cursor, output, result, httpStatus: 200, ...extra });
const client = fetch => new Putered({ baseUrl: 'http://localhost', apiKey: 'x'.repeat(32), config: {}, fetch });
const record = { id, tools: [], settings: {} };

test('writable sinks and logsBytes preserve non-UTF8 bytes on both streams', async () => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0, 0xc3]);
  const output = ['stdout', 'stderr'].flatMap(stream => [
    { stream, data: bytes.subarray(0, 3).toString('base64') },
    { stream, data: bytes.subarray(3).toString('base64') },
  ]);
  const sdk = client(async (url, options) => {
    if (options.method === 'POST') return Response.json({ jobId, state: 'running', commandPath: path });
    if (url.includes('/commands/')) return Response.json(snapshot(bytes.length * 2, output));
    return Response.json(record);
  });
  const env = await sdk.environments.connect(id);
  const stdout = [], stderr = [];
  const sink = chunks => new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
  await env.run('python', [], { stdout: sink(stdout), stderr: sink(stderr) });
  assert.deepEqual(Buffer.concat(stdout), bytes);
  assert.deepEqual(Buffer.concat(stderr), bytes);
  const handle = await env.getCommand(jobId);
  const chunks = [];
  for await (const chunk of handle.logsBytes()) chunks.push(Buffer.from(chunk.data));
  assert.deepEqual(Buffer.concat(chunks), Buffer.concat([bytes, bytes]));
});

test('truncated history fails explicitly, then resumes retained logs and exposes a reconnect cursor', async () => {
  const cursors = [];
  const sdk = client(async url => {
    if (!url.includes('/commands/')) return Response.json(record);
    const cursor = Number(new URL(url).searchParams.get('cursor'));
    cursors.push(cursor);
    return Response.json(cursor < 8
      ? snapshot(10, [{ stream: 'stdout', data: 'b2s=' }], { reset: true })
      : snapshot(10, []));
  });
  const env = await sdk.environments.connect(id);
  const handle = await env.getCommand(jobId);
  await assert.rejects(async () => { for await (const _ of handle.logs()) {} }, { code: 'CONFLICT' });
  assert.equal(handle.outputCursor, 0);
  const chunks = [];
  for await (const chunk of handle.logs({ acceptTruncation: true })) chunks.push(chunk.data);
  assert.deepEqual(chunks, ['ok']);
  assert.equal(handle.outputCursor, 10);
  const reconnected = await env.getCommand(jobId, { cursor: handle.outputCursor });
  for await (const _ of reconnected.logs()) assert.fail('replayed output');
  assert.deepEqual(cursors, [0, 0, 10, 10]);
  const count = cursors.length;
  for (const cursor of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1])
    await assert.rejects(env.getCommand(jobId, { cursor }), { code: 'INVALID_INPUT' });
  assert.equal(cursors.length, count);
});

test('a live iterator can recover after encountering a reset', async () => {
  let polls = 0;
  const sdk = client(async url => {
    if (!url.includes('/commands/')) return Response.json(record);
    return Response.json(++polls === 1 ? snapshot(0, [], { state: 'running' })
      : snapshot(10, [{ stream: 'stdout', data: 'b2s=' }], { reset: true }));
  });
  const env = await sdk.environments.connect(id);
  const handle = await env.getCommand(jobId);
  await assert.rejects(async () => { for await (const _ of handle.logs()) {} }, { code: 'CONFLICT' });
  const chunks = [];
  for await (const chunk of handle.logsBytes({ acceptTruncation: true })) chunks.push(chunk.data);
  assert.equal(Buffer.concat(chunks).toString(), 'ok');
});

test('caller IDs survive a lost submission response for exec, async run and detached run without replay', async () => {
  for (const kind of ['exec', 'run', 'detached']) {
    const submissions = [];
    const sdk = client(async (url, options) => {
      if (options.method === 'POST') {
        submissions.push({ url, body: JSON.parse(options.body) });
        throw new Error('response lost after server accepted command');
      }
      return Response.json(url.includes('/commands/') ? snapshot(0, []) : record);
    });
    const env = await sdk.environments.connect(id);
    await assert.rejects(kind === 'exec' ? env.exec('side-effect', { requestId: jobId })
      : env.run('python', [], { requestId: jobId, ...(kind === 'detached' ? { detached: true } : {}) }),
    { code: 'NETWORK_ERROR' });
    const recovered = await env.getCommand(jobId);
    assert.equal((await recovered.wait()).stdout, 'ok');
    assert.equal(submissions.length, 1);
    assert.equal(submissions[0].body.requestId, jobId);
    assert.ok(submissions[0].url.endsWith('?async=1'));
    for (const options of [{ requestId: 'bad' }, { requestId: jobId.toUpperCase() }, { requestId: jobId, async: false }]) {
      await assert.rejects(env.exec('test', options), { code: 'INVALID_INPUT' });
      await assert.rejects(env.run('python', [], options), { code: 'INVALID_INPUT' });
    }
    assert.equal(submissions.length, 1);
  }
});

test('caller IDs work on successful submissions and reject substituted tickets', async () => {
  for (const kind of ['exec', 'run', 'detached', 'streamed']) {
    for (const mismatch of [false, true]) {
      const sdk = client(async (url, options) => {
        if (options.method === 'POST') return Response.json({
          jobId: mismatch ? '40e6ec34-3029-4d22-a491-fffc1f5a51da' : jobId,
          state: 'running', commandPath: path,
        });
        return Response.json(url.includes('/commands/') ? snapshot(0, []) : record);
      });
      const env = await sdk.environments.connect(id);
      const operation = kind === 'exec' ? env.exec('test', { requestId: jobId })
        : env.run('python', [], { requestId: jobId,
          ...(kind === 'detached' ? { detached: true } : {}),
          ...(kind === 'streamed' ? { stdout: new Writable({ write(_chunk, _encoding, done) { done(); } }) } : {}),
        });
      if (mismatch) await assert.rejects(operation, { code: 'PROTOCOL_ERROR' });
      else {
        const value = await operation;
        assert.equal((kind === 'detached' ? await value.wait() : value).stdout, 'ok');
      }
    }
  }
});

test('text logs decode UTF-8 across frames and keep streams separate', async () => {
  const emoji = Buffer.from('🙂');
  const sdk = client(async url => Response.json(url.includes('/commands/') ? snapshot(6, [
    { stream: 'stdout', data: emoji.subarray(0, 2).toString('base64') },
    { stream: 'stderr', data: 'b2s=' },
    { stream: 'stdout', data: emoji.subarray(2).toString('base64') },
  ]) : record));
  const env = await sdk.environments.connect(id);
  const handle = await env.getCommand(jobId);
  const chunks = [];
  for await (const chunk of handle.logs()) chunks.push(chunk);
  assert.deepEqual(chunks, [{ stream: 'stderr', data: 'ok' }, { stream: 'stdout', data: '🙂' }]);
});

test('stopping a byte iterator preserves the cursor before unconsumed frames', async () => {
  const sdk = client(async url => {
    if (!url.includes('/commands/')) return Response.json(record);
    const cursor = Number(new URL(url).searchParams.get('cursor'));
    return Response.json(snapshot(2, cursor === 0
      ? [{ stream: 'stdout', data: 'YQ==' }, { stream: 'stdout', data: 'Yg==' }]
      : [{ stream: 'stdout', data: 'Yg==' }]));
  });
  const env = await sdk.environments.connect(id);
  const handle = await env.getCommand(jobId);
  for await (const chunk of handle.logsBytes()) {
    assert.equal(Buffer.from(chunk.data).toString(), 'a');
    break;
  }
  assert.equal(handle.outputCursor, 1);
  const next = await env.getCommand(jobId, { cursor: handle.outputCursor });
  const chunks = [];
  for await (const chunk of next.logsBytes()) chunks.push(chunk.data);
  assert.equal(Buffer.concat(chunks).toString(), 'b');
});
