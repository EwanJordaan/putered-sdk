import { z } from "zod";
import { PuteredError } from "../errors.js";
import { callOptionsSchema } from "../tool-contract.js";

export interface CallOptions {
  wait?: true;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export function inputContract<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  try { return schema.parse(value); }
  catch (error) { throw new PuteredError("Input does not match the SDK contract.", "INVALID_INPUT", { cause: error }); }
}

export function callOptions(options: CallOptions) {
  return inputContract(callOptionsSchema, {
    ...(options.wait === undefined ? {} : { wait: options.wait }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
}
