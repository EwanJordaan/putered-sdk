import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import { Readable, type Writable } from "node:stream";
import { ERROR_CODES, PuteredError, codeForStatus } from "../errors.js";
import type { Transport } from "./transport.js";
import { commandResult, CommandError, type CommandResult } from "./command-output.js";
import { execResultSchema } from "./responses.js";

export const snapshotSchema = z.object({
  id: z.string().uuid(), environmentId: z.string(), state: z.enum(["running", "completed", "failed", "unknown"]),
  createdAt: z.number(), cursor: z.number().int().nonnegative(), program: z.string().optional(),
  nextSequence: z.number().int().nonnegative().optional(), stdinOpen: z.boolean().optional(), reset: z.literal(true).optional(),
  output: z.array(z.object({ stream: z.enum(["stdout", "stderr"]), data: z.string().max(87384) })).default([]),
  httpStatus: z.number().int().min(100).max(599).optional(), result: z.unknown().optional(), error: z.string().optional(),
});
export const commandTicketSchema = z.object({ jobId: z.string().uuid(), state: z.literal("running"), commandPath: z.string().optional() });
export type OutputChunk = { stream: "stdout" | "stderr"; data: string };
export type CommandSignal = "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGHUP" | "SIGQUIT" | "SIGSTOP" | "SIGCONT";

function decodeBase64(value: string): Uint8Array {
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new PuteredError("Invalid command output bytes.", "PROTOCOL_ERROR");
  return bytes;
}
function validateCursor(value: z.infer<typeof snapshotSchema>, requestedCursor: number): void {
  const outputBytes = value.output.reduce((total, item) => total + decodeBase64(item.data).byteLength, 0);
  if (value.cursor < requestedCursor || (!value.reset && value.cursor !== requestedCursor + outputBytes))
    throw new PuteredError("Invalid command output cursor.", "PROTOCOL_ERROR");
}
function commandFailure(snapshot: z.infer<typeof snapshotSchema>): never {
  if (snapshot.state === "unknown") throw new PuteredError(snapshot.error ?? "Command outcome is unknown.", "CONFLICT");
  if (snapshot.state === "failed") {
    const saved = z.object({ error: z.string(), code: z.string().optional() }).safeParse(snapshot.result);
    const savedCode = saved.success && saved.data.code ? z.enum(ERROR_CODES).safeParse(saved.data.code) : undefined;
    throw new PuteredError(saved.success ? saved.data.error : snapshot.error ?? "Command execution failed.",
      savedCode?.success ? savedCode.data : snapshot.httpStatus === undefined ? "EXECUTION_FAILED" : codeForStatus(snapshot.httpStatus), {
        ...(snapshot.httpStatus === undefined ? {} : { status: snapshot.httpStatus }),
      });
  }
  throw new PuteredError("Command is still running.", "PROTOCOL_ERROR");
}

