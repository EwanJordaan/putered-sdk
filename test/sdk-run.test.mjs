import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { Putered, CommandError, PuteredError } from '../dist/client/sdk.js';

const id = 'env_run', jobId = '6ab8dedc-1c8b-4eed-ae76-c0a9a462bb11';
const result = { stdout: 'ok\n', stdoutBase64: 'b2sK', stderr: '', exitCode: 0, durationMs: 1, hostDurationMs: 2 };
const completed = { id: jobId, environmentId: id, state: 'completed', httpStatus: 200, result };

function client(fetch) {
  return new Putered({ baseUrl: 'https://putered.invalid', apiKey: 'x'.repeat(32), config: {}, fetch });
}

test('run forwards literal argv unchanged and keeps command output semantics', async () => {
  const requests = [];
  const argv = ['status', '--porcelain', 'two words', 'a;b', '$(touch pwned)'];
  const sdk = client(async (url, options) => {
    requests.push({ url, options });
    return Response.json(options.method === 'POST' ? result : { id, tools: [], settings: {} });
  });
  const env = await sdk.environments.connect(id);
  const command = await env.run('git', argv);
  const post = requests.find(request => request.options.method === 'POST');
  assert.equal(post.url, `https://putered.invalid/v1/environments/${id}/run`);
  assert.deepEqual(JSON.parse(post.options.body), { program: 'git', args: argv });
  assert.equal(command.output, 'ok\n');
  assert.deepEqual(command, result);
  assert.equal(requests.filter(request => request.options.method === 'POST').length, 1);
});

test('run validates the flat program/args contract before network I/O', async () => {
  let posts = 0;
  const sdk = client(async (_url, options) => {
    if (options.method === 'POST') posts++;
    return Response.json({ id, tools: [], settings: {} });
  });
  const env = await sdk.environments.connect(id);
  for (const [program, args] of [
    ['Git', []], ['git;touch', []], ['git', ['bad\0arg']], ['git', Array(4097).fill('x')], ['git', ['x'.repeat(65536)]],
  ]) await assert.rejects(env.run(program, args), error => error instanceof PuteredError && error.code === 'INVALID_INPUT');
  await assert.rejects(env.run('git', [], { async: 'yes' }), error => error.code === 'INVALID_INPUT');
  await assert.rejects(env.run('git', [], { check: 'yes' }), error => error.code === 'INVALID_INPUT');
  assert.equal(posts, 0);
});

test('run async submits once to the run endpoint and polls the same saved result', async () => {
  const requests = [];
  let polls = 0;
  const sdk = client(async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith(`/execution-jobs/${jobId}`))
      return Response.json(++polls === 1 ? { id: jobId, environmentId: id, state: 'running' } : completed);
    return Response.json(options.method === 'POST' ? { jobId, state: 'running' } : { id, tools: [], settings: {} });
  });
  const env = await sdk.environments.connect(id);
  const output = await env.run('bash', ['-c', 'git clone https://example.invalid/repo'], { async: true, timeoutMs: 300000 });
  assert.deepEqual(output, result);
  const posts = requests.filter(request => request.options.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, `https://putered.invalid/v1/environments/${id}/run?async=1`);
  assert.deepEqual(JSON.parse(posts[0].options.body), {
    program: 'bash', args: ['-c', 'git clone https://example.invalid/repo'], timeoutMs: 300000,
  });
  assert.equal(requests.filter(request => request.url.endsWith(`/execution-jobs/${jobId}`)).length, 2);
});

test('run uses the same CommandError and unchecked nonzero behavior as exec', async () => {
  const failed = { ...result, stdout: '', stdoutBase64: '', stderr: 'failed\n', exitCode: 2 };
  const sdk = client(async (_url, options) => Response.json(options.method === 'POST' ? failed : { id, tools: [], settings: {} }));
  const env = await sdk.environments.connect(id);
  await assert.rejects(env.run('git', ['status']), error => {
    assert.ok(error instanceof CommandError && error instanceof PuteredError);
    assert.equal(error.output, 'failed\n');
    assert.equal(error.exitCode, 2);
    assert.equal(error.stderr, 'failed\n');
    return true;
  });
  assert.equal((await env.run('git', ['status'], { check: false })).exitCode, 2);
});

