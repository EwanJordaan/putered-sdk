import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, cp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { z } from 'zod';
import { Putered, PuteredError } from '../dist/client/sdk.js';
import { jsonValue, encodeJson } from '../dist/json.js';
import { defineTool } from '../dist/tool-definition.js';
import { buildPlugin } from '../dist/tool-package.js';
import { compileToolSchema, toolValidator } from '../dist/tool-validation.js';

const root = fileURLToPath(new URL('../', import.meta.url));

test('bounded JSON preserves valid data and rejects cycles, depth, sparse arrays and accessors', () => {
  const shared = { text: 'é🙂漢字\u0000\n"\\\ud800' };
  const value = { one: shared, two: shared, numbers: [1e-7, -4, 0], ok: true };
  const expected = JSON.stringify(value);
  const bytes = Buffer.byteLength(expected);
  assert.equal(encodeJson(value, { maxBytes: bytes }), expected);
  assert.throws(() => encodeJson(value, { maxBytes: bytes - 1 }), error => error.code === 'PAYLOAD_TOO_LARGE');
  const cycle = {}; cycle.self = cycle;
  assert.throws(() => jsonValue(cycle), error => error instanceof PuteredError && error.code === 'INVALID_INPUT');
  let deep = null; for (let i = 0; i < 70; i++) deep = [deep];
  assert.throws(() => jsonValue(deep), error => error.code === 'PAYLOAD_TOO_LARGE');
  for (const invalid of [NaN, Infinity, { missing: undefined }, new Date(), [, 1]])
    assert.throws(() => jsonValue(invalid), error => error.code === 'INVALID_INPUT');
  let accessed = false;
  const getter = Object.defineProperty({}, 'secret', { enumerable: true, get() { accessed = true; return 'no'; } });
  assert.throws(() => jsonValue(getter), error => error.code === 'INVALID_INPUT');
  assert.equal(accessed, false);
});

test('SDK rejects oversized input before network I/O and reports malformed/failed responses by code', async () => {
  let requests = 0;
  const environment = { id: 'env_test', tools: [], settings: {} };
  const client = new Putered({ baseUrl: 'http://localhost:3000', apiKey: 'x'.repeat(32), fetch: async () => {
    requests++; return new Response(JSON.stringify(environment));
  } });
  const env = await client.environments.create();
  await assert.rejects(env.exec('x'.repeat(8 * 1024 * 1024)), error => error.code === 'INVALID_INPUT');
  assert.equal(requests, 1);
  const record = { id: 'tool_' + 'a'.repeat(64), visibility: 'private', manifest: {
    name: 'test', version: '1', execution: { backend: 'v8' }, tools: { echo: { inputSchema: {}, outputSchema: {} } },
  } };
  const toolClient = new Putered({ baseUrl: 'http://localhost:3000', apiKey: 'x'.repeat(32), fetch: async url => {
    requests++; return new Response(JSON.stringify(String(url).includes('/tools/') ? record : { ...environment, tools: [record.id] }));
  } });
  const tool = await toolClient.tools.use(record.id);
  const toolEnv = await toolClient.environments.create({ tools: [tool] });
  const before = requests;
  await assert.rejects(toolEnv.tools.call(tool, 'echo', 'x'.repeat(8 * 1024 * 1024)), error => error.code === 'PAYLOAD_TOO_LARGE');
  const cyclic = {}; cyclic.self = cyclic;
  await assert.rejects(toolEnv.tools.call(tool, 'echo', cyclic), error => error.code === 'INVALID_INPUT');
  assert.equal(requests, before);
  const broken = new Putered({ baseUrl: 'http://localhost:3000', apiKey: 'x'.repeat(32), fetch: async () => new Response('not-json') });
  await assert.rejects(broken.environments.create(), error => error.code === 'PROTOCOL_ERROR');
  const unavailable = new Putered({ baseUrl: 'http://localhost:3000', apiKey: 'x'.repeat(32), fetch: async () => { throw new Error('offline'); } });
  await assert.rejects(unavailable.environments.create(), error => error.code === 'NETWORK_ERROR');
  const denied = new Putered({ baseUrl: 'http://localhost:3000', apiKey: 'x'.repeat(32), fetch: async () => new Response(JSON.stringify({ error: 'Denied', code: 'POLICY_DENIED' }), { status: 403 }) });
  await assert.rejects(denied.environments.create(), error => error instanceof PuteredError && error.code === 'POLICY_DENIED' && error.status === 403);
});

