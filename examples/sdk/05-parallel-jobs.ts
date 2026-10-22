import { client, quote } from './client.js';

// Separate environments run independently; commands in one workspace serialize.
const jobs = ['alpha', 'beta', 'gamma'];
const results = await Promise.allSettled(jobs.map(async name => {
  const environment = await client.environments.create({
    settings: { saveScope: 'workspace-only', network: { mode: 'disabled' } },
  });
  try {
    const result = await environment.exec(`printf '%s\n' ${quote(name)}`);
    return { name, environmentId: environment.id, output: result.output };
  } finally {
    await environment.delete();
  }
}));

for (const result of results) {
  if (result.status === 'fulfilled') console.log(result.value);
  else { console.error(result.reason); process.exitCode = 1; }
}
