import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Putered } from '../dist/client/sdk.js';
import { clientFromEnv } from '../dist/client/cli-helpers.js';

test('clients always use the hosted endpoint and preserve its compute path', async () => {
  const client = new Putered({ apiKey: 'x'.repeat(32), config: {}, fetch: async (url, options) => {
    assert.equal(url, 'https://putered.com/api/compute/v1/environments');
    assert.equal(options.headers.Authorization, `Bearer ${'x'.repeat(32)}`);
    assert.equal(options.method, 'POST');
    return Response.json({ id: 'env_hosted', tools: [], settings: {} });
  } });
  assert.equal((await client.environments.create()).id, 'env_hosted');
});

test('custom baseUrl options are rejected and CLI ignores PUTERED_BASE_URL', async () => {
  for (const invalid of [null, []])
    assert.throws(() => new Putered(invalid), error => error.code === 'INVALID_INPUT');
  for (const baseUrl of ['http://127.0.0.1:3000/', 'https://putered.com/api/compute', '', null, 'https://putered.com/?token=secret'])
    assert.throws(() => new Putered({ baseUrl, apiKey: 'x'.repeat(32) }), error => error.code === 'INVALID_INPUT');
  const previousKey = process.env.PUTERED_API_KEY;
  const previousBase = process.env.PUTERED_BASE_URL;
  const previousFetch = globalThis.fetch;
  process.env.PUTERED_API_KEY = 'x'.repeat(32);
  process.env.PUTERED_BASE_URL = 'http://127.0.0.1:3000';
  const urls = [];
  globalThis.fetch = async url => {
    urls.push(String(url));
    return Response.json({ id: 'env_cli', tools: [], settings: {} });
  };
  try {
    const client = clientFromEnv();
    assert.equal((await client.environments.connect('env_cli')).id, 'env_cli');
    assert.deepEqual(urls, ['https://putered.com/api/compute/v1/environments/env_cli']);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.PUTERED_API_KEY; else process.env.PUTERED_API_KEY = previousKey;
    if (previousBase === undefined) delete process.env.PUTERED_BASE_URL; else process.env.PUTERED_BASE_URL = previousBase;
  }
});
