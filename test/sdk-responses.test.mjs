import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Putered } from '../dist/client/sdk.js';
import { assetId, ASSET_CHUNK_BYTES } from '../dist/asset-contract.js';
import { presetId } from '../dist/preset-contract.js';
import { MAX_BYTES } from '../dist/limits.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const record = { id: 'env_test', tools: [], settings: {} };
const toolId = 'tool_' + 'a'.repeat(64);
const tool = { id: toolId, visibility: 'private', manifest: { name: 'echo', version: '1', execution: { backend: 'v8' }, tools: {
  echo: { inputSchema: { type: 'string' }, outputSchema: { type: 'string' } },
} } };
const execution = { stdout: 'ok', stdoutBase64: 'b2s=', stderr: '', exitCode: 0, durationMs: 1.5, hostDurationMs: 2.5 };
const protocol = error => error.code === 'PROTOCOL_ERROR';
const client = fetcher => new Putered({ baseUrl: 'https://putered.invalid', apiKey: 'x'.repeat(32), config: {}, fetch: fetcher });
const reply = value => Response.json(value);
async function directory(t) { const path = await mkdtemp(join(tmpdir(), 'putered-response-')); t.after(() => rm(path, { recursive: true, force: true })); return path; }
function preset(bytes, overrides = {}) {
  const value = { name: 'image', format: 'oci', state: 'ready', visibility: 'private', platform: { os: 'linux', architecture: 'amd64' },
    manifestDigest: 'sha256:' + 'b'.repeat(64), archiveSha256: hash(bytes), bytes: bytes.length, source: 'upload', ...overrides };
  return { ...value, id: presetId(value.name, value.archiveSha256) };
}
function asset(bytes) {
  const manifest = { format: 1, platform: 'linux-x64', entrypoints: { run: 'run.sh' }, files: [{ path: 'run.sh', bytes: bytes.length, sha256: hash(bytes), executable: true }] };
  return { id: assetId(manifest), state: 'uploading', manifest, offsets: { [hash(bytes)]: 0 }, chunkBytes: ASSET_CHUNK_BYTES };
}

test('environment create/connect/describe accept additive metadata and reject wrong identity or malformed policy', async () => {
  const sdk = client(async () => reply({ ...record, name: 'Dashboard name', futureMetadata: true }));
  assert.deepEqual((await sdk.environments.create()).describe(), record);
  assert.equal((await sdk.environments.connect(record.id)).id, record.id);
  for (const bad of [{ ...record, id: '../escape' }, { ...record, tools: 'wrong' }, { ...record, settings: null },
    { ...record, settings: { network: { mode: 'internet', futurePolicy: true } } }])
    await assert.rejects(client(async () => reply(bad)).environments.create(), protocol);
  await assert.rejects(client(async () => reply({ ...record, id: 'env_other' })).environments.connect(record.id), protocol);
  await assert.rejects(sdk.environments.create({ settings: { git: true } }), protocol);
  await assert.rejects(sdk.environments.create({ settings: { network: { mode: 'disabled' } } }), protocol);
  await assert.rejects(sdk.environments.create({ tools: [{ id: toolId }] }), protocol);
  const broadened = client(async () => reply({ ...record, settings: { network: { mode: 'internet' } } }));
  await assert.rejects(broadened.environments.create({ settings: { network: { mode: 'internet', allow: ['example.com'] } } }), protocol);
});

test('execution validates every required field, byte/text agreement and optional metrics; nonzero exit is a result', async () => {
  async function exec(value) {
    const sdk = client(async url => reply(String(url).endsWith('/exec') ? value : record));
    return (await sdk.environments.create()).exec('echo ok');
  }
  for (const field of Object.keys(execution)) {
    const bad = { ...execution }; delete bad[field]; await assert.rejects(exec(bad), protocol);
  }
  for (const patch of [{ stdoutBase64: '!!!' }, { stdout: 'different' }, { exitCode: 0.5 }, { durationMs: -1 }, { hostDurationMs: -1 },
    { networkUsage: { sentBytes: -1, receivedBytes: 0, connections: 0, limitBytes: 10 } },
    { gitMetrics: [{ durationMs: 1, wasmMemoryBytes: 1, helperCount: 'wrong' }] },
    { pythonMetrics: { backend: 'invalid', warm: true, initMs: 1, executionMs: 1, rssBytes: 0 } }])
    await assert.rejects(exec({ ...execution, ...patch }), protocol);
  const metrics = { networkUsage: { sentBytes: 1, receivedBytes: 2, connections: 1, limitBytes: 100 },
    gitMetrics: [{ durationMs: 1, wasmMemoryBytes: 65536, helperCount: 0 }],
    pythonMetrics: { backend: 'native', warm: false, initMs: 1, executionMs: 2, rssBytes: 4096, cpuMicros: 1 } };
  assert.deepEqual(await exec({ ...execution, exitCode: 7, ...metrics, futureMetadata: true }), { ...execution, exitCode: 7, ...metrics });
  const bytes = Buffer.from([0, 255, 0xc3, 0xa9]);
  assert.equal((await exec({ ...execution, stdout: bytes.toString('utf8'), stdoutBase64: bytes.toString('base64') })).stdoutBase64, bytes.toString('base64'));
});

