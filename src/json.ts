import { PuteredError } from "./errors.js";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export const JSON_MAX_BYTES = 8 * 1024 * 1024;
export const JSON_MAX_DEPTH = 64;
export interface JsonLimits { maxBytes?: number; maxDepth?: number; maxNodes?: number }

/** Validate and clone JSON before serialization, bounded by exact UTF-8 wire size. */
export function jsonValue(value: unknown, limits: JsonLimits = {}): Json {
  const maxBytes = limits.maxBytes ?? JSON_MAX_BYTES;
  const maxDepth = limits.maxDepth ?? JSON_MAX_DEPTH;
  const maxNodes = limits.maxNodes ?? 1_000_000;
  if (![maxBytes, maxDepth, maxNodes].every(limit => Number.isInteger(limit) && limit > 0))
    throw new PuteredError("Invalid JSON limits.", "INVALID_INPUT");
  const ancestors = new WeakSet<object>();
  let bytes = 0, nodes = 0;
  const add = (amount: number) => {
    bytes += amount;
    if (bytes > maxBytes) throw new PuteredError(`JSON payload exceeds ${maxBytes} bytes.`, "PAYLOAD_TOO_LARGE");
  };
  const stringBytes = (text: string) => {
    // At least one byte per UTF-16 code unit; reject huge strings before walking them.
    if (text.length + 2 > maxBytes - bytes) throw new PuteredError(`JSON payload exceeds ${maxBytes} bytes.`, "PAYLOAD_TOO_LARGE");
    add(2);
    for (let i = 0; i < text.length; i++) {
      const unit = text.charCodeAt(i);
      if (unit === 34 || unit === 92 || [8, 9, 10, 12, 13].includes(unit)) add(2);
      else if (unit < 32) add(6);
      else if (unit < 128) add(1);
      else if (unit < 2048) add(2);
      else if (unit >= 0xd800 && unit <= 0xdbff && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { add(4); i++; }
      else if (unit >= 0xd800 && unit <= 0xdfff) add(6);
      else add(3);
    }
  };
  const visit = (entry: unknown, depth: number): Json => {
    if (++nodes > maxNodes || depth > maxDepth)
      throw new PuteredError("JSON payload is too deeply nested or complex.", "PAYLOAD_TOO_LARGE");
    if (entry === null || typeof entry === "boolean") { add(entry === null ? 4 : entry ? 4 : 5); return entry; }
    if (typeof entry === "string") { stringBytes(entry); return entry; }
    if (typeof entry === "number" && Number.isFinite(entry)) { add(JSON.stringify(entry).length); return entry; }
    if (typeof entry !== "object" || !entry || (!Array.isArray(entry) && ![null, Object.prototype].includes(Object.getPrototypeOf(entry))))
      throw new PuteredError("Tool data must be finite JSON values.", "INVALID_INPUT");
    if (ancestors.has(entry)) throw new PuteredError("JSON payload contains a cycle.", "INVALID_INPUT");
    ancestors.add(entry);
    try {
      add(2);
      if (Array.isArray(entry)) {
        const result: Json[] = [];
        for (let i = 0; i < entry.length; i++) {
          if (i) add(1);
          const property = Object.getOwnPropertyDescriptor(entry, String(i));
          if (!property || !Object.hasOwn(property, "value"))
            throw new PuteredError("JSON arrays cannot be sparse or contain accessors.", "INVALID_INPUT");
          result.push(visit(property.value, depth + 1));
        }
        return result;
      }
      const result: Record<string, Json> = {};
      let first = true;
      for (const key of Object.keys(entry)) {
        if (["__proto__", "constructor", "prototype"].includes(key))
          throw new PuteredError("Unsafe JSON object key.", "INVALID_INPUT");
        const property = Object.getOwnPropertyDescriptor(entry, key)!;
        if (!Object.hasOwn(property, "value")) throw new PuteredError("JSON properties cannot be accessors.", "INVALID_INPUT");
        if (!first) add(1);
        first = false;
        stringBytes(key); add(1);
        result[key] = visit(property.value, depth + 1);
      }
      return result;
    } finally { ancestors.delete(entry); }
  };
  return visit(value, 0);
}

export function encodeJson(value: unknown, limits: JsonLimits = {}): string {
  return JSON.stringify(jsonValue(value, limits));
}

export function canonical(value: unknown, limits: JsonLimits = {}): string {
  const json = jsonValue(value, limits);
  const encode = (entry: Json): string => {
    if (Array.isArray(entry)) return `[${entry.map(encode).join(",")}]`;
    if (entry !== null && typeof entry === "object")
      return `{${Object.keys(entry).sort().map(key => `${JSON.stringify(key)}:${encode(entry[key])}`).join(",")}}`;
    return JSON.stringify(entry);
  };
  return encode(json);
}
