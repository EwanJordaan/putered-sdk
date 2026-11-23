import { clientFromEnv, parseCliFlags, withSignalAbort } from "./cli-helpers.js";
import { persistenceSchema } from "../persistence-contract.js";

export const environmentUsage = `Usage: putered environments create [--name <label>] [--template <preset-id|general>] [--execution native|v8|auto] [--cpu <0.25-8>] [--memory-mib <128-8192>] [--network internet|disabled] [--persistence full|workspace|workspace-and-dependencies|none|custom] [--include <guest-path>] [--exclude <guest-path>] [--json]
       putered environments exec <id> [--cpu <0.25-8>] [--memory-mib <128-8192>] [--timeout <ms>] [--json] -- <quoted shell command>
       putered environments describe <id>
Defaults: persistence, execution, resources, and network come from putered.config.json. Omitting --memory-mib enables automatic 128–384 MiB V8 RAM tiers.`;

function parseNumberFlag(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number.`);
  return parsed;
}

export async function runEnvironmentCli(args: string[]) {
  if (args.includes("--help") || args[0] === "help") { console.log(environmentUsage); return; }
  if (["exec", "describe"].includes(args[0])) {
    const [action, id, ...rest] = args;
    if (!id) throw new Error(environmentUsage);
    if (action === "describe") {
      if (rest.length) throw new Error(environmentUsage);
      const environment = await clientFromEnv().environments.connect(id);
      console.log(JSON.stringify(environment.describe(), null, 2)); return;
    }
    const separator = rest.indexOf("--");
    const optionArgs = separator >= 0 ? rest.slice(0, separator) : rest.slice(0, -1);
    const commandArgs = separator >= 0 ? rest.slice(separator + 1) : rest.slice(-1);
    const { flags, booleans } = parseCliFlags(optionArgs, {
      valueFlags: ["--cpu", "--memory-mib", "--timeout"],
      booleanFlags: ["--json"],
      allowPositionals: false,
      unknownOptionMessage: flag => `Unknown or duplicate exec option: ${flag}`,
    });
    if (commandArgs.length !== 1) throw new Error("Supply one quoted shell command after --.");
    const cpu = parseNumberFlag(flags.get("--cpu")?.[0], "--cpu");
    const memoryMiB = parseNumberFlag(flags.get("--memory-mib")?.[0], "--memory-mib");
    const timeoutMs = parseNumberFlag(flags.get("--timeout")?.[0], "--timeout");
    const resources = cpu !== undefined || memoryMiB !== undefined ? { ...(cpu !== undefined ? { cpu } : {}), ...(memoryMiB !== undefined ? { memoryMiB } : {}) } : undefined;
    const json = booleans.has("--json");
    const environment = await clientFromEnv().environments.connect(id);
    await withSignalAbort(async signal => {
      const result = await environment.exec(commandArgs[0], { signal, check: false, ...(resources ? { resources } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
      if (json) console.log(JSON.stringify(result));
      else { process.stdout.write(Buffer.from(result.stdoutBase64, "base64")); process.stderr.write(result.stderr); }
      process.exitCode = result.exitCode;
    });
    return;
  }
  if (args[0] !== "create") throw new Error(environmentUsage);
  const { flags, booleans } = parseCliFlags(args.slice(1), {
    valueFlags: ["--name", "--template", "--execution", "--cpu", "--memory-mib", "--persistence", "--network"],
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
  const executionDefault = flags.get("--execution")?.[0];
  if (executionDefault !== undefined && !["native", "v8", "auto"].includes(executionDefault)) throw new Error("--execution must be native, v8, or auto.");
  const cpu = parseNumberFlag(flags.get("--cpu")?.[0], "--cpu");
  const memoryMiB = parseNumberFlag(flags.get("--memory-mib")?.[0], "--memory-mib");
  const resources = cpu !== undefined || memoryMiB !== undefined ? { ...(cpu !== undefined ? { cpu } : {}), ...(memoryMiB !== undefined ? { memoryMiB } : {}) } : undefined;
  const name = flags.get("--name")?.[0];
  const environment = await clientFromEnv().environments.create({
    ...(name === undefined ? {} : { name }),
    template: flags.get("--template")?.[0] ?? "general",
    ...(executionDefault === undefined ? {} : { execution: { default: executionDefault as "native" | "v8" | "auto" } }),
    persistence,
    settings: {
      ...(network === undefined ? {} : { network: { mode: network as "internet" | "disabled" } }),
      ...(resources ? { resources } : {}),
    },
  });
  const record = environment.describe();
  console.log(json ? JSON.stringify(record, null, 2) :
    `${environment.id} — ${typeof environment.persistence === "string" ? environment.persistence : "custom"}; internet ${record.settings.network?.mode === "internet" ? "enabled" : "disabled"}\nNext: putered environments exec ${environment.id} -- 'pwd'`);
}
