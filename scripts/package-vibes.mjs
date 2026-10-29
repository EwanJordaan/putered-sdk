import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(process.argv[2] ?? join(root, 'work/releases'));
await mkdir(output, { recursive: true });
const stage = await mkdtemp(join(output, '.vibes-'));
try {
  const pack = JSON.parse(execFileSync('npm', ['pack', root, '--pack-destination', stage, '--json'], { cwd: root, encoding: 'utf8' }))[0];
  const sdk = join(output, pack.filename);
  await cp(join(stage, pack.filename), sdk);
  const bundle = join(stage, 'vibes'); await mkdir(join(bundle, 'vendor'), { recursive: true });
  for (const name of ['app', 'public', 'server.mjs', '.env.example', '.gitignore', 'putered.config.json', 'README.md', 'package.json'])
    await cp(join(root, 'examples/vibes', name), join(bundle, name), { recursive: true });
  await cp(sdk, join(bundle, 'vendor', pack.filename));
  const manifest = JSON.parse(await readFile(join(bundle, 'package.json'), 'utf8'));
  manifest.dependencies['@putered/sdk'] = `file:vendor/${pack.filename}`;
  await writeFile(join(bundle, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  const archive = join(output, `putered-vibes-v${manifest.version}.zip`);
  execFileSync('python3', ['-c', `
import sys, zipfile
from pathlib import Path
base = Path(sys.argv[1])
with zipfile.ZipFile(sys.argv[2], 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for path in sorted(base.rglob('*')):
        if path.is_file(): archive.write(path, path.relative_to(base.parent))
`, bundle, archive]);
  for (const path of [sdk, archive]) {
    const name = path.slice(output.length + 1), sum = createHash('sha256').update(await readFile(path)).digest('hex');
    await writeFile(path + '.sha256', `${sum}  ${name}\n`);
  }
  console.log(JSON.stringify({ archive, sdk }));
} finally { await rm(stage, { recursive: true, force: true }); }
