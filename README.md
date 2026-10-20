# Putered SDK

Open-source TypeScript/Node SDK for [Putered](https://github.com/EwanJordaan/Putered):
persistent workspaces, typed local plugins and stored binary/toolchain assets.
The server runs separately; its implementation and storage credentials are not
part of this package.

Requires Node.js 22.13 or later. Licensed under Apache 2.0.

## Install from this repository

The npm package is not published yet. Clone, build and pack it:

```sh
git clone https://github.com/EwanJordaan/putered-sdk.git
cd putered-sdk
npm ci
npm run build
npm pack
# In your application: npm install /path/to/putered-sdk-0.1.2.tgz
```

Normal installs include the optional esbuild/TypeScript plugin builder.
Applications consuming prebuilt plugins can use `npm install --omit=optional`.
Runtime client imports do not load build tooling or any server dependencies.

## Command output and long public API requests

```ts
const result = await environment.exec('git clone --depth 1 https://github.com/nestjs/nest.git', {
  timeoutMs: 60000,
  async: true,
});
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
if (result.exitCode !== 0) throw new Error(`Command exited ${result.exitCode}`);
```

Empty stdout is valid. Git progress and errors normally appear on stderr; a
nonzero process exit is returned as a result and must be checked by your program.
`async: true` uses the public account API's saved execution results to avoid long
synchronous HTTP responses while workspace changes are persisted. The command
is submitted once, then polled. The default remains synchronous; ordinary direct
servers can return their usual result immediately. Cancelling result collection
does not cancel the server command. Collection errors include the execution ID
for inspection and never automatically replay the command. Polling is bounded
to 30 minutes. See [response contracts](docs/sdk-response-contracts.md).

Stdout and stderr are fields of that one result, never separate retrieval APIs.
Use `await environment.delete()` to permanently remove an idle environment and
its saved workspace data (requires server v0.1.2). Shared tool assets and separately
captured presets remain.

## Define your own plugin

```ts
// word-count.ts
import { definePlugin, defineTool } from '@putered/sdk/plugins';
import { z } from 'zod';

export default definePlugin({
  name: 'word-count',
  tools: {
    count: defineTool({
      input: z.object({ text: z.string() }),
      output: z.object({ words: z.number().int() }),
      handler: ({ text }) => ({ words: text.trim() ? text.trim().split(/\s+/u).length : 0 }),
    }),
  },
});
```

```sh
putered plugin build word-count.ts word-count.mjs
```

```ts
import { Putered } from '@putered/sdk';
import wordCount from './word-count.mjs';

const putered = new Putered({
  baseUrl: process.env.PUTERED_BASE_URL!, apiKey: process.env.PUTERED_API_KEY!,
});
const tool = await putered.tools.use(wordCount);
const environment = await putered.environments.create({ tools: [tool] });
const { output } = await environment.tools.call(tool, 'count', { text: 'hello world' });
console.log(output.words); // Inferred number; wrong names and inputs fail type checking.
```

`tools.use()` stores the bundled plugin once and reuses its content-addressed ID.
Workspaces have Git disabled by default; enable it through environment settings.
Plugin code stays the source of truth. The plugin backend defaults to V8;
`execution: { backend: 'native' }` enables native tools on a compatible server.

## Upload a compiler or binary

```ts
const rust = await putered.assets.upload('./rust-toolchain', {
  platform: 'linux-x64', entrypoints: { cargo: 'bin/cargo', rustc: 'bin/rustc' },
});
```

Or save a typed source reference from the CLI:

```sh
putered assets upload ./rust-toolchain --platform linux-x64 \
  --entrypoint cargo=bin/cargo --entrypoint rustc=bin/rustc --output rust.asset.ts
```

Import that reference in a local native plugin, declare `assets: { rust }`, and call
`ctx.exec(rust, 'cargo', ['build', '--offline'])`. Entrypoint names autocomplete;
the server mounts stored bytes read-only inside the sandbox. Uploads resume after
interruption and verify SHA-256 checksums. Schemas and handlers remain in your code.

## Entry points

| Import | Purpose |
| --- | --- |
| `@putered/sdk` | Client, environment/tool APIs, uploads and typed errors |
| `@putered/sdk/plugins` | `definePlugin`, `defineTool`, `defineAsset` |
| `@putered/sdk/packaging` | Low-level artifact attachment/inspection |
| `@putered/sdk/build` | Optional local `buildPlugin` helper |

[SDK guide](docs/sdk.md) · [Stored assets and API flow](docs/assets.md) ·
[Word-count example](examples/typed-tools) · [Cargo example](examples/stored-assets)

## Development

```sh
npm ci
npm test
```

Tests cover client validation/error handling, import boundaries, JSON/schema limits,
portable generated declarations and compile-time tool/asset inference. Remote
execution tests and the server's PostgreSQL/S3 adapters live in the
[Putered server repository](https://github.com/EwanJordaan/Putered).

This initial extraction comes from server commit `d3da39b`. API contracts retain
format 1 / node22 compatibility. Server-side runtime changes are outside this repo.
Please submit SDK issues and pull requests here; do not include credentials in reports.
