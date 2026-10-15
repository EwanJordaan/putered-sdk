# A reusable custom tool

The app uploads a word-count plugin privately on first use, reuses its immutable
content-addressed reference on later uses, invokes it with inferred TypeScript
input/output types, then writes a report in a plain workspace without Git.

Build the SDK and plugin once after changing its source:

```sh
npm run build
npm run build:plugin -- examples/typed-tools/word-count.ts examples/typed-tools/word-count.mjs
```

Start [the Putered server](https://github.com/EwanJordaan/Putered) with `PUTERED_API_TOKEN` (at least 32 characters) and
`PUTERED_DATA_DIR`. On a Linux host with Node 22+ and working Bubblewrap 0.9+,
run the app against that server:

```sh
PUTERED_API_KEY="$PUTERED_API_TOKEN" PUTERED_BASE_URL=http://127.0.0.1:3000 \
  node --import tsx examples/typed-tools/app.ts
```

The app prints `Word count: 7`, the saved tool ID and the environment ID. Files
persist after execution. Use `putered.environments.connect(id)` to reopen it.
String IDs work with `tools.use(id)` without local source; their outputs are
`unknown` until bound to a matching definition with `tools.use(id, { definition })`.

The generated `.d.mts` and adjacent `.types/` directory retain the plugin's types
without its original source. Distribute both alongside the bundled `.mjs` when
consumers need type checking. Runtime SDK imports do not load esbuild or TypeScript;
build machines use `@putered/sdk/build` with those optional dependencies installed.
Generated files are not committed. See [the SDK guide](../../docs/sdk.md) for stable
error codes and JSON limits.

This example uses the separate `@putered/sdk` client package. The server defaults
to its persistent data directory and operator bearer token; S3-compatible artifact
storage, PostgreSQL metadata and scoped project keys are also supported. See
[stored assets](../../docs/assets.md) for configuration. Account/team management,
install recipes, private GitHub imports, live output and arbitrary environment
templates remain future work. V8 handlers have no
filesystem/process/addon grants; native handlers run real Node in Bubblewrap.
Neither mode is a claim of hardened hostile multi-tenant execution.
