import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Putered } from '../dist/client/sdk.js';

test('API-key-only clients use the hosted endpoint and preserve its compute path', async () => {
  const client = new Putered({ apiKey: 'x'.repeat(32), config: {}, fetch: async (url, options) => {
    assert.equal(url, 'https://putered.com/api/compute/v1/environments');
    assert.equal(options.headers.Authorization, `Bearer ${'x'.repeat(32)}`);
    assert.equal(options.method, 'POST');
    return Response.json({ id: 'env_hosted', tools: [], settings: {} });
  } });
  assert.equal((await client.environments.create()).id, 'env_hosted');
});

test('explicit backend URLs remain available as overrides and malformed URLs are rejected', async () => {
  const client = new Putered({ baseUrl: 'http://127.0.0.1:3000/', apiKey: 'x'.repeat(32), config: {}, fetch: async url => {
    assert.equal(url, 'http://127.0.0.1:3000/v1/environments/env_local');
    return Response.json({ id: 'env_local', tools: [], settings: {} });
  } });
  assert.equal((await client.environments.connect('env_local')).id, 'env_local');
  for (const baseUrl of ['', null, 'https://putered.com/?token=secret'])
    assert.throws(() => new Putered({ baseUrl, apiKey: 'x'.repeat(32) }), error => error.code === 'INVALID_INPUT');
});
