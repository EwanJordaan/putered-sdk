# HTTP API Contract

This reference documents the live HTTP JSON contract for Putered:

- **Account API (hosted compute):** `https://putered.com/api/compute/v1` (the endpoint `@putered/sdk` uses; `https://api.putered.com/v1` is the public key gateway to the same account API).
- **Internal execution server (operators):** `<server>/v1`.

The two surfaces do not expose identical routes. Unless noted, requests and responses use `Content-Type: application/json` (binary upload chunks and OCI archives use raw binary or OCI tar content types). Successful responses return the resource or result directly — there is no `{ success, data }` wrapper.

## Authentication & base URLs

| Caller | Base URL | Credential | Scope & boundary |
| --- | --- | --- | --- |
| Personal account key | `https://putered.com/api/compute/v1` or `https://api.putered.com/v1` | `Authorization: Bearer pk_live_<64 hex>` | Account ownership, verified email, quota, and key `canExecute` permission (`403` on mutations when false). |
| Internal execution server | `<server>/v1` | `Authorization: Bearer <token>` (≥ 32 chars) | Operator tokens access all local records; project keys are limited to their `projectId` and `read`/`upload`/`execute` scopes. |
| Browser dashboard | `https://putered.com/api/...` | Same-origin session cookie | Same-origin `Origin` required on mutations. Not a bearer-key SDK surface. |

Account keys (`pk_live_...`) are verified by the account service and proxied upstream with server-held credentials. Never send backend credentials from a client.

```sh
curl https://putered.com/api/compute/v1/environments \
  -H "Authorization: Bearer $PUTERED_API_KEY"
```

## Environments & commands

| Method & path | Request body | Success response |
| --- | --- | --- |
| `POST /environments` | `{ name?, persistence?, execution?, template?, tools?, settings?, env?, networkPolicy? }` *(website accepts `name`, not `tools`; direct accepts `tools`, not `name`)* | `201 Environment` |
| `GET /environments` | — *(website only)* | `200 [{ id, name, created_at }]` (newest first) |
| `GET /environments/{id}` | — | `200 Environment` |
| `PATCH /environments/{id}` | `{ env?, networkPolicy? }` (at least one required) | `200 Environment` |
| `DELETE /environments/{id}` | — | `200 { id, deleted: true }` |
| `POST /environments/{id}/stop` | `{}` | `200 { id, stopped: true }` |
| `POST /environments/{id}/resume` | `{}` | `200 Environment` |
| `POST /environments/{id}/exec` | `{ command, resources?, queueTimeoutMs?, timeoutMs?, requestId? }` (`command` nonempty, ≤ 64 KiB; direct also accepts `metered`, `wait`) | `200 ExecutionResult` (or `202` ticket with `?async=1`) |
| `POST /environments/{id}/run` | `{ program, args?, cwd?, env?, stdinBase64?, stdinOpen?, sudo?, resources?, queueTimeoutMs?, timeoutMs?, requestId?, wait? }` | `200 ExecutionResult` (or `202` ticket with `?async=1`) |
| `POST /environments/{id}/tools/call` | Direct only: `{ id, tool, input, resources?, queueTimeoutMs?, timeoutMs?, wait? }` | `200 { output }` |
| `POST /environments/{id}/preset` | Direct only: `{ name, mode?: "complete" \| "state", workspace?, home? }` | `201 Preset` |
| `GET /environments/{id}/terminals` | — *(website only)* | `200 [{ id, state, created_at }]` (up to 20) |
| `POST /environments/{id}/terminals` | `{ id: UUID, columns?: 20..300, rows?: 5..120 }` *(direct also accepts `environmentId`)* | `202 TerminalSession` |

### Environment record & settings

```json
{
  "id": "env_demo",
  "name": "Demo",
  "tools": [],
  "persistence": "full",
  "settings": { "network": { "mode": "disabled" } }
}
```

