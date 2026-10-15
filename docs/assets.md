# Stored binaries and locally defined tools

Upload a Linux binary or toolchain once, then keep its immutable reference in your
source tree. Your `definePlugin`/`defineTool` code owns the schemas, handlers and
backend choice. The stored binary never replaces that code. A future dashboard can
upload the same bytes and give you the same reference to paste into your project.

## Separate SDK and server

`@putered/sdk` contains the Node HTTP client, typed definitions, upload CLI and
optional local plugin builder. Shared wire contracts live in `src/`; client code
lives in `src/client`. Runtime imports have no server, PostgreSQL, S3, shell or
Python dependencies. Build tooling is isolated behind `@putered/sdk/build`.

The [server repository](https://github.com/EwanJordaan/Putered) maintains execution,
API handlers and storage adapters independently. Provider credentials and project
key configuration remain on the server. See [installation](../README.md#install-from-this-repository)
for building and packing this SDK before its npm release.

## Upload and use

With `PUTERED_API_KEY` and `PUTERED_BASE_URL` set, upload an unpacked toolchain:

```sh
# From this repository; installed SDK consumers can use `putered` directly.
node dist/client/cli.js assets upload ./rust-toolchain \
  --platform linux-x64 \
  --entrypoint cargo=bin/cargo --entrypoint rustc=bin/rustc \
  --output ./examples/stored-assets/rust.asset.ts
```

The CLI creates a small typed `defineAsset(...)` source file. Commit it with your
plugin. It contains the platform, entrypoint names/paths and SHA-256-based asset ID,
with no handler or credentials. New binary contents produce a new immutable ID;
change the reference in code when you want to update. Uploading identical contents
again resumes an incomplete upload or reuses the ready asset.

The equivalent Node SDK call is:

```ts
const rust = await putered.assets.upload('./rust-toolchain', {
  platform: 'linux-x64',
  entrypoints: { cargo: 'bin/cargo', rustc: 'bin/rustc' },
  signal: AbortSignal.timeout(180_000),
  onProgress: ({ completedBytes, totalBytes }) => console.log(completedBytes, totalBytes),
});
// rust.entrypoints.cargo is typed; unknown entrypoint names are rejected.
```

Define the tool in your codebase:

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
      output: z.object({ stdout: z.string(), stderr: z.string(), exitCode: z.number().int() }),
      handler: (_input, ctx) => ctx.exec(rust, 'cargo', ['run', '--offline'], {
        env: { RUSTFLAGS: '-C linker=/usr/bin/gcc' },
      }),
    }),
  },
});
```

Build it, import the resulting `.mjs`, then call it normally:

```ts
const saved = await putered.tools.use(cargo);
const environment = await putered.environments.create({ tools: [saved] });
const { output } = await environment.tools.call(saved, 'run', {});
// output.exitCode, output.stdout and output.stderr are inferred from your schema.
```

See [the runnable Cargo example](../examples/stored-assets/README.md). Its workspace
contains a small Rust program and its uploaded compiler compiles and runs it.

`ctx.exec(asset, entrypoint, args, { cwd, env, stdin })` executes an explicitly
declared asset inside the native sandbox. Entrypoint names autocomplete from the
local reference. Arguments are passed directly without a shell. `stdin` supports
strings or `Uint8Array`; results include `stdout`, `stderr`, `stdoutBase64` and
`exitCode`. Binary output should use `stdoutBase64`. The default cwd is `/workspace`,
and custom cwd must stay inside that workspace. Output is bounded to 4 MiB combined;
the tool's time budget includes provisioning and terminates guest descendants.

The server mounts each asset read-only at `/tools/<asset-id>` after verifying every
file. Entrypoint directories are added to PATH, allowing Cargo to find its uploaded
rustc. Home directories remain writable. A V8 plugin cannot declare native assets;
an `isolate-only` environment rejects native tools. There is no automatic backend
fallback or installation onto the credential-bearing server host.

Upload the full runtime layout your program needs, including its support files.
This release supports regular files/directories, ELF64 Linux x64/arm64 binaries and
shebang entrypoints. Symlinks, archive extraction and automatic dependency
installation are unsupported. Match the worker's architecture and libc/OS libraries.
A compiler may also require a linker, assembler, sysroot and offline dependencies.
The example explicitly uses the worker's `/usr/bin/gcc` linker; `/etc/alternatives`
is not mounted, so the host's `cc` alias may be unavailable. Custom images and
installation recipes remain future work. Rust's standard library, Cargo and rustc
can be uploaded together without depending on a preinstalled Rust toolchain.

## Dashboard-ready HTTP flow

All endpoints use `Authorization: Bearer <project-key>`. A browser-facing dashboard
can use its own authenticated backend to call these APIs; do not expose operator
keys or object-store credentials in browser code. Dashboard login, user membership,
short-lived credential issuance, CORS policy and UI are deliberately left for that
application. The server already supports separately scoped project keys.

| Operation | Endpoint | Result |
| --- | --- | --- |
| List | `GET /v1/assets` | Compact summaries: reference, state, totalBytes, optional error |
| Begin/resume | `POST /v1/assets/uploads` with `{ manifest }` | Upload state and per-file offsets |
| Check progress | `GET /v1/assets/:id/upload` | Manifest, state and acknowledged offsets |
| Send chunk | `PUT /v1/assets/:id/upload/:sha256/:offset` | Updated offsets; raw binary request body |
| Validate/publish | `POST /v1/assets/:id/upload/complete` with `{}` | Immutable ready reference |
| Get reference | `GET /v1/assets/:id` | Ready reference for local `defineAsset` |
| Cancel | `DELETE /v1/assets/:id/upload` | Deletes incomplete/failed upload parts and frees its manifest quota |

A manifest is `{ format: 1, platform, entrypoints, files }`. Each file has
`{ path, bytes, sha256, executable }`. Paths are relative, unique and traversal-free;
entrypoints must point to executable manifest files. The server computes the ID.
Upload chunks sequentially for each distinct file hash, from the server's offset,
in chunks of `chunkBytes` (4 MiB; the final chunk can be shorter). Re-sending an
identical acknowledged part is safe; conflicting data or offsets return a conflict.
After a lost response, request status or begin again before continuing. The SDK
implements this protocol; a browser can hash selected Files and stream Blob slices
through the same endpoints without needing a server-local filesystem path.

States are `uploading → validating → ready` or `failed`. Validation checks full
SHA-256 hashes, file sizes and executable architecture before returning ready.
Failed uploads can be retried with begin or cancelled. Ready assets cannot be
cancelled, so references in existing plugins remain valid. SDK equivalents are
`assets.list()`, `assets.status(id)`, `assets.get(id)` and `assets.cancel(id)`.
`tools.list()` exposes stored plugin manifests independently of assets.

Limits: 128 asset records / 8 GiB logical declared bytes per project, 1 GiB per asset,
512 MiB per file, 8,192 files, a 1 MiB manifest, and up to 16 declared assets per
plugin. Plugin packages retain their separate 128-record/64 MiB registry quota.
Cancel incomplete uploads explicitly; automatic expiry and reference-aware garbage
collection of unreferenced content-addressed blobs are future work.

## Storage and server configuration

Development defaults to atomic local-disk objects and JSON metadata under the data
directory. Disk metadata uses in-process locks and requires a single server writer.
Production registry deployments can use an S3-compatible private bucket (including
Cloudflare R2) for bytes and PostgreSQL for metadata/cross-process advisory locks.
Plugin bundles and asset bytes use the same adapters. Environment metadata can also
live in PostgreSQL; workspace files and writable homes remain on the worker's data
volume and must be routed to that worker. This is not distributed workspace storage.

```sh
# Server environment only; provision your bucket and database separately.
PUTERED_REGISTRY_DATABASE_URL=postgres://...
PUTERED_STORAGE_BUCKET=putered-private
PUTERED_STORAGE_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
PUTERED_STORAGE_REGION=auto
PUTERED_STORAGE_ACCESS_KEY_ID=...
PUTERED_STORAGE_SECRET_ACCESS_KEY=...
PUTERED_PROJECT_KEYS_FILE=/run/secrets/putered-project-keys.json
```

For other S3 services, set the endpoint/region appropriately and optionally
`PUTERED_STORAGE_FORCE_PATH_STYLE=1`. HTTPS proxy environment settings are respected.
Buckets stay private; clients never get provider keys or raw object addresses.
Only the server configuration module reads these variables. You can instead inject
`ArtifactStorage`/`RegistryMetadata` implementations into `createApi` for another
provider; `putered/server` exports both interfaces and supplied adapters.

The trusted project-keys file is an array such as:

```json
[{ "token": "<random-project-key-of-at-least-32-characters>", "projectId": "my-project", "scopes": ["read", "upload", "execute"] }]
```

Keys for the same project share its assets/tools/environments. Reads require `read`,
asset/plugin mutations require `upload`, and environment creation/execution requires
`execute`. Project keys cannot access legacy operator endpoints. IDs and blob hashes
are scoped to their owner, including duplicate uploads. Development does not require
a linked dashboard account: the configured API key determines access.

These grants are foundations for a later account/dashboard layer, not a complete
hostile multi-tenant sandbox. Apply your deployment's authentication, volume
routing, resource isolation and operational policies before exposing it publicly.
