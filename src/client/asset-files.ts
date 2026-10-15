import { constants } from "node:fs";
import { lstat, readdir, realpath, open } from "node:fs/promises";
import { basename, join, resolve, relative } from "node:path";
import { createHash } from "node:crypto";
import { assetManifestSchema, safeAssetPath, type AssetManifest, type AssetPlatform, type AssetFile, type AssetUpload,
  ASSET_MAX_BYTES } from "../asset-contract.js";
import { PuteredError } from "../errors.js";

function cancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new PuteredError("Asset upload cancelled; verified parts can be resumed.", "CANCELLED");
}
export async function scanAsset(source: string, platform: AssetPlatform, entrypoints: Record<string, string>, signal?: AbortSignal) {
  if (typeof source !== "string" || !source.trim()) throw new PuteredError("Asset source must be a file or directory path.", "INVALID_INPUT");
  const files: AssetFile[] = [], paths = new Map<string, string>();
  let total = 0;
  const absolute = resolve(source);
  let root: string;
  try {
    if ((await lstat(absolute)).isSymbolicLink()) throw new PuteredError("Asset sources cannot be symlinks.", "INVALID_INPUT");
    root = await realpath(absolute);
  } catch (error) {
    if (error instanceof PuteredError) throw error;
    throw new PuteredError("Could not read asset source.", "INVALID_INPUT", { cause: error });
  }
  async function visit(path: string, name: string) {
    cancelled(signal);
    if (name && !safeAssetPath(name)) throw new PuteredError("Unsupported asset path.", "INVALID_INPUT");
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new PuteredError("Asset uploads currently require regular files; symlinks are unsupported.", "INVALID_INPUT");
    if (info.isDirectory()) {
      for (const child of (await readdir(path)).sort()) await visit(join(path, child), name ? `${name}/${child}` : child);
      return;
    }
    if (!info.isFile() || files.length >= 8192 || info.size > 512 * 1024 * 1024 || (total += info.size) > ASSET_MAX_BYTES)
      throw new PuteredError("Asset contains unsupported files or exceeds upload limits.", "PAYLOAD_TOO_LARGE");
    const resolved = await realpath(path);
    if (root !== resolved && relative(root, resolved).startsWith(".."))
      throw new PuteredError("Asset file escaped its source directory.", "INVALID_INPUT");
    const digest = createHash("sha256");
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { for await (const chunk of handle.createReadStream({ signal, autoClose: false })) digest.update(chunk); }
    finally { await handle.close(); }
    const file = { path: name, bytes: info.size, sha256: digest.digest("hex"),
      executable: !!(info.mode & 0o111) || Object.values(entrypoints).includes(name) };
    files.push(file); paths.set(file.sha256, path);
  }
  try {
    const info = await lstat(root);
    await visit(root, info.isDirectory() ? "" : basename(root));
    files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    return { manifest: assetManifestSchema.parse({ format: 1, platform, entrypoints, files }), paths };
  } catch (error) {
    cancelled(signal);
    if (error instanceof PuteredError) throw error;
    throw new PuteredError("Could not read or validate asset files.", "INVALID_INPUT", { cause: error });
  }
}
export async function uploadFiles(manifest: AssetManifest, paths: Map<string, string>, upload: AssetUpload,
  part: (file: AssetFile, offset: number, bytes: Uint8Array) => Promise<AssetUpload>, signal?: AbortSignal) {
  for (const file of manifest.files) {
    cancelled(signal);
    if (upload.offsets[file.sha256] === file.bytes) continue;
    const handle = await open(paths.get(file.sha256)!, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      while (upload.offsets[file.sha256] < file.bytes) {
        cancelled(signal);
        const offset = upload.offsets[file.sha256];
        const bytes = Buffer.alloc(Math.min(upload.chunkBytes, file.bytes - offset));
        let read = 0;
        while (read < bytes.length) {
          const result = await handle.read(bytes, read, bytes.length - read, offset + read);
          if (!result.bytesRead) throw new PuteredError("Asset source changed during upload.", "INVALID_INPUT");
          read += result.bytesRead;
        }
        upload = await part(file, offset, bytes);
      }
    } finally { await handle.close(); }
  }
  return upload;
}
