# Stored Binaries & Native Assets

Upload a Linux binary or toolchain once, commit its immutable reference in your codebase, and invoke it from any native Putered plugin. Your `definePlugin` / `defineTool` code continues to own schemas, handlers, and backend selection — the asset only supplies the verified read-only executables.

## SDK vs. server boundaries

- **`@putered/sdk`** ships the HTTP client, typed definitions, upload CLI, and optional plugin builder (`@putered/sdk/build`). Runtime imports have no server, PostgreSQL, S3, shell, or Python dependencies.
- **The [Putered server](https://github.com/EwanJordaan/Putered)** owns execution, sandboxing, storage adapters, and project key configuration. Storage credentials never leave the server.

## Upload an asset

With `PUTERED_API_KEY` set, upload an unpacked Linux directory via the CLI:

```sh
putered assets upload ./rust-toolchain \
  --platform linux-x64 \
  --entrypoint cargo=bin/cargo \
  --entrypoint rustc=bin/rustc \
  --output ./examples/stored-assets/rust.asset.ts
```

This generates a small, typed `defineAsset(...)` file containing the platform, entrypoint map, and SHA-256 asset ID (no credentials or handler code). Commit it alongside your plugin. Updating binary contents produces a new immutable ID; re-uploading identical bytes resumes an incomplete upload or reuses the ready asset.

You can also upload programmatically from Node.js:

```ts
const rust = await putered.assets.upload('./rust-toolchain', {
  platform: 'linux-x64',
  entrypoints: { cargo: 'bin/cargo', rustc: 'bin/rustc' },
  signal: AbortSignal.timeout(180_000),
  onProgress: ({ completedBytes, totalBytes }) => {
    console.log(`${completedBytes} / ${totalBytes}`);
  },
});
// rust.entrypoints.cargo is typed; unknown entrypoints fail at compile time.
```

## Call an asset from a native plugin

Declare the asset on your plugin and run its entrypoints with `ctx.exec()`:

```ts
import { definePlugin, defineTool } from '@putered/sdk/plugins';
import { z } from 'zod';
import rust from './rust.asset.js';

export default definePlugin({
  name: 'cargo',
  execution: { backend: 'native' },
  assets: { rust },
  tools: {
    run: defineTool({
      input: z.object({}),
      output: z.object({
        stdout: z.string(),
        stderr: z.string(),
        exitCode: z.number().int(),
      }),
      handler: (_input, ctx) =>
        ctx.exec(rust, 'cargo', ['run', '--offline'], {
          env: { RUSTFLAGS: '-C linker=/usr/bin/gcc' },
        }),
    }),
  },
});
```

Build the plugin, register it, and call it like any other typed tool:

```ts
const saved = await putered.tools.use(cargo);
const env = await putered.environments.create({ tools: [saved] });
const { output } = await env.tools.call(saved, 'run', {});
```

See the [runnable Cargo example](../examples/stored-assets/README.md) for a complete project.

### Execution semantics & constraints

- **Direct invocation:** `ctx.exec(asset, entrypoint, args, { cwd, env, stdin })` passes arguments directly without a shell. `stdin` accepts a string or `Uint8Array`; results return `{ stdout, stderr, stdoutBase64, exitCode }` (use `stdoutBase64` for binary output).
- **Sandbox layout:** Verified assets are mounted read-only at `/tools/<asset-id>` with entrypoint directories added to `PATH` (so `cargo` can locate its uploaded `rustc`). Default `cwd` is `/workspace`, and custom `cwd` must stay inside `/workspace`. Home directories remain writable.
- **Bounds:** Combined output is capped at **4 MiB**. The tool timeout covers provisioning and terminates guest descendants on expiry.
- **Backend rules:** Only `native` plugins can declare assets; `isolate-only` environments reject native tools with no automatic fallback.
- **Supported files:** Regular files and directories, ELF64 `linux-x64` / `linux-arm64` binaries, and shebang entrypoints. Symlinks, archive extraction, and automatic dependency installation are not supported. Include any required runtime support files and match the worker's architecture and libc (for example, pass `-C linker=/usr/bin/gcc` explicitly since `/etc/alternatives` is not mounted).

## Resumable HTTP upload flow

All endpoints require `Authorization: Bearer <project-key>`. Browser dashboards should proxy through their own authenticated backend rather than exposing project keys or object-storage credentials in browser code.

| Operation | Endpoint | Returns |
| --- | --- | --- |
| List assets | `GET /v1/assets` | Compact summaries (`reference`, `state`, `totalBytes`, optional `error`) |
| Begin / resume | `POST /v1/assets/uploads` (`{ manifest }`) | Upload state and per-file byte offsets |
| Check progress | `GET /v1/assets/:id/upload` | Manifest, state, and acknowledged offsets |
| Upload chunk | `PUT /v1/assets/:id/upload/:sha256/:offset` | Updated offsets (raw binary body, max 4 MiB) |
| Validate & publish | `POST /v1/assets/:id/upload/complete` (`{}`) | Immutable ready `AssetReference` |
| Get reference | `GET /v1/assets/:id` | Ready reference for local `defineAsset` |
| Cancel upload | `DELETE /v1/assets/:id/upload` | Deletes incomplete/failed parts and frees manifest quota |

Matching SDK methods: `assets.list()`, `assets.status(id)`, `assets.get(id)`, and `assets.cancel(id)` (plus `tools.list()` for plugin manifests).

- **Manifest format:** `{ format: 1, platform, entrypoints, files }` where each file entry is `{ path, bytes, sha256, executable }`. Paths must be relative, unique, and traversal-free; entrypoints must reference executable files. The server computes the asset ID.
- **Chunking:** Upload chunks sequentially per distinct file SHA-256 from the acknowledged offset in `chunkBytes` (4 MiB) steps. Resending an identical acknowledged part is idempotent; conflicting data or offsets return `CONFLICT`. After a dropped response, query status or call begin again before continuing.
- **Lifecycle:** `uploading → validating → ready` (or `failed`). Validation verifies full SHA-256 hashes, file sizes, and executable architecture. Ready assets cannot be cancelled so existing plugin references stay intact.

### Quotas & limits

| Limit | Value |
| --- | --- |
| Project asset quota | 128 records / 8 GiB logical declared bytes |
| Max asset size | 1 GiB |
| Max single file size | 512 MiB |
| Max files per asset | 8,192 |
| Max manifest size | 1 MiB |
| Max assets per plugin | 16 |
| Plugin package quota *(separate)* | 128 records / 64 MiB |

Cancel incomplete uploads explicitly; automatic expiry and garbage collection of unreferenced blobs are planned for a future release.

## Server storage configuration (operators)

Development defaults to atomic local-disk objects and JSON metadata under the server data directory (single writer). Production deployments can back both plugins and assets with an S3-compatible private bucket (such as Cloudflare R2) and PostgreSQL for metadata and cross-process advisory locks:

```sh
# Server environment only
PUTERED_REGISTRY_DATABASE_URL=postgres://...
PUTERED_STORAGE_BUCKET=putered-private
PUTERED_STORAGE_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
PUTERED_STORAGE_REGION=auto
PUTERED_STORAGE_ACCESS_KEY_ID=...
PUTERED_STORAGE_SECRET_ACCESS_KEY=...
PUTERED_PROJECT_KEYS_FILE=/run/secrets/putered-project-keys.json
```

Set `PUTERED_STORAGE_FORCE_PATH_STYLE=1` for path-style S3 endpoints; standard HTTPS proxy variables are respected. Buckets remain private, and operators can also inject custom `ArtifactStorage` / `RegistryMetadata` adapters via `putered/server`.

Project keys are configured as a JSON array:

```json
[
  {
    "token": "<random-project-key-of-at-least-32-characters>",
    "projectId": "my-project",
    "scopes": ["read", "upload", "execute"]
  }
]
```

Keys in the same project share its assets, tools, and environments (`read` for reads, `upload` for asset/tool/preset mutations, `execute` for environment execution). Project keys cannot access legacy operator endpoints.
