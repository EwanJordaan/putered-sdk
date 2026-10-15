# Compile a Rust program with your uploaded toolchain

This example is useful when a native tool is not preinstalled on the worker. Your
local source defines the Cargo tool; Putered stores its compiler bytes and reuses
them. No dashboard account or Putered-maintained Rust plugin is required.

1. Build the SDK with `npm ci && npm run build` and start or connect to a
   [Putered server](https://github.com/EwanJordaan/Putered) with your API key/base URL.
2. Prepare a regular-file-only, unpacked Linux Rust toolchain with Cargo, rustc,
   libexec/runtime files and the Rust standard library. Its layout must contain
   `bin/cargo` and `bin/rustc`; match your worker's architecture/libc. This example
   uses the worker's `/usr/bin/gcc` linker and needs no external crate downloads.
3. Set `PUTERED_API_KEY` and `PUTERED_BASE_URL`, then from the repository root:

```sh
node dist/client/cli.js assets upload /path/to/rust-toolchain \
  --platform linux-x64 --entrypoint cargo=bin/cargo --entrypoint rustc=bin/rustc \
  --output examples/stored-assets/rust.asset.ts
npm run build:plugin -- examples/stored-assets/cargo.ts examples/stored-assets/cargo.mjs
npx tsx examples/stored-assets/app.ts
```

Commit `rust.asset.ts` and `cargo.ts` in your application. Rebuild after changing
source or references. Repeated application runs use `tools.use(cargo)` to reuse
its immutable deployment with inferred input/output types. A future dashboard
upload will return the same `defineAsset` fields, so the plugin code stays the same.

See [stored assets](../../docs/assets.md) for storage configuration, resumable
uploads, native dependencies, dashboard endpoints and the SDK/server boundary.