/** A resumable command reference. Calls to wait/logs only inspect saved output; they never replay the command. */
export class CommandHandle {
  readonly id: string;
  private cursor = 0;
  private nextInputSequence = 0;
  private stdinOpen?: boolean;
  private _result?: CommandResult;
  private inputFailure?: unknown;
  private outputFailure?: unknown;
  private lostOutputHistory = false;
  private inputQueue: Promise<void> = Promise.resolve();
  private logsActive = false;
  private abortCleanup?: () => void;
  private outputPump?: Promise<void>;
  constructor(private readonly transport: Transport, readonly environmentId: string, id: string, private readonly path: string,
    private readonly program?: string, historyLost = false, nextInputSequence = 0, stdinOpen?: boolean) {
    this.id = id;
    this.lostOutputHistory = historyLost;
    this.nextInputSequence = nextInputSequence;
    this.stdinOpen = stdinOpen;
  }
  get result(): CommandResult | undefined { return this._result; }
  recordInputFailure(error: unknown): void { this.inputFailure = error; }
  recordOutputFailure(error: unknown): void { this.outputFailure = error; }
  trackOutputPump(pump: Promise<void>): void { this.outputPump = pump; }
  setAbortCleanup(cleanup: () => void): void { this.abortCleanup = cleanup; }
  private finish(): void { this.abortCleanup?.(); this.abortCleanup = undefined; }
  async hasFinished(): Promise<boolean> {
    const value = await this.snapshot(undefined, false, true);
    return value.state !== "running";
  }
  private async snapshot(signal?: AbortSignal, advance = true, ignoreReset = false) {
    const requestedCursor = this.cursor;
    const value = await this.transport.request(`${this.path}?cursor=${requestedCursor}`, "GET", snapshotSchema, undefined, signal);
    if (value.id !== this.id || value.environmentId !== this.environmentId)
      throw new PuteredError("Command result identity mismatch.", "PROTOCOL_ERROR");
    if (value.reset) {
      this.lostOutputHistory = true;
      if (!ignoreReset) throw new PuteredError("Command output history was truncated; reconnect from the latest cursor.", "CONFLICT");
    }
    validateCursor(value, requestedCursor);
    if (value.state !== "running") this.finish();
    if (advance) this.cursor = Math.max(this.cursor, value.cursor);
    if (value.stdinOpen !== undefined) this.stdinOpen = value.stdinOpen;
    return value;
  }
  async *logs(options: { signal?: AbortSignal } = {}): AsyncGenerator<OutputChunk> {
    if (this.logsActive) throw new PuteredError("Only one logs() iterator may read a command at a time.", "CONFLICT");
    this.logsActive = true;
    try {
    if (this.lostOutputHistory) throw new PuteredError("Command output history was truncated; reconnect from the latest cursor.", "CONFLICT");
    const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
    for (;;) {
      options.signal?.throwIfAborted();
      const value = await this.snapshot(options.signal);
      for (const item of value.output) {
        const bytes = decodeBase64(item.data);
        const data = decoders[item.stream].decode(bytes, { stream: true });
        if (data) yield { stream: item.stream, data };
      }
      if (value.state === "completed") {
        const result = execResultSchema.safeParse(value.result);
        if (!result.success) throw new PuteredError("Invalid saved command result.", "PROTOCOL_ERROR", { cause: result.error });
        this._result = commandResult(result.data, false);
        for (const stream of ["stdout", "stderr"] as const) {
          const tail = decoders[stream].decode();
          if (tail) yield { stream, data: tail };
        }
        return;
      }
      if (value.state === "failed" || value.state === "unknown") commandFailure(value);
      await delay(250, undefined, { signal: options.signal });
    }
    } finally { this.logsActive = false; }
  }
  async wait(options: { signal?: AbortSignal; check?: boolean } = {}): Promise<CommandResult> {
    if (this.inputFailure !== undefined) throw this.inputFailure;
    if (this.outputFailure !== undefined) throw this.outputFailure;
    for (;;) {
      options.signal?.throwIfAborted();
      const value = await this.snapshot(options.signal, false, true);
      if (value.state === "completed") {
        await this.outputPump;
        const result = execResultSchema.safeParse(value.result);
        if (!result.success) throw new PuteredError("Invalid saved command result.", "PROTOCOL_ERROR", { cause: result.error });
        this._result = commandResult(result.data, false);
        if (this.inputFailure !== undefined) throw this.inputFailure;
        if (this.outputFailure !== undefined) throw this.outputFailure;
        if ((options.check ?? true) && this._result.exitCode !== 0) throw new CommandError(this._result);
        return this._result;
      }
      if (value.state === "failed" || value.state === "unknown") commandFailure(value);
      await delay(250, undefined, { signal: options.signal });
    }
  }
  async writeStdin(input: string | Uint8Array): Promise<void> {
    if (this.stdinOpen === false) throw new PuteredError("Command stdin is closed.", "CONFLICT");
    const bytes = typeof input === "string" ? Buffer.from(input) : Buffer.from(input);
    if (!bytes.byteLength || bytes.byteLength > 32 * 1024) throw new PuteredError("Each stdin write must contain 1 to 32 KiB.", "INVALID_INPUT");
    await this.enqueueInput(async () => {
      const result = await this.transport.request(`${this.path}/input`, "POST", z.object({ nextSequence: z.number().int().positive() }), {
        sequence: this.nextInputSequence, input: bytes.toString("base64"),
      });
      if (result.nextSequence < this.nextInputSequence + 1) throw new PuteredError("Invalid command input sequence response.", "PROTOCOL_ERROR");
      this.nextInputSequence = result.nextSequence;
      this.stdinOpen = true;
    });
  }
  async closeStdin(): Promise<void> {
    if (this.stdinOpen === false) throw new PuteredError("Command stdin is already closed.", "CONFLICT");
    await this.enqueueInput(async () => {
      const result = await this.transport.request(`${this.path}/input`, "POST", z.object({ nextSequence: z.number().int().positive() }), {
        sequence: this.nextInputSequence, close: true,
      });
      if (result.nextSequence < this.nextInputSequence + 1) throw new PuteredError("Invalid command input sequence response.", "PROTOCOL_ERROR");
      this.nextInputSequence = result.nextSequence;
      this.stdinOpen = false;
    });
  }
  async kill(signal: CommandSignal = "SIGTERM"): Promise<void> {
    const parsed = z.enum(["SIGTERM", "SIGKILL", "SIGINT", "SIGHUP", "SIGQUIT", "SIGSTOP", "SIGCONT"]).safeParse(signal);
    if (!parsed.success) throw new PuteredError("Unsupported command signal.", "INVALID_INPUT");
    if (this.program === "git" && signal !== "SIGKILL")
      throw new PuteredError("Direct Wasm Git only supports SIGKILL.", "CONFLICT");
    const result = await this.transport.request(`${this.path}/signal`, "POST", snapshotSchema, { signal });
    if (result.id !== this.id || result.environmentId !== this.environmentId)
      throw new PuteredError("Command result identity mismatch.", "PROTOCOL_ERROR");
  }
  private enqueueInput<T>(action: () => Promise<T>): Promise<T> {
    const result = this.inputQueue.then(action);
    this.inputQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

export function validateCommandPath(path: string | undefined, environmentId: string, jobId: string): string {
  const expected = `/environments/${environmentId}/commands/${jobId}`;
  if (path !== undefined && path !== expected) throw new PuteredError("Command ticket path is invalid.", "PROTOCOL_ERROR");
  return path ?? `/execution-jobs/${jobId}`;
}

export async function loadCommandHandle(transport: Transport, environmentId: string, id: string): Promise<CommandHandle> {
  if (!z.string().uuid().safeParse(id).success) throw new PuteredError("Command ID must be a UUID.", "INVALID_INPUT");
  const path = transport.commandPath(environmentId, id);
  const value = await transport.request(`${path}?cursor=0`, "GET", snapshotSchema);
  if (value.id !== id || value.environmentId !== environmentId)
    throw new PuteredError("Command result identity mismatch.", "PROTOCOL_ERROR");
  validateCursor(value, 0);
  return new CommandHandle(transport, environmentId, id, path, value.program, value.reset === true,
    value.nextSequence ?? 0, value.stdinOpen);
}

export async function pipeCommand(handle: CommandHandle, options: { stdin?: string | Uint8Array | Readable | true;
  stdout?: Writable; stderr?: Writable; signal?: AbortSignal }): Promise<CommandResult> {
  const pumpInput = async () => {
    if (options.stdin instanceof Readable) {
      await pumpCommandInput(handle, options.stdin);
    } else if (options.stdin === true) { /* caller owns stdin */ }
    // Text and byte stdin was included in the submission body and is already closed.
  };
  try {
    await Promise.all([pumpInput(), pumpCommandOutput(handle, options.stdout, options.stderr, options.signal)]);
    if (!handle.result) await handle.wait();
    return handle.result!;
  } catch (error) {
    await handle.kill("SIGKILL").catch(() => undefined);
    throw error;
  }
}

export async function pumpCommandOutput(handle: CommandHandle, stdout?: Writable, stderr?: Writable,
  signal?: AbortSignal): Promise<void> {
  for await (const item of handle.logs({ signal })) {
    const sink = item.stream === "stdout" ? stdout : stderr;
    if (!sink) continue;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error | null) => {
        if (settled) return;
        settled = true;
          if (error) setImmediate(() => sink.removeListener("error", onError));
          else sink.removeListener("error", onError);
        error ? reject(error) : resolve();
      };
      const onError = (error: Error) => finish(error);
      sink.once("error", onError);
      try { sink.write(item.data, error => finish(error)); }
      catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
  }
}

export async function pumpCommandInput(handle: CommandHandle, input: Readable): Promise<void> {
  try {
    for await (const chunk of input.iterator({ destroyOnReturn: false })) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      for (let offset = 0; offset < bytes.byteLength; offset += 32 * 1024)
        await handle.writeStdin(bytes.subarray(offset, offset + 32 * 1024));
    }
    await handle.closeStdin();
  } catch (error) {
    if (await handle.hasFinished().catch(() => false)) return;
    await handle.kill("SIGKILL").catch(() => undefined);
    throw error;
  }
}
