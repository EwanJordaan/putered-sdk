import { assetReferenceSchema, type AssetReference } from "./asset-contract.js";
import { PuteredError } from "./errors.js";

/** A reference to uploaded bytes; schemas and handlers remain in local source. */
export function defineAsset<const K extends string>(reference: AssetReference<K>): AssetReference<K> {
  try {
    const value = assetReferenceSchema.parse(reference);
    return Object.freeze({ ...value, entrypoints: Object.freeze(value.entrypoints) }) as AssetReference<K>;
  } catch (error) { throw new PuteredError("Invalid stored asset reference.", "PACKAGE_INVALID", { cause: error }); }
}
export interface AssetExecOptions {
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  stdin?: string | Uint8Array;
}
export interface AssetExecResult { stdout: string; stderr: string; stdoutBase64: string; exitCode: number }
export type AssetExecutor = <const K extends string>(asset: AssetReference<K>, entrypoint: NoInfer<K>,
  args?: readonly string[], options?: AssetExecOptions) => Promise<AssetExecResult>;
