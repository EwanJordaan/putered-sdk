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
  for (const text of ['{', '{"network":{"mode":"typo"}}', '{"typo":false}', ' '.repeat(65537)]) {
    await writeFile(path, text);
    assert.throws(() => new Putered(options), error => error.code === 'INVALID_INPUT');
  }
  assert.throws(() => loadSdkConfig({ network: { mode: 'disabled', maxBytesPerExecution: 1 } }),
    error => error.code === 'INVALID_INPUT');
  assert.deepEqual(loadSdkConfig({ network: { mode: 'disabled' } }), { network: { mode: 'disabled' } });
  assert.equal(SDK_CONFIG_FILE, 'putered.sdk.config.json');
  assert.equal(requests, 0);
});
