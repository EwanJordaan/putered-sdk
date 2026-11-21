import { clientFromEnv, parseCliFlags, withSignalAbort } from "./cli-helpers.js";
import { persistenceSchema } from "../persistence-contract.js";

export const environmentUsage = `Usage: putered environments create [--template <preset-id|general>] [--network internet|disabled] [--persistence full|workspace|workspace-and-dependencies|none|custom] [--include <guest-path>] [--exclude <guest-path>] [--json]
       putered environments exec <id> [--json] -- <quoted shell command>
       putered environments describe <id>
Defaults: persistence and network come from putered.config.json. Custom paths are repeatable.`;

export async function runEnvironmentCli(args: string[]) {
  if (args.includes("--help") || args[0] === "help") { console.log(environmentUsage); return; }
  const client = clientFromEnv();
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
    await withSignalAbort(async signal => {
      const result = await environment.exec(rest[0], { signal });
      if (json) console.log(JSON.stringify(result));
      else { process.stdout.write(Buffer.from(result.stdoutBase64, "base64")); process.stderr.write(result.stderr); }
      process.exitCode = result.exitCode;
    });
    return;
  }
  if (args[0] !== "create") throw new Error(environmentUsage);
  const { flags, booleans } = parseCliFlags(args.slice(1), {
    valueFlags: ["--template", "--persistence", "--network"],
    repeatableFlags: ["--include", "--exclude"],
    booleanFlags: ["--json"],
    allowPositionals: false,
    unknownOptionMessage: flag => `Unknown or duplicate creation option: ${flag}`,
  });
  const include = flags.get("--include") ?? [], exclude = flags.get("--exclude") ?? [];
  const json = booleans.has("--json");
  const mode = flags.get("--persistence")?.[0];
  if ((include.length || exclude.length) && mode !== "custom") throw new Error("--include/--exclude require --persistence custom.");
  const persistence = mode === undefined ? undefined : persistenceSchema.parse(mode === "custom" ? { mode, include, exclude } : mode);
  const network = flags.get("--network")?.[0];
  if (network !== undefined && !["internet", "disabled"].includes(network)) throw new Error("--network must be internet or disabled.");
  const environment = await client.environments.create({ template: flags.get("--template")?.[0] ?? "general", persistence, settings: {
    ...(network === undefined ? {} : { network: { mode: network as "internet" | "disabled" } }) } });
  const record = environment.describe();
  console.log(json ? JSON.stringify(record, null, 2) :
    `${environment.id} — ${typeof environment.persistence === "string" ? environment.persistence : "custom"}; internet ${record.settings.network?.mode === "internet" ? "enabled" : "disabled"}\nNext: putered environments exec ${environment.id} -- 'pwd'`);
}
