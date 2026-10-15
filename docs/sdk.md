# Typed SDK tools and automatic reuse

The separate `@putered/sdk` package exports `Putered` and provides
`definePlugin`/`defineTool` through `@putered/sdk/plugins`. The server is maintained separately in
[EwanJordaan/Putered](https://github.com/EwanJordaan/Putered). The npm package is
not published yet; see [installation](../README.md#install-from-this-repository).

## Define and build a plugin

```ts
import { definePlugin, defineTool } from '@putered/sdk/plugins';
import { z } from 'zod';

export default definePlugin({
  name: 'word-count',
  execution: { backend: 'v8' },
  tools: {
    count: defineTool({
      input: z.object({ text: z.string() }),
      output: z.object({ words: z.number().int() }),
      handler: ({ text }) => ({ words: text.trim() ? text.trim().split(/\s+/u).length : 0 }),
    }),
  },
});
```

The plugin-level backend defaults to `v8`; `version` is an optional label. The
tool schemas infer handler parameters/results and SDK input/output types. Schemas
must be JSON-representable. Async JSON Schema validators are rejected; Zod parsing
and handlers themselves can be asynchronous. Format constraints are validated.
Hosted data must be finite JSON, not BigInt, Date, undefined or function values.
String length and flag-free custom regex constraints preserve Zod's JS semantics.
Regex flags are currently
rejected at definition time, and unsupported JSON Schema formats fail explicitly.

Build after changing source or dependencies:

```sh
npm run build
npm run build:plugin -- path/to/plugin.ts path/to/plugin.mjs
```

This bundles actual module source and dependencies into a self-contained ESM
artifact, embeds its manifest, and emits portable declarations. Import the generated
`.mjs` in the application. Distribute the `.mjs`, `.d.mts` and adjacent `.types/`
directory together for consumers that need inferred types; the original source is
not required. Consumers still install referenced type dependencies such as Putered
and Zod. Deployed runtime code needs only the bundle and Putered's packaging helper.
The build evaluates the local source as ordinary trusted application code to
obtain its definition. It is not an isolated remote build service. Do not capture
client-only state in module initialization; the stored source evaluates afresh
inside the sandbox. Live application closures/environment values are not serialized.
Native CommonJS dependencies can require Node builtins; external dependencies are
otherwise bundled. Native addons and system libraries are not provisioned by this
build helper. V8 packages reject external builtin imports. Their handler APIs are
restricted further at execution time.

Build tooling is isolated behind `@putered/sdk/build`, which exports `buildPlugin`.
The runtime SDK (`@putered/sdk`), definitions (`@putered/sdk/plugins`) and artifact
helper (`@putered/sdk/packaging`) do not import esbuild or TypeScript. Those packages are optional
dependencies: install them on build machines; runtime installations can use
`npm install --omit=optional` when consuming prebuilt plugins or saved IDs.
The standalone SDK has no server, shell, Python, PostgreSQL or S3 dependencies.
The server has its own dependencies in its separate repository.

```ts
import { buildPlugin } from '@putered/sdk/build';
await buildPlugin('./plugin.ts', './plugin.mjs');
```

## Use a tool

```ts
const tool = await putered.tools.use(wordCount);
const environment = await putered.environments.create({ tools: [tool] });
const result = await environment.tools.call(tool, 'count', { text: 'hello world' });
const words: number = result.output.words;
```

No repeated name/version/source directory and no reuse flag are needed. `use()`
hashes the bundled code, dependency contents, manifest and runtime target. It
checks for that immutable ID, uploads only if absent, and returns a ready private
reference. Repeating a call or racing submissions reuses the same complete record.
Changed content produces a different ID; a version label never overwrites an old
artifact. Returned manifests are deeply readonly and frozen.

Use a saved ID without any local plugin files:

```ts
const saved = await putered.tools.use('tool_<64-character-sha256>');
const reopened = await putered.environments.connect(environmentId);
const result = await reopened.tools.call(saved, 'count', { text: 'hello' });
// result.output is unknown: a string reference cannot invent a TypeScript type.
```

To restore inferred types, bind a local definition and verify its manifest:

```ts
const typed = await putered.tools.use(savedId, { definition: wordCount });
```

This checks name/version/backend and schemas, not equality of handler code. The
saved ID pins the executable contents; the definition binds a compatible type
contract. Inputs and outputs are additionally validated by the SDK, server and
plugin runner. Unknown tool names, malformed inputs, missing fields and invalid
results are rejected. Type inference keeps each tool's own input/result shape;
tool names or inputs cannot broaden the inferred plugin map.

## Errors and JSON limits

`PuteredError`, `ErrorCode` and the readonly `ERROR_CODES` list are exported from
`putered`. Errors expose a stable `code`, HTTP `status` and optional local `cause`.
Use the code to distinguish bad input, execution failures, cancellation and policy
decisions rather than matching message text:

```ts
import { PuteredError } from '@putered/sdk';
try {
  await environment.tools.call(tool, 'count', { text: 'hello' });
} catch (error) {
  if (error instanceof PuteredError && error.code === 'TIMEOUT') {
    console.error('The tool exceeded its time budget.');
  } else {
    throw error;
  }
}
```

| Codes | Meaning |
| --- | --- |
| `INVALID_INPUT`, `INVALID_OUTPUT` | Data violates its schema or JSON contract |
| `PAYLOAD_TOO_LARGE`, `QUOTA_EXCEEDED` | Request, result or registry limit exceeded |
| `NOT_FOUND`, `UNAUTHORIZED`, `POLICY_DENIED`, `CONFLICT` | Missing resource, access restriction or busy workspace |
| `TIMEOUT`, `CANCELLED`, `EXECUTION_FAILED` | Execution exceeded its budget, was aborted or failed |
| `PACKAGE_INVALID`, `STORAGE_ERROR` | Invalid package or unavailable/corrupt storage |
| `PROTOCOL_ERROR`, `NETWORK_ERROR`, `INTERNAL_ERROR` | Invalid response, transport failure or unexpected server failure |

JSON validation bounds depth at 64, complexity at one million values and encoded
payloads at 8 MiB by default. The existing 4 MiB invocation/result and artifact
limits still apply. Cycles, nonfinite numbers, sparse arrays, enumerable accessors
and unsafe object keys are rejected. Validation clones values before serialization
so hidden `toJSON` hooks cannot alter validated data. Oversized input is rejected
before network I/O; malformed responses and invalid output have separate codes.
Execution is never automatically retried after a transport failure, since the
remote call may already have run.

## Storage, environments and execution

The server stores content-addressed packages beneath `<data>/.tools/` and
environment records beneath `<data>/.environments/`. Workspaces remain under
`<data>/<environment-id>/files/`. Tool packages and environment/file state survive
restart and do not require the user's own storage hosting. Back up the server's
data directory. This increment uses local persistent disk rather than an external
object-storage provider or an account-specific cloud bucket.

The existing bearer token grants operator access to all records; private visibility
means access behind that token, not a new multi-user ACL system. Only `private` is
currently accepted. The registry holds up to 128 artifacts/64 MiB, with at most
4 MiB per artifact and 2 MiB of bundled code. IDs and content are checksum-checked
when read. Default disk publication exposes only complete files through atomic operations.
Configured object storage holds plugin bytes while PostgreSQL supplies metadata and
cross-process registry locks; see [storage configuration](assets.md#storage-and-server-configuration).

The SDK implements `environments.create`, `environments.connect`, `environment.exec`
and `environment.tools.call`. `general` is the supported template. Settings include
optional Git (off by default), execution mode, disabled networking and timeouts.
There is no idle VM to suspend: tool processes end after each call, while shared
runtime caches may remain warm. Files persist. Calls currently wait for completion;
`wait: false` is rejected instead of returning a fake streaming handle. Client
disconnect/abort cancels these synchronous calls, matching the existing API.

Stored handlers run in real Node inside Bubblewrap, never in the host process
containing server credentials. Both backend selections require a working Linux
sandbox and Node 22.13+. V8 handlers additionally enable Node permissions and deny
filesystem, subprocess, worker and native-addon grants. Native handlers can use
normal Node APIs and available executables within the sandbox. Package context
supplies `workspaceId`, an AbortSignal and typed `ctx.exec` for declared native
[binary assets](assets.md); cancellation terminates the
process rather than delivering live IPC abort events to the handler.

`auto` accepts the plugin's declared backend. `isolate-only` rejects native tools
and all native/legacy-plugin dispatch from shell requests, including nested dynamic
commands. Virtual file/text builtins and Wasm Git remain available. Python shell
dispatch is also denied in this first strict mode; integrating approved Pyodide
bindings is future work. `native-only` accepts native tools but rejects complete
Bash execution because a native Bash route is not implemented. An environment
can call only its attached tool IDs. Complete scripts otherwise use the existing
virtual shell and supported Node/Python backends; trusted host/HTTP command plugins
are not dispatched from these hosted environment scripts.

Guest networking is disabled. Stored tools and environment execution explicitly
reject a host configured with shared networking; `PUTERED_NODE_NETWORK` must be
unset or `0`. Backend selection happens before invoking a handler, and failures
are never retried on another backend. Tool console logs go to stderr so they do
not corrupt the JSON result. Direct writes to protocol stdout are unsupported.
Timeouts/cancellation terminate native descendants before releasing workspace locks.
These controls do not turn the current sandbox into a hardened hostile multi-tenant
service: per-job cgroups, comprehensive filesystem policies and account grants are
still required for that deployment model.

## Future work

Uploaded binary/toolchain assets, S3-compatible storage, PostgreSQL metadata and
project-scoped keys are implemented; see [stored assets](assets.md). Generic isolated
installation/build recipes, custom images, account/team management, tool export/deletion,
streaming/reconnection, shell adapters for typed tools and per-call backend overrides
remain planned. The later GitHub source adapter will import authorized private
repositories at pinned commits and store private artifacts with provenance; no
GitHub connection is required or configured by `tools.use()` today.

See [the full runnable example](../examples/typed-tools/README.md). `npm run test:types`
checks valid calls and compile-time rejection of wrong names/inputs/results. The
SDK tests cover real sandbox invocation, durable reuse without source files,
checksums, auth, schema validation, native file visibility and cancellation. Set
`PUTERED_TEST_NATIVE=1` to require those sandbox tests; CI does so explicitly.
