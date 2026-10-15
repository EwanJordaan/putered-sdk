import { canonical, type ToolMap, type ToolPlugin } from "./tool-definition.js";
import { artifactSchema, type ToolArtifact } from "./tool-contract.js";
import { PuteredError } from "./errors.js";

const packageSymbol = Symbol.for("putered.tool-package.v1");
type Packaged<T extends ToolMap> = ToolPlugin<T> & { [packageSymbol]: ToolArtifact };
function parsedArtifact(value: unknown): ToolArtifact {
  try { return artifactSchema.parse(value); }
  catch (error) { throw new PuteredError("Invalid plugin artifact.", "PACKAGE_INVALID", { cause: error }); }
}
export function attachPackage<T extends ToolMap>(plugin: ToolPlugin<T>, value: unknown): ToolPlugin<T> {
  const artifact = parsedArtifact(value);
  if (canonical(plugin.manifest) !== canonical(artifact.manifest))
    throw new PuteredError("Plugin definition does not match its package manifest.", "PACKAGE_INVALID");
  return Object.freeze({ ...plugin, [packageSymbol]: artifact });
}
export function packageOf<T extends ToolMap>(plugin: ToolPlugin<T>): ToolArtifact {
  const artifact = (plugin as Partial<Packaged<T>>)[packageSymbol];
  if (!artifact) throw new PuteredError("Build this plugin with npm run build:plugin before tools.use(plugin).", "PACKAGE_INVALID");
  const parsed = parsedArtifact(artifact);
  if (canonical(plugin.manifest) !== canonical(parsed.manifest))
    throw new PuteredError("Plugin changed after packaging; rebuild it.", "PACKAGE_INVALID");
  return parsed;
}
