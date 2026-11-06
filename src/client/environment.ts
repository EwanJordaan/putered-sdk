import { z } from "zod";
import { Readable, Writable } from "node:stream";
import { runCommandSchema, type EnvironmentRecord } from "../tool-contract.js";
import { canonical, freezeRecord, type DeepReadonly } from "../tool-definition.js";
import { PuteredError } from "../errors.js";
import { samePersistence, type Persistence } from "../persistence-contract.js";
import { redactOutboundPolicy, updateEnvironmentSchema, type OutboundPolicy } from "../outbound-policy.js";
import type { Transport } from "./transport.js";
import { callOptions, inputContract, type CallOptions } from "./input-contract.js";
import { asyncExecution } from "./execution.js";
import { commandResult, type CommandResult } from "./command-output.js";
import {
  CommandHandle, commandTicketSchema, loadCommandHandle, pipeCommand,
  pumpCommandInput, pumpCommandOutput, validateCommandPath, type GetCommandOptions,
} from "./commands.js";
import { capturePreset, type CapturePresetOptions } from "./presets.js";
import { EnvironmentTerminals } from "./terminals.js";
import { EnvironmentTools } from "./tools.js";
import { environmentResponseSchema, execResultSchema } from "./responses.js";

export interface ExecOptions extends CallOptions { async?: boolean; check?: boolean; requestId?: string }
interface RunOptionsBase extends CallOptions {
  async?: boolean; check?: boolean; cwd?: string; env?: Readonly<Record<string, string>>;
  stdout?: Writable; stderr?: Writable; sudo?: boolean; requestId?: string;
}
export type RunOptions = RunOptionsBase & (
  { stdin?: string | Uint8Array | Readable; detached?: boolean } |
  { stdin: true; detached: true }
);
export interface ExecResult extends CommandResult {}

/** Caller IDs are supported by the direct server and force async submission. */
function recoveryOptions(options: { requestId?: string; async?: boolean }): { requestId?: string } {
  if (options.requestId === undefined) return {};
  if (!z.string().uuid().safeParse(options.requestId).success || options.requestId !== options.requestId.toLowerCase())
    throw new PuteredError("requestId must be a lowercase UUID.", "INVALID_INPUT");
  if (options.async === false) throw new PuteredError("requestId requires async execution.", "INVALID_INPUT");
  return { requestId: options.requestId };
}

