import { CommandError, PuteredError } from '@putered/sdk';
import { client } from './client.js';

const environment = await client.environments.create({
  settings: { saveScope: 'workspace-only', network: { mode: 'disabled' } },
});
try {
  try {
    await environment.exec("printf 'Starting\n'; printf 'Something failed\n' >&2; exit 7");
  } catch (error) {
    if (error instanceof CommandError) {
      console.log('Program exit code:', error.exitCode);
      process.stdout.write(error.output); // stdout followed by stderr
    } else if (error instanceof PuteredError) {
      console.error('API error:', error.code, error.status, error.message);
      throw error; // Do not automatically rerun a command after a network failure.
    } else {
      throw error;
    }
  }

  // Expected nonzero exits can be handled without throwing.
  const result = await environment.exec('exit 1', { check: false });
  console.log('Expected exit:', result.exitCode);
} finally {
  await environment.delete();
}
