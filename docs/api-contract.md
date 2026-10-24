# Public API contract (current implementation)

This documents the HTTP JSON contract implemented today. It covers the account-backed API at
`https://putered.com/api/compute/v1` (the SDK base URL is `https://putered.com/api/compute`, because
it appends `/v1`; the public key gateway also exposes `https://api.putered.com/v1`) and the direct
server API at `<server>/v1`. It is not a promise that the two surfaces have identical routes or
behavior. JSON objects shown below omit optional fields unless noted. Requests use `Content-Type:
application/json` except binary upload parts and OCI archives.

## Authentication and base URLs

| Caller | Base URL | Credential | Boundary |
| --- | --- | --- | --- |
| Website/API account key | `https://putered.com/api/compute/v1` or `https://api.putered.com/v1` | `Authorization: Bearer pk_live_<64 lowercase hex>` | Personal account ownership, email verification, per-account quota, and key execute permission. The website Worker and public gateway translate the path to account compute. |
| Direct server / scoped SDK | `<server>/v1` | `Authorization: Bearer <token>` | Operator token has access to all local records. Configured project keys are restricted to their project and scopes. |
| Browser dashboard | `https://putered.com/api/...` | Same-origin authenticated session cookie | Browser/session routes. Session-authenticated mutations require the configured same-origin `Origin`; cross-site fetches are rejected. Do not use these as SDK bearer-key routes. |

The website key is checked by the account service, then proxied to the backend with a server-held
project-scoped key and internal gateway token. The public `api.putered.com` gateway routes personal
keys into that same account API. Never send either backend credential from a client. The
`pk_live_...` key is not a direct-server project key. Direct server tokens must be at least 32
characters. Project keys are configured server-side with a project ID and one or more `read`,
`upload`, `execute` scopes. Reads require `read`; asset/tool/preset uploads require `upload`;
command, tool-call, terminal and other execution mutations require `execute`. Capturing a preset
requires both `upload` and `read`. Project keys cannot access operator-only routes such as plugins,
admin status, runtime stats, and legacy workspace processes. A website key with `canExecute: false`
can read but receives 403 on mutations.

Example:

```sh
curl https://putered.com/api/compute/v1/environments \
  -H 'Authorization: Bearer pk_live_…'

curl http://127.0.0.1:3000/v1/environments/env_… \
  -H 'Authorization: Bearer <server-token>'
```

## Environment and command API

| Method and path | Request | Success |
| --- | --- | --- |
| `POST /environments` | Website: `{ "name"?: string, "template"?: "general" \| "preset_<sha256>", "settings"?: EnvironmentSettings }`. Direct server: `{ "template"?: "general" \| "preset_<sha256>", "tools"?: [toolId], "settings"?: EnvironmentSettings }`. | `201 Environment`; website includes `name`, direct does not. |
| `GET /environments` | No body. Website only. | `200 [ { id, name, created_at } ]` (account records, newest first). Direct core has no collection route. |
| `GET /environments/{id}` | No body. | `200 Environment`; website includes `name`. |
| `DELETE /environments/{id}` | No body. Website and direct. | `200 { "id": "…", "deleted": true }`. |
| `POST /environments/{id}/exec` | `{ "command": string, "timeoutMs"?: 1..300000 }`. Website rejects blank or >64 KiB commands and extra fields (including SDK `wait`). Direct core also accepts optional `metered` when configured and `wait: true` as a call option; it still responds synchronously. | `200 ExecutionResult` (sync). On website, `?async=1` may return a ticket; see below. |
| `POST /environments/{id}/run` | `{ "program": string, "args"?: string[], "timeoutMs"?: 1..300000, "wait"?: true }`. Program matches `^[a-z][a-z0-9_-]{0,63}$`; args default to `[]`, contain no NUL, are limited to 4096 entries and 64 KiB encoded JSON total. Extra fields are rejected. | `200 ExecutionResult` (sync). On website, `?async=1` may return a ticket; see below. |
| `POST /environments/{id}/tools/call` | Direct server only: `{ "id": toolId, "tool": string, "input": any, "timeoutMs"?: 1..300000, "wait"?: true }`. | `200 { "output": any }`. |
| `POST /environments/{id}/preset` | Direct server only: `{ "name": string, "mode"?: "complete" \| "state", "workspace"?: [relativePath], "home"?: [relativePath] }`. | `201 Preset`. |
| `GET /environments/{id}/terminals` | Website only. | `200 [{ id, state, created_at }]` (up to 20). |
| `POST /environments/{id}/terminals` | Website: `{ "id": UUID, "columns"?: 20..300, "rows"?: 5..120 }`. Direct server also supports this path with `{ "id": UUID, "environmentId": id, "columns"?: 20..300, "rows"?: 5..120 }`. | `202 TerminalSession`. |