export class Environment {
  readonly terminals: EnvironmentTerminals;
  readonly tools: EnvironmentTools;
  readonly id: string;
  constructor(private readonly transport: Transport, private readonly record: EnvironmentRecord) {
    this.id = record.id;
    this.terminals = new EnvironmentTerminals(transport, record.id);
    this.tools = new EnvironmentTools(transport, record);
  }
  /** Display name returned by Putered; older records may omit it. */
  get name(): string | undefined { return this.record.name; }
  /** Stored creation-time policy. Reconnect keeps this choice. */
  get persistence(): Persistence {
    return structuredClone(this.record.persistence ?? "full");
  }
  /** Environment variables stored with this environment. */
  get env(): DeepReadonly<Record<string, string>> | undefined {
    return this.record.env === undefined ? undefined : freezeRecord(structuredClone(this.record.env));
  }
  /** Outbound request policy stored with this environment; transformed header values may be redacted. */
  get networkPolicy(): DeepReadonly<OutboundPolicy> | undefined {
    return this.record.networkPolicy === undefined ? undefined : freezeRecord(structuredClone(this.record.networkPolicy));
  }
  capturePreset(options: CapturePresetOptions) {
    return capturePreset(this.transport, this.id, options);
  }
  getCommand(id: string, options: GetCommandOptions = {}): Promise<CommandHandle> {
    return loadCommandHandle(this.transport, this.id, id, options);
  }
  /** Save the selected filesystem scope and release local state. Finish or cancel
   * active commands/terminals first. Does not save live processes or RAM. */
  async stop(options: { signal?: AbortSignal } = {}): Promise<{ id: string; stopped: true }> {
    return this.transport.request(`/environments/${this.id}/stop`, "POST",
      z.object({ id: z.literal(this.id), stopped: z.literal(true) }), {}, options.signal);
  }
  /** Restore saved files now. exec/run also resume automatically on demand. */
  async resume(options: { signal?: AbortSignal } = {}): Promise<Environment> {
    const record = await this.transport.request(`/environments/${this.id}/resume`, "POST",
      environmentResponseSchema, {}, options.signal);
    if (record.id !== this.id) throw new PuteredError("Environment response identity mismatch.", "PROTOCOL_ERROR");
    if (!samePersistence(this.persistence, record.persistence ?? "full"))
      throw new PuteredError("Resume response changed the environment's persistence policy.", "PROTOCOL_ERROR");
    return new Environment(this.transport, record);
  }
  /** Replace stored environment variables and/or outbound request policy. */
  async update(value: z.input<typeof updateEnvironmentSchema>, options: { signal?: AbortSignal } = {}): Promise<this> {
    const request = inputContract(updateEnvironmentSchema, value);
    const record = await this.transport.request(`/environments/${this.id}`, "PATCH", environmentResponseSchema, request, options.signal);
    if (record.id !== this.id) throw new PuteredError("Environment response identity mismatch.", "PROTOCOL_ERROR");
    if (request.env !== undefined && canonical(record.env ?? null) !== canonical(request.env))
      throw new PuteredError("Environment response does not preserve the requested environment variables.", "PROTOCOL_ERROR");
    if (request.networkPolicy !== undefined && canonical(record.networkPolicy ?? null) !== canonical(redactOutboundPolicy(request.networkPolicy)))
      throw new PuteredError("Environment response does not preserve the requested outbound network policy.", "PROTOCOL_ERROR");
    Object.assign(this.record, record);
    return this;
  }
  /** Permanently delete this environment and its stored workspace data. */
  async delete(options: { signal?: AbortSignal } = {}): Promise<{ id: string; deleted: true }> {
    return this.transport.request(`/environments/${this.id}`, "DELETE",
      z.object({ id: z.literal(this.id), deleted: z.literal(true) }), undefined, options.signal);
  }
  /** Stored settings from create/connect; no request or live health check. */
  describe(): DeepReadonly<EnvironmentRecord> { return freezeRecord(structuredClone(this.record)); }
  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    if (typeof command !== "string" || !command.trim() || Buffer.byteLength(command) > 64 * 1024)
      throw new PuteredError("Command must be nonempty and no larger than 64 KiB.", "INVALID_INPUT");
    if (options.async !== undefined && typeof options.async !== "boolean")
      throw new PuteredError("async must be a boolean.", "INVALID_INPUT");
    if (options.check !== undefined && typeof options.check !== "boolean")
      throw new PuteredError("check must be a boolean.", "INVALID_INPUT");
    const input = {
      command,
      ...recoveryOptions(options),
      ...callOptions(options),
    };
    const result = options.async || options.requestId !== undefined
      ? await asyncExecution(this.transport, this.id, input, options.signal)
      : await this.transport.request(`/environments/${this.id}/exec`, "POST", execResultSchema, input, options.signal);
    return commandResult(result, options.check ?? true);
  }
  run(program: string, args: readonly string[] | undefined, options: RunOptions & { detached: true }): Promise<CommandHandle>;
  run(program: string, args?: readonly string[], options?: RunOptions & { detached?: false | undefined }): Promise<ExecResult>;
  run(program: string, args?: readonly string[], options?: RunOptions): Promise<ExecResult | CommandHandle>;
  async run(program: string, args: readonly string[] = [], options: RunOptions = {}): Promise<ExecResult | CommandHandle> {
    const openStdin = options.stdin === true || options.stdin instanceof Readable;
    if (options.async !== undefined && typeof options.async !== "boolean")
      throw new PuteredError("async must be a boolean.", "INVALID_INPUT");
    if (options.check !== undefined && typeof options.check !== "boolean")
      throw new PuteredError("check must be a boolean.", "INVALID_INPUT");
    if (options.detached !== undefined && typeof options.detached !== "boolean")
      throw new PuteredError("detached must be a boolean.", "INVALID_INPUT");
    if (options.stdin === true && options.detached !== true)
      throw new PuteredError("stdin: true requires detached: true so the command can be written interactively.", "INVALID_INPUT");
    if (options.stdin !== undefined && options.stdin !== true && typeof options.stdin !== "string" &&
        !(options.stdin instanceof Uint8Array) && !(options.stdin instanceof Readable))
      throw new PuteredError("stdin must be text, bytes, a Node Readable, or true.", "INVALID_INPUT");
    for (const sink of [options.stdout, options.stderr])
      if (sink !== undefined && !(sink instanceof Writable))
        throw new PuteredError("stdout and stderr must be writable streams.", "INVALID_INPUT");
    if (options.sudo && !this.record.settings.execution?.allowSudo)
      throw new PuteredError("Sudo was not enabled for this environment.", "POLICY_DENIED");
    if (options.sudo && program === "git")
      throw new PuteredError("Sudo is unsupported for direct Wasm Git.", "INVALID_INPUT");
    if (program === "git" && (options.stdin === true || options.stdin instanceof Readable))
      throw new PuteredError("Interactive stdin is unsupported for direct Wasm Git.", "INVALID_INPUT");
    const stdinBytes = typeof options.stdin === "string" ? Buffer.from(options.stdin)
      : options.stdin instanceof Uint8Array ? Buffer.from(options.stdin) : undefined;
    if (stdinBytes && stdinBytes.byteLength > 64 * 1024)
      throw new PuteredError("Static stdin exceeds 64 KiB.", "PAYLOAD_TOO_LARGE");
    const command = inputContract(runCommandSchema, { program, args,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(stdinBytes === undefined ? {} : { stdinBase64: stdinBytes.toString("base64") }),
      ...(openStdin ? { stdinOpen: true } : {}),
      ...(options.sudo === undefined ? {} : { sudo: options.sudo }),
    });
    const input = {
      ...command,
      ...recoveryOptions(options),
      ...callOptions(options),
    };
    const interactive = options.detached === true || options.stdout !== undefined || options.stderr !== undefined ||
      openStdin || (options.stdin !== undefined && !stdinBytes);
    if (interactive) {
      const handle = await this.startRun(input, options);
      if (options.detached) return handle;
      const result = await pipeCommand(handle, options);
      return commandResult(result, options.check ?? true);
    }
    const result = options.async || options.requestId !== undefined
      ? await asyncExecution(this.transport, this.id, input, options.signal, "run", true)
      : await this.transport.request(`/environments/${this.id}/run`, "POST", execResultSchema, input, options.signal);
    return commandResult(result, options.check ?? true);
  }
  private async startRun(input: Record<string, unknown>, options: RunOptions): Promise<CommandHandle> {
    const ticket = await this.transport.request(
      `/environments/${this.id}/run?async=1`, "POST", commandTicketSchema, input, options.signal,
    );
    if (input.requestId !== undefined && ticket.jobId !== input.requestId)
      throw new PuteredError("Command ticket identity mismatch.", "PROTOCOL_ERROR");
    const path = validateCommandPath(ticket.commandPath, this.id, ticket.jobId);
    this.transport.rememberCommandPath(this.id, ticket.jobId, path);
    const handle = new CommandHandle(this.transport, this.id, ticket.jobId, path, input.program as string,
      false, 0, input.stdinOpen === true);
    if (options.signal) {
      if (options.signal.aborted) {
        await handle.kill("SIGKILL").catch(() => undefined);
        throw new PuteredError("Command cancelled after submission.", "CANCELLED");
      }
      const abort = () => { void handle.kill("SIGKILL").catch(() => undefined); };
      options.signal.addEventListener("abort", abort, { once: true });
      handle.setAbortCleanup(() => options.signal?.removeEventListener("abort", abort));
    }
    if (options.detached && options.stdin instanceof Readable) {
      void pumpCommandInput(handle, options.stdin).catch(error => handle.recordInputFailure(error));
    }
    if (options.detached && (options.stdout || options.stderr)) {
      const outputPump = pumpCommandOutput(handle, options.stdout, options.stderr)
        .catch(error => {
          handle.recordOutputFailure(error);
          return handle.kill("SIGKILL").catch(() => undefined);
        });
      handle.trackOutputPump(outputPump);
    }
    if (options.detached) void handle.wait({ check: false }).catch(() => undefined);
    return handle;
  }
}
