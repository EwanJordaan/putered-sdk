import { z } from "zod";
import { assetId, assetIdSchema, assetPlatformSchema, defineAsset, entrypointsSchema,
  type AssetPlatform, type AssetReference, type AssetUpload } from "../asset-contract.js";
import { PuteredError } from "../errors.js";
import { canonical } from "../json.js";
import { inputContract } from "./input-contract.js";
import { assetReferenceResponseSchema, assetSummaryResponseSchema, assetUploadResponseSchema, cancelledResponseSchema } from "./responses.js";
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
    inputContract(assetIdSchema, id);
    const reference = await this.transport.request(`/assets/${id}`, "GET", assetReferenceResponseSchema);
    if (reference.id !== id) throw new PuteredError("Asset ID mismatch.", "PROTOCOL_ERROR");
    return defineAsset(reference);
  }
  async list() { return this.transport.request("/assets", "GET", z.array(assetSummaryResponseSchema)); }
  async cancel(id: string): Promise<void> {
    inputContract(assetIdSchema, id);
    await this.transport.request(`/assets/${id}/upload`, "DELETE", cancelledResponseSchema);
  }
  async status(id: string) {
    inputContract(assetIdSchema, id);
    const result = await this.transport.request(`/assets/${id}/upload`, "GET", assetUploadResponseSchema);
    if (result.id !== id) throw new PuteredError("Asset status ID mismatch.", "PROTOCOL_ERROR");
    return result;
  }
  async upload<const K extends string>(source: string, options: AssetUploadOptions<K>): Promise<AssetReference<K>> {
    const { scanAsset, uploadFiles } = await import("./asset-files.js");
    const platform = inputContract(assetPlatformSchema, options.platform);
    const entrypoints = inputContract(entrypointsSchema, options.entrypoints);
    const { manifest, paths } = await scanAsset(source, platform, entrypoints, options.signal);
    const id = assetId(manifest);
    const totalBytes = manifest.files.reduce((sum, file) => sum + file.bytes, 0);
    let previous: AssetUpload | undefined;
    const checked = (upload: AssetUpload) => {
      if (upload.id !== id || canonical(upload.manifest) !== canonical(manifest))
        throw new PuteredError("Upload manifest mismatch.", "PROTOCOL_ERROR");
      if (previous && manifest.files.some(file => upload.offsets[file.sha256] < previous!.offsets[file.sha256]))
        throw new PuteredError("Upload offsets moved backwards.", "PROTOCOL_ERROR");
      if (upload.state === "failed") throw new PuteredError(upload.error ?? "Asset upload failed.", "PACKAGE_INVALID");
      previous = upload;
      options.onProgress?.({ id, state: upload.state,
        completedBytes: manifest.files.reduce((sum, file) => sum + upload.offsets[file.sha256], 0),
        totalBytes });
      return upload;
    };
    let upload = checked(await this.transport.request("/assets/uploads", "POST", assetUploadResponseSchema, { manifest }, options.signal));
    if (upload.state !== "ready") {
      upload = await uploadFiles(manifest, paths, upload, async (file, offset, bytes) => checked(await this.transport.request(
        `/assets/${id}/upload/${file.sha256}/${offset}`, "PUT", assetUploadResponseSchema, undefined, options.signal, bytes)), options.signal);
    }
    const result = await this.transport.request(`/assets/${id}/upload/complete`, "POST", assetReferenceResponseSchema, {}, options.signal);
    if (result.id !== id || result.platform !== platform || canonical(result.entrypoints) !== canonical(entrypoints))
      throw new PuteredError("Published asset mismatch.", "PROTOCOL_ERROR");
    options.onProgress?.({ id, state: "ready", completedBytes: totalBytes, totalBytes });
    return defineAsset(result) as AssetReference<K>;
  }
}