`EnvironmentSettings` accepts only these fields: `saveScope?: "entire-environment" |
"workspace-only"`, `git?: boolean`, `execution?: { mode: "auto" | "isolate-only" | "native-only" }`,
`network?: { mode: "disabled" } | { mode: "internet", maxBytesPerExecution?: 1..1073741824, allow?:
[rule], deny?: [rule], vm?: {allow?,deny?}, v8?: {allow?,deny?} }`. Rules are hostnames,
`*.hostname`, IPs, CIDRs, or HTTP(S) origins without paths/ports; each list is limited to 128 rules.
`timeoutMs?: 1..300000`. Omitted settings use the server defaults. The website API defaults a newly
created environment to `network: { mode: "disabled" }`; direct core defaults come from the server.
Website create additionally accepts a 1–100 character `name` and defaults it to `My environment`.

Environment wire example:

```json
{
  "id": "env_demo",
  "tools": [],
  "settings": { "network": { "mode": "disabled" } },
  "name": "Demo"
}
```

Execution response is the server's actual result object; `output` is **not** a JSON field:

Successful JSON responses contain the resource or result directly; there is no
shared `{success,data}` wrapper. Failed HTTP responses use the error object
documented below. A completed program with a nonzero exit code is an execution
result, not necessarily an HTTP failure.

```json
{
  "stdout": "hello\n",
  "stdoutBase64": "aGVsbG8K",
  "stderr": "warning\n",
  "exitCode": 0,
  "durationMs": 12,
  "hostDurationMs": 14,
  "gitMetrics": [],
  "networkUsage": { "sentBytes": 0, "receivedBytes": 0, "connections": 0, "limitBytes": 0 }
}
```

| Execution field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `stdout` | string | Yes | UTF-8 decoding of collected stdout. Can be empty. |
| `stdoutBase64` | string | Yes | Original stdout bytes in canonical base64. |
| `stderr` | string | Yes | Collected stderr. Can be empty. |
| `exitCode` | integer | Yes | Program exit status; zero conventionally indicates success. |
| `durationMs` | nonnegative number | Yes | Recorded execution duration in milliseconds. |
| `hostDurationMs` | nonnegative number | Yes | Host-side request execution duration in milliseconds. |
| `allocationUsage` | object | No | Enforced CPU/RAM allocation measurements used for billing. |
| `networkUsage` | object | No | Network byte and connection measurements. |
| `gitMetrics` | array | No | Git execution measurements. |
| `pythonMetrics` | object | No | Python backend and execution measurements. |

In the SDK, `exec()` adds the string property `result.output` and throws
`CommandError` for a nonzero exit unless `check: false` is set. `output` joins
stdout followed by stderr; it is non-enumerable and is omitted by
`JSON.stringify(result)`. It does not preserve interleaving between streams.
`environment.run(program, args, options)` uses this same result and error contract.
Its argument vector is forwarded as individual strings; it is never shell-quoted
or parsed by the SDK. Direct Git runs use offline Wasm Git. Explicit `sh`/`bash`
commands use the native VM route and the environment's stored network policy;
choosing a program does not grant network authority. `native-only` rejects direct
Wasm Git, and `isolate-only` rejects every non-Git direct program.
Other direct programs use the native sandbox. OCI images configured with a
non-root UID or GID must use explicit shell Git so the image's ownership is
preserved; direct Wasm Git rejects that case before executing.

The SDK's `run()` accepts optional `cwd`, `env`, `stdinBase64`, `stdinOpen` and
`sudo` fields. The program/argument vector is bounded to 64 KiB, environment data
to 64 KiB, static stdin to 64 KiB, and the complete JSON request to 256 KiB.
`cwd` is an absolute path equal to `/workspace` or below it, without NUL or `..`.
Environment keys must be valid shell-style identifiers. Static stdin is canonical base64; streaming clients set `stdinOpen`
and then send chunks to the accepted command's input route. Sudo requires
`settings.execution.allowSudo: true` on the environment. Direct Wasm Git does not
support sudo or interactive stdin.

Minimal account command request (replace the environment ID and key):

```sh
curl 'https://putered.com/api/compute/v1/environments/env_demo/exec' \
  -H "Authorization: Bearer $PUTERED_API_KEY" \
  -H 'Content-Type: application/json' \
  --data '{"command":"printf hello","timeoutMs":30000}'
```

