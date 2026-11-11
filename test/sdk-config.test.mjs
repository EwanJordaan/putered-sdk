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

test('resource defaults, per-call partial overrides, queue timeout, and validation', async () => {
  const calls = [];
  const resources = { cpu: 1, memoryMiB: 1024 };
  const sdk = new Putered({ apiKey: 'x'.repeat(32), config: { resources }, fetch: async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ url: String(url), body });
    if (String(url).endsWith('/environments')) return Response.json({ id: 'env_resource', tools: [], settings: { resources: body.settings.resources } });
    return Response.json({ stdout: '', stdoutBase64: '', stderr: '', exitCode: 0, durationMs: 1, hostDurationMs: 1 });
  } });
  const env = await sdk.environments.create();
  await env.exec('true', { resources: { cpu: 2 }, queueTimeoutMs: 30000 });
  await env.exec('true', { resources: { cpu: undefined } });
  assert.deepEqual(calls[0].body.settings.resources, resources);
  assert.deepEqual(calls[1].body.resources, { cpu: 2, memoryMiB: 1024 });
  assert.equal(calls[1].body.queueTimeoutMs, 30000);
  assert.deepEqual(calls[2].body.resources, resources);
  const before = calls.length;
  for (const invalid of [{ cpu: 0.1 }, { cpu: 1.1 }, { memoryMiB: 300 }, { memoryMiB: 9000 }, null, [], 'bad'])
    await assert.rejects(env.exec('true', { resources: invalid }), error => error.code === 'INVALID_INPUT');
  await assert.rejects(env.exec('true', { queueTimeoutMs: 0 }), error => error.code === 'INVALID_INPUT');
  assert.equal(calls.length, before);
});

test('connect fills missing resource defaults from config while saved settings win', async () => {
  const requests = [];
  const sdk = new Putered({ apiKey: 'x'.repeat(32), config: { resources: { cpu: 1, memoryMiB: 1024 } }, fetch: async (url, options) => {
    requests.push({ url: String(url), body: options.body && JSON.parse(options.body) });
    if (String(url).endsWith('/environments/env_saved'))
      return Response.json({ id: 'env_saved', tools: [], settings: { resources: { cpu: 2, memoryMiB: 2048 } } });
    return Response.json({ stdout: '', stdoutBase64: '', stderr: '', exitCode: 0, durationMs: 1, hostDurationMs: 1 });
  } });
  const env = await sdk.environments.connect('env_saved');
  await env.exec('true', { resources: { memoryMiB: 4096 } });
  assert.deepEqual(requests[1].body.resources, { cpu: 2, memoryMiB: 4096 });
});

test('partial config and saved resource fields merge for create and tool calls', async () => {
  const toolId = `tool_${'a'.repeat(64)}`;
  const requests = [];
  const sdk = new Putered({ apiKey: 'x'.repeat(32), config: { resources: { cpu: 1 } }, fetch: async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    requests.push({ url: String(url), body });
    if (String(url).endsWith('/environments'))
      return Response.json({ id: 'env_partial', tools: [], settings: { resources: body.settings.resources } });
    if (String(url).endsWith('/environments/env_saved'))
      return Response.json({ id: 'env_saved', tools: [toolId], settings: { resources: { memoryMiB: 2048 } } });
    return Response.json({ output: 'ok' });
  } });
  const created = await sdk.environments.create({ settings: { resources: { memoryMiB: 2048 } } });
  assert.deepEqual(requests[0].body.settings.resources, { cpu: 1, memoryMiB: 2048 });
  const connected = await sdk.environments.connect('env_saved');
  const reference = { id: toolId, visibility: 'private', manifest: { tools: { echo: { inputSchema: {}, outputSchema: {} } } } };
  await connected.tools.call(reference, 'echo', {}, { resources: { cpu: 2 } });
  assert.deepEqual(requests.at(-1).body.resources, { cpu: 2, memoryMiB: 2048 });
  assert.deepEqual(created.describe().settings.resources, { cpu: 1, memoryMiB: 2048 });
});
