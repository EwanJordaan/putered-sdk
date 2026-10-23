import { Putered, PuteredError, type Preset } from "./sdk.js";

export const presetUsage = `Usage:
  putered presets upload <image.oci.tar> --name <name> [--json]
  putered presets capture <environment-id> --name <name> [--json]
  putered presets list [--json]
  putered presets inspect <preset-id> [--json]
  putered presets download <preset-id> --output <archive.tar> [--json]

What to save is stored per environment: entire-environment (default, saves installed
software/configuration and workspace files) or workspace-only (less storage).
Choose it at environment creation with settings.saveScope; capture always uses it.
Output shows actual stored bytes. Legacy --mode state
accepts repeatable --workspace/--home selections. Downloads never overwrite files.
Configure PUTERED_BASE_URL and PUTERED_API_KEY.`;

function describe(record: Preset) {
  const scope = record.captureScope === "workspace-only" ? "Workspace only (less storage)" :
    record.source === "upload" ? "Uploaded image" : record.captureScope === "complete" ? "Entire environment" : "Legacy state";
  return `${record.id}\n  ${record.name} | ${scope} | ${record.bytes} bytes | ${record.platform.os}/${record.platform.architecture}`;
}

export async function runPresetCli(args: string[]) {
  if (args.includes("--help") || args[0] === "help") { console.log(presetUsage); return; }
  const [action, ...rest] = args;
  if (!["upload", "capture", "list", "inspect", "download"].includes(action)) throw new Error(presetUsage);
  const positional: string[] = [], flags = new Map<string, string[]>(); let json = false;
  const allowed = action === "upload" ? ["--name"] : action === "capture" ? ["--name", "--mode", "--workspace", "--home"] :
    action === "download" ? ["--output"] : [];
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (arg === "--json") { if (json) throw new Error("Duplicate --json option."); json = true; continue; }
    if (!arg.startsWith("-")) { positional.push(arg); continue; }
    if (!allowed.includes(arg)) throw new Error(`Unknown option for presets ${action}: ${arg}`);
    const value = rest[++index];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
    if (flags.has(arg) && !["--workspace", "--home"].includes(arg)) throw new Error(`Duplicate option: ${arg}`);
    flags.set(arg, [...(flags.get(arg) ?? []), value]);
  }
  if (positional.length !== (action === "list" ? 0 : 1)) throw new Error(presetUsage);
  const name = flags.get("--name")?.[0], destination = flags.get("--output")?.[0];
  if (["upload", "capture"].includes(action) && !name) throw new Error("--name is required.");
  if (action === "download" && !destination) throw new Error("--output is required.");
  const mode = flags.get("--mode")?.[0] ?? "complete";
  if (mode !== "complete" && mode !== "state") throw new Error("--mode must be complete or state.");
  if (mode === "complete" && (flags.has("--workspace") || flags.has("--home")))
    throw new Error("--workspace and --home require --mode state.");

  const client = new Putered({ baseUrl: process.env.PUTERED_BASE_URL ?? "http://127.0.0.1:3000",
    apiKey: process.env.PUTERED_API_KEY ?? "" });
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  try {
    const options = { signal: controller.signal };
    let result: Preset | Preset[];
    if (action === "upload") result = await client.presets.upload({ name: name!, file: positional[0], ...options });
    else if (action === "list") result = await client.presets.list(options);
    else if (action === "inspect") result = await client.presets.get(positional[0], options);
    else if (action === "download") result = await client.presets.download(positional[0], { destination: destination!, ...options });
    else {
      const environment = await client.environments.connect(positional[0], options);
      result = await environment.capturePreset(mode === "state" ? { name: name!, mode, workspace: flags.get("--workspace"),
        home: flags.get("--home"), ...options } : { name: name!, ...options });
    }
    if (json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(Array.isArray(result) ? result.length ? result.map(describe).join("\n") : "No presets." : describe(result));
      if (action === "download") console.log(`Saved to ${destination}`);
    }
  } catch (error) {
    if (controller.signal.aborted && !(error instanceof PuteredError && error.code === "CANCELLED"))
      throw new PuteredError("Preset command cancelled; publication may already have completed.", "CANCELLED");
    throw error;
  } finally { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); }
}
