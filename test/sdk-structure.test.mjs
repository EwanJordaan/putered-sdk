import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const sdk = fileURLToPath(new URL('../dist/client/sdk.js', import.meta.url));
const root = fileURLToPath(new URL('../', import.meta.url));

test('SDK import does not load server or build dependencies', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'putered-sdk-import-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const loader = join(directory, 'loader.mjs');
  await writeFile(loader, `export function resolve(specifier, context, next) {
    if (['esbuild','typescript','pg','pyodide','just-bash'].includes(specifier) || specifier.startsWith('@aws-sdk/') || specifier.includes('/server/') || specifier.endsWith('/tool-package.js') || specifier.endsWith('/tool-declarations.js')) throw new Error('Server/build code loaded by SDK');
    return next(specifier, context);
  }`);
  const importUrl = JSON.stringify(pathToFileURL(sdk).href);
  const result = spawnSync(process.execPath, ['--experimental-loader', pathToFileURL(loader).href, '--input-type=module', '-e',
    `import {Putered} from ${importUrl}; if(typeof Putered !== 'function') throw new Error('Missing SDK export');`],
  { cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('CLI help and plugin build keep the standalone builder entry point', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'putered-plugin-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cli = join(root, 'dist', 'client', 'cli.js');
  const help = spawnSync(process.execPath, [cli, '--help'], { cwd: root, encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /putered plugin build/);

  const output = join(directory, 'word-count.mjs');
  const built = spawnSync(process.execPath, [cli, 'plugin', 'build',
    join(root, 'examples', 'typed-tools', 'word-count.ts'), output], { cwd: root, encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  assert.match(built.stdout, /^tool_[a-f0-9]{64}\s*$/);
});
