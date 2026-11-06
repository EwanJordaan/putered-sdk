import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Putered } from '../dist/client/sdk.js';

const id = 'env_outbound';
const apiKey = 'x'.repeat(32);
const policy = {
  allow: {
    'api.vercel.com': [
      { match: { path: { startsWith: '/v1/deployments' }, method: ['GET', 'POST'] },
        transform: [{ headers: { Authorization: 'Bearer dummy-vercel-token' } }] },
      { response: { statusCode: 403 } },
    ],
  },
};
const envVars = { VERCEL_TOKEN: 'dummy-vercel-token', VERCEL_TEAM_ID: 'team_demo' };
const redactedPolicy = structuredClone(policy);
redactedPolicy.allow['api.vercel.com'][0].transform[0].headers.Authorization = '<redacted>';
const record = extra => ({ id, tools: [], settings: {}, ...extra });
const client = fetch => new Putered({ baseUrl: 'https://putered.invalid', apiKey, fetch });

function reply(value) { return Response.json(value); }

function sizeBoundaryPolicy(value = 'v') {
  const keys = [
    ...Array.from({ length: 10 }, (_, index) => `a${index}`),
    ...'klmnop'.split('').map(letter => `x-${letter}`),
  ];
  const headers = Object.fromEntries(keys.map(key => [key, value]));
  const rules = Array.from({ length: 32 }, () => ({
    transform: Array.from({ length: 4 }, () => ({ headers })),
  }));
  return { allow: { 'a.example.com': rules, 'b.example.com': rules } };
}

function redact(policy) {
  const result = structuredClone(policy);
  for (const rules of Object.values(result.allow)) for (const rule of rules) for (const transform of rule.transform)
    for (const key of Object.keys(transform.headers)) transform.headers[key] = '<redacted>';
  return result;
}

test('create sends top-level env and networkPolicy and accepts redacted policy readback', async () => {
  let request;
  const sdk = client(async (_url, options) => {
    request = JSON.parse(options.body);
    return reply(record({ env: envVars, networkPolicy: redactedPolicy }));
  });
  const environment = await sdk.environments.create({ env: envVars, networkPolicy: policy });
  assert.deepEqual(request.env, envVars);
  assert.deepEqual(request.networkPolicy, policy);
  assert.deepEqual(environment.env, envVars);
  assert.deepEqual(environment.networkPolicy, redactedPolicy);
  assert.deepEqual(environment.describe().env, envVars);
});

test('create rejects silently changed variables or broadened outbound rules', async () => {
  const changedEnv = client(async () => reply(record({ env: { ...envVars, VERCEL_TOKEN: 'changed' }, networkPolicy: redactedPolicy })));
  await assert.rejects(changedEnv.environments.create({ env: envVars, networkPolicy: policy }), error => error.code === 'PROTOCOL_ERROR');
  const broadened = structuredClone(policy);
  broadened.allow['api.vercel.com'].unshift({ match: { path: { startsWith: '/' } }, transform: [{ headers: { Authorization: 'Bearer dummy-vercel-token' } }] });
  const changedPolicy = client(async () => reply(record({ env: envVars, networkPolicy: broadened })));
  await assert.rejects(changedPolicy.environments.create({ env: envVars, networkPolicy: policy }), error => error.code === 'PROTOCOL_ERROR');
});

test('update validates input, PATCHes, and refreshes the described cached record after identity checks', async () => {
  let requests = 0;
  const sdk = client(async (_url, options) => {
    requests++;
    if (options.method === 'PATCH') {
      assert.deepEqual(JSON.parse(options.body), { env: envVars, networkPolicy: policy });
      return reply(record({ env: envVars, networkPolicy: redactedPolicy }));
    }
    return reply(record());
  });
  const environment = await sdk.environments.connect(id);
  await environment.update({ env: envVars, networkPolicy: policy }, { signal: new AbortController().signal });
  assert.equal(requests, 2);
  assert.deepEqual(environment.describe().env, envVars);
  assert.deepEqual(environment.networkPolicy, redactedPolicy);
  await assert.rejects(environment.update({}), error => error.code === 'INVALID_INPUT');
  await assert.rejects(environment.update({ networkPolicy: { allow: { 'api.vercel.com': [{ response: { statusCode: 200 } }] } } }),
    error => error.code === 'INVALID_INPUT');
  assert.equal(requests, 2);
});

