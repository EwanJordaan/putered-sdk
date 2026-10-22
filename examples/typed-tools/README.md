# Reusable typed tool

This example defines a word-count tool, builds it as an ESM plugin, uploads it
privately on first use, and calls it from a persistent environment. The tool's
input and output types come from its Zod schemas.

From the repository root, build the SDK and plugin:

```sh
npm ci
npm run build
npm run build:plugin -- examples/typed-tools/word-count.ts examples/typed-tools/word-count.mjs
```

Set `PUTERED_BASE_URL` and `PUTERED_API_KEY` for a running Putered server, then
run the example:

```sh
node --import tsx examples/typed-tools/app.ts
```

The app prints the word count, tool ID, and environment ID. Reconnect to the
saved files later with `environments.connect(id)`. The generated plugin files
are build output; rebuild after changing `word-count.ts`.

See the [SDK guide](../../docs/sdk.md), [SDK and HTTP API contract](../../docs/api-contract.md),
and [stored assets example](../stored-assets/README.md).
