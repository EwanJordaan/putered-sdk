import { client, quote } from './client.js';

const environment = await client.environments.create({
  settings: { saveScope: 'workspace-only', network: { mode: 'disabled' } },
});
try {
  const input = JSON.stringify([{ name: 'a', value: 4 }, { name: 'b', value: 6 }]);
  await environment.exec(`printf '%s' ${quote(input)} > input.json`);
  const program = [
    'import json',
    'from pathlib import Path',
    'rows = json.loads(Path("input.json").read_text())',
    'result = {"count": len(rows), "total": sum(row["value"] for row in rows)}',
    'Path("result.json").write_text(json.dumps(result))',
    'print(json.dumps(result))',
  ].join('\n');
  process.stdout.write((await environment.exec(`python -c ${quote(program)}`, { timeoutMs: 60_000 })).output);
  const result = await environment.exec('cat result.json');
  console.log('Saved JSON:', JSON.parse(result.stdout));
} finally {
  await environment.delete();
}
