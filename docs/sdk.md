# TypeScript SDK

Start with the [runnable examples](../examples/sdk/README.md). The
[HTTP API contract](api-contract.md) defines request bodies, response fields,
authentication, and errors for clients that call the server directly.

For normal work, create or reconnect to one environment and send a shell string:

```ts
const environment = await putered.environments.create();
console.log((await environment.exec('pwd')).output);
// Later: await putered.environments.connect(environment.id)
```

Files persist between requests. Git HTTPS, downloads and dependency installs work
by default. To opt out, put `{"network":{"mode":"disabled"}}` in
`putered.sdk.config.json` in your client’s working directory; see
[SDK config and limits](https://github.com/EwanJordaan/Putered/blob/main/docs/internet.md#sdk-config-opt-out). `environment.describe()`
returns the settings received at create/connect without another request. Use
`putered environments exec <id> -- 'command'` to print program output directly;
`--json` includes the structured result and optional network usage.

Delete an environment permanently with `await environment.delete()`. This removes
its saved workspace data and local environment state. Active executions must finish
first. Captured presets and shared tool assets are separate resources and remain.
Deletion requires local-disk mode or durable workspace storage; metadata-only
registry deployments cannot safely coordinate deletion across workers.

The separate `@putered/sdk` package exports `Putered` and provides
`definePlugin`/`defineTool` through `@putered/sdk/plugins`. Server implementations
live under `src/server` and are exported through `putered/server`. Packages are
not published to a public registry yet; see [package installation and stored binaries](assets.md).
Legacy `putered` / `putered/plugins` imports remain compatible.

OCI preset upload, listing, inspection and verified streaming download are exposed
through `putered.presets`; `environment.capturePreset({ name })` saves the entire
OCI environment by default. Set the environment’s `settings.saveScope: "workspace-only"` at creation to save only workspace
files and restore them into a fresh standard environment with less storage.
The creation-time choice is fixed; omitting it defaults to the entire environment.
The CLI provides matching `putered presets` commands.
See [preset SDK/CLI examples and scope compatibility](https://github.com/EwanJordaan/Putered/blob/main/docs/presets.md#sdk-and-cli).

Interactive shells use the same environment and workspace:

```ts
const terminal = await environment.terminals.start({ columns: 100, rows: 30 });
// Poll read() until state === 'running' before sending input.
const state = await terminal.read({ cursor: 0 });
process.stdout.write(state.outputBytes);
await terminal.write('pwd\n');
await terminal.resize(120, 40);
await terminal.stop(); // Ends compute and waits for the durable workspace save.
```

Keep the returned `cursor` for the next read. Reads maintain the connection;
one-hour sessions stop after five minutes without input or 45 seconds without
a reader. CPU/RAM are charged while allocated, including an idle shell. Full OS
configuration requires an OCI environment and an Entire environment snapshot.
`environment.terminals.connect(id)` reconnects to an existing owned session.

Personal account keys use resumable image operations automatically when calling
`presets.upload()` or `environment.capturePreset()`. Pass `onOperation(id)` to
retain the operation ID; `presets.operation(id)` inspects an uncertain result.
Transfers and captures are never blindly replayed after a dropped response.
OCI image users and full-snapshot ownership preservation work through these same
methods; see [non-root identity and host requirements](https://github.com/EwanJordaan/Putered/blob/main/docs/nonroot.md).

## Command output and long public API requests

`exec()` returns separate `stdout`, `stderr`, and `exitCode` fields. Empty stdout is
valid: Git progress and errors normally appear on stderr. A nonzero process exit
throws `CommandError` by default. Set `check: false` to inspect nonzero exits as results.
The `output` string property combines stdout followed by stderr.

Both streams are always returned together by the same execution API, for example:
`{ "stdout": "hello\n", "stderr": "warning\n", "exitCode": 0, "durationMs": 12 }`.
Synchronous responses contain this object directly; asynchronous polling carries
the same object in `result`, and the SDK unwraps it before returning. There are
no extra requests to retrieve either stream. The fields preserve which stream produced text;
they do not claim to preserve ordering between separate operating-system pipes.

```ts
const result = await environment.exec('git clone --depth 1 https://github.com/nestjs/nest.git', {
  timeoutMs: 60000,
  async: true,
});
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
```

For combined text with automatic failure handling:

```ts
import { CommandError } from '@putered/sdk';

try {
  const command = await environment.exec('npm run build', { async: true });
  console.log(command.output);
} catch (error) {
  if (!(error instanceof CommandError)) throw error; // API/network errors
  console.error(error.output, error.exitCode);
}
```

`output` is a string property, not a method. A nonzero exit rejects `exec()` with
`CommandError`. The error includes
`output`, `stdout`, `stderr`, `exitCode`, and the full `result`. Combined text is
stdout followed by stderr, with no added separator; it does not reconstruct
chronological ordering. Reading it never makes a request or runs a command.
For commands where a nonzero exit is expected (such as `grep` with no matches),
use `await environment.exec(command, { check: false })` and inspect `exitCode`.
The server response format is unchanged; `output` is added locally by the SDK.

For the public account API, `async: true` submits once and polls a saved result,
avoiding a long synchronous HTTP response while workspace changes are persisted.
It returns the same validated result. Ordinary direct servers may return their
normal result immediately. The default remains synchronous. Polling stops after
30 minutes or when `signal` aborts; stopping polling does not cancel the server
command. Collection errors include the execution ID so it can be inspected;
the SDK never replays execution after an error or unknown outcome.

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

Build tooling is isolated behind `putered/build`, which exports `buildPlugin`.
The runtime SDK (`@putered/sdk`), definitions (`@putered/sdk/plugins`) and artifact
helper (`@putered/sdk/packaging`) do not import esbuild or TypeScript. Those packages are optional
dependencies: install them on build machines; runtime installations can use
`npm install --omit=optional` when consuming prebuilt plugins or saved IDs.
The standalone SDK has no server, shell, Python, PostgreSQL or S3 dependencies.
The root development/server package still includes those server dependencies.

```ts
import { buildPlugin } from 'putered/build';
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
optional Git (off by default), execution mode, network access (enabled for new environments by default)
and timeouts. See [internet access](https://github.com/EwanJordaan/Putered/blob/main/docs/internet.md) for the worker capability and limits.
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
bindings is future work. `native-only` accepts native tools and runs complete
scripts in native Bash. Internet-enabled `auto` environments also use native Bash;
offline `auto` environments retain the virtual shell. An environment
can call only its attached tool IDs. Complete scripts otherwise use the existing
virtual shell and supported Node/Python backends; trusted host/HTTP command plugins
are not dispatched from these hosted environment scripts.

New environments default to public HTTP(S) through an isolated proxy. SDK config
can disable internet for all tools, including Git. Existing offline environments
stay offline; operators can disable internet worker-wide with `PUTERED_INTERNET=0`.
See [internet access](https://github.com/EwanJordaan/Putered/blob/main/docs/internet.md).
Stored tools and environment execution still reject a host configured with
shared networking; `PUTERED_NODE_NETWORK` must be
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
