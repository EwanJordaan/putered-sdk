import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Putered } from '../dist/client/sdk.js';

const { version } = createRequire(import.meta.url)('../package.json');

test('SDK identifies its installed version on JSON, upload and download requests', async () => {
  const { Transport } = await import('../dist/client/transport.js');
  const { z } = await import('zod');
  const seen = [];
  const transport = new Transport('https://putered.com/api/compute', 'x'.repeat(32), async (_url, options) => {
    seen.push(options.headers);
    return Response.json({});
  });
  await transport.request('/tools', 'GET', z.object({}));
  await transport.upload('/assets', z.object({}), (async function* () { yield Buffer.from('x'); })(), 'application/octet-stream', 1);
  await transport.download('/presets/test/archive');
  assert.equal(seen.length, 3);
  for (const headers of seen) assert.equal(headers['X-Putered-SDK-Version'], version);
});

test('upgrade failures retain the readable message and HTTP status without replay', async () => {
  let requests = 0;
  const message = 'Putered SDK 0.1.4 is no longer supported. Upgrade to @putered/sdk@0.2.0 or newer.';
  const client = new Putered({ apiKey: 'x'.repeat(32), config: {}, fetch: async () => {
    requests++;
    return Response.json({ error: message, code: 'PROTOCOL_ERROR' }, { status: 426 });
  } });
  await assert.rejects(client.environments.create(), error =>
    error.code === 'PROTOCOL_ERROR' && error.status === 426 && error.message === message);
  assert.equal(requests, 1);
});
