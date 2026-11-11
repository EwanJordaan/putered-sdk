import { z } from "zod";
import { PuteredError } from "../errors.js";
import { callOptionsSchema, resourceOverridesSchema } from "../tool-contract.js";

export interface CallOptions {
  wait?: true;
  timeoutMs?: number;
  queueTimeoutMs?: number;
  resources?: { cpu?: number; memoryMiB?: number };
  signal?: AbortSignal;
}

export function inputContract<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  try { return schema.parse(value); }
  catch (error) { throw new PuteredError("Input does not match the SDK contract.", "INVALID_INPUT", { cause: error }); }
}

/** Validate each override before merging, and treat explicit undefined as omission. */
export function mergeResources(...values: unknown[]): z.output<typeof resourceOverridesSchema> {
  const merged: z.output<typeof resourceOverridesSchema> = {};
  for (const value of values) {
    if (value === undefined) continue;
    const parsed = inputContract(resourceOverridesSchema, value);
    for (const [key, field] of Object.entries(parsed))
      if (field !== undefined) Object.assign(merged, { [key]: field });
  }
  return merged;
}

export function callOptions(options: CallOptions) {
  return inputContract(callOptionsSchema, {
    ...(options.wait === undefined ? {} : { wait: options.wait }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.queueTimeoutMs === undefined ? {} : { queueTimeoutMs: options.queueTimeoutMs }),
    ...(options.resources === undefined ? {} : { resources: options.resources }),
  });
}
