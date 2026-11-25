# TypeScript SDK Guide

The `@putered/sdk` package connects Node.js applications to hosted Putered compute. Create a persistent environment, run shell commands or typed tools, stream output, and reconnect to the same workspace later.

- Looking for working code first? See the [runnable examples](../examples/sdk/README.md).
- Calling the HTTP endpoints directly? See the [HTTP API contract](api-contract.md).

## Getting started

Create an API key in the [Putered console](https://putered.com) and store it in your server's `PUTERED_API_KEY` environment variable.

```ts
import { Putered } from '@putered/sdk';

const putered = new Putered({
  apiKey: process.env.PUTERED_API_KEY!,
});

const env = await putered.environments.create({ name: 'my-agent' });
console.log((await env.exec('pwd')).output);

// Reconnect later using the environment ID:
const reopened = await putered.environments.connect(env.id);
```

## Environments

### Creating, naming, and reconnecting

Pass an optional `name` when creating an environment. Surrounding whitespace is trimmed, and the result must be **1–100 characters**.

- Read the name with `env.name` or `env.describe().name` (preserved across reconnects).
- Names are display labels, not unique identifiers — always reconnect using `env.id`.
- Existing environments cannot be renamed through the SDK.
- `env.describe()` returns a deeply frozen copy of the settings received at create/connect without making a network request.

### Persistence policies

Choose what survives `stop()` and `resume()` with the top-level `persistence` option at creation time. The policy is fixed once created; reconnect and resume preserve it.

```ts
const env = await putered.environments.create({
  persistence: 'workspace-and-dependencies',
});

await env.exec('printf saved > /workspace/note');
await env.stop();

const resumed = await env.resume();
console.log((await resumed.exec('cat /workspace/note')).output);
```

| Policy | Saved state |
| --- | --- |
| `'full'` *(default)* | All mutable state: `/workspace`, mutable home/Node/Python state, and private OCI filesystem. |
| `'workspace'` | Project files under `/workspace` only. |
| `'workspace-and-dependencies'` | `/workspace` plus standard Node and Python package locations. |
| `'none'` | No file checkpoints; mutable state is discarded on `stop()` or orderly shutdown. |
| `{ mode: 'custom', include, exclude }` | Explicit absolute guest subtrees (no `..`, globs, or symlink traversal). Exclusions win. |

```ts
const env = await putered.environments.create({
  persistence: {
    mode: 'custom',
    include: ['/workspace', '/home/putered/.config'],
    exclude: ['/workspace/node_modules', '/workspace/cache'],
  },
});
```

Important persistence rules:

- Read the active policy with `env.persistence`. The legacy `settings.saveScope` field is no longer accepted.
- Calling `exec()` or `run()` resumes a stopped environment automatically, so explicit `env.resume()` is optional.
- Finish or cancel active commands and close terminals before calling `env.stop()`; busy environments return `CONFLICT`.
- Persistence restores files, not running processes or RAM. Synthetic mounts (`/proc`, `/dev`, `/sys`, `/run`, `/tmp`, `/var/tmp`) are excluded.
- Automatic saves retain selected guest credentials unless excluded; portable preset exports apply separate credential exclusions.
- Standard OS/tool bundles remain server-managed; use an OCI template if you need a private writable Linux OS.

### Environment variables & outbound policies

Store environment variables (`env`) and outbound HTTP request policies (`networkPolicy`) on an environment at creation time, or replace them later with `env.update()`:

```ts
const env = await putered.environments.create({
  env: { NODE_ENV: 'production' },
  networkPolicy: { allow: ['api.github.com', '*.npmjs.org'] },
});

await env.update({
  env: { NODE_ENV: 'staging' },
});
```

Read them back via `env.env` and `env.networkPolicy`. Transformed outbound header values may be redacted to `"<redacted>"` on readback.

### Deleting an environment

```ts
await env.delete();
```

Deletion permanently removes the saved workspace and local environment state. Active executions must finish first. Captured presets and shared tool assets are independent resources and are not deleted.

## Running commands

### Shell commands with `exec()`

Use `env.exec(command, options)` for complete shell strings, pipelines, redirects, and chained commands:

```ts
const result = await env.exec(
  'mkdir -p output && echo "ready" > output/status.txt'
);
console.log(result.output);
```

### Direct programs with `run()`

Use `env.run(program, args, options)` when you want to pass a literal program and argument vector without shell quoting:

```ts
const status = await env.run('git', ['status', '--short']);
const shell = await env.run('sh', ['-c', 'git clone https://github.com/org/repo.git']);
```

`run()` accepts:

- `cwd` — Absolute path under `/workspace`.
- `env` — Key/value map of POSIX-style environment variables (up to 64 KiB).
- `stdin` — Static string or `Uint8Array` (up to 64 KiB), a Node `Readable` stream, or `true` (with `detached: true`) for interactive writes.
- `stdout` / `stderr` — Node `Writable` streams for live raw byte output.
- `detached` — Returns a `CommandHandle` immediately instead of waiting for completion.
- `sudo` — Requires `settings.execution.allowSudo: true` on the environment (unsupported on direct Wasm Git).

### Reading output & handling exit codes

Both `exec()` and `run()` return the same result object:

| Field | Type | Description |
| --- | --- | --- |
| `stdout` | `string` | UTF-8 text written to standard output (may be empty) |
| `stdoutBase64` | `string` | Raw stdout bytes in canonical base64 |
| `stderr` | `string` | Text written to standard error (Git progress normally appears here) |
| `output` | `string` | Local SDK convenience property equal to `stdout + stderr` (non-enumerable) |
| `exitCode` | `number` | Process exit status |
| `durationMs` | `number` | Recorded execution duration in milliseconds |
| `hostDurationMs` | `number` | Host-side request duration in milliseconds |

- **Nonzero exits throw `CommandError` by default.** The error exposes `output`, `stdout`, `stderr`, `exitCode`, and the full `result`.
- **Expected nonzero exits** (such as `grep` finding no matches): pass `{ check: false }` and inspect `result.exitCode`.
- `output` is a plain string property (not a method). It concatenates `stdout` then `stderr` with no separator and does not reconstruct pipe interleaving.

```ts
import { CommandError } from '@putered/sdk';

try {
  const result = await env.exec('npm run build', { async: true });
  console.log(result.output);
} catch (error) {
  if (!(error instanceof CommandError)) throw error;
  console.error(`Build failed (${error.exitCode}):`, error.output);
}
```

### Long-running commands (`async: true`)

Pass `{ async: true }` to submit a command once and poll for the saved result instead of holding a long synchronous HTTP request open:

```ts
const result = await env.exec('git clone --depth 1 https://github.com/nestjs/nest.git', {
  timeoutMs: 60_000,
  async: true,
});
```

Polling stops after 30 minutes or when `signal` aborts. Stopping ordinary async polling does not cancel the remote command. Collection errors include the execution ID so you can inspect it — the SDK never replays a command automatically.

### Streaming, detached handles, and binary logs

Pass `stdout`/`stderr` writable streams to receive live bytes while awaiting completion, or set `detached: true` to work with a `CommandHandle`:

```ts
import { Readable } from 'node:stream';

// Live streaming (waits for completion)
const result = await env.run('python', ['-u', '-c', 'import sys; print(sys.stdin.read())'], {
  cwd: '/workspace',
  env: { MODE: 'build' },
  stdin: Readable.from(['input data']),
  stdout: process.stdout,
});

// Detached command handle
const command = await env.run('sh', ['-c', 'long-running-command'], {
  detached: true,
});

for await (const chunk of command.logs()) {
  process.stdout.write(chunk.data);
}
await command.wait();
```

`CommandHandle` methods and properties:

- `id` and `outputCursor` — Reconnect later with `await env.getCommand(id, { cursor })`.
- `logs(options?)` — Async iterator of UTF-8 `{ stream, data }` chunks.
- `logsBytes(options?)` — Async iterator of raw `{ stream, data: Uint8Array }` chunks (no UTF-8 decoding).
- `writeStdin(data)` / `closeStdin()` — Send ordered input when started with `stdin: true`.
- `kill(signal?)` — Send a process signal (`SIGTERM`, `SIGKILL`, `SIGINT`, etc.).
- `wait(options?)` — Wait for completion and return the `ExecResult`.

Key streaming details:

- Running and saving commands hold the environment's execution lock; use separate environments for parallel workloads.
- Writable stream chunk boundaries are arbitrary; use a streaming decoder or concatenate buffers for multi-byte UTF-8.
- Retained log history is bounded. If older output was evicted, `logs()` / `logsBytes()` throw `CONFLICT`. Pass `{ acceptTruncation: true }` to explicitly resume from retained history. `wait()` still returns the final result even after log truncation.
- `signal` on `run()` aborts the submitted command best-effort; a `signal` on `wait()` or `logs()` only stops local collection.
- Direct Wasm Git only supports `kill('SIGKILL')` and rejects interactive `stdin` and `sudo`.

### Recovery IDs (direct server)

When targeting a direct server that supports caller-generated IDs, pass a lowercase UUID as `requestId`. It automatically selects async submission (conflicting with `async: false`):

```ts
import { randomUUID } from 'node:crypto';

const requestId = randomUUID();
try {
  await env.exec('perform-side-effect', { requestId });
} catch {
  // Inspect by the known ID instead of resubmitting blindly.
  const command = await env.getCommand(requestId);
  console.log(await command.wait());
}
```

Direct command sessions live in memory, expire after 5 minutes, and may be evicted earlier under load. A missing command does not prove execution never happened — inspect workspace state before deciding whether to run again.

## Execution backends & compute resources

### Execution preferences

New environments default to native execution. Configure a default backend and per-program overrides (`'native'`, `'v8'`, or `'auto'`) in `putered.config.json` or via `environments.create({ execution })`:

```json
{
  "execution": {
    "default": "native",
    "programs": { "git": "v8" }
  }
}
```

- Distinct from `settings.execution`, which sets the security policy (`'auto'`, `'isolate-only'`, or `'native-only'`).
- Per-program overrides apply only to direct `run()` calls, not child programs inside `exec()`.
- `git` is currently the only direct program with a V8 backend; unsupported selections fail before execution without silent fallback.
- Non-root OCI environments require native Git to preserve configured file ownership.
- Terminal sessions always use native execution.

### Per-call CPU, RAM, and queue limits

Set defaults in `putered.config.json` or `settings.resources`, and override either field per command:

```ts
await env.exec('make', {
  resources: { cpu: 1, memoryMiB: 1024 },
  queueTimeoutMs: 30_000,
  timeoutMs: 120_000,
});
```

- **Precedence:** per-call `resources` → saved environment `settings.resources` → `putered.config.json` → server defaults.
- **Increments:** CPU `0.25–8` in `0.25` steps; RAM `256–8192 MiB` in `256 MiB` steps.
- **Hosted limits:** Plus up to `2 vCPU / 2048 MiB`, Pro up to `8 vCPU / 8192 MiB`. Current hosted availability caps at **`1 vCPU / 1024 MiB`**; larger requests are rejected rather than queued indefinitely.
- **Scheduling:** CPU is shared fairly up to your ceiling (no guaranteed minimum). RAM is a hard ceiling — OOM kills report `memoryLimitExceeded: true`.
- **Queueing:** Work queues FIFO until RAM fits. `queueTimeoutMs` accepts `1–300000` ms (default `120000` ms) and is not billed. `timeoutMs` limits execution after allocation.

## SDK configuration (`putered.config.json`)

The SDK automatically loads `putered.config.json` from your client process's working directory (or pass a `config` object or file path to `new Putered({ apiKey, config })`).

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
  },
  "network": {
    "mode": "disabled"
  }
}
```

Validation runs before any network request: malformed JSON, oversized files, missing explicit paths, and unknown fields are rejected immediately. A configured offline `network` policy (`{ "mode": "disabled" }`) cannot be loosened by `environments.create()` or bypassed when reconnecting.

## Interactive terminals

Interactive shells run in the same environment and workspace:

```ts
const terminal = await env.terminals.start({ columns: 100, rows: 30 });

