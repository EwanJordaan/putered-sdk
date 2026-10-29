import { z } from "zod";
import { createHash } from "node:crypto";
import { canonical, validName } from "./tool-definition.js";
import { assetReferenceSchema } from "./asset-contract.js";
import { presetIdSchema } from "./preset-contract.js";
import { persistenceSchema } from "./persistence-contract.js";
import { internetPolicySchema } from "./network-policy.js";

const name = z.string().refine(validName);
const schema = z.record(z.string(), z.unknown());
export const manifestSchema = z.strictObject({
  name,
  version: z.string().min(1).max(64),
  execution: z.strictObject({ backend: z.enum(["v8", "native"]) }),
  assets: z.record(name, assetReferenceSchema).refine(assets => Object.keys(assets).length > 0 && Object.keys(assets).length <= 16).optional(),
  tools: z.record(name, z.strictObject({
    description: z.string().max(1024).optional(),
    inputSchema: schema,
    outputSchema: schema,
  })).refine(tools => Object.keys(tools).length > 0 && Object.keys(tools).length <= 32),
}).refine(value => !value.assets || value.execution.backend === "native", "Binary assets require native execution.");
export const artifactSchema = z.strictObject({
  format: z.literal(1),
  target: z.literal("node22"),
  manifest: manifestSchema,
  code: z.string().min(1).max(2 * 1024 * 1024),
});
export type ToolArtifact = z.infer<typeof artifactSchema>;
export const toolIdSchema = z.string().regex(/^tool_[a-f0-9]{64}$/);
export const storedToolSchema = z.strictObject({
  id: toolIdSchema,
  visibility: z.literal("private"),
  manifest: manifestSchema,
});
export type StoredTool = z.infer<typeof storedToolSchema>;
export const toolOptionsSchema = z.strictObject({ visibility: z.literal("private").optional() });
export const environmentSettingsSchema = z.strictObject({
  git: z.boolean().optional(),
  execution: z.strictObject({ mode: z.enum(["auto", "isolate-only", "native-only"]), allowSudo: z.boolean().optional() }).optional(),
  network: z.discriminatedUnion("mode", [
    z.strictObject({ mode: z.literal("disabled") }),
    internetPolicySchema,
  ]).optional(),
  timeoutMs: z.number().int().min(1).max(300000).optional(),
});
export const executionPreferenceSchema = z.strictObject({
  default: z.enum(["auto", "native", "v8"]).optional(),
  programs: z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), z.enum(["auto", "native", "v8"])).optional(),
});
export const environmentSchema = z.strictObject({
  persistence: persistenceSchema.optional(),
  execution: executionPreferenceSchema.optional(),
  name: z.string().min(1).max(100).refine(value => value === value.trim(), "Environment names must be trimmed.").optional(),
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),
  tools: z.array(toolIdSchema).max(64),
  settings: environmentSettingsSchema,
  template: presetIdSchema.optional(),
});
export type EnvironmentRecord = z.infer<typeof environmentSchema>;
export const createEnvironmentSchema = z.strictObject({
  persistence: persistenceSchema.optional(),
  execution: executionPreferenceSchema.optional(),
  name: z.string().trim().min(1).max(100).optional(),
  template: z.union([z.literal("general"), presetIdSchema]).optional(),
  tools: z.array(toolIdSchema).max(64).optional(),
  settings: environmentSettingsSchema.optional(),
});
export const callOptionsSchema = z.strictObject({
  wait: z.literal(true).optional(),
  timeoutMs: z.number().int().min(1).max(300000).optional(),
});
export const runCommandSchema = z.strictObject({
  program: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  args: z.array(z.string().refine(value => !value.includes("\0"), "Arguments must not contain NUL."))
    .max(4096).default([]),
  cwd: z.string().min(1).refine(value => !value.includes("\0") &&
    (value === "/workspace" || value.startsWith("/workspace/")) && !value.split("/").includes(".."),
    "Working directory must stay inside /workspace.").optional(),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().refine(value => !value.includes("\0"))).optional(),
  stdinBase64: z.string().max(87384).refine(value => value.length % 4 === 0 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value) &&
    Buffer.from(value, "base64").toString("base64") === value, "stdinBase64 must be canonical base64.").optional(),
  stdinOpen: z.literal(true).optional(),
  sudo: z.boolean().optional(),
}).superRefine((value, context) => {
  if (Buffer.byteLength(JSON.stringify({ program: value.program, args: value.args }), "utf8") > 65536)
    context.addIssue({ code: "custom", message: "Program and arguments exceed 64 KiB." });
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 256 * 1024)
    context.addIssue({ code: "custom", message: "Command input exceeds 256 KiB." });
  if (value.env && Buffer.byteLength(JSON.stringify(value.env), "utf8") > 64 * 1024)
    context.addIssue({ code: "custom", message: "Command environment exceeds 64 KiB." });
  if (value.stdinBase64 && Buffer.from(value.stdinBase64, "base64").byteLength > 64 * 1024)
    context.addIssue({ code: "custom", message: "Command stdin exceeds 64 KiB." });
  if (value.stdinBase64 !== undefined && value.stdinOpen)
    context.addIssue({ code: "custom", message: "Static stdin and open stdin are mutually exclusive." });
});
export function artifactId(artifact: ToolArtifact): string {
  return `tool_${createHash("sha256").update(canonical(artifact)).digest("hex")}`;
}
