import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { z } from "zod";
import { environmentSettingsSchema } from "../tool-contract.js";
import { PuteredError } from "../errors.js";
import { persistenceSchema } from "../persistence-contract.js";

export const SDK_CONFIG_FILE = "putered.config.json";
const schema = z.strictObject({ network: environmentSettingsSchema.shape.network, persistence: persistenceSchema.optional() });
export type SdkConfig = z.input<typeof schema>;

/** One local config per SDK client. No ancestor/global config or remote file access. */
export function loadSdkConfig(value?: SdkConfig | string): SdkConfig {
  if (value !== undefined && typeof value !== "string") {
    try { return schema.parse(value); }
    catch (cause) { throw new PuteredError("Invalid SDK config.", "INVALID_INPUT", { cause }); }
  }
  const path = value ?? SDK_CONFIG_FILE;
  let file: number;
  try { file = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK); }
  catch (cause) {
    if (value === undefined && (cause as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new PuteredError(`Could not read SDK config: ${path}`, "INVALID_INPUT", { cause });
  }
  try {
    if (!fstatSync(file).isFile()) throw new Error("SDK config must be a regular file.");
    const bytes = Buffer.alloc(64 * 1024 + 1);
    let size = 0, count: number;
    while (size < bytes.length && (count = readSync(file, bytes, size, bytes.length - size, null)) > 0) size += count;
    if (size === bytes.length) throw new Error("SDK config exceeds 64 KiB.");
    return schema.parse(JSON.parse(bytes.subarray(0, size).toString("utf8")));
  } catch (cause) {
    throw new PuteredError(`Invalid SDK config: ${path}`, "INVALID_INPUT", { cause });
  } finally { closeSync(file); }
}
