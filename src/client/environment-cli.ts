import { Putered } from "./sdk.js";
import { persistenceSchema } from "../persistence-contract.js";

export const environmentUsage = `Usage: putered environments create [--template <preset-id|general>] [--network internet|disabled] [--persistence full|workspace|workspace-and-dependencies|none|custom] [--include <guest-path>] [--exclude <guest-path>] [--json]
       putered environments exec <id> [--json] -- <quoted shell command>
       putered environments describe <id>
Defaults: persistence and network come from putered.config.json. Custom paths are repeatable.`;

export async function runEnvironmentCli(args: string[]) {
  if (args[0] === "--help") { console.log(environmentUsage); return; }
  const client = new Putered({ baseUrl: process.env.PUTERED_BASE_URL, apiKey: process.env.PUTERED_API_KEY ?? "" });
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
  const flags = new Map<string, string>(); const include: string[] = [], exclude: string[] = []; let json = false;
  for (let index = 1; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--json") { if (json) throw new Error("Duplicate --json option."); json = true; continue; }
    if (flag === "--include" || flag === "--exclude") {
      const value = args[++index]; if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
      (flag === "--include" ? include : exclude).push(value); continue;
    }
    if (!["--template", "--persistence", "--network"].includes(flag) || flags.has(flag)) throw new Error(`Unknown or duplicate creation option: ${flag}`);
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
    flags.set(flag, value);
  }
  const mode = flags.get("--persistence");
  if ((include.length || exclude.length) && mode !== "custom") throw new Error("--include/--exclude require --persistence custom.");
  const persistence = mode === undefined ? undefined : persistenceSchema.parse(mode === "custom" ? { mode, include, exclude } : mode);
  const network = flags.get("--network");
  if (network !== undefined && !["internet", "disabled"].includes(network)) throw new Error("--network must be internet or disabled.");
  const environment = await client.environments.create({ template: flags.get("--template") ?? "general", persistence, settings: {
    ...(network === undefined ? {} : { network: { mode: network as "internet" | "disabled" } }) } });
  const record = environment.describe();
  console.log(json ? JSON.stringify(record, null, 2) :
    `${environment.id} — ${typeof environment.persistence === "string" ? environment.persistence : "custom"}; internet ${record.settings.network?.mode === "internet" ? "enabled" : "disabled"}\nNext: putered environments exec ${environment.id} -- 'pwd'`);
}
