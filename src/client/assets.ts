import { z } from "zod";
import { assetId, assetReferenceSchema, assetUploadSchema, assetSummarySchema, assetPlatformSchema, entrypointsSchema,
  type AssetPlatform, type AssetReference, type AssetUpload } from "../asset-contract.js";
import { defineAsset } from "../asset-definition.js";
import { PuteredError } from "../errors.js";
import { canonical } from "../json.js";
import type { Transport } from "./transport.js";

export interface AssetUploadOptions<K extends string> {
  platform: AssetPlatform;
  entrypoints: Readonly<Record<K, string>>;
  signal?: AbortSignal;
  onProgress?: (progress: { id: string; state: AssetUpload["state"]; completedBytes: number; totalBytes: number }) => void;
}
export class Assets {
  constructor(private readonly transport: Transport) {}
  async get(id: string): Promise<AssetReference> {
    if (!/^asset_[a-f0-9]{64}$/.test(id)) throw new PuteredError("Invalid asset ID.", "INVALID_INPUT");
    const reference = await this.transport.request(`/assets/${id}`, "GET", assetReferenceSchema);
    if (reference.id !== id) throw new PuteredError("Asset ID mismatch.", "PROTOCOL_ERROR");
    return defineAsset(reference);
  }
  async list() { return this.transport.request("/assets", "GET", z.array(assetSummarySchema)); }
  async cancel(id: string): Promise<void> {
    if (!/^asset_[a-f0-9]{64}$/.test(id)) throw new PuteredError("Invalid asset ID.", "INVALID_INPUT");
    await this.transport.request(`/assets/${id}/upload`, "DELETE", z.strictObject({ cancelled: z.literal(true) }));
  }
  async status(id: string) {
    if (!/^asset_[a-f0-9]{64}$/.test(id)) throw new PuteredError("Invalid asset ID.", "INVALID_INPUT");
    return this.transport.request(`/assets/${id}/upload`, "GET", assetUploadSchema);
  }
  async upload<const K extends string>(source: string, options: AssetUploadOptions<K>): Promise<AssetReference<K>> {
    const { scanAsset, uploadFiles } = await import("./asset-files.js");
    let platform: AssetPlatform, entrypoints: Record<string, string>;
    try { platform = assetPlatformSchema.parse(options.platform); entrypoints = entrypointsSchema.parse(options.entrypoints); }
    catch (error) { throw new PuteredError("Invalid asset upload options.", "INVALID_INPUT", { cause: error }); }
    const { manifest, paths } = await scanAsset(source, platform, entrypoints, options.signal);
    const id = assetId(manifest);
    const checked = (upload: AssetUpload) => {
      if (upload.id !== id || canonical(upload.manifest) !== canonical(manifest))
        throw new PuteredError("Upload manifest mismatch.", "PROTOCOL_ERROR");
      for (const file of manifest.files) {
        const offset = upload.offsets[file.sha256];
        if (!Number.isInteger(offset) || offset < 0 || offset > file.bytes ||
          (offset !== file.bytes && offset % upload.chunkBytes !== 0))
          throw new PuteredError("Invalid upload offset.", "PROTOCOL_ERROR");
      }
      options.onProgress?.({ id, state: upload.state,
        completedBytes: manifest.files.reduce((sum, file) => sum + upload.offsets[file.sha256], 0),
        totalBytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0) });
      return upload;
    };
    let upload = checked(await this.transport.request("/assets/uploads", "POST", assetUploadSchema, { manifest }, options.signal));
    if (upload.state !== "ready") {
      upload = await uploadFiles(manifest, paths, upload, async (file, offset, bytes) => checked(await this.transport.request(
        `/assets/${id}/upload/${file.sha256}/${offset}`, "PUT", assetUploadSchema, undefined, options.signal, bytes)), options.signal);
    }
    const result = await this.transport.request(`/assets/${id}/upload/complete`, "POST", assetReferenceSchema, {}, options.signal);
    if (result.id !== id || result.platform !== platform || canonical(result.entrypoints) !== canonical(entrypoints))
      throw new PuteredError("Published asset mismatch.", "PROTOCOL_ERROR");
    options.onProgress?.({ id, state: "ready", completedBytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0),
      totalBytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0) });
    return defineAsset(result) as AssetReference<K>;
  }
}