// Poll read() until state === 'running' before sending input.
const state = await terminal.read({ cursor: 0 });
process.stdout.write(state.outputBytes);

await terminal.write('pwd\n');
await terminal.resize(120, 40);
await terminal.stop(); // Ends compute and waits for the durable workspace save.
```

- Pass the returned `cursor` to subsequent `read()` calls; reads keep the session alive.
- Reconnect to an active session with `env.terminals.connect(id)`.
- Sessions stop automatically after **1 hour**, **5 minutes** without input, or **45 seconds** without a reader.
- CPU is billed for measured usage; RAM is billed for its allocated ceiling while the terminal exists, even when idle. Always call `stop()` when finished.

## OCI presets & snapshots

Capture a reusable OCI snapshot from an environment, or restore one as a template:

```ts
const snapshot = await env.capturePreset({
  name: 'my-workspace',
  onOperation: id => console.log('Operation ID:', id),
});

const restored = await putered.environments.create({
  template: snapshot.id,
  persistence: 'workspace',
});
```

- `capturePreset()` follows the environment's creation-time persistence scope (`workspace` saves `/workspace` into a lighter snapshot; `full` captures the entire OCI environment).
- Personal account keys use resumable operations automatically for `presets.upload()` and `env.capturePreset()`. Save the ID passed to `onOperation(id)` and inspect uncertain outcomes with `putered.presets.operation(id)` instead of blindly retrying.
- `putered.presets` also provides `list()`, `get(id)`, `upload()`, and verified streaming `download()`. Matching CLI commands live under `putered presets`.

## Typed tools & plugins

Define Zod-typed tools with `@putered/sdk/plugins` so handler parameters, return values, and SDK call sites are all type-checked end to end:

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
      handler: ({ text }) => ({
        words: text.trim() ? text.trim().split(/\s+/u).length : 0,
      }),
    }),
  },
});
```

