import { client } from './client.js';

const environment = await client.environments.create({
  settings: { saveScope: 'workspace-only', network: { mode: 'disabled' } },
});
console.log('Environment ID:', environment.id);

const result = await environment.exec("printf 'Hello from Putered\n' > greeting.txt && cat greeting.txt");
process.stdout.write(result.output);
console.log('Exit code:', result.exitCode);
console.log('Duration (ms):', result.durationMs);

// Keep this environment for example 02. Save its ID, then run example 11 to delete it.
