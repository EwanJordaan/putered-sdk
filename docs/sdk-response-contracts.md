# SDK response contracts

This audit covers all 17 public client operations and every HTTP response consumed
by `src/client/`. Request and stored-record schemas remain strict. Client response
schemas live in `src/client/responses.ts`: harmless extra envelope metadata is
discarded, while required values, policy, manifests and identity are checked.
Returned execution types derive from their runtime schema, including optional
Git/Python/network metrics, to keep TypeScript and runtime validation aligned.

Opt-in `environment.exec(command, { async: true })` additionally validates the
submission ticket, matching execution/environment IDs and job state, HTTP status,
and the complete saved execution result. Collection failures retain the execution
ID and never replay the POST. Output streams remain separate, and empty stdout
or a nonzero process exit are valid results.

## Operation coverage

| SDK operation | Producer / return | Checks |
| --- | --- | --- |
| `tools.list()` | `GET /v1/tools` → tool references | Array, record/manifest shape, bounded JSON; returned references are frozen. |
| `tools.use()` | `GET /v1/tools/{id}`, or `POST /v1/tools/use` → reference | Record shape, requested ID, packaged definition's manifest when supplied. A missing package may be published once after GET 404. |
| `environments.create()` | `POST /v1/environments` → environment | Required record fields, requested tool set and explicit settings, network restrictions/transfer cap; permits gateway display metadata. |
| `environments.connect()` | `GET /v1/environments/{id}` → environment | Shape, matching ID and SDK network policy. |
| `environment.describe()` | Validated cached record → frozen copy | No network read; uses the record validated by create/connect. |
| `environment.exec()` | `POST /v1/environments/{id}/exec` → execution result | Required outputs/status/timings; canonical base64, decoded text agreement and byte bound; nonnegative timings/counters and optional metrics. Nonzero process exits are valid results. |
| `environment.tools.call()` | `POST /v1/environments/{id}/tools/call` → `{output}` | Required output, bounded JSON and the tool's declared output schema; not merely its envelope. |
| `environment.capturePreset()` | `POST /v1/environments/{id}/preset` → preset | Preset identity, name, source, originating environment and capture scope. |
| `assets.get()` | `GET /v1/assets/{id}` → asset reference | Reference shape, requested ID; returned reference/entrypoints are frozen. |
| `assets.list()` | `GET /v1/assets` → summaries | Array, IDs/platform/entrypoints, state, byte counts. |
| `assets.status()` | `GET /v1/assets/{id}/upload` → upload | Requested ID, manifest digest identity, exact offset hash set, bounds/alignment, ready/validating state completeness. |
| `assets.cancel()` | `DELETE /v1/assets/{id}/upload` → void | Requires `{cancelled:true}` before returning. |
| `assets.upload()` | Begin/part/complete → asset reference | Manifest/request agreement, digest identity, offsets that never regress, per-part progress, terminal failure, published ID/platform/entrypoints. Never resends a part after a nonadvancing acknowledgement. |
| `presets.list()` | `GET /v1/presets` → presets | Array and preset shape, identity derived from name/archive hash, validated default environment settings. |
| `presets.get()` | `GET /v1/presets/{id}` → preset | Same validation plus requested ID. |
| `presets.upload()` | `POST /v1/presets?name=...` → preset | Shape, derived identity, requested name, source, uploaded byte count and archive SHA-256. |
| `presets.download()` | Metadata plus binary archive → preset | Metadata identity, archive content type, streamed byte count/SHA-256. Publishes a private staging file only after verification and never overwrites an existing destination. |

The server and SDK now share the preset-ID derivation function. No wire identity
algorithm or server execution behavior changed.

## Transport and error responses

All JSON responses are size-bounded and decoded as strict UTF-8 before parsing.
Malformed successes fail with `PROTOCOL_ERROR`; missing or mistyped fields do not
become partial SDK values. Empty/HTML error responses preserve their actual HTTP
status and classification, including Cloudflare 524 as `TIMEOUT`. Unknown future
error-code strings retain a valid server message and fall back to HTTP-based
classification. Redirects are rejected without following credentials or replaying
mutations. Response failures do not trigger automatic command retries.

The response budget remains 32 MiB, separate from the four-MiB execution-byte
limit; JSON escaping and base64 account for the larger envelope allowance. Large
responses are rejected explicitly rather than accepted without bounds. Downloaded
preset archives use their separate one-GiB limit and streamed verification.

SDK capability and authentication restrictions still apply. The hosted account
API supports a subset of the private registry API; it can reject unsupported
tool/asset/preset operations. Validating those errors does not grant those routes.
The existing SDK `exec()` remains synchronous; this audit does not add the chat
adapter's asynchronous execution API to the SDK.

## Verification

```sh
node node_modules/typescript/bin/tsc
node scripts/copy-sdk.mjs
node --test test/sdk-responses.test.mjs test/sdk-server-responses.test.mjs
```

Ten focused test groups cover all operations, malformed/substituted values,
optional metadata, upload nonprogress, binary corruption and no-replay behavior.
The HTTP integration test uses the actual router, metadata/asset registries and
OCI upload/download code. Execution and capture results are deterministic runtime
fixtures; it does not claim to exercise Linux namespaces or real OCI capture.

The broader `sdk-structure.test.mjs` run passed its five JSON/response/schema tests.
Four other tests failed on Windows in unchanged module-loader/plugin-packaging
paths (drive-letter loader URL and the Linux `/workspace` require shim). Those
failures remain separate from these response changes. A full native Linux suite
has not been run for this audit.

The standalone SDK package was rebuilt and copied into the adjacent
`test-putered/vendor/putered-sdk` project. Its two regression tests and live
`npm start` both passed, returning the server's Node version `v24.19.0`.
