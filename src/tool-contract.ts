import { z } from "zod";
import { createHash } from "node:crypto";
import { canonical, validName } from "./tool-definition.js";
import { assetReferenceSchema } from "./asset-contract.js";
import { presetIdSchema, presetSaveScopeSchema } from "./preset-contract.js";
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
  saveScope: presetSaveScopeSchema.optional(),
  git: z.boolean().optional(),
  execution: z.strictObject({ mode: z.enum(["auto", "isolate-only", "native-only"]) }).optional(),
  network: z.discriminatedUnion("mode", [
    z.strictObject({ mode: z.literal("disabled") }),
    internetPolicySchema,
  ]).optional(),
  timeoutMs: z.number().int().min(1).max(300000).optional(),
});
export const environmentSchema = z.strictObject({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),
  tools: z.array(toolIdSchema).max(64),
  settings: environmentSettingsSchema,
  template: presetIdSchema.optional(),
});
export type EnvironmentRecord = z.infer<typeof environmentSchema>;
export const createEnvironmentSchema = z.strictObject({
  template: z.union([z.literal("general"), presetIdSchema]).optional(),
  tools: z.array(toolIdSchema).max(64).optional(),
  settings: environmentSettingsSchema.optional(),
});
export const callOptionsSchema = z.strictObject({
  wait: z.literal(true).optional(),
  timeoutMs: z.number().int().min(1).max(300000).optional(),
});
export function artifactId(artifact: ToolArtifact): string {
  return `tool_${createHash("sha256").update(canonical(artifact)).digest("hex")}`;
}
