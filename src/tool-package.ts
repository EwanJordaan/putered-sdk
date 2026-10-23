import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type ToolPlugin } from "./tool-definition.js";
import { artifactId, artifactSchema } from "./tool-contract.js";
import { pluginDeclarations } from "./tool-declarations.js";
import { PuteredError } from "./errors.js";
export { attachPackage, packageOf } from "./tool-artifact.js";


/** Bundle module source and imports, not live functions or captured application state. */
export async function buildPlugin(entrypoint: string, outfile: string): Promise<string> {
  try { return await bundlePlugin(entrypoint, outfile); }
  catch (error) {
    if (error instanceof PuteredError) throw error;
    throw new PuteredError(error instanceof Error ? error.message : "Plugin build failed.", "PACKAGE_INVALID", { cause: error });
  }
}

async function bundlePlugin(entrypoint: string, outfile: string): Promise<string> {
  if (!outfile.endsWith(".mjs") || resolve(entrypoint) === resolve(outfile))
    throw new Error("Plugin output must be a distinct .mjs file.");
  const result = await build({
    entryPoints: [resolve(entrypoint)], bundle: true, write: false,
    format: "esm", platform: "node", target: "node22", minify: true,
    legalComments: "eof", metafile: true,
    // Bundled CommonJS dependencies can require Node builtins. V8 packages
    // still reject external builtin dependencies below and runtime grants stay closed.
    banner: { js: 'import { createRequire as __puteredCreateRequire } from "node:module"; const require = __puteredCreateRequire(process.cwd() + "/putered-tool.mjs");' },
  });
  const code = result.outputFiles[0].text;
  const uri = `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
  const loaded: { default?: ToolPlugin } = await import(uri);
  if (!loaded.default) throw new Error("Plugin entrypoint must export a default definePlugin result.");
  const artifact = artifactSchema.parse({ format: 1, target: "node22", manifest: loaded.default.manifest, code });
  if (artifact.manifest.execution.backend === "v8" &&
      Object.values(result.metafile.outputs).some(output => output.imports.some(item => item.external)))
    throw new Error("V8 tool packages must bundle their dependencies; native imports are not supported.");
  // Declaration diagnostics fail before replacing the runnable artifact.
  await pluginDeclarations(entrypoint, outfile);
  await mkdir(dirname(resolve(outfile)), { recursive: true });
  await writeFile(outfile,
    `// Generated tool package. Rebuild from source to change it.\n` +
    `import { attachPackage } from "@putered/sdk/packaging";\n` +
    `const { default: plugin } = await import(${JSON.stringify(uri)});\n` +
    `export default attachPackage(plugin, ${JSON.stringify(artifact)});\n`);
  return artifactId(artifact);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [entrypoint, outfile] = process.argv.slice(2);
  if (!entrypoint || !outfile) {
    console.error("Usage: putered plugin build <plugin.ts> <plugin.mjs>");
    process.exitCode = 2;
  } else {
    await buildPlugin(entrypoint, outfile).then(id => console.log(id)).catch(error => {
      console.error(error instanceof Error ? error.message : "Plugin build failed.");
      process.exitCode = 1;
    });
  }
}