- **`name`** (website): trimmed string, 1–100 characters (defaults to `"My environment"`). Not unique; reconnect by `id`.
- **`persistence`**: `"full"` (default), `"workspace"`, `"workspace-and-dependencies"`, `"none"`, or `{ mode: "custom", include, exclude }`. Fixed at creation.
- **`execution`**: `{ default?: "native" | "v8" | "auto", programs?: Record<string, "native" | "v8" | "auto"> }`.
- **`settings`**:
  - `resources?: { cpu?: number, memoryMiB?: number }`
  - `git?: boolean`
  - `execution?: { mode: "auto" | "isolate-only" | "native-only", allowSudo?: boolean }`
  - `network?: { mode: "disabled" } | { mode: "internet", maxBytesPerExecution?: 1..1073741824, allow?, deny?, vm?, v8? }` (rules: hostnames, `*.hostname`, IPs, CIDRs, or HTTP(S) origins without paths/ports; max 128 per list)
  - `timeoutMs?: 1..300000`
- **`env`**: POSIX variable map to NUL-free strings, ≤ 64 KiB JSON.
- **`networkPolicy`**: `"allow-all"`, `"deny-all"`, `{ allow: [domain, ...] }`, or `{ allow: { [domain]: OutboundRule[] } }` (rules match exact/prefix paths and methods to add headers, or return `{ response: { statusCode } }`). Authored ≤ 64 KiB JSON; readback ≤ 256 KiB with transformed header values redacted to `"<redacted>"`.

### Execution request & result

```sh
curl 'https://putered.com/api/compute/v1/environments/env_demo/exec' \
  -H "Authorization: Bearer $PUTERED_API_KEY" \
  -H 'Content-Type: application/json' \
  --data '{"command":"printf hello","timeoutMs":30000}'
```

For `POST /environments/{id}/run`:

- `program` must match `^[a-z][a-z0-9_-]{0,63}$`.
- `args` defaults to `[]`, NUL-free, ≤ 4,096 entries and ≤ 64 KiB encoded JSON.
- `cwd` must be `/workspace` or a descendant without NUL or `..`.
- `env` and static `stdinBase64` are each capped at 64 KiB; complete request JSON is capped at 256 KiB.
- `sudo: true` requires `settings.execution.allowSudo: true` and is rejected on direct Wasm Git.

A completed command with a nonzero `exitCode` still returns HTTP `200` with an `ExecutionResult`:

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

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `stdout` | `string` | Yes | UTF-8 decoding of stdout (may be empty) |
| `stdoutBase64` | `string` | Yes | Raw stdout bytes in canonical base64 |
| `stderr` | `string` | Yes | Collected stderr (may be empty) |
| `exitCode` | `integer` | Yes | Process exit status |
| `durationMs` | `number` | Yes | Execution duration in milliseconds |
| `hostDurationMs` | `number` | Yes | Host-side duration in milliseconds |
| `memoryLimitExceeded` | `boolean` | No | `true` when killed by memory cgroup OOM |
| `allocationUsage` | `object` | No | `{ enforced: true, durationMs, cpuQuotaMicros, memoryBytes, cpuMicros? }` |
| `networkUsage` | `object` | No | `{ sentBytes, receivedBytes, connections, limitBytes }` |
| `gitMetrics` | `array` | No | `[{ durationMs, wasmMemoryBytes, helperCount }]` |
| `pythonMetrics` | `object` | No | `{ backend: "wasm" \| "native", warm, sessionId?, initMs, executionMs, rssBytes, cpuMicros?, wasmMemoryBytes? }` |

> `output` is **not** a wire field — the SDK computes `stdout + stderr` locally as a non-enumerable property.

### Async execution, streaming & signals

Pass `?async=1` to `POST /environments/{id}/exec` or `/run` to submit once and receive `202 { jobId, state: "running", commandPath? }`:

