import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { cp, lstat, mkdir, mkdtemp, readFile, rm, rmdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const packageLink = join(root, 'node_modules', '@putered', 'sdk');
let linkedPackage = false;
try { await lstat(packageLink); }
catch { await mkdir(dirname(packageLink), { recursive: true }); await symlink(root, packageLink, 'junction'); linkedPackage = true; }
const { createVibesServer } = await import('../examples/vibes/server.mjs');
after(async () => {
  if (linkedPackage) {
    await rm(packageLink, { force: true });
    await rmdir(dirname(packageLink));
  }
});

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'putered-vibes-'));
  await cp(new URL('../examples/vibes/app/', import.meta.url), join(path, 'app'), { recursive: true });
  await cp(new URL('../examples/vibes/public/', import.meta.url), join(path, 'public'), { recursive: true });
  t.after(() => rm(path, { recursive: true, force: true })); return path;
}
async function start(t, options) {
  const server = createVibesServer(options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, server, post: (path, data = {}, origin = base) => fetch(base + '/api/' + path, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  }) };
}

test('Vibes requires local-origin actions, exposes no env files and serves an isolated preview', async t => {
  const root = await directory(t), app = await start(t, { directory: root });
  assert.equal((await (await fetch(app.base + '/api/status')).json()).configured, false);
  const page = await fetch(app.base);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(await page.text(), /sandbox="allow-scripts"/);
  assert.equal((await fetch(app.base + '/.env')).status, 404);
  assert.equal((await app.post('run', { command: 'true' }, 'https://other.example')).status, 403);
  const missing = await app.post('build');
  assert.match((await missing.json()).error, /Set PUTERED_API_KEY/);
});

test('Vibes keeps one environment across requests and restarts, and serves only built preview files', async t => {
  const root = await directory(t); let creates = 0, connects = 0;
  const environment = { id: 'env_vibes', exec: async command => ({
    stdout: command.includes('const out={}') ? JSON.stringify({ 'index.html': '<h1>built</h1>', 'main.js': 'console.log(1)', 'main.css': 'body{}' }) : 'hello',
    stderr: '', exitCode: 0, stdoutBase64: '', durationMs: 1, hostDurationMs: 1,
  }) };
  const client = { environments: { create: async () => { creates++; return environment; }, connect: async id => { connects++; assert.equal(id, environment.id); return environment; } } };
  const first = await start(t, { client, directory: root });
  assert.equal((await (await first.post('run', { command: 'printf hello' })).json()).stdout, 'hello');
  assert.equal(JSON.parse(await readFile(join(root, '.vibes/environment.json'), 'utf8')).id, environment.id);
  await new Promise(resolve => first.server.close(resolve));
  const reopened = await start(t, { client, directory: root });
  assert.equal((await (await reopened.post('build')).json()).previewReady, true);
  assert.equal(creates, 1); assert.equal(connects, 1);
  assert.equal(await (await fetch(reopened.base + '/preview/index.html')).text(), '<h1>built</h1>');
  assert.equal((await fetch(reopened.base + '/preview/server.mjs')).status, 404);
});
