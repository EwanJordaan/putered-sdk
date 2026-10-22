import { client, required } from './client.js';

const id = required('PUTERED_ENVIRONMENT_ID');
if (process.env.PUTERED_CONFIRM_DELETE !== id) {
  throw new Error('Set PUTERED_CONFIRM_DELETE to the same environment ID to confirm permanent deletion.');
}
const environment = await client.environments.connect(id);
const result = await environment.delete();
console.log('Deleted:', result.id, result.deleted);
// Saved files are removed. Independently captured snapshots remain available.
