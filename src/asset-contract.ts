import { z } from "zod";
import { createHash } from "node:crypto";
import { canonical } from "./json.js";

export const ASSET_CHUNK_BYTES = 4 * 1024 * 1024;
export const ASSET_MAX_BYTES = 1024 * 1024 * 1024;
export const assetIdSchema = z.string().regex(/^asset_[a-f0-9]{64}$/);
export const assetPlatformSchema = z.enum(["linux-x64", "linux-arm64"]);
export function safeAssetPath(path: string): boolean {
  return path.length > 0 && path.length <= 512 && !/[\\\x00-\x1f\x7f]/.test(path) &&
    !path.startsWith("/") && path.split("/").every(part => part !== "" && part !== "." && part !== "..");
}
export const assetPathSchema = z.string().refine(safeAssetPath, "Expected a relative asset path without traversal.");
export const entrypointsSchema = z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)
  .refine(name => !["constructor", "prototype", "__proto__"].includes(name)), assetPathSchema)
  .refine(value => Object.keys(value).length > 0 && Object.keys(value).length <= 64);
export const assetReferenceSchema = z.strictObject({
  id: assetIdSchema, platform: assetPlatformSchema, entrypoints: entrypointsSchema,
});
export type AssetPlatform = z.infer<typeof assetPlatformSchema>;
export interface AssetReference<K extends string = string> {
  readonly id: string;
  readonly platform: AssetPlatform;
  readonly entrypoints: Readonly<Record<K, string>>;
}
export const assetFileSchema = z.strictObject({
  path: assetPathSchema, bytes: z.number().int().min(0).max(512 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), executable: z.boolean(),
});
export const assetManifestSchema = z.strictObject({
  format: z.literal(1), platform: assetPlatformSchema, entrypoints: entrypointsSchema,
  files: z.array(assetFileSchema).min(1).max(8192),
}).superRefine((value, ctx) => {
  if (Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024)
    ctx.addIssue({ code: "custom", message: "Asset manifest exceeds 1 MiB." });
  const files = new Map(value.files.map(file => [file.path, file]));
  const sizes = new Map<string, number>();
  if (files.size !== value.files.length || value.files.reduce((sum, file) => sum + file.bytes, 0) > ASSET_MAX_BYTES)
    ctx.addIssue({ code: "custom", message: "Duplicate files or asset exceeds 1 GiB." });
  for (const file of value.files) {
    if (sizes.has(file.sha256) && sizes.get(file.sha256) !== file.bytes)
      ctx.addIssue({ code: "custom", message: "Identical digests must have identical sizes." });
    sizes.set(file.sha256, file.bytes);
    const parts = file.path.split("/");
    for (let i = 1; i < parts.length; i++) if (files.has(parts.slice(0, i).join("/")))
      ctx.addIssue({ code: "custom", message: "An asset file cannot also be a directory." });
  }
  for (const path of Object.values(value.entrypoints)) if (!files.get(path)?.executable)
    ctx.addIssue({ code: "custom", message: "Every entrypoint must name an executable file." });
});
export type AssetManifest = z.infer<typeof assetManifestSchema>;
export type AssetFile = z.infer<typeof assetFileSchema>;
export function assetId(manifest: AssetManifest): string {
  return `asset_${createHash("sha256").update(canonical({ ...manifest,
    files: [...manifest.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) })).digest("hex")}`;
}
export function assetReference(manifest: AssetManifest): AssetReference {
  return { id: assetId(manifest), platform: manifest.platform, entrypoints: manifest.entrypoints };
}
export const assetUploadSchema = z.strictObject({
  id: assetIdSchema, state: z.enum(["uploading", "validating", "ready", "failed"]),
  manifest: assetManifestSchema, offsets: z.record(z.string(), z.number().int().min(0)),
  chunkBytes: z.literal(ASSET_CHUNK_BYTES), error: z.string().optional(),
});
export type AssetUpload = z.infer<typeof assetUploadSchema>;
export const assetSummarySchema = z.strictObject({
  ...assetReferenceSchema.shape, state: assetUploadSchema.shape.state,
  totalBytes: z.number().int().min(0).max(ASSET_MAX_BYTES), error: z.string().optional(),
});