test('run accepts bounded cwd/env/static stdin and validates before submitting', async () => {
  const requests = [];
  const sdk = client(async (url, options) => {
    requests.push({ url, options });
    return Response.json(options.method === 'POST' ? result : { id, tools: [], settings: {} });
  });
  const env = await sdk.environments.connect(id);
  await env.run('python', ['-c', 'print(1)'], { cwd: '/workspace/src', env: { MODE: 'test' }, stdin: 'hello' });
  assert.deepEqual(JSON.parse(requests.find(request => request.options.method === 'POST').options.body), {
    program: 'python', args: ['-c', 'print(1)'], cwd: '/workspace/src', env: { MODE: 'test' }, stdinBase64: 'aGVsbG8=',
  });
  await env.run('git', ['hash-object', '--stdin'], { stdin: 'blob data' });
  assert.deepEqual(JSON.parse(requests.filter(request => request.options.method === 'POST')[1].options.body), {
    program: 'git', args: ['hash-object', '--stdin'], stdinBase64: 'YmxvYiBkYXRh',
  });
  await assert.rejects(env.run('git', [], { stdin: Readable.from(['interactive']) }), error => error instanceof PuteredError && error.code === 'INVALID_INPUT');
  for (const options of [
    { cwd: '../outside' }, { cwd: '/etc' }, { env: { 'BAD-KEY': 'x' } }, { stdin: 'x'.repeat(65537) }, { stdin: true },
  ]) await assert.rejects(env.run('python', [], options), error => error instanceof PuteredError && ['INVALID_INPUT', 'PAYLOAD_TOO_LARGE'].includes(error.code));
  assert.equal(requests.filter(request => request.options.method === 'POST').length, 2);
});

test('run streams saved output into sinks and exposes detached command handles', async () => {
  const output = [];
  const first = '6ab8dedc-1c8b-4eed-ae76-c0a9a462bb11';
  const emoji = Buffer.from('🙂');
  const streamedResult = { ...result, stdout: '🙂', stdoutBase64: emoji.toString('base64') };
  let initialCursorZeroSeen = false;
  const requests = [];
  const sdk = client(async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/environments/env_run')) return Response.json({ id, tools: [], settings: {} });
    if (url.includes('/run?async=1')) return Response.json({ jobId: first, state: 'running', commandPath: `/environments/${id}/commands/${first}` });
    if (url.includes(`/commands/${first}?cursor=`)) {
      const cursor = Number(new URL(url).searchParams.get('cursor'));
      if (cursor === 0 && !initialCursorZeroSeen) {
        initialCursorZeroSeen = true;
        return Response.json({ id: first, environmentId: id, state: 'running', createdAt: 1, cursor: 2,
          output: [{ stream: 'stdout', data: emoji.subarray(0, 2).toString('base64') }] });
      }
      if (cursor === 2) return Response.json({ id: first, environmentId: id, state: 'completed', createdAt: 1, cursor: 4,
        output: [{ stream: 'stdout', data: emoji.subarray(2).toString('base64') }], httpStatus: 200, result: streamedResult });
      if (cursor === 4) return Response.json({ id: first, environmentId: id, state: 'completed', createdAt: 1, cursor: 4,
        output: [], httpStatus: 200, result: streamedResult });
      return Response.json({ id: first, environmentId: id, state: 'completed', createdAt: 1, cursor: 4,
        output: [{ stream: 'stdout', data: emoji.subarray(0, 2).toString('base64') },
          { stream: 'stdout', data: emoji.subarray(2).toString('base64') }], httpStatus: 200, result: streamedResult });
    }
    throw new Error(`Unexpected request ${url}`);
  });
  const env = await sdk.environments.connect(id);
  const stdout = new Writable({ write(chunk, _encoding, callback) { output.push(chunk.toString()); callback(); } });
  const command = await env.run('python', [], { stdin: 'static', stdout });
  assert.equal(command.stdout, '🙂');
  assert.deepEqual(output, ['🙂']);
  const submit = requests.find(request => request.url.includes('/run?async=1'));
  assert.equal(JSON.parse(submit.options.body).stdinBase64, 'c3RhdGlj');
  assert.equal(requests.some(request => request.url.endsWith(`/commands/${first}/input`)), false);

  const detachedOutput = [];
  const handle = await env.run('python', [], { detached: true,
    stdout: new Writable({ write(chunk, _encoding, callback) { detachedOutput.push(chunk.toString()); callback(); } }) });
  assert.equal(handle.id, first);
  assert.equal((await handle.wait()).stdout, '🙂');
  assert.deepEqual(detachedOutput, ['🙂']);
  assert.equal((await env.getCommand(first)).id, first);
});

