import { z } from "zod";
import { PuteredError, type ErrorCode } from "../errors.js";
import { DEFAULT_INTERNET_BYTES, preservesNetworkRules } from "../network-policy.js";
import { redactOutboundPolicy } from "../outbound-policy.js";
import { callOptionsSchema, resourceOverridesSchema, type EnvironmentRecord } from "../tool-contract.js";
import { canonical } from "../tool-definition.js";

export interface CallOptions {
  wait?: true;
  timeoutMs?: number;
  queueTimeoutMs?: number;
  resources?: { cpu?: number; memoryMiB?: number };
  signal?: AbortSignal;
}

export function formatZodError(error: unknown, fallback: string): string {
  if (error instanceof z.ZodError) {
    const issue = error.issues[0];
    if (issue) {
      const where = issue.path.length ? `${issue.path.join(".")}: ` : "";
      return `Invalid ${where}${issue.message}`;
    }
  }
  return fallback;
}

export function inputContract<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  try { return schema.parse(value); }
  catch (error) { throw new PuteredError(formatZodError(error, "Input does not match the SDK contract."), "INVALID_INPUT", { cause: error }); }
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

export function assertEnvAndOutboundPolicy(
  requested: { env?: EnvironmentRecord["env"]; networkPolicy?: Parameters<typeof redactOutboundPolicy>[0] },
  record: Pick<EnvironmentRecord, "env" | "networkPolicy">,
): void {
  if (requested.env !== undefined && canonical(record.env ?? null) !== canonical(requested.env))
    throw new PuteredError("Environment response does not preserve the requested environment variables.", "PROTOCOL_ERROR");
  if (requested.networkPolicy !== undefined && canonical(record.networkPolicy ?? null) !== canonical(redactOutboundPolicy(requested.networkPolicy)))
    throw new PuteredError("Environment response does not preserve the requested outbound network policy.", "PROTOCOL_ERROR");
}

export function assertNetworkPreserved(
  expected: EnvironmentRecord["settings"]["network"],
  actual: EnvironmentRecord["settings"]["network"],
  code: ErrorCode,
  messages: { rules: string; limit: string },
): void {
  if (expected?.mode !== "internet" || actual?.mode !== "internet") return;
  if (!preservesNetworkRules(expected, actual)) throw new PuteredError(messages.rules, code);
  if (expected.maxBytesPerExecution !== undefined &&
      (actual.maxBytesPerExecution ?? DEFAULT_INTERNET_BYTES) > expected.maxBytesPerExecution)
    throw new PuteredError(messages.limit, code);
}