Optional result fields have these shapes: `allocationUsage: { enforced: true, durationMs: integer,
cpuQuotaMicros: positive integer, memoryBytes: positive integer }`; `networkUsage: { sentBytes,
receivedBytes, connections, limitBytes }` (all nonnegative integers); `gitMetrics: [{ durationMs,
wasmMemoryBytes, helperCount }]`; `pythonMetrics: { backend: "wasm" | "native", warm: boolean,
sessionId?, initMs, executionMs, rssBytes, cpuMicros?, wasmMemoryBytes? }`. Metrics may be absent
when not applicable. `stdoutBase64` is canonical base64 for stdout bytes; `stdout` is its UTF-8
decoding. `stderr` is separate. The SDK adds a local `result.output` convenience string equal to
`stdout + stderr` (no separator); HTTP clients must combine the two themselves. Separate streams do
not preserve chronological interleaving. A nonzero `exitCode` is still a successful HTTP execution
response.

### Async execution and durability

For the website endpoints, `POST /environments/{id}/exec?async=1` and
`POST /environments/{id}/run?async=1` submit once and return `202 {
"jobId": "<uuid>", "state": "running" }`. Poll `GET /execution-jobs/{jobId}`. The gateway-backed job
response is `{ id, environmentId, state, httpStatus?, result?, error? }`, with state `running`,
`completed`, `failed`, or `unknown`. `completed` contains `result: ExecutionResult`; `failed`
contains `result: { error, code? }` and `httpStatus`. Website `async=1` works even when the client
requests a long task, and metered website runs also use this job path.

Gateway tickets omit `commandPath`; poll `GET /execution-jobs/{jobId}`. Direct
core tickets include `commandPath: "/environments/{id}/commands/{jobId}"` and
use the command routes below. Completed jobs contain `result: ExecutionResult`;
failed jobs contain an error and HTTP status. `unknown` means the server cannot
prove whether an interrupted command completed. Never replay a command after a
timeout, disconnect, ambiguous submission or unknown outcome.

Interactive and detached SDK runs use the command route, which carries bounded
incremental output and ordered stdin writes:

| Method and path | Request | Success |
| --- | --- | --- |
| `GET /environments/{id}/commands/{uuid}?cursor=N` | No body | Snapshot `{ id, environmentId, state, createdAt, cursor, output: [{stream, data}], reset?, httpStatus?, result?, error? }`; output `data` is canonical base64, `reset: true` signals lost history |
| `POST /environments/{id}/commands/{uuid}/input` | `{ sequence, input?: base64, close?: true }` | `{ nextSequence }`; omit `input` to close stdin |
| `POST /environments/{id}/commands/{uuid}/signal` | `{ signal: "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGHUP" | "SIGQUIT" | "SIGSTOP" | "SIGCONT" }` | `{ accepted: true }` |

Each stdin chunk is at most 32 KiB and sequences begin at zero. The SDK never
replays a command when collecting output or reconnecting to a command ID.

### Terminal sessions (website-backed route)

| Method and path | Request | Success |
| --- | --- | --- |
| `POST /environments/{id}/terminals` | Website: `{ "id": UUID, "columns"?: 20..300, "rows"?: 5..120 }`; direct server also accepts explicit `environmentId` | `202 TerminalSession` |
| `GET /environments/{id}/terminals` | No body | `200 [{id,state,created_at}]` |
| `GET /terminals/{uuid}?cursor=N` | No body | `200 TerminalSession` with up to 64 KiB base64 `output`, `cursor`, and `reset` |
| `POST /terminals/{uuid}/input` | `{ "sequence": integer, "input"?: base64, "columns"?: 20..300, "rows"?: 5..120 }` | `200 { "nextSequence": integer }` |
| `DELETE /terminals/{uuid}` | No body | `200 TerminalSession` after stop |

Direct core also accepts `POST /terminals` with `{id,environmentId,columns?,rows?}`. A session
record includes `id`, `environmentId`, `state`, `createdAt`, `expiresAt`, and `nextSequence`; it can
include `exitCode`, `error`, `allocationUsage`, and `containmentUncertain`. States are `starting`,
`running`, `stopping`, `saving`, `closed`, `failed`, `unknown`. Output is base64 in the HTTP
`output` field. Cursors are byte offsets; `reset: true` means older output was discarded. Inputs are
sequenced: resend the same sequence only to receive its current acknowledgement; out-of-order input
conflicts. Terminals require an isolated native environment and server-enforced resource limits.
Sessions stop after one hour, five minutes without input, or 45 seconds without a reader. Website
routes are account-owned; direct core also has `/v1/terminals` and `POST
/v1/environments/{id}/terminals` for configured operator/project-key deployments.

