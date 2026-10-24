# SDK examples

Small programs you can run separately and edit. They use the real SDK and server;
they are not a simulated workspace.

## Setup

Use Node.js 22.13 or later. From this directory:

```sh
npm install
```

Create an API key with execution permission in the Putered console. Hosted
compute needs an active subscription and available credits. The SDK connects to
hosted compute by default, so only the API key is needed.

Set credentials in your shell. Do not put the key in source code or browser code.

PowerShell:

```powershell
$env:PUTERED_API_KEY = '<your-api-key>'
npm run example -- 01-create-and-run.ts
```

Bash:

```sh
export PUTERED_API_KEY='<your-api-key>'
npm run example -- 01-create-and-run.ts
```

For a self-hosted server, set `PUTERED_BASE_URL` to its origin and use a
server-issued project key. The SDK adds `/v1` to the base URL. No real
credentials are included here.

If you already built this repository, you can run from its root without installing
the example package separately:

```sh
node --import tsx examples/sdk/01-create-and-run.ts
node node_modules/typescript/bin/tsc -p examples/sdk/tsconfig.json
```

## Programs

Run a file with `npm run example -- <file>`. Set the listed variables first.

| Program | What it shows | Additional inputs | Resources left behind on success |
| --- | --- | --- | --- |
| [01-create-and-run.ts](01-create-and-run.ts) | Create, execute, read `result.output` and write a persistent file. | None | One environment; prints its ID. |
| [02-reconnect-and-files.ts](02-reconnect-and-files.ts) | Reconnect and read/update files saved by example 01. | `PUTERED_ENVIRONMENT_ID` from 01 | Keeps the existing environment. |
| [03-command-errors.ts](03-command-errors.ts) | Catch `CommandError`, distinguish API failures, use `check: false`. | None | Deletes its own environment. |
| [04-python-data.ts](04-python-data.ts) | Write JSON, process it in Python and read the saved result. | None | Deletes its own environment. |
| [05-parallel-jobs.ts](05-parallel-jobs.ts) | Three independent jobs with per-job cleanup and failure reporting. | None | Deletes its own environments. |
| [06-async-command.ts](06-async-command.ts) | Submit once and let the SDK poll for the completed command. | None | Deletes on success; keeps the environment if the outcome is uncertain. |
| [07-capture-and-restore.ts](07-capture-and-restore.ts) | Capture workspace files and create a new environment from the snapshot. | None | One snapshot; deletes both environments on success. |
| [08-upload-image.ts](08-upload-image.ts) | Upload an OCI archive with progress and create an environment from it. | `PUTERED_IMAGE_FILE` | One uploaded image and one environment. |
| [09-download-snapshot.ts](09-download-snapshot.ts) | List snapshots and download one with checksum verification. | `PUTERED_SNAPSHOT_ID`, `PUTERED_DOWNLOAD_FILE` | A local archive; no new server resources. |
| [10-terminal-session.ts](10-terminal-session.ts) | Read PTY output, preserve the cursor, send a command and exit. | `PUTERED_ENVIRONMENT_ID` | Keeps the existing environment. |
| [11-delete-environment.ts](11-delete-environment.ts) | Permanently delete an environment with an explicit confirmation. | `PUTERED_ENVIRONMENT_ID`, `PUTERED_CONFIRM_DELETE` set to that same ID | Deletes the chosen environment. |
| [12-stream-and-detach.ts](12-stream-and-detach.ts) | Set cwd/env, pipe stdin and stdout, then collect a detached command by ID. | None | Deletes its environment. |

For example, after running 01 in PowerShell:

```powershell
$env:PUTERED_ENVIRONMENT_ID = 'env_<id-printed-by-example-01>'
npm run example -- 02-reconnect-and-files.ts
# When finished with that environment:
$env:PUTERED_CONFIRM_DELETE = $env:PUTERED_ENVIRONMENT_ID
npm run example -- 11-delete-environment.ts
```

## Behavior to know

- `result.output` is a string property. It contains stdout followed by stderr;
  it does not reconstruct their chronological order. `stdout`, `stderr`,
  `exitCode`, and `durationMs` remain available.
- Nonzero exits throw `CommandError` by default. API and connection failures
  are different errors. Do not automatically rerun commands after an uncertain
  outcome: files may already have changed.
- `async: true` changes how the result is collected, not the execution timeout.
  Commands default to 30 seconds and permit at most 300,000 ms (five minutes).
- Examples use workspace-only persistence unless they explicitly create an
  uploaded OS environment. Full OS configuration needs an Entire environment
  capture; ordinary automatic persistence covers `/workspace`.
- Terminals require native Linux support on the server. Sessions last at most
  one hour, stop after five minutes without input, and stop after 45 seconds
  without a reader. Reads keep the connection alive. CPU and RAM are billed
  while allocated, including an idle shell.
- Snapshots and uploaded images are separate stored resources. Deleting an
  environment does not delete its snapshots; remove those in the console.
- The programs print resource and operation IDs where useful. If a multi-step
  example fails, use those IDs to inspect existing resources before rerunning it.

See the [API contract](../../docs/api-contract.md) for raw HTTP requests/responses,
and the [SDK guide](../../docs/sdk.md) for tools and additional SDK behavior.
