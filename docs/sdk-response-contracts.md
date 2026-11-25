# SDK response contracts

Every HTTP response consumed by `src/client/` is validated at runtime against schemas in `src/client/responses.ts`. Harmless extra envelope fields are stripped, while identity, policy, manifests, and required payload fields are strictly checked. Execution return types are inferred directly from those runtime schemas so TypeScript types and runtime checks stay in lockstep.

## Operation coverage

This audit covers all 18 public client operations:

| SDK operation | Endpoint | Runtime checks |
| --- | --- | --- |
| `tools.list()` | `GET /v1/tools` | Array of valid tool records and manifests within JSON bounds; returned references are deeply frozen. |
| `tools.use()` | `GET /v1/tools/{id}`, `POST /v1/tools/use` | Record shape, exact ID match, and manifest match when a local definition is supplied. Publishes once on `404`. |
| `environments.create()` | `POST /v1/environments` | Required record fields, requested `name` (when provided), tool list, explicit settings, and network/transfer constraints. |
| `environments.connect()` | `GET /v1/environments/{id}` | Record shape, matching ID, and compliance with the client's configured network policy. |
| `environment.describe()` | *(cached)* | Returns a frozen copy of the validated create/connect record without a network call. |
| `environment.exec()` | `POST /v1/environments/{id}/exec` | Output streams, exit code, canonical base64 agreement with UTF-8 `stdout`, byte bounds, nonnegative timings, and optional metrics. Nonzero exits are valid responses. |
| `environment.delete()` | `DELETE /v1/environments/{id}` | Matching environment ID and `{ deleted: true }` acknowledgement. |
| `environment.tools.call()` | `POST /v1/environments/{id}/tools/call` | Present output within JSON bounds, validated against the tool's declared output schema. |
| `environment.capturePreset()` | `POST /v1/environments/{id}/preset` | Preset identity, name, source, originating environment ID, and capture scope. |
| `assets.get()` | `GET /v1/assets/{id}` | Reference shape and requested ID; returned reference and entrypoints are frozen. |
| `assets.list()` | `GET /v1/assets` | Array of summaries with IDs, platform, entrypoints, state, and byte counts. |
| `assets.status()` | `GET /v1/assets/{id}/upload` | Requested ID, manifest digest identity, exact offset hash set, alignment/bounds, and state completeness. |
| `assets.cancel()` | `DELETE /v1/assets/{id}/upload` | Requires `{ cancelled: true }` before resolving. |
| `assets.upload()` | Begin / part / complete | Manifest agreement, digest identity, non-regressing offsets, progress bounds, terminal errors, and published reference. Never resends a part after a non-advancing acknowledgement. |
| `presets.list()` | `GET /v1/presets` | Array of presets with derived IDs and validated default environment settings. |
| `presets.get()` | `GET /v1/presets/{id}` | Same validation plus exact requested ID match. |
| `presets.upload()` | `POST /v1/presets?name=...` | Shape, derived identity, requested name, source, uploaded bytes, and archive SHA-256. |
| `presets.download()` | Metadata + binary archive | Metadata identity, OCI content type, streamed byte count and SHA-256. Stages privately and verifies before publishing; never overwrites an existing file. |

When `environment.exec(command, { async: true })` is used, the SDK also validates the submission ticket, matching execution/environment IDs, job state, HTTP status, and final saved result. Collection errors retain the execution ID and never replay the `POST`.

The server and SDK share the same preset-ID derivation logic.

## Transport & error guarantees

- **Strict decoding & bounds:** JSON responses are capped at **32 MiB** (separate from the 4 MiB execution-byte limit, accounting for JSON escaping and base64) and decoded as strict UTF-8 before parsing. Downloaded preset archives use a separate **1 GiB** limit with streaming SHA-256 verification.
- **No partial values:** Malformed `2xx` responses fail with `PROTOCOL_ERROR` rather than returning partial objects.
- **Preserved error semantics:** Empty or HTML error responses retain their HTTP status and classification (including Cloudflare `524` → `TIMEOUT`). Unrecognized future error codes preserve the server message and fall back to HTTP status classification.
- **No unsafe redirects or retries:** Redirects are rejected so credentials are never forwarded and mutations are never replayed. Transport or response errors never trigger automatic command retries.
- **Surface boundaries:** The hosted account API exposes a subset of the direct server's registry endpoints and may reject unsupported tool/asset/preset calls. Response validation does not grant access to unavailable routes.

## Verification

Run the focused response-contract tests:

```sh
npm test
```

Or run the response suites directly:

```sh
node --test test/sdk-responses.test.mjs
```

The test suite covers malformed and substituted payloads, optional metadata stripping, upload non-progress detection, binary corruption, and no-replay guarantees.
