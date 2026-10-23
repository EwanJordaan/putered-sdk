import { z } from "zod";
import { environmentSchema, environmentSettingsSchema, storedToolSchema } from "../tool-contract.js";
import { assetId, assetReferenceSchema, assetSummarySchema, assetUploadSchema } from "../asset-contract.js";
import { presetId, presetSchema } from "../preset-contract.js";
import { MAX_BYTES } from "../limits.js";
import { jsonValue } from "../json.js";

// Ignore additive envelope metadata, never unknown request/policy/manifest fields.
export const environmentResponseSchema = environmentSchema.strip();
export const storedToolResponseSchema = storedToolSchema.strip().superRefine((value, ctx) => {
  try { jsonValue(value.manifest); }
  catch { ctx.addIssue({ code: "custom", message: "Tool manifest must contain bounded JSON data." }); }
});
export const assetReferenceResponseSchema = assetReferenceSchema.strip();
export const assetSummaryResponseSchema = assetSummarySchema.strip();
export const cancelledResponseSchema = z.object({ cancelled: z.literal(true) });
export const toolCallResponseSchema = z.object({ output: z.unknown() });

export const assetUploadResponseSchema = assetUploadSchema.strip().superRefine((value, ctx) => {
  const files = new Map(value.manifest.files.map(file => [file.sha256, file]));
  if (assetId(value.manifest) !== value.id)
    ctx.addIssue({ code: "custom", message: "Upload ID does not match its manifest." });
  if (Object.keys(value.offsets).length !== files.size || Object.keys(value.offsets).some(hash => !files.has(hash)))
    ctx.addIssue({ code: "custom", message: "Upload offsets do not match its files." });
  for (const [hash, file] of files) {
    const offset = value.offsets[hash];
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > file.bytes ||
        (offset !== file.bytes && offset % value.chunkBytes !== 0) ||
        (["ready", "validating"].includes(value.state) && offset !== file.bytes))
      ctx.addIssue({ code: "custom", message: "Invalid upload offset or state." });
  }
});

export const presetResponseSchema = presetSchema.extend({
  defaults: presetSchema.shape.defaults.unwrap().extend({ settings: environmentSettingsSchema }).optional(),
}).strip().superRefine((value, ctx) => {
  if (presetId(value.name, value.archiveSha256) !== value.id)
    ctx.addIssue({ code: "custom", message: "Preset ID does not match its name and archive." });
});

const count = z.number().int().nonnegative();
const duration = z.number().nonnegative();
export const execResultSchema = z.object({
  stdout: z.string().max(MAX_BYTES), stdoutBase64: z.string().max(Math.ceil(MAX_BYTES / 3) * 4), stderr: z.string().max(MAX_BYTES),
  exitCode: z.number().int(), durationMs: duration, hostDurationMs: duration,
  allocationUsage: z.object({ enforced: z.literal(true), durationMs: count,
    cpuQuotaMicros: z.number().int().positive(), memoryBytes: z.number().int().positive() }).optional(),
  networkUsage: z.object({ sentBytes: count, receivedBytes: count, connections: count, limitBytes: count }).optional(),
  gitMetrics: z.array(z.object({ durationMs: duration, wasmMemoryBytes: count, helperCount: count })).optional(),
  pythonMetrics: z.object({
    backend: z.enum(["wasm", "native"]), warm: z.boolean(), sessionId: z.string().optional(),
    initMs: duration, executionMs: duration, rssBytes: count, cpuMicros: count.optional(), wasmMemoryBytes: count.optional(),
  }).optional(),
}).superRefine((value, ctx) => {
  const bytes = Buffer.from(value.stdoutBase64, "base64");
  if (bytes.length > MAX_BYTES || bytes.toString("base64") !== value.stdoutBase64 || bytes.toString("utf8") !== value.stdout)
    ctx.addIssue({ code: "custom", message: "Execution stdout does not match its base64 bytes." });
});
