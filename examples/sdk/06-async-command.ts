import { client } from './client.js';

const environment = await client.environments.create({
  settings: { saveScope: 'workspace-only', network: { mode: 'disabled' } },
});
console.log('Environment ID:', environment.id);
// The SDK submits once and polls the job. This is still one command execution.
const result = await environment.exec("sleep 3; printf 'Finished\n' > job.txt; cat job.txt", {
  async: true,
  timeoutMs: 60_000,
});
process.stdout.write(result.output);
await environment.delete();

// On an uncertain submission/collection failure this program deliberately leaves
// the environment intact. Inspect the job ID in the error before retrying or deleting.