test('SDK accepts valid control-byte exec responses within actual stdout limits', async () => {
  const stdout = '\0'.repeat(2 * 1024 * 1024);
  const result = { stdout, stdoutBase64: Buffer.from(stdout).toString('base64'), stderr: '', exitCode: 0, durationMs: 1, hostDurationMs: 2 };
  const client = new Putered({ baseUrl: 'http://localhost:3000', apiKey: 'x'.repeat(32), fetch: async url =>
    new Response(JSON.stringify(String(url).endsWith('/exec') ? result : { id: 'env_test', tools: [], settings: {} })) });
  const env = await client.environments.create();
  assert.equal((await env.exec('echo test')).stdout.length, stdout.length);
});

test('schema conversion rejects regex flags, preserves UTF-16 length and validates JWT formats', async () => {
  for (const schema of [z.string().regex(/foo/i), z.object({ text: z.string().regex(/^a.b$/s) })])
    assert.throws(() => defineTool({ input: schema, output: z.string(), handler: () => '' }), error => error.code === 'PACKAGE_INVALID');
  const tool = defineTool({ input: z.string().min(2), output: z.string().min(2), handler: text => text });
  assert.equal(compileToolSchema(toolValidator(), tool.inputSchema)('🙂'), true);
  assert.equal(await tool.run('🙂', { workspaceId: 'test', signal: new AbortController().signal }), '🙂');
  for (const schema of [z.string().regex(/^.$/), z.string().regex(/^.$/).regex(/./)]) {
    const regex = defineTool({ input: schema, output: z.string(), handler: text => text });
    const validate = compileToolSchema(toolValidator(), regex.inputSchema);
    assert.equal(validate('🙂'), schema.safeParse('🙂').success);
    assert.equal(validate('a'), true);
  }
  const jwt = defineTool({ input: z.string(), output: z.jwt(), handler: text => text });
  assert.equal(compileToolSchema(toolValidator(), jwt.outputSchema)('BAD VALUE'), false);
  assert.throws(() => compileToolSchema(toolValidator(), { type: 'string', format: 'unknown-format' }), error => error.code === 'PACKAGE_INVALID');
  const emoji = defineTool({ input: z.string().emoji(), output: z.emoji(), handler: text => text });
  assert.equal(compileToolSchema(toolValidator(), emoji.inputSchema)('🙂'), true);
  assert.equal(compileToolSchema(toolValidator(), emoji.inputSchema)('a'), false);
});

test('tool outputs serialize the validated clone and service output errors use INVALID_OUTPUT', async () => {
  let called = false;
  const value = Object.defineProperty({ value: 1 }, 'toJSON', { get() { called = true; return () => ({ value: NaN }); } });
  const tool = defineTool({ input: z.string(), output: z.unknown(), handler: () => value });
  const output = await tool.run('x', { workspaceId: 'test', signal: new AbortController().signal });
  assert.equal(JSON.stringify(output), '{"value":1}');
  assert.equal(called, false);
  assert.notEqual(output, value);
  const record = { id: 'tool_' + 'a'.repeat(64), visibility: 'private', manifest: {
    name: 'test', version: '1', execution: { backend: 'v8' }, tools: { echo: { inputSchema: {}, outputSchema: {} } },
  } };
  for (const response of ['{"output":{"constructor":"unsafe"}}', '{"output":1e400}']) {
    const client = new Putered({ baseUrl: 'http://localhost:3000', apiKey: 'x'.repeat(32), fetch: async url => {
      if (String(url).endsWith('/tools/call')) return new Response(response);
      return new Response(JSON.stringify(String(url).includes('/tools/') ? record : { id: 'env_test', tools: [record.id], settings: {} }));
    } });
    const ref = await client.tools.use(record.id);
    const env = await client.environments.create({ tools: [ref] });
    await assert.rejects(env.tools.call(ref, 'echo', 'x'), error => error.code === 'INVALID_OUTPUT');
  }
});