### Build and publish a plugin

```sh
npx putered plugin build path/to/plugin.ts path/to/plugin.mjs
```

Or call `buildPlugin` programmatically from `@putered/sdk/build`:

```ts
import { buildPlugin } from '@putered/sdk/build';
await buildPlugin('./plugin.ts', './plugin.mjs');
```

- The build bundles source and dependencies into a self-contained `.mjs` artifact with an embedded manifest and portable `.d.mts` / `.types/` declarations.
- Runtime installs can use `npm install --omit=optional` when consuming prebuilt plugins (`esbuild` and `typescript` are optional dependencies only needed at build time).
- Schemas must be JSON-representable (finite JSON only — no `BigInt`, `Date`, `undefined`, or functions; regex flags are rejected; string lengths count Unicode code points).
- Module code evaluates fresh inside the sandbox; do not rely on client-only closures or host environment state.

### Attach and call a tool

```ts
import wordCount from './word-count.mjs';

const tool = await putered.tools.use(wordCount);
const env = await putered.environments.create({ tools: [tool] });

const result = await env.tools.call(tool, 'count', { text: 'hello world' });
const words: number = result.output.words;
```

- `tools.use()` content-addresses the bundle, manifest, and target. It uploads only if absent and returns a deeply frozen reference. Changing code produces a new ID.
- Reconnect to a saved tool ID without local files via `putered.tools.use('tool_<sha256>')` (returning `unknown` output), or restore inferred types by passing `{ definition: wordCount }`.
- Stored handlers run in sandboxed Node inside Bubblewrap — never in the credential-bearing host process. V8 plugins additionally enforce Node permissions and deny filesystem, subprocess, worker, and native-addon access. Native plugins can invoke declared [stored binary assets](assets.md) via `ctx.exec()`.

