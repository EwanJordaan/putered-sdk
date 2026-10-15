#!/usr/bin/env node
import { lstat, writeFile } from "node:fs/promises";
import { Putered } from "./sdk.js";
import { assetPlatformSchema } from "../asset-contract.js";

async function main() {
  const [group, action, source, ...args] = process.argv.slice(2);
  if (group === "plugin" && action === "build") {
    if (!source || args.length !== 1) throw new Error("Usage: putered plugin build <plugin.ts> <plugin.mjs>");
    const { buildPlugin } = await import("../tool-package.js");
    console.log(await buildPlugin(source, args[0]));
    return;
  }
  if (group !== "assets" || action !== "upload" || !source) throw new Error(
    "Usage: putered assets upload <file-or-directory> --platform linux-x64 --entrypoint name=path [--entrypoint ...] [--output tool.asset.ts]");
  const entrypoints: Record<string, string> = {};
  let platform: string | undefined, output: string | undefined;
  for (let index = 0; index < args.length; index += 2) {
    const [flag, value] = args.slice(index, index + 2);
    if (!value) throw new Error("CLI options require a value.");
    if (flag === "--platform") platform = value;
    else if (flag === "--output") output = value;
    else if (flag === "--entrypoint") {
      const split = value.indexOf("=");
      if (split <= 0 || Object.hasOwn(entrypoints, value.slice(0, split))) throw new Error("Entrypoints use unique name=relative/path values.");
      entrypoints[value.slice(0, split)] = value.slice(split + 1);
    } else throw new Error(`Unknown CLI option: ${flag}`);
  }
  if (output) {
    if (!output.endsWith(".ts")) throw new Error("Asset references must be saved as a .ts source file.");
    try { await lstat(output); throw new Error("Output already exists; choose another source file."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const client = new Putered({ baseUrl: process.env.PUTERED_BASE_URL ?? "http://127.0.0.1:3000", apiKey: process.env.PUTERED_API_KEY ?? "" });
  const reference = await client.assets.upload(source, { platform: assetPlatformSchema.parse(platform), entrypoints });
  if (output) {
    await writeFile(output, `// Stored bytes only; tool schemas and handlers stay in your codebase.\nimport { defineAsset } from "@putered/sdk/plugins";\nexport default defineAsset(${JSON.stringify(reference, null, 2)});\n`, { flag: "wx" });
  }
  console.log(JSON.stringify(reference, null, 2));
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Upload failed."); process.exitCode = 1; });