test('SDK import does not load esbuild, TypeScript or the build module', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'putered-import-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const loader = join(directory, 'loader.mjs');
  await writeFile(loader, `export function resolve(specifier, context, next) {
    if (['esbuild','typescript','pg','pyodide','just-bash'].includes(specifier) || specifier.startsWith('@aws-sdk/') || specifier.includes('/server/') || specifier.endsWith('/tool-package.js') || specifier.endsWith('/tool-declarations.js')) throw new Error('Server/build code loaded by SDK');
    return next(specifier, context);
  }`);
  const result = spawnSync(process.execPath, ['--experimental-loader', pathToFileURL(loader).href, '--input-type=module', '-e',
    "import {Putered} from '@putered/sdk'; import {Putered as Standalone} from '@putered/sdk'; if(typeof Putered !== 'function'||typeof Standalone !== 'function') throw new Error('Missing SDK');"], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

for (const kind of ['local', 'external-commonjs', 'ambient']) test(`plugin declarations remain portable after deleting ${kind} source graph`, async t => {
  await mkdir(join(root, 'work'), { recursive: true });
  const source = await mkdtemp(join(root, 'work', 'portable-source-'));
  const consumer = await mkdtemp(join(tmpdir(), 'portable-consumer-'));
  t.after(async () => { await rm(source, { recursive: true, force: true }); await rm(consumer, { recursive: true, force: true }); });
  if (kind === 'external-commonjs') {
    await writeFile(join(source, 'package.json'), '{"type":"commonjs"}');
    await writeFile(join(source, 'tsconfig.json'), '{"compilerOptions":{"module":"ESNext","moduleResolution":"Bundler","target":"ES2022","strict":true,"esModuleInterop":true}}');
    await mkdir(join(source, 'node_modules'));
    await mkdir(join(source, 'node_modules', '@putered'));
    await symlink(root, join(source, 'node_modules', '@putered', 'sdk'), 'junction');
    await symlink(join(root, 'node_modules', 'zod'), join(source, 'node_modules', 'zod'), 'junction');
    await symlink(join(root, 'node_modules', '@types'), join(source, 'node_modules', '@types'), 'junction');
  }
  if (kind === 'ambient') await writeFile(join(source, 'ambient.d.ts'), 'type GlobalText = string;\n');
  await writeFile(join(source, kind === 'ambient' ? 'shape.d.ts' : 'shape.ts'),
    (kind === 'ambient' ? '/// <reference path="./ambient.d.ts" />\n' : '') +
    `export interface Note { text: ${kind === 'ambient' ? 'GlobalText' : 'string'} }\nexport type Label = 'research' | 'notes';\n`);
  const entry = join(source, kind === 'external-commonjs' ? 'plugin.ts' : 'plugin.mts');
  await writeFile(entry, `import {definePlugin,defineTool} from '@putered/sdk/plugins';
import {z} from 'zod'; import type {Label, Note} from './shape.js';
const input: z.ZodType<Note, Note> = z.object({text:z.string()});
export default definePlugin({name:'portable', tools:{classify:defineTool({
 input, output:z.enum(['research','notes']), handler:({text}):Label=>text?'research':'notes'
})}});`);
  const output = join(source, 'bundle.mjs');
  await buildPlugin(entry, output);
  for (const name of ['bundle.mjs', 'bundle.d.mts', 'bundle.types'])
    await cp(join(source, name), join(consumer, name), { recursive: true });
  await rm(source, { recursive: true, force: true });
  await mkdir(join(consumer, 'node_modules'));
  await mkdir(join(consumer, 'node_modules', '@putered'));
  await symlink(root, join(consumer, 'node_modules', '@putered', 'sdk'), 'junction');
  await symlink(join(root, 'node_modules', 'zod'), join(consumer, 'node_modules', 'zod'), 'junction');
  await symlink(join(root, 'node_modules', '@types'), join(consumer, 'node_modules', '@types'), 'junction');
  await writeFile(join(consumer, 'consumer.mts'), `import plugin from './bundle.mjs'; import {Putered} from '@putered/sdk';
const client=new Putered({baseUrl:'http://localhost:3000',apiKey:'x'.repeat(32)});
const ref=await client.tools.use(plugin); const env=await client.environments.create({tools:[ref]});
const output=await env.tools.call(ref,'classify',{text:'hi'});
const label:'research'|'notes'=output.output;
// @ts-expect-error The copied package retains the exact input type.
await env.tools.call(ref,'classify',{text:42});
// @ts-expect-error It retains the output enum, not merely unknown or string.
const invalid:'other'=output.output;
`);
  const checked = spawnSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit', '--strict', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', join(consumer, 'consumer.mts')], { cwd: consumer, encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  const runtime = spawnSync(process.execPath, ['--input-type=module', '-e', "const {default:plugin}=await import('./bundle.mjs'); console.log(plugin.name);"], { cwd: consumer, encoding: 'utf8' });
  assert.equal(runtime.status, 0, runtime.stderr);
  assert.match(runtime.stdout, /portable/);
  assert.doesNotMatch(await readFile(join(consumer, 'bundle.d.mts'), 'utf8'), /portable-source/);
});
