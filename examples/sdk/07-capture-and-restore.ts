import { client } from './client.js';

const original = await client.environments.create({
  settings: { saveScope: 'workspace-only', network: { mode: 'disabled' } },
});
console.log('Original environment:', original.id);
await original.exec("printf 'Saved configuration\n' > config.txt");
const snapshot = await original.capturePreset({
  name: 'example-' + Date.now(),
  onOperation: id => console.log('Snapshot operation ID:', id),
});
console.log('Snapshot ID:', snapshot.id, 'Bytes:', snapshot.bytes);

const restored = await client.environments.create({
  template: snapshot.id,
  settings: { saveScope: 'workspace-only', network: { mode: 'disabled' } },
});
console.log('Restored environment:', restored.id);
process.stdout.write((await restored.exec('cat config.txt')).output);
await restored.delete();
await original.delete();
// The snapshot remains in the console. Delete it there when finished.
// If any step fails, inspect the printed IDs before creating replacement resources.