- **Gateway tickets** (no `commandPath`): poll `GET /execution-jobs/{jobId}` for `{ id, environmentId, state, phase?, httpStatus?, result?, error? }`.
- **Command tickets** (with `commandPath`): use the interactive command routes below.

| Method & path | Request | Response |
| --- | --- | --- |
| `GET /environments/{id}/commands/{uuid}?cursor=N` | — | `{ id, environmentId, state, phase?, createdAt, cursor, output: [{ stream, data }], reset?, httpStatus?, result?, error? }` |
| `POST /environments/{id}/commands/{uuid}/input` | `{ sequence, input?: base64, close?: true }` (≤ 32 KiB per chunk, zero-indexed) | `{ nextSequence }` |
| `POST /environments/{id}/commands/{uuid}/signal` | `{ signal: "SIGTERM" \| "SIGKILL" \| "SIGINT" \| "SIGHUP" \| "SIGQUIT" \| "SIGSTOP" \| "SIGCONT" }` | `{ accepted: true }` |

States are `running`, `completed`, `failed`, or `unknown`. `unknown` means the server cannot prove whether an interrupted command finished — never replay a command automatically after a timeout, disconnect, or `unknown` state.

## Terminal sessions

| Method & path | Request | Success |
| --- | --- | --- |
| `POST /environments/{id}/terminals` | `{ id: UUID, columns?: 20..300, rows?: 5..120 }` | `202 TerminalSession` |
| `GET /environments/{id}/terminals` | — *(website only)* | `200 [{ id, state, created_at }]` |
| `GET /terminals/{uuid}?cursor=N` | — | `200 TerminalSession` (up to 64 KiB base64 `output`, `cursor`, `reset`) |
| `POST /terminals/{uuid}/input` | `{ sequence, input?: base64, columns?, rows? }` | `200 { nextSequence }` |
| `DELETE /terminals/{uuid}` | — | `200 TerminalSession` |

Direct servers also accept `POST /terminals` with `environmentId`. Session states are `starting`, `running`, `stopping`, `saving`, `closed`, `failed`, `unknown`. Inputs are strictly sequenced (resending the same sequence returns its acknowledgement; out-of-order sequences conflict). Sessions stop after **1 hour**, **5 minutes** without input, or **45 seconds** without a reader.

## Assets, tools, and OCI presets (direct API)

These registry routes live on the direct server under `/v1`. Personal account keys support environment execution, terminals, and account-owned presets/preset-operations, not the full binary asset/tool registry.

| Method & path | Request | Success |
| --- | --- | --- |
| `GET /assets` | — | `200 [AssetSummary]` |
| `GET /assets/{assetId}` | — | `200 AssetReference` |
| `POST /assets/uploads` | `{ manifest: AssetManifest }` | `200 AssetUpload` |
| `PUT /assets/{assetId}/upload/{sha256}/{offset}` | Raw chunk (≤ 4 MiB) | `200 AssetUpload` |
| `GET /assets/{assetId}/upload` | — | `200 AssetUpload` |
| `POST /assets/{assetId}/upload/complete` | `{}` | `200 AssetReference` |
| `DELETE /assets/{assetId}/upload` | — | `200 { cancelled: true }` |
| `GET /tools` | — | `200 [StoredTool]` |
| `GET /tools/{toolId}` | — | `200 StoredTool` |
| `POST /tools/use` | `{ artifact: ToolArtifact }` | `200 StoredTool` |
| `GET /presets` | — | `200 [Preset]` |
| `GET /presets/{presetId}` | — | `200 Preset` |
| `DELETE /presets/{presetId}` | — *(account API only)* | `200 { id, deleted: true }` |
| `GET /presets/{presetId}/archive` | — | Binary OCI tar (`application/vnd.oci.image.layout.v1+tar`) |
| `POST /presets?name={name}` | Raw OCI tar (≤ 1 GiB) | `201 Preset` |
| `POST /preset-operations` | Capture: `{ id, name, kind: "capture", environmentId }` · Upload: `{ id, name, kind: "upload", bytes: 1024..1073741824 }` | `202 PresetOperation` |
| `GET /preset-operations/{uuid}` | — | `200 PresetOperation` |
| `PUT /preset-operations/{uuid}/parts/{index}` | Ordered raw part (≤ 8 MiB, exact expected size) | `200 { index, bytes, sha256 }` |
| `POST /preset-operations/{uuid}/complete` | `{}` | `202 PresetOperation` |
| `DELETE /preset-operations/{uuid}` | — *(only while `uploading`)* | `200 PresetOperation` |