## Error handling & JSON limits

Match on `error.code` (a stable `ErrorCode` from `ERROR_CODES`) rather than message text:

```ts
import { PuteredError } from '@putered/sdk';

try {
  await env.tools.call(tool, 'count', { text: 'hello' });
} catch (error) {
  if (error instanceof PuteredError && error.code === 'TIMEOUT') {
    console.error('The tool exceeded its time budget.');
  } else {
    throw error;
  }
}
```

| Error codes | Meaning |
| --- | --- |
| `INVALID_INPUT`, `INVALID_OUTPUT` | Payload violates its schema or JSON contract |
| `PAYLOAD_TOO_LARGE`, `QUOTA_EXCEEDED` | Request, result, or registry limit exceeded |
| `NOT_FOUND`, `UNAUTHORIZED`, `POLICY_DENIED`, `CONFLICT` | Missing resource, auth/policy denial, or busy workspace |
| `TIMEOUT`, `CANCELLED`, `EXECUTION_FAILED` | Exceeded time budget, aborted, or failed during execution |
| `PACKAGE_INVALID`, `STORAGE_ERROR` | Invalid plugin artifact or storage failure |
| `PROTOCOL_ERROR`, `NETWORK_ERROR`, `INTERNAL_ERROR` | Malformed response, transport failure, or unexpected server error |

**JSON safety bounds:** depth ≤ 64, complexity ≤ 1,000,000 values, and encoded payload ≤ 8 MiB (with 4 MiB limits on tool invocations, results, and artifacts). Cycles, nonfinite numbers, sparse arrays, enumerable accessors, and unsafe object keys are rejected before network I/O. Transport failures never trigger automatic retries.

## CLI & SDK version header

The package ships a `putered` CLI binary (`putered environments exec <id> -- 'command'`, `putered presets ...`, `putered assets ...`). Pass `--json` to inspect structured results and network metrics.

SDK requests send `X-Putered-SDK-Version`. Hosted compute rejects reported SDK versions older than `0.2.0` with HTTP `426`.
