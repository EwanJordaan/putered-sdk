import { z } from "zod";
import { safeAssetPath } from "./asset-contract.js";
import { createHash } from "node:crypto";
import { canonical } from "./json.js";

export const presetId = (name: string, archiveSha256: string) =>
  `preset_${createHash("sha256").update(canonical({ name, archiveSha256 })).digest("hex")}`;

export const PRESET_MAX_BYTES = 1024 * 1024 * 1024;
export const PRESET_MAX_EXPANDED_BYTES = 2 * PRESET_MAX_BYTES;
export const presetIdSchema = z.string().regex(/^preset_[a-f0-9]{64}$/);
export const presetNameSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/);
// Read old stored records; compression is no longer an accepted capture option.
export const presetCompressionSchema = z.enum(["larger-image", "smaller-image"]);
export const presetSaveScopeSchema = z.enum(["entire-environment", "workspace-only"]);
export const capturePresetSchema = z.strictObject({
  name: presetNameSchema,
  // Compatibility for existing callers. New clients select persistence at environment creation.
  mode: z.enum(["complete", "state"]).optional(),
  // Explicit opt-in; "." selects a whole tree. Known credentials are still excluded.
  workspace: z.array(z.string().refine(path => path === "." || safeAssetPath(path))).max(128).default([]),
  home: z.array(z.string().refine(path => path === "." || safeAssetPath(path))).max(128).default([]),
});
export function captureScope(options: z.infer<typeof capturePresetSchema>, environmentScope: PresetSaveScope = "entire-environment"): "complete" | "workspace-only" | "state" {
  if (options.mode === "state") return "state";
  return environmentScope === "workspace-only" ? "workspace-only" : "complete";
}
export const presetSchema = z.strictObject({
  id: presetIdSchema, name: presetNameSchema,
  format: z.literal("oci"), state: z.literal("ready"), visibility: z.literal("private"),
  platform: z.strictObject({ os: z.literal("linux"), architecture: z.enum(["amd64", "arm64"]) }),
  manifestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  archiveSha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().min(1024).max(PRESET_MAX_BYTES),
  source: z.enum(["upload", "capture"]),
  runtime: z.literal("general").optional(),
  environmentId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/).optional(),
  compression: presetCompressionSchema.optional(),
  captureScope: z.enum(["complete", "workspace-only", "state"]).optional(),
  defaults: z.strictObject({
    tools: z.array(z.string().regex(/^tool_[a-f0-9]{64}$/)).max(64),
    settings: z.record(z.string(), z.unknown()),
  }).optional(),
});
export type Preset = z.infer<typeof presetSchema>;
export type PresetSaveScope = z.infer<typeof presetSaveScopeSchema>;
