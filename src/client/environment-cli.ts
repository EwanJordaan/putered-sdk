import { Putered } from "./sdk.js";
import { presetSaveScopeSchema } from "../preset-contract.js";

export const environmentUsage = `Usage: putered environments create [--template <preset-id|general>] [--network internet|disabled] [--save-scope entire-environment|workspace-only] [--json]
       putered environments exec <id> [--json] -- <quoted shell command>
       putered environments describe <id>
Defaults: entire environment saved, internet enabled (SDK config can disable it).`;

export async function runEnvironmentCli(args: string[]) {
  if (args[0] === "--help") { console.log(environmentUsage); return; }
  const client = new Putered({ baseUrl: process.env.PUTERED_BASE_URL ?? "http://127.0.0.1:3000", apiKey: process.env.PUTERED_API_KEY ?? "" });
  if (["exec", "describe"].includes(args[0])) {
    const [action, id, ...rest] = args;
    if (!id) throw new Error(environmentUsage);
    const environment = await client.environments.connect(id);
    if (action === "describe") {
      if (rest.length) throw new Error(environmentUsage);
      console.log(JSON.stringify(environment.describe(), null, 2)); return;
    }
    const json = rest[0] === "--json";
    if (json) rest.shift();
    if (rest[0] === "--") rest.shift();
    if (rest.length !== 1) throw new Error("Supply one quoted shell command after --.");
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    try {
      const result = await environment.exec(rest[0], { signal: controller.signal });
      if (json) console.log(JSON.stringify(result));
      else { process.stdout.write(Buffer.from(result.stdoutBase64, "base64")); process.stderr.write(result.stderr); }
      process.exitCode = result.exitCode;
    } finally { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); }
    return;
  }
  if (args[0] !== "create") throw new Error(environmentUsage);
  const flags = new Map<string, string>(); let json = false;
  for (let index = 1; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--json") { if (json) throw new Error("Duplicate --json option."); json = true; continue; }
    if (!["--template", "--save-scope", "--network"].includes(flag) || flags.has(flag)) throw new Error(`Unknown or duplicate creation option: ${flag}`);
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
    flags.set(flag, value);
  }
  const saveScope = presetSaveScopeSchema.parse(flags.get("--save-scope") ?? "entire-environment");
  const network = flags.get("--network");
  if (network !== undefined && !["internet", "disabled"].includes(network)) throw new Error("--network must be internet or disabled.");
  const environment = await client.environments.create({ template: flags.get("--template") ?? "general", settings: { saveScope,
    ...(network === undefined ? {} : { network: { mode: network as "internet" | "disabled" } }) } });
  const record = environment.describe();
  console.log(json ? JSON.stringify(record, null, 2) :
    `${environment.id} — ${saveScope === "workspace-only" ? "Workspace only" : "Entire environment"}; internet ${record.settings.network?.mode === "internet" ? "enabled" : "disabled"}\nNext: putered environments exec ${environment.id} -- 'pwd'`);
}