test('tool list/use/call validate records, IDs, required output and the declared output schema', async () => {
  let output = { output: 'echoed', futureMetadata: true };
  const sdk = client(async url => reply(String(url).endsWith('/tools/call') ? output : String(url).endsWith('/environments') ? { ...record, tools: [toolId] } :
    String(url).endsWith('/tools') ? [{ ...tool, futureMetadata: true }] : { ...tool, futureMetadata: true }));
  assert.equal((await sdk.tools.list())[0].id, toolId);
  const saved = await sdk.tools.use(toolId), env = await sdk.environments.create({ tools: [saved] });
  assert.deepEqual(await env.tools.call(saved, 'echo', 'input'), { output: 'echoed' });
  for (const bad of [{}, { output: 5 }]) { output = bad; await assert.rejects(env.tools.call(saved, 'echo', 'input'), error => error.code === 'INVALID_OUTPUT'); }
  await assert.rejects(client(async () => reply([{ ...tool, visibility: 'public' }])).tools.list(), protocol);
  await assert.rejects(client(async () => new Response(JSON.stringify([tool]).replace('"inputSchema":{"type":"string"}', '"inputSchema":{"maxLength":1e400}'))).tools.list(), protocol);
  await assert.rejects(client(async () => reply({ ...tool, id: 'tool_' + 'b'.repeat(64) })).tools.use(toolId), error => error.code === 'PACKAGE_INVALID');
});

test('asset get/list/status/cancel validate ID, manifest, offsets, state and acknowledgements', async () => {
  const upload = asset(Buffer.from('#!/bin/sh\necho ok\n')), reference = { id: upload.id, platform: upload.manifest.platform, entrypoints: upload.manifest.entrypoints };
  const sdk = client(async (url, options) => reply(options.method === 'DELETE' ? { cancelled: true, futureMetadata: true } : String(url).endsWith('/upload') ? { ...upload, futureMetadata: true } :
    String(url).endsWith('/assets') ? [{ ...reference, state: 'ready', totalBytes: upload.manifest.files[0].bytes, futureMetadata: true }] : { ...reference, futureMetadata: true }));
  assert.deepEqual(await sdk.assets.get(upload.id), reference);
  assert.equal((await sdk.assets.list())[0].id, upload.id);
  assert.equal((await sdk.assets.status(upload.id)).id, upload.id);
  assert.equal(await sdk.assets.cancel(upload.id), undefined);
  const other = asset(Buffer.from('#!/bin/sh\necho other\n'));
  await assert.rejects(client(async () => reply(other)).assets.status(upload.id), protocol);
  for (const bad of [{ ...upload, id: 'asset_' + '0'.repeat(64) }, { ...upload, offsets: {} }, { ...upload, offsets: { [hash(Buffer.from('other'))]: 0 } },
    { ...upload, offsets: { [upload.manifest.files[0].sha256]: 1 } }, { ...upload, state: 'ready' }])
    await assert.rejects(client(async () => reply(bad)).assets.status(upload.id), protocol);
  await assert.rejects(client(async () => reply({ cancelled: false })).assets.cancel(upload.id), protocol);
  await assert.rejects(client(async () => reply({ ...reference, id: other.id })).assets.get(upload.id), protocol);
});

test('asset upload rejects a nonadvancing acknowledgement after one part, without replay or publication', async t => {
  const folder = await directory(t), bytes = Buffer.from('#!/bin/sh\necho ok\n');
  await writeFile(join(folder, 'run.sh'), bytes);
  let puts = 0, completes = 0;
  const sdk = client(async (url, options) => {
    if (options.method === 'PUT') puts++;
    if (String(url).endsWith('/complete')) completes++;
    return reply(asset(bytes));
  });
  await assert.rejects(sdk.assets.upload(folder, { platform: 'linux-x64', entrypoints: { run: 'run.sh' } }), protocol);
  assert.equal(puts, 1); assert.equal(completes, 0);
});