test('update does not cache responses with a different identity or widened policy', async () => {
  const changedId = client(async (_url, options) => reply(options.method === 'PATCH' ? record({ id: 'env_other', env: envVars }) : record()));
  const environment = await changedId.environments.connect(id);
  await assert.rejects(environment.update({ env: envVars }), error => error.code === 'PROTOCOL_ERROR');
  assert.equal(environment.describe().id, id);
  const wider = structuredClone(policy);
  wider.allow['api.vercel.com'][0].match.path = { startsWith: '/' };
  const broadened = client(async (_url, options) => reply(options.method === 'PATCH' ? record({ env: envVars, networkPolicy: wider }) : record()));
  const other = await broadened.environments.connect(id);
  await assert.rejects(other.update({ env: envVars, networkPolicy: policy }), error => error.code === 'PROTOCOL_ERROR');
  assert.equal(other.env, undefined);
});

test('large valid policy survives create, connect and update readback, then can be revoked', async () => {
  const authored = sizeBoundaryPolicy();
  const readback = redact(authored);
  assert.equal(Buffer.byteLength(JSON.stringify(authored)), 43055);
  assert.equal(Buffer.byteLength(JSON.stringify(readback)), 79919);
  let requests = 0;
  const sdk = client(async (_url, options) => {
    requests++;
    if (options.method === 'PATCH' && JSON.parse(options.body).networkPolicy === 'deny-all')
      return reply(record({ networkPolicy: 'deny-all' }));
    return reply(record({ networkPolicy: readback }));
  });
  const created = await sdk.environments.create({ networkPolicy: authored });
  assert.deepEqual(created.networkPolicy, readback);
  const connected = await sdk.environments.connect(id);
  assert.deepEqual(connected.networkPolicy, readback);
  await connected.update({ networkPolicy: authored });
  assert.deepEqual(connected.describe().networkPolicy, readback);
  await connected.update({ networkPolicy: 'deny-all' });
  assert.equal(connected.networkPolicy, 'deny-all');
  assert.equal(requests, 4);
});

test('authored policies over 64 KiB fail before HTTP and readbacks over 256 KiB fail schema validation', async () => {
  let requests = 0;
  const sdk = client(async () => { requests++; return reply(record()); });
  const tooLargeToWrite = sizeBoundaryPolicy('v'.repeat(20));
  assert.ok(Buffer.byteLength(JSON.stringify(tooLargeToWrite)) > 64 * 1024);
  await assert.rejects(sdk.environments.create({ networkPolicy: tooLargeToWrite }), error => error.code === 'INVALID_INPUT');
  assert.equal(requests, 0);

  const longHeaders = Object.fromEntries(Array.from({ length: 16 }, (_, index) => [
    `x${String(index).padStart(2, '0')}${'a'.repeat(123)}`, '<redacted>',
  ]));
  const hugeRules = Array.from({ length: 32 }, () => ({
    transform: Array.from({ length: 4 }, () => ({ headers: longHeaders })),
  }));
  const tooLargeToRead = { allow: Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`h${index}.example.com`, hugeRules])) };
  assert.ok(Buffer.byteLength(JSON.stringify(tooLargeToRead)) > 256 * 1024);
  const readbackSdk = client(async () => { requests++; return reply(record({ networkPolicy: tooLargeToRead })); });
  await assert.rejects(readbackSdk.environments.connect(id, { signal: new AbortController().signal }), error => error.code === 'PROTOCOL_ERROR');
  assert.equal(requests, 1);
});