## Assets, tools and OCI presets (direct API)

These registry routes exist on the direct server under `/v1`; account website keys support
environment execution, terminal, and preset operations, not the full binary asset/tool registry. The
website's `/api/presets...` routes are a separate account-owned OCI catalog described below.

| Method and path | Request | Success |
| --- | --- | --- |
| `GET /assets` | — | `200 [AssetSummary]` |
| `GET /assets/{assetId}` | — | `200 AssetReference` |
| `POST /assets/uploads` | `{ "manifest": AssetManifest }` | `200 AssetUpload` |
| `PUT /assets/{assetId}/upload/{sha256}/{offset}` | Raw chunk bytes, max 4 MiB | `200 AssetUpload` |
| `GET /assets/{assetId}/upload` | — | `200 AssetUpload` |
| `POST /assets/{assetId}/upload/complete` | `{}` | `200 AssetReference` |
| `DELETE /assets/{assetId}/upload` | — | `200 { "cancelled": true }` |
| `GET /tools` | — | `200 [StoredTool]` |
| `GET /tools/{toolId}` | — | `200 StoredTool` |
| `POST /tools/use` | `{ "artifact": ToolArtifact }` | `200 StoredTool` |
| `GET /presets` | — | `200 [Preset]` |
| `GET /presets/{presetId}` | — | `200 Preset` |
| `DELETE /presets/{presetId}` | Account API only; no body | `200 {"id":"preset_<sha256>","deleted":true}` |
| `GET /presets/{presetId}/archive` | — | Binary OCI tar (`application/vnd.oci.image.layout.v1+tar`) |
| `POST /presets?name={name}` | OCI tar body, `Content-Type: application/vnd.oci.image.layout.v1+tar`, max 1 GiB | `201 Preset` |
| `POST /preset-operations` | Capture: `{id:UUID,name,kind:"capture",environmentId}`; upload: `{id:UUID,name,kind:"upload",bytes:1024..1073741824}` | `202 PresetOperation` |
| `GET /preset-operations/{uuid}` | — | `200 PresetOperation` |
| `PUT /preset-operations/{uuid}/parts/{index}` | Ordered raw part, max 8 MiB; exact expected size | `200 {index,bytes,sha256}` |
| `POST /preset-operations/{uuid}/complete` | `{}` | `202 PresetOperation` |
| `DELETE /preset-operations/{uuid}` | Upload can be cancelled only while `uploading` | `200 PresetOperation` |

An `AssetManifest` is `{format:1, platform:"linux-x64"|"linux-arm64",
entrypoints:{name:relativePath}, files:[{path,bytes,sha256,executable}]}`. Each path is relative and
traversal-free; each entrypoint must name an executable file. An `AssetReference` is
`{id:"asset_<sha256>",platform,entrypoints}`. Upload states are `uploading`, `validating`, `ready`,
`failed`; `AssetUpload` includes `manifest`, per-file digest `offsets`, `chunkBytes:4194304`, and
optional `error`.

A `Preset` includes `id`, `name`, `format:"oci"`, `state:"ready"`, `visibility:"private"`,
`platform:{os:"linux",architecture:"amd64"|"arm64"}`, `manifestDigest`, `archiveSha256`, `bytes`,
`source:"upload"|"capture"`, and optional `environmentId`, `runtime`, `compression`, `captureScope`,
and `defaults`. Snapshot operation records include `id`, `name`, `kind`, optional
`environmentId`/`bytes`, `state`, `createdAt`, `parts`, optional `completedAt`, `result`, `error`.
States are `uploading`, `running`, `ready`, `failed`, `unknown`, `cancelled`. Results are durable to
inspect, but interrupted capture/publication can be `unknown`; do not repeat a side-effecting
operation under a new ID until its outcome is understood. Operation IDs are UUIDs and cannot be
reused for a different request.

For account keys, starting a snapshot operation returns only `{id,state}` with
HTTP 202. Poll `GET /preset-operations/{id}` for `{id,state,result?,error?,
uploadedBytes,partBytes}`; `partBytes` is 8,388,608. The finished `result` is a
`Preset`. Direct-server operations additionally expose their stored timestamps
and part metadata. Account snapshot deletion removes the catalog entry and its
retained-storage charge when no other account snapshot uses that archive;
existing environments remain intact. Shared backend archive cleanup is separate.

## Website account routes outside `/api/compute`

