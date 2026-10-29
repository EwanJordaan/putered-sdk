import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Putered } from '../dist/client/sdk.js';

test('top-level persistence overrides the config default and is retained across reconnect/resume', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'putered-persistence-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = join(directory, 'putered.config.json');
  await writeFile(config, JSON.stringify({ persistence: 'workspace-and-dependencies' }));
  const requests = []; let record;
  const fetch = async (url, options) => {
    requests.push({ url: String(url), ...options });
    if (String(url).endsWith('/environments')) record = { id: 'env_policy', tools: [], settings: {}, persistence: JSON.parse(options.body).persistence };
    return Response.json(record);
  };
  const client = new Putered({ apiKey: 'x'.repeat(32), config, fetch });
  const inherited = await client.environments.create();
  assert.equal(inherited.persistence, 'workspace-and-dependencies');
  assert.equal(JSON.parse(requests.at(-1).body).settings.persistence, undefined);
  const policy = { mode: 'custom', include: ['/workspace/', '/home/putered'], exclude: ['/workspace/cache'] };
  const environment = await client.environments.create({ persistence: policy });
  const expected = { ...policy, include: ['/workspace', '/home/putered'] };
  assert.deepEqual(environment.persistence, expected);
  assert.deepEqual((await environment.resume()).persistence, expected);
  const other = new Putered({ apiKey: 'x'.repeat(32), config: { persistence: 'none' }, fetch });
  assert.deepEqual((await other.environments.connect(environment.id)).persistence, expected, 'reconnect does not apply a new default');
  const prior = process.cwd();
  let automatic;
  try { process.chdir(directory); automatic = new Putered({ apiKey: 'x'.repeat(32), fetch }); }
  finally { process.chdir(prior); }
  assert.equal((await automatic.environments.create()).persistence, 'workspace-and-dependencies');
});

test('removed saveScope fields and invalid paths are rejected before any creation request', async () => {
  let requests = 0;
  const client = new Putered({ apiKey: 'x'.repeat(32), config: {}, fetch: async () => { requests++; throw Error('must not fetch'); } });
  for (const options of [
    { settings: { saveScope: 'workspace-only' } }, { saveScope: 'workspace-only' },
    { persistence: 'ephemeral' }, { persistence: 'invalid' },
    { persistence: { mode: 'custom', include: [] } },
    { persistence: { mode: 'custom', include: ['relative'] } },
    { persistence: { mode: 'custom', include: ['/workspace/../etc'] } },
    { persistence: { mode: 'custom', include: ['/workspace/**'] } },
    { persistence: { mode: 'custom', include: ['/workspace'], exclude: ['../private'] } },
  ]) await assert.rejects(client.environments.create(options), error => error.code === 'INVALID_INPUT');
  assert.equal(requests, 0);
  assert.throws(() => new Putered({ apiKey: 'x'.repeat(32), config: { saveScope: 'workspace-only' } }), error => error.code === 'INVALID_INPUT');
});

test('a server cannot silently ignore or change an explicit persistence policy', async () => {
  let persistence;
  const client = new Putered({ apiKey: 'x'.repeat(32), config: {}, fetch: async () =>
    Response.json({ id: 'env_policy', tools: [], settings: {}, ...(persistence === undefined ? {} : { persistence }) }) });
  await assert.rejects(client.environments.create({ persistence: 'none' }), error => error.code === 'PROTOCOL_ERROR');
  persistence = 'full';
  await assert.rejects(client.environments.create({ persistence: 'workspace' }), error => error.code === 'PROTOCOL_ERROR');
});
