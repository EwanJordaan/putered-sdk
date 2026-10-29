# Build with an uploaded Rust toolchain

This example uploads an unpacked Linux Rust toolchain as a stored asset, then
uses a typed native tool to compile and run a small Rust program inside a
Putered environment.

Build the repository first with `npm ci && npm run build`. Prepare a
regular-file-only toolchain for the worker's Linux architecture and libc, with
`bin/cargo`, `bin/rustc`, runtime files, and the Rust standard library. The
example links with `/usr/bin/gcc` and builds offline, so its Cargo project needs
no downloaded crates.

Set `PUTERED_API_KEY`, then upload the toolchain and build
the plugin from the repository root:

```sh
node packages/sdk/dist/client/cli.js assets upload /path/to/rust-toolchain \
  --platform linux-x64 --entrypoint cargo=bin/cargo --entrypoint rustc=bin/rustc \
  --output examples/stored-assets/rust.asset.ts
npm run build:plugin -- examples/stored-assets/cargo.ts examples/stored-assets/cargo.mjs
npx tsx examples/stored-assets/app.ts
```

The upload generates `rust.asset.ts`; keep it with the plugin source and rebuild
the plugin after changes. See [stored assets](../../docs/assets.md), the
[SDK guide](../../docs/sdk.md), and the [SDK and HTTP API contract](../../docs/api-contract.md)
for upload options and server requirements.
