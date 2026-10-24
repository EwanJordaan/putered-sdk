import { Readable } from 'node:stream';
import { client } from './client.js';

const environment = await client.environments.create({
  settings: { saveScope: 'workspace-only', network: { mode: 'disabled' } },
});

try {
  const piped = await environment.run('python', [
    '-c', 'import os,sys; print(os.getcwd()); print(os.getenv("RUN_MODE")); print(sys.stdin.read())',
  ], {
    cwd: '/workspace', env: { RUN_MODE: 'streaming-example' },
    stdin: Readable.from(['sent through stdin\n']), stdout: process.stdout,
  });
  console.log('Piped command exit code:', piped.exitCode);

  const command = await environment.run('sh', ['-c', 'printf "background started\\n"; sleep 1; printf "background finished\\n"'], {
    detached: true,
  });
  console.log('Command ID:', command.id);
  const reopened = await environment.getCommand(command.id);
  for await (const chunk of reopened.logs()) process.stdout.write(chunk.data);
  const completed = await reopened.wait();
  console.log('Detached command exit code:', completed.exitCode);
} finally {
  await environment.delete();
}