test('detached stdin is queued and split into 32 KiB control writes', async () => {
  const inputs = [];
  const id2 = '40e6ec34-3029-4d22-a491-fffc1f5a51da';
  let finishInput;
  const inputDone = new Promise(resolve => { finishInput = resolve; });
  const sdk = client(async (url, options) => {
    if (url.endsWith(`/environments/${id}`) && options.method === 'GET') return Response.json({ id, tools: [], settings: {} });
    if (url.includes('/run?async=1')) return Response.json({ jobId: id2, state: 'running', commandPath: `/environments/${id}/commands/${id2}` });
    if (url.endsWith(`/commands/${id2}/input`)) {
      const body = JSON.parse(options.body);
      inputs.push(body);
      if (body.close) finishInput();
      return Response.json({ nextSequence: body.sequence + 1 });
    }
    throw new Error(`Unexpected request ${url}`);
  });
  const env = await sdk.environments.connect(id);
  await env.run('python', [], { detached: true, stdin: Readable.from([Buffer.alloc(70 * 1024, 1)]) });
  await inputDone;
  assert.deepEqual(inputs.map(item => item.sequence), [0, 1, 2, 3]);
  assert.deepEqual(inputs.map(item => item.input ? Buffer.from(item.input, 'base64').byteLength : 0), [32768, 32768, 6144, 0]);
  assert.equal(inputs.at(-1).close, true);
});

test('a writable sink error kills the submitted command and rejects collection', async () => {
  const id2 = '84d2d5be-cc11-4f52-ae07-9ab6a22da029';
  const requests = [];
  const sdk = client(async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith(`/environments/${id}`) && options.method === 'GET') return Response.json({ id, tools: [], settings: {} });
    if (url.includes('/run?async=1')) return Response.json({ jobId: id2, state: 'running', commandPath: `/environments/${id}/commands/${id2}` });
    if (url.includes(`/commands/${id2}?cursor=`)) return Response.json({ id: id2, environmentId: id,
      state: 'running', createdAt: 1, cursor: 1, output: [{ stream: 'stdout', data: 'eA==' }] });
    if (url.endsWith(`/commands/${id2}/signal`)) return Response.json({ id: id2, environmentId: id,
      state: 'running', createdAt: 1, cursor: 1, output: [] });
    throw new Error(`Unexpected request ${url}`);
  });
  const env = await sdk.environments.connect(id);
  const failingSink = new Writable({ write(_chunk, _encoding, callback) { callback(new Error('sink failed')); } });
  await assert.rejects(env.run('python', [], { stdout: failingSink }), /sink failed/);
  assert.equal(requests.filter(request => request.url.endsWith(`/commands/${id2}/signal`)).length, 1);
});

test('detached command failures preserve saved SDK error codes', async () => {
  const id2 = '78cd605d-d792-4edb-9da4-4ef7a0da6db6';
  const sdk = client(async (url, options) => {
    if (url.endsWith(`/environments/${id}`) && options.method === 'GET') return Response.json({ id, tools: [], settings: {} });
    if (url.includes('/run?async=1')) return Response.json({ jobId: id2, state: 'running', commandPath: `/environments/${id}/commands/${id2}` });
    if (url.includes(`/commands/${id2}?cursor=`)) return Response.json({ id: id2, environmentId: id,
      state: 'failed', createdAt: 1, cursor: 0, output: [], httpStatus: 504,
      result: { error: 'Command timed out.', code: 'TIMEOUT' } });
    throw new Error(`Unexpected request ${url}`);
  });
  const env = await sdk.environments.connect(id);
  const handle = await env.run('python', [], { detached: true });
  await assert.rejects(handle.wait(), error => error instanceof PuteredError && error.code === 'TIMEOUT');
});
