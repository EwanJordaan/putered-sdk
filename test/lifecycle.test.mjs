import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Putered } from '../dist/client/sdk.js';

test('stop/resume preserve scope, validate response identities and forward cancellation', async () => {
  for (const persistence of ['workspace', 'full']) {
    const record = { id: 'env_lifecycle', tools: [], persistence, settings: {} }, requests = [];
    let wrongIdentity = false;
    const client = new Putered({ apiKey: 'x'.repeat(32), config: {}, fetch: async (url, options) => {
      options.signal?.throwIfAborted();
      requests.push({ url: String(url), ...options });
      return Response.json(String(url).endsWith('/stop') ? { id: wrongIdentity ? 'env_other' : record.id, stopped: true }
        : { ...record, ...(wrongIdentity ? { id: 'env_other' } : {}) });
    } });
    const environment = await client.environments.create({ persistence });
    assert.equal(JSON.parse(requests[0].body).persistence, persistence);
    const controller = new AbortController();
    assert.deepEqual(await environment.stop({ signal: controller.signal }), { id: record.id, stopped: true });
    assert.equal(requests.at(-1).url.endsWith(`/environments/${record.id}/stop`), true);
    assert.equal(requests.at(-1).method, 'POST'); assert.equal(requests.at(-1).body, '{}');
    const resumed = await environment.resume();
    assert.equal(resumed.id, record.id); assert.equal(resumed.describe().persistence, persistence);
    wrongIdentity = true;
    await assert.rejects(environment.stop(), error => error.code === 'PROTOCOL_ERROR');
    await assert.rejects(environment.resume(), error => error.code === 'PROTOCOL_ERROR');
    controller.abort();
    await assert.rejects(environment.stop({ signal: controller.signal }), error => error.code === 'CANCELLED');
  }
});