These are same-origin, session-authenticated routes used by the website UI. Mutations require
same-origin `Origin` and reject cross-site fetches. They are not general bearer-key API routes.

| Route | Methods and response |
| --- | --- |
| `/api/dashboard` | `GET { environments, totals, recent, activity, computeQuota, refreshedAt, storageBytes, billing }` |
| `/api/keys` | `GET [key metadata]`; `POST {name, canExecute?}` → `201 {id,key,name,baseUrl,revealOnce:true}` (secret is returned once); `/api/keys/{id}` `DELETE` → `{revoked:true}` |
| `/api/usage` | `GET { executions, durationMs, computeQuota, recent }` |
| `/api/billing`, `/api/billing/checkout`, `/api/billing/portal` | Account billing actions and summaries; response varies by action. |
| `/api/ssh-keys...`, `/api/ssh/control` | Website SSH key and control-plane routes. |
| `/api/presets...`, `/api/preset-operations...` | Account-owned preset catalog and durable image operations; structure follows `Preset`/`PresetOperation`, with list entries adding `createdAt` and operation responses adding `uploadedBytes`/`partBytes`. |
| `/api/terminals/{uuid}[ /input]` | Account-owned terminal polling, input, and stop routes. |

`/api/compute/...` is the one account Worker prefix that accepts personal API keys.
`/api/environments/...`, `/api/terminals/...`, and `/api/presets/...` without `/compute` are
browser/session routes. The `/api/compute/v1` surface deliberately does not mirror every standalone
server route (for example direct `tools`, `assets`, admin, plugin, and billing inspection APIs are
not generally exposed to personal keys).

## Timeouts, cancellation and error JSON

Execution `timeoutMs` defaults to 30,000 ms and is limited to 300,000 ms. A timeout or client
disconnect can happen after partial filesystem or external effects; the HTTP caller must treat a
lost response as ambiguous. The direct server emits JSON errors as `{ "error": string, "code":
ErrorCode, "allocationUsage"?: object, "containmentUncertain"?: true }`. The account Worker normally
emits `{ "error": string, "code": string }`. HTTP status and code pairs in the core are:

| HTTP | Code |
| ---: | --- |
| 400 | `INVALID_INPUT`, `PACKAGE_INVALID` |
| 401 | `UNAUTHORIZED` |
| 403 | `POLICY_DENIED` |
| 404 | `NOT_FOUND` |
| 409 | `CONFLICT` |
| 413 | `PAYLOAD_TOO_LARGE` |
| 429 | `QUOTA_EXCEEDED` |
| 499 | `CANCELLED` |
| 502 | `INVALID_OUTPUT`, `PROTOCOL_ERROR` |
| 503 | `NETWORK_ERROR` |
| 504 | `TIMEOUT` |
| 500 | `EXECUTION_FAILED`, `STORAGE_ERROR`, `INTERNAL_ERROR` (other codes default to 500) |

Example:

```json
{ "error": "Environment is busy.", "code": "CONFLICT" }
```

The gateway's internal execution-job admission errors are a legacy exception:
`scripts/public-api.mjs` can return `{error}` without `code`; when job storage is unconfigured it
returns 503 `{error}`. The account Worker wraps its own errors with a code, usually preserving
backend status/message. Unknown internal errors are deliberately generic on the website (`500
{"error":"Account request failed. Please try again.","code":"INTERNAL_ERROR"}`). `allocationUsage`
may accompany failures and affects billing settlement; clients should preserve unrecognized additive
fields.

## Known surface differences and contract gaps

- Website account routes add account `name` and ownership metadata; core environment records do not. Website environment creation accepts `name` and does not accept `tools`; direct creation accepts `tools` but has no account name.
- Website environment listing exists at `GET /api/compute/v1/environments`; the core `/v1/environments` router has no GET collection route.
- Website `?async=1` uses the gateway's durable `/execution-jobs` adapter. Direct core `/v1` command runs return command tickets with per-environment command routes; `exec` keeps its existing synchronous response unless async command support is selected.
- SDK `output` is convenience-only. The wire result uses separate `stdout`, `stdoutBase64`, and `stderr` fields.
- Website personal keys do not expose the complete core plugin/asset/tool interface. Website snapshots use account-owned preset operation endpoints, while direct server preset upload also accepts one raw OCI tar POST.
- HTTP timeout limits differ by layer: account upstream calls use the command timeout plus a 10-second allowance, the public gateway permits a 330-second upstream connection, direct server request timeout is 30 seconds for receiving a request, and SDK async polling is capped at 30 minutes. None of these creates an idempotent command retry guarantee.
