# @putered/sdk

TypeScript SDK for [Putered](https://putered.com). Create persistent Linux environments, run commands or typed tools, and reconnect to saved workspaces by ID.

Requires Node.js 22.13+ and an API key from the [Putered console](https://putered.com).

## Installation

```sh
npm install @putered/sdk
```

<details>
<summary>Build a local tarball from source</summary>

```sh
git clone https://github.com/EwanJordaan/putered-sdk.git
cd putered-sdk
npm ci
npm run build
npm pack
```

Install the tarball with `npm install /path/to/putered-sdk-<version>.tgz`.

</details>

## Basic usage

Set `PUTERED_API_KEY` in your server environment (never in browser code):

```ts
import { Putered } from '@putered/sdk';

const putered = new Putered({
  apiKey: process.env.PUTERED_API_KEY!,
});

const env = await putered.environments.create({ name: 'my-agent' });

await env.exec("printf 'hello\\n' > hello.txt");
console.log((await env.exec('cat hello.txt')).output); // => hello
console.log((await env.run('git', ['status', '--short'])).output);

// Save this ID to reconnect later:
console.log(env.id); // => env_...
```

Reconnect to the same files in a later process:

```ts
const reopened = await putered.environments.connect(env.id);
console.log((await reopened.exec('cat hello.txt')).output); // => hello
```

Hosted compute requires an active subscription and available credits.

## Persistence

Set `persistence` at creation time to control what survives `stop()` and `resume()`:

| Policy | Saved state |
| --- | --- |
| `'full'` *(default)* | `/workspace`, mutable home/Node/Python state, and private OCI filesystem |
| `'workspace'` | `/workspace` only |
| `'workspace-and-dependencies'` | `/workspace` plus standard Node and Python package directories |
| `'none'` | Nothing; mutable state is discarded on stop or shutdown |
| `{ mode: 'custom', include, exclude }` | Explicit absolute guest subtrees (exclusions win) |

```ts
const env = await putered.environments.create({
  persistence: 'workspace-and-dependencies',
});

await env.stop();
const resumed = await env.resume(); // Or call exec()/run() to resume on demand.
```

> **Migrating from `0.2.0`:** replace `settings.saveScope: 'workspace-only'` with `persistence: 'workspace'`, and `'entire-environment'` with `persistence: 'full'`. `saveScope` is no longer accepted.

## Execution backends & resources

Configure defaults in `putered.config.json` in your working directory:

```json
{
  "persistence": "workspace",
  "execution": {
    "default": "native",
    "programs": { "git": "v8" }
  },
  "resources": {
    "cpu": 0.5,
    "memoryMiB": 512
  }
}
```

- `execution` selects `'native'`, `'v8'`, or `'auto'` per environment or per direct `run()` program (separate from `settings.execution`, which sets security policy).
- `resources` can be overridden per command (`env.exec('npm run build', { resources: { cpu: 1, memoryMiB: 1024 } })`). CPU shares fairly up to the cap; RAM is a hard ceiling. Current hosted sizes cap at `1 vCPU / 1024 MiB`.
- Explicit `environments.create()` options override `putered.config.json` defaults, except an offline `network` policy.

## Exports

- `@putered/sdk` — `Putered`, `Environment`, `CommandHandle`, `TerminalSession`, `CommandError`, `PuteredError`
- `@putered/sdk/plugins` — `definePlugin`, `defineTool`, `defineAsset`
- `@putered/sdk/packaging` — runtime artifact helpers
- `@putered/sdk/build` — `buildPlugin` (requires optional `esbuild` and `typescript`)

## Docs & examples

- [Documentation](https://putered.com/documentation)
- [SDK guide](docs/sdk.md)
- [HTTP API contract](docs/api-contract.md)
- [Stored binaries & assets](docs/assets.md)
- [Response contracts](docs/sdk-response-contracts.md)
- [Publishing](docs/publishing.md)
- [SDK examples](examples/sdk/README.md) · [Vibes](examples/vibes/README.md) · [Typed tools](examples/typed-tools/README.md) · [Stored assets](examples/stored-assets/README.md)
