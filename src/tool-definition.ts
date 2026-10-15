import { z } from "zod";
import { jsonValue } from "./json.js";
import { PuteredError } from "./errors.js";
import { defineAsset, type AssetExecutor } from "./asset-definition.js";
import type { AssetReference } from "./asset-contract.js";
export { defineAsset } from "./asset-definition.js";
export type { AssetReference, AssetPlatform } from "./asset-contract.js";
export type { AssetExecOptions, AssetExecResult } from "./asset-definition.js";
export { canonical, jsonValue } from "./json.js";
export type { Json } from "./json.js";

export type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
export function freezeRecord<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeRecord(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}
export interface ToolContext {
  readonly workspaceId: string;
  readonly signal: AbortSignal;
  /** Execute an entrypoint of an explicitly declared, attached binary asset. */
  readonly exec: AssetExecutor;
}
export type ToolRunContext = Omit<ToolContext, "exec"> & Partial<Pick<ToolContext, "exec">>;
export interface ToolDefinition<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  readonly input: I;
  readonly output: O;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema: Record<string, unknown>;
  run(input: unknown, context: ToolRunContext): Promise<z.output<O>>;
}
export type ToolMap = Readonly<Record<string, ToolDefinition>>;
export interface ToolManifest {
  name: string;
  version: string;
  execution: { backend: "v8" | "native" };
  assets?: Record<string, AssetReference>;
  tools: Record<string, {
    description?: string;
    inputSchema: Record<string, unknown>;
    outputSchema: Record<string, unknown>;
  }>;
}
export interface ToolPlugin<T extends ToolMap = ToolMap> {
  readonly name: string;
  readonly version: string;
  readonly tools: T;
  readonly manifest: DeepReadonly<ToolManifest>;
}

function wireSchema(schema: z.ZodType, io: "input" | "output") {
  try { return z.toJSONSchema(schema, { io, override: ({ zodSchema, jsonSchema }) => {
    const checks = zodSchema._zod.def.checks ?? [];
    const patterns = new Set<string>();
    for (const check of checks) {
      const definition = check._zod.def;
      if (!("format" in definition) || definition.format !== "regex") continue;
      if ("pattern" in definition && definition.pattern instanceof RegExp && definition.pattern.flags)
        throw new PuteredError("Regex flags cannot be represented in tool JSON schemas; use a flag-free pattern.", "PACKAGE_INVALID");
      if ("pattern" in definition && definition.pattern instanceof RegExp) patterns.add(definition.pattern.source);
    }
    // Custom Zod regex checks use plain JS regexes, whereas JSON Schema uses /u.
    const preservePattern = (part: Record<string, unknown>) => {
      if (typeof part.pattern === "string" && patterns.has(part.pattern)) {
        part["x-putered-pattern"] = part.pattern;
        delete part.pattern;
      }
    };
    preservePattern(jsonSchema);
    if (Array.isArray(jsonSchema.allOf)) for (const part of jsonSchema.allOf) preservePattern(part);
    // Zod counts UTF-16 units; JSON Schema minLength/maxLength count code points.
    if (jsonSchema.type === "string") {
      if (jsonSchema.minLength !== undefined) {
        jsonSchema["x-putered-minUtf16Length"] = jsonSchema.minLength;
        delete jsonSchema.minLength;
      }
      if (jsonSchema.maxLength !== undefined) {
        jsonSchema["x-putered-maxUtf16Length"] = jsonSchema.maxLength;
        delete jsonSchema.maxLength;
      }
    }
  } }); } catch (error) {
    if (error instanceof PuteredError) throw error;
    throw new PuteredError("Tool schemas must be JSON-representable.", "PACKAGE_INVALID", { cause: error });
  }
}

