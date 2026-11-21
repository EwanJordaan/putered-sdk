#!/usr/bin/env node
import { lstat, writeFile } from "node:fs/promises";
import { PuteredError } from "./sdk.js";
import { clientFromEnv, parseCliFlags, withSignalAbort } from "./cli-helpers.js";
import { runPresetCli, presetUsage } from "./preset-cli.js";
import { runEnvironmentCli, environmentUsage } from "./environment-cli.js";
import { assetPlatformSchema } from "../asset-contract.js";

async function main() {
  if (["--help", "help"].includes(process.argv[2])) {
    console.log(`Usage: putered assets upload <file-or-directory> --platform linux-x64 --entrypoint name=path [--output tool.asset.ts] [--json]\n       putered plugin build <plugin.ts> <plugin.mjs>\n\n${environmentUsage}\n\n${presetUsage}`);
    return;
  }
  if (process.argv[2] === "presets") return runPresetCli(process.argv.slice(3));
  if (process.argv[2] === "environments") return runEnvironmentCli(process.argv.slice(3));
  const [group, action, source, ...args] = process.argv.slice(2);
  if (group === "plugin" && action === "build") {
    if (!source || args.length !== 1) throw new Error("Usage: putered plugin build <plugin.ts> <plugin.mjs>");
    const { buildPlugin } = await import("../tool-package.js");
    console.log(await buildPlugin(source, args[0]));
    return;
  }
  if (group !== "assets" || action !== "upload" || !source) throw new Error(
    "Usage: putered assets upload <file-or-directory> --platform linux-x64 --entrypoint name=path [--entrypoint ...] [--output tool.asset.ts]\n       putered presets --help");
  const { flags, booleans } = parseCliFlags(args, {
    valueFlags: ["--platform", "--output"],
    repeatableFlags: ["--entrypoint"],
    booleanFlags: ["--json"],
    allowPositionals: false,
  });
  const entrypoints: Record<string, string> = {};
  for (const value of flags.get("--entrypoint") ?? []) {
    const split = value.indexOf("=");
    if (split <= 0 || Object.hasOwn(entrypoints, value.slice(0, split))) throw new Error("Entrypoints use unique name=relative/path values.");
    entrypoints[value.slice(0, split)] = value.slice(split + 1);
  }
  const platform = flags.get("--platform")?.[0];
  const output = flags.get("--output")?.[0];
  const json = booleans.has("--json");
  if (output) {
    if (!output.endsWith(".ts")) throw new Error("Asset references must be saved as a .ts source file.");
    try { await lstat(output); throw new Error("Output already exists; choose another source file."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const client = clientFromEnv();
  const reference = await withSignalAbort(signal =>
    client.assets.upload(source, { platform: assetPlatformSchema.parse(platform), entrypoints, signal }));
  if (output) {
    await writeFile(output, `// Stored bytes only; tool schemas and handlers stay in your codebase.\nimport { defineAsset } from "@putered/sdk/plugins";\nexport default defineAsset(${JSON.stringify(reference, null, 2)});\n`, { flag: "wx" });
  }
  console.log(json ? JSON.stringify(reference, null, 2) : `Uploaded ${reference.id}${output ? ` → ${output}` : " (use --json for the complete reference)"}`);
}
main().catch(error => {
  console.error(error instanceof PuteredError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : "Command failed.");
  process.exitCode = error instanceof PuteredError && error.code === "CANCELLED" ? 130 : 1;
});
