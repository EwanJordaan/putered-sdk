import { Putered, PuteredError } from "./sdk.js";

export function clientFromEnv(): Putered {
  return new Putered({
    baseUrl: process.env.PUTERED_BASE_URL,
    apiKey: process.env.PUTERED_API_KEY ?? "",
  });
}

export async function withSignalAbort<T>(
  action: (signal: AbortSignal) => Promise<T>,
  cancelledMessage?: string,
): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    return await action(controller.signal);
  } catch (error) {
    if (cancelledMessage && controller.signal.aborted && !(error instanceof PuteredError && error.code === "CANCELLED"))
      throw new PuteredError(cancelledMessage, "CANCELLED");
    throw error;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}

export interface FlagSpec {
  valueFlags?: readonly string[];
  repeatableFlags?: readonly string[];
  booleanFlags?: readonly string[];
  unknownOptionMessage?: (flag: string) => string;
  allowPositionals?: boolean;
}

export function parseCliFlags(args: readonly string[], spec: FlagSpec): {
  positional: string[];
  flags: Map<string, string[]>;
  booleans: Set<string>;
} {
  const valueSet = new Set(spec.valueFlags ?? []);
  const repeatableSet = new Set(spec.repeatableFlags ?? []);
  const booleanSet = new Set(spec.booleanFlags ?? []);
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  const booleans = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (booleanSet.has(arg)) {
      if (booleans.has(arg)) throw new Error(`Duplicate ${arg} option.`);
      booleans.add(arg);
      continue;
    }
    if (!arg.startsWith("-")) {
      if (spec.allowPositionals === false)
        throw new Error(spec.unknownOptionMessage ? spec.unknownOptionMessage(arg) : `Unknown CLI option: ${arg}`);
      positional.push(arg);
      continue;
    }
    const isRepeatable = repeatableSet.has(arg);
    if (!isRepeatable && !valueSet.has(arg))
      throw new Error(spec.unknownOptionMessage ? spec.unknownOptionMessage(arg) : `Unknown CLI option: ${arg}`);
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
    if (!isRepeatable && flags.has(arg)) throw new Error(`Duplicate option: ${arg}`);
    flags.set(arg, [...(flags.get(arg) ?? []), value]);
  }
  return { positional, flags, booleans };
}