test('preset list/get/capture/upload/download preserve archive identity and reject substituted bytes', async t => {
  const folder = await directory(t), bytes = Buffer.alloc(2048, 42), source = join(folder, 'source.tar'); await writeFile(source, bytes);
  const image = preset(bytes); let download = bytes, capture = { ...preset(bytes, { name: 'captured', source: 'capture', environmentId: record.id, captureScope: 'complete' }), futureMetadata: true };
  const sdk = client(async (url, options) => {
    url = String(url);
    if (url.endsWith('/archive')) return new Response(download, { headers: { 'Content-Type': 'application/vnd.oci.image.layout.v1+tar' } });
    if (url.endsWith('/preset')) return reply(capture);
    if (url.endsWith('/environments')) return reply(record);
    if (url.includes('/presets?')) { for await (const _ of options.body) {} return reply({ ...image, futureMetadata: true }); }
    return reply(url.endsWith('/presets') ? [{ ...image, futureMetadata: true }] : { ...image, futureMetadata: true });
  });
  assert.equal((await sdk.presets.list())[0].id, image.id);
  assert.equal((await sdk.presets.get(image.id)).id, image.id);
  assert.equal((await sdk.presets.upload({ name: image.name, file: source })).id, image.id);
  const env = await sdk.environments.create();
  assert.equal((await env.capturePreset({ name: 'captured' })).environmentId, record.id);
  const destination = join(folder, 'saved.tar'); await sdk.presets.download(image.id, { destination }); assert.deepEqual(await readFile(destination), bytes);
  download = Buffer.alloc(2048, 43);
  await assert.rejects(sdk.presets.download(image.id, { destination: join(folder, 'corrupt.tar') }), protocol);
  assert.equal((await readdir(folder)).includes('corrupt.tar'), false);
  await assert.rejects(sdk.presets.download(image.id, { destination }), error => error.code === 'CONFLICT');
  capture = { ...capture, environmentId: 'env_other' }; await assert.rejects(env.capturePreset({ name: 'captured' }), protocol);
  const substituted = { ...image, archiveSha256: '0'.repeat(64) };
  await assert.rejects(client(async () => reply(substituted)).presets.get(image.id), protocol);
  await assert.rejects(client(async () => reply([substituted])).presets.list(), protocol);
  await assert.rejects(client(async () => reply({ ...image, defaults: { tools: [], settings: { network: { mode: 'invalid' } } } })).presets.get(image.id), protocol);
});

test('transport preserves HTTP errors and messages, rejects malformed success and never follows redirects', async () => {
  for (const [status, body, expected] of [[524, '<html>timeout</html>', 'TIMEOUT'], [503, JSON.stringify({ error: 'Unavailable', code: 'FUTURE_CODE' }), 'NETWORK_ERROR'],
    [401, null, 'UNAUTHORIZED'], [200, 'not JSON', 'PROTOCOL_ERROR']]) {
    let calls = 0;
    await assert.rejects(client(async () => { calls++; return new Response(body, { status }); }).environments.create(), error => {
      assert.equal(error.code, expected); if (status >= 400) assert.equal(error.status, status);
      if (status === 503) assert.equal(error.message, 'Unavailable'); return true;
    });
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(client(async (_, options) => { assert.equal(options.redirect, 'manual'); calls++; return new Response(null, { status: 307, headers: { Location: 'https://other.invalid' } }); }).environments.create(), error => error.code === 'NETWORK_ERROR');
  assert.equal(calls, 1);
  await assert.rejects(client(async () => new Response(Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]))).environments.create(), protocol);
  await assert.rejects(client(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MAX_BYTES * 8 + 1)); controller.close(); } }))).environments.create(), error => error.code === 'PAYLOAD_TOO_LARGE');
});

test('upload responses cannot change archive identity or claim failed asset upload as success', async t => {
  const folder = await directory(t), bytes = Buffer.alloc(2048, 42), file = join(folder, 'image.tar'); await writeFile(file, bytes);
  let uploads = 0;
  const sdk = client(async (_url, options) => { uploads++; for await (const _ of options.body) {} return reply(preset(Buffer.alloc(2048, 43))); });
  await assert.rejects(sdk.presets.upload({ name: 'image', file }), protocol);
  assert.equal(uploads, 1);
  const script = Buffer.from('#!/bin/sh\necho ok\n'); await writeFile(join(folder, 'run.sh'), script);
  let puts = 0, finishes = 0;
  const failed = client(async (url, options) => { if (options.method === 'PUT') puts++; if (String(url).endsWith('/complete')) finishes++;
    // scan only this file so the known manifest agrees with the request.
    return reply({ ...asset(script), state: 'failed', error: 'Checksum failed' }); });
  await assert.rejects(failed.assets.upload(join(folder, 'run.sh'), { platform: 'linux-x64', entrypoints: { run: 'run.sh' } }), error => error.code === 'PACKAGE_INVALID');
  assert.equal(puts, 0); assert.equal(finishes, 0);
});

test('empty lists are valid but malformed list envelopes are not', async () => {
  const sdk = client(async () => reply([]));
  assert.deepEqual(await sdk.tools.list(), []); assert.deepEqual(await sdk.assets.list(), []); assert.deepEqual(await sdk.presets.list(), []);
  const bad = client(async () => reply({ records: [] }));
  for (const list of [() => bad.tools.list(), () => bad.assets.list(), () => bad.presets.list()]) await assert.rejects(list(), protocol);
});
