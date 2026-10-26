import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Putered } from '../dist/client/sdk.js';

const record = { id: 'env_named', tools: [], settings: {} };
const client = fetcher => new Putered({ apiKey: 'x'.repeat(32), config: {}, fetch: fetcher });

test('named environments send a trimmed name and preserve it on create, connect and describe', async () => {
  const requests = [];
  const sdk = client(async (url, options) => {
    requests.push({ url, options });
    if (options.method === 'POST') assert.equal(JSON.parse(options.body).name, 'My agent');
    return Response.json({ ...record, name: 'My agent', futureMetadata: true });
  });
  const environment = await sdk.environments.create({ name: '  My agent  ' });
  assert.equal(environment.name, 'My agent');
  assert.deepEqual(environment.describe(), { ...record, name: 'My agent' });
  const connected = await sdk.environments.connect(environment.id);
  assert.equal(connected.name, environment.name);
  assert.equal(connected.describe().name, environment.name);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, 'https://putered.com/api/compute/v1/environments');
  assert.equal(requests[1].options.method, 'GET');
});

test('invalid names are rejected before HTTP; the 100-character boundary is accepted', async () => {
  let requests = 0;
  const sdk = client(async (_, options) => {
    requests++;
    return Response.json({ ...record, name: JSON.parse(options.body).name });
  });
  for (const name of ['', '   ', 'x'.repeat(101), null, 123, {}, []])
    await assert.rejects(sdk.environments.create({ name }), error => error.code === 'INVALID_INPUT');
  assert.equal(requests, 0);
  const environment = await sdk.environments.create({ name: 'x'.repeat(100) });
  assert.equal(environment.name.length, 100);
  assert.equal(requests, 1);
});

test('named creation rejects missing, mismatched or malformed returned names', async () => {
  for (const name of [undefined, 'different', '', '   ', ' named ', 'x'.repeat(101), null, 123]) {
    const sdk = client(async () => Response.json({ ...record, ...(name === undefined ? {} : { name }) }));
    await assert.rejects(sdk.environments.create({ name: 'named' }), error => error.code === 'PROTOCOL_ERROR');
  }
});

test('omitting a name keeps legacy unnamed core responses compatible', async () => {
  const sdk = client(async (_, options) => {
    if (options.method === 'POST') assert.equal(Object.hasOwn(JSON.parse(options.body), 'name'), false);
    return Response.json(record);
  });
  assert.equal((await sdk.environments.create()).name, undefined);
  assert.equal((await sdk.environments.connect(record.id)).describe().name, undefined);
  const hosted = client(async () => Response.json({ ...record, name: 'My environment' }));
  assert.equal((await hosted.environments.create()).name, 'My environment');
});
