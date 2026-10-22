import { setTimeout as delay } from 'node:timers/promises';
import { client, required } from './client.js';

const environment = await client.environments.connect(required('PUTERED_ENVIRONMENT_ID'));
const terminal = await environment.terminals.start({ columns: 100, rows: 30 });
console.log('Terminal session ID:', terminal.id);
let cursor = 0, sent = false;
// Keep reading: reads are the heartbeat and advance through buffered output.
for (;;) {
  const state = await terminal.read({ cursor });
  process.stdout.write(state.outputBytes);
  cursor = state.cursor ?? cursor;
  if (state.reset) console.error('[Older terminal output is no longer buffered.]');
  if (state.state === 'running' && !sent) {
    sent = true;
    await terminal.write("pwd; printf 'Hello from the terminal\n'; exit\n");
  }
  if (state.state === 'closed') {
    console.log('Terminal exited:', state.exitCode);
    if (state.exitCode !== 0) throw new Error(`Terminal exited with code ${state.exitCode}.`);
    break;
  }
  if (state.state === 'failed' || state.state === 'unknown') {
    throw new Error(state.error ?? `Terminal state: ${state.state}. Inspect it before retrying.`);
  }
  await delay(500);
}
// The existing environment is kept. To end a shell yourself, await terminal.stop().