- **Preset operation states:** `uploading`, `running`, `ready`, `failed`, `unknown`, `cancelled`. Operation IDs are UUIDs and cannot be reused for a different request.
- **Account key responses:** Starting a preset operation returns `202 { id, state }`; polling returns `{ id, state, result?, error?, uploadedBytes, partBytes: 8388608 }`. Deleting an account snapshot removes the catalog entry and storage charge when unreferenced; existing environments remain intact.

## Per-execution resources & queueing

- **`Resources`:** `{ cpu?: number, memoryMiB?: number }`. CPU uses `0.25` vCPU steps (min `0.25`); RAM uses `256 MiB` steps (min `256`).
- **Caps:** Current hosted availability caps at **1 vCPU / 1024 MiB** (entitlement ceilings: Plus `2 vCPU / 2048 MiB`, Pro `8 vCPU / 8192 MiB`). Oversized requests reject before execution.
- **Queueing:** `queueTimeoutMs` is `1–300000` ms (default `120000`), independent of `timeoutMs`. Admission reserves the full RAM ceiling in FIFO order; CPU shares fairly under contention with no guaranteed minimum. Queue time is not billed.
- **Enforcement:** Routes that cannot enforce requested resource limits fail with `POLICY_DENIED` before effects. RAM OOM kills report `memoryLimitExceeded: true`.

## Errors & status codes

Direct servers emit `{ error, code, allocationUsage?, containmentUncertain? }`; the account Worker emits `{ error, code }`.

| HTTP | Error codes |
| ---: | --- |
| `400` | `INVALID_INPUT`, `PACKAGE_INVALID` |
| `401` | `UNAUTHORIZED` |
| `403` | `POLICY_DENIED` |
| `404` | `NOT_FOUND` |
| `409` | `CONFLICT` |
| `413` | `PAYLOAD_TOO_LARGE` |
| `429` | `QUOTA_EXCEEDED` |
| `499` | `CANCELLED` |
| `502` | `INVALID_OUTPUT`, `PROTOCOL_ERROR` |
| `503` | `NETWORK_ERROR` |
| `504` | `TIMEOUT` |
| `500` | `EXECUTION_FAILED`, `STORAGE_ERROR`, `INTERNAL_ERROR` |

```json
{ "error": "Environment is busy.", "code": "CONFLICT" }
```

## Website session routes (outside `/api/compute`)

Browser routes under `/api/dashboard`, `/api/keys`, `/api/usage`, `/api/billing/*`, `/api/ssh-keys/*`, `/api/presets/*`, `/api/preset-operations/*`, and `/api/terminals/*` use same-origin session cookies and reject cross-site mutations. Use `/api/compute/v1/...` for bearer-key API access.

## Known surface differences

- **Names vs. tools:** Website `POST /environments` accepts `name` (not `tools`); direct core accepts `tools` (not `name`).
- **Environment listing:** `GET /api/compute/v1/environments` exists on the website API; direct core has no collection route.
- **Async tickets:** Website `?async=1` uses the gateway's durable `/execution-jobs` adapter; direct core returns per-environment command tickets.
- **Timeout layers:** Account upstream adds 10s to the command timeout; public gateway allows 330s; direct server request read timeout is 30s; SDK async polling caps at 30 minutes. None of these provide idempotent retries.