export function defineTool<I extends z.ZodType, O extends z.ZodType>(definition: {
  input: I;
  output: O;
  description?: string;
  handler: (input: z.output<I>, context: ToolContext) => z.input<O> | Promise<z.input<O>>;
}): ToolDefinition<I, O> {
  // JSON-representable schemas support validation on both sides of the HTTP boundary.
  const inputSchema = wireSchema(definition.input, "input");
  const outputSchema = wireSchema(definition.output, "output");
  return Object.freeze({
    input: definition.input,
    output: definition.output,
    description: definition.description,
    inputSchema,
    outputSchema,
    async run(input: unknown, context: ToolRunContext) {
      let parsed: z.output<I>;
      try { parsed = await definition.input.parseAsync(input); }
      catch (error) { throw new PuteredError("Tool input does not match its schema.", "INVALID_INPUT", { cause: error }); }
      const scopedContext: ToolContext = { ...context, exec: context.exec ?? (async () => {
        throw new PuteredError("Binary execution is unavailable in this context.", "POLICY_DENIED");
      }) };
      const result = await definition.handler(parsed, scopedContext);
      let output: z.output<O>;
      try { output = await definition.output.parseAsync(result); }
      catch (error) { throw new PuteredError("Tool output does not match its schema.", "INVALID_OUTPUT", { cause: error }); }
      try { return jsonValue(output, { maxBytes: 4 * 1024 * 1024 }) as z.output<O>; }
      catch (error) { throw new PuteredError(error instanceof Error ? error.message : "Tool output is not JSON.",
        error instanceof PuteredError && error.code === "PAYLOAD_TOO_LARGE" ? "PAYLOAD_TOO_LARGE" : "INVALID_OUTPUT", { cause: error }); }
    },
  });
}

const namePattern = /^[a-z][a-z0-9_-]{0,63}$/;
export function validName(name: unknown): name is string {
  return typeof name === "string" && namePattern.test(name) &&
    !["__proto__", "constructor", "prototype"].includes(name);
}
export function definePlugin<const T extends ToolMap>(definition: {
  name: string;
  version?: string;
  execution?: { backend: "v8" | "native" };
  assets?: Readonly<Record<string, AssetReference>>;
  tools: T;
}): ToolPlugin<T> {
  if (!validName(definition.name)) throw new PuteredError("Invalid tool plugin name.", "PACKAGE_INVALID");
  const version = definition.version ?? "unversioned";
  if (typeof version !== "string" || !version.length || version.length > 64)
    throw new PuteredError("Invalid tool plugin version.", "PACKAGE_INVALID");
  const backend = definition.execution?.backend ?? "v8";
  if (backend !== "v8" && backend !== "native") throw new PuteredError("Invalid tool backend.", "PACKAGE_INVALID");
  const assets = definition.assets && Object.fromEntries(Object.entries(definition.assets).map(([name, asset]) => {
    if (!validName(name)) throw new PuteredError("Invalid asset name.", "PACKAGE_INVALID");
    return [name, defineAsset(asset)];
  }));
  if (assets && (backend !== "native" || Object.keys(assets).length === 0 || Object.keys(assets).length > 16))
    throw new PuteredError("Binary assets require a native plugin and 1–16 references.", "PACKAGE_INVALID");
  const entries = Object.entries(definition.tools);
  if (!entries.length || entries.length > 32) throw new PuteredError("A plugin needs 1–32 tools.", "PACKAGE_INVALID");
  const tools: ToolManifest["tools"] = {};
  for (const [name, tool] of entries) {
    if (!validName(name) || !tool || typeof tool.run !== "function")
      throw new PuteredError("Invalid tool definition.", "PACKAGE_INVALID");
    tools[name] = {
      ...(tool.description === undefined ? {} : { description: tool.description }),
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
    };
  }
  return Object.freeze({
    name: definition.name,
    version,
    tools: Object.freeze({ ...definition.tools }) as T,
    manifest: freezeRecord({ name: definition.name, version, execution: { backend }, tools, ...(assets ? { assets } : {}) }),
  });
}
