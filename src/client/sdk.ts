import { z } from "zod";
import { artifactId, callOptionsSchema, createEnvironmentSchema, environmentSchema,
  runCommandSchema, toolIdSchema, toolOptionsSchema, type EnvironmentRecord, type StoredTool } from "../tool-contract.js";
import { canonical, freezeRecord, jsonValue, type DeepReadonly, type Json, type ToolMap, type ToolPlugin } from "../tool-definition.js";
import { packageOf } from "../tool-artifact.js";
import { Transport } from "./transport.js";
import { asyncExecution } from "./execution.js";
import { commandResult, type CommandResult } from "./command-output.js";
import { CommandHandle, commandTicketSchema, loadCommandHandle, pipeCommand, pumpCommandInput, pumpCommandOutput, validateCommandPath } from "./commands.js";
import { Readable, Writable } from "node:stream";
export { CommandError } from "./command-output.js";
export { CommandHandle } from "./commands.js";
export type { CommandSignal, OutputChunk, OutputBytesChunk, LogOptions, GetCommandOptions } from "./commands.js";
import { Assets } from "./assets.js";
import { Presets, capturePreset, type CapturePresetOptions } from "./presets.js";
import { EnvironmentTerminals } from './terminals.js';
export { TerminalSession } from './terminals.js';
export type { TerminalState } from './terminals.js';
import { PuteredError } from "../errors.js";
export { PuteredError, ERROR_CODES } from "../errors.js";
export type { ErrorCode } from "../errors.js";
export type { AssetReference, AssetPlatform } from "../asset-contract.js";
export type { AssetUploadOptions } from "./assets.js";
export type { Preset, PresetSaveScope } from "../preset-contract.js";
export type { CapturePresetOptions, PresetRequestOptions, PresetTransferOptions, PresetUploadOptions, PresetDownloadOptions } from "./presets.js";
import { compileToolSchema, toolValidator } from "../tool-validation.js";
import { loadSdkConfig, type SdkConfig } from "./config.js";
import { DEFAULT_INTERNET_BYTES, preservesNetworkRules } from "../network-policy.js";
import { persistenceSchema, samePersistence, type Persistence } from "../persistence-contract.js";
export type { Persistence } from "../persistence-contract.js";
import { environmentResponseSchema, storedToolResponseSchema, execResultSchema, toolCallResponseSchema } from "./responses.js";
export type { SdkConfig } from "./config.js";
export type { InternetPolicy, NetworkRuntime } from "../network-policy.js";

function inputContract<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  try { return schema.parse(value); }
  catch (error) { throw new PuteredError("Input does not match the SDK contract.", "INVALID_INPUT", { cause: error }); }
}

/** Caller IDs are supported by the direct server and force async submission. */
function recoveryOptions(options: { requestId?: string; async?: boolean }): { requestId?: string } {
  if (options.requestId === undefined) return {};
  if (!z.string().uuid().safeParse(options.requestId).success || options.requestId !== options.requestId.toLowerCase())
    throw new PuteredError("requestId must be a lowercase UUID.", "INVALID_INPUT");
  if (options.async === false) throw new PuteredError("requestId requires async execution.", "INVALID_INPUT");
  return { requestId: options.requestId };
}

declare const toolTypes: unique symbol;
export interface ToolReference<T extends ToolMap | null = null> {
  readonly id: string;
  readonly visibility: "private";
  readonly manifest: DeepReadonly<StoredTool["manifest"]>;
  readonly [toolTypes]: T;
}
export interface ToolUseOptions { visibility?: "private" }
export interface CallOptions { wait?: true; timeoutMs?: number; signal?: AbortSignal }
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

export class Tools {
  constructor(private readonly transport: Transport) {}
  async list(): Promise<ToolReference[]> {
    const records = await this.transport.request("/tools", "GET", z.array(storedToolResponseSchema));
    return records.map(record => freezeRecord({ ...record }) as ToolReference);
  }
  use<T extends ToolMap>(plugin: ToolPlugin<T>, options?: ToolUseOptions): Promise<ToolReference<T>>;
  use<T extends ToolMap>(id: string, options: ToolUseOptions & { definition: ToolPlugin<T> }): Promise<ToolReference<T>>;
  use(id: string, options?: ToolUseOptions): Promise<ToolReference>;
  async use(value: ToolPlugin | string, options: ToolUseOptions & { definition?: ToolPlugin } = {}): Promise<ToolReference<ToolMap | null>> {
    const { definition: _definition, ...configuration } = options;
    inputContract(toolOptionsSchema, configuration);
    const plugin = typeof value === "string" ? options.definition : value;
    const artifact = typeof value === "string" ? undefined : packageOf(value);
    const id = typeof value === "string" ? inputContract(toolIdSchema, value) : artifactId(artifact!);
    let record: StoredTool;
    try { record = await this.transport.request(`/tools/${id}`, "GET", storedToolResponseSchema); }
    catch (error) {
      if (!(error instanceof PuteredError) || error.status !== 404 || !artifact) throw error;
      record = await this.transport.request("/tools/use", "POST", storedToolResponseSchema, { artifact });
    }
    if (record.id !== id || (plugin && canonical(record.manifest) !== canonical(plugin.manifest)))
      throw new PuteredError("Saved tool does not match the expected plugin definition.", "PACKAGE_INVALID");
    return freezeRecord({ ...record }) as ToolReference<ToolMap | null>;
  }
}

class EnvironmentTools {
  constructor(private readonly transport: Transport, private readonly record: EnvironmentRecord) {}
  call<const T extends ToolMap, const K extends keyof NoInfer<T> & string>(reference: ToolReference<T>, name: K,
    input: z.input<NoInfer<T>[K]["input"]>, options?: CallOptions): Promise<{ output: z.output<T[K]["output"]> }>;
  call(reference: ToolReference, name: string, input: Json, options?: CallOptions): Promise<{ output: unknown }>;
  async call(reference: ToolReference<ToolMap | null>, name: string, input: unknown,
    options: CallOptions = {}): Promise<{ output: unknown }> {
    if (!this.record.tools.includes(reference.id)) throw new PuteredError("Tool is not attached to this environment.", "POLICY_DENIED");
    if (!Object.hasOwn(reference.manifest.tools, name)) throw new PuteredError("Unknown tool.", "NOT_FOUND");
    const definition = reference.manifest.tools[name];
    const ajv = toolValidator();
    const validateInput = compileToolSchema(ajv, definition.inputSchema);
    const validateOutput = compileToolSchema(ajv, definition.outputSchema);
    const value = jsonValue(input);
    if (!validateInput(value)) throw new PuteredError("Tool input does not match its schema.", "INVALID_INPUT");
    const result = await this.transport.request(`/environments/${this.record.id}/tools/call`, "POST",
      toolCallResponseSchema, {
        id: reference.id, tool: name, input: value,
        ...inputContract(callOptionsSchema, { ...(options.wait === undefined ? {} : { wait: options.wait }),
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) }),
      }, options.signal);
    if (!Object.hasOwn(result, "output")) throw new PuteredError("Missing tool output.", "INVALID_OUTPUT");
    let output: Json;
    try { output = jsonValue(result.output); }
    catch (error) { throw new PuteredError("Tool output is not valid JSON.",
      error instanceof PuteredError && error.code === "PAYLOAD_TOO_LARGE" ? "PAYLOAD_TOO_LARGE" : "INVALID_OUTPUT", { cause: error }); }
    if (!validateOutput(output))
      throw new PuteredError("Tool output does not match its schema.", "INVALID_OUTPUT");
    return { output };
  }
}

export class Environment {
  readonly terminals:EnvironmentTerminals;
  readonly tools: EnvironmentTools;
  readonly id: string;
  constructor(private readonly transport: Transport, private readonly record: EnvironmentRecord) {
    this.id = record.id;
    this.terminals=new EnvironmentTerminals(transport,record.id);
    this.tools = new EnvironmentTools(transport, record);
  }
  /** Display name returned by Putered; older records may omit it. */
  get name(): string | undefined { return this.record.name; }
  /** Stored creation-time policy. Reconnect keeps this choice. */
  get persistence(): Persistence {
    return structuredClone(this.record.persistence ?? "full");
  }
  capturePreset(options: CapturePresetOptions) {
    return capturePreset(this.transport, this.id, options);
  }
  getCommand(id: string, options: import("./commands.js").GetCommandOptions = {}): Promise<CommandHandle> {
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
  /** Permanently delete this environment and its stored workspace data. */
  async delete(options: { signal?: AbortSignal } = {}): Promise<{ id: string; deleted: true }> {
    const result = await this.transport.request(`/environments/${this.id}`, "DELETE",
      z.object({ id: z.literal(this.id), deleted: z.literal(true) }), undefined, options.signal);
    return result;
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
      ...inputContract(callOptionsSchema, { ...(options.wait === undefined ? {} : { wait: options.wait }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) }),
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
      ...inputContract(callOptionsSchema, { ...(options.wait === undefined ? {} : { wait: options.wait }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) }),
    };
    const interactive = options.detached === true || options.stdout !== undefined || options.stderr !== undefined ||
      openStdin || (options.stdin !== undefined && !stdinBytes);
    const result = (options.async || options.requestId !== undefined) && !interactive
      ? await asyncExecution(this.transport, this.id, input, options.signal, "run", true)
      : interactive
        ? await this.startRun(input, options)
        : await this.transport.request(`/environments/${this.id}/run`, "POST", execResultSchema, input, options.signal);
    if (result instanceof CommandHandle) {
      if (options.detached) return result;
      return pipeCommand(result, options).then(value => commandResult(value, options.check ?? true));
    }
    return commandResult(result, options.check ?? true);
  }
  private async startRun(input: Record<string, unknown>, options: RunOptions): Promise<CommandHandle> {
    let ticket: z.infer<typeof commandTicketSchema>;
    try {
      ticket = await this.transport.request(`/environments/${this.id}/run?async=1`, "POST", commandTicketSchema, input, options.signal);
    } catch (error) { throw error; }
    if (input.requestId !== undefined && ticket.jobId !== input.requestId)
      throw new PuteredError("Command ticket identity mismatch.", "PROTOCOL_ERROR");
    const path = validateCommandPath(ticket.commandPath, this.id, ticket.jobId);
    this.transport.rememberCommandPath(this.id, ticket.jobId, path);
    const handle = new CommandHandle(this.transport, this.id, ticket.jobId, path, input.program as string,
      false, 0, input.stdinOpen === true);
    if (options.signal) {
      if (options.signal.aborted) { await handle.kill("SIGKILL").catch(() => undefined); throw new PuteredError("Command cancelled after submission.", "CANCELLED"); }
      const abort = () => { void handle.kill("SIGKILL").catch(() => undefined); };
      options.signal.addEventListener("abort", abort, { once: true });
      handle.setAbortCleanup(() => options.signal?.removeEventListener("abort", abort));
    }
    if (options.detached && options.stdin instanceof Readable) {
      void pumpCommandInput(handle, options.stdin).catch(error => handle.recordInputFailure(error));
    }
    if (options.detached && (options.stdout || options.stderr)) {
      const outputPump = pumpCommandOutput(handle, options.stdout, options.stderr)
        .catch(error => { handle.recordOutputFailure(error); return handle.kill("SIGKILL").catch(() => undefined); });
      handle.trackOutputPump(outputPump);
    }
    if (options.detached) void handle.wait({ check: false }).catch(() => undefined);
    return handle;
  }
}
export interface EnvironmentOptions {
  persistence?: Persistence;
  /** Default execution backend preference for commands in the new environment. */
  execution?: z.input<typeof createEnvironmentSchema>["execution"];
  /** Optional display name, trimmed to 1–100 characters. Supported by hosted accounts. */
  name?: string;
  template?: string;
  tools?: readonly ToolReference<ToolMap | null>[];
  settings?: z.input<typeof createEnvironmentSchema>["settings"];
}
export class Putered {
  readonly tools: Tools;
  readonly assets: Assets;
  readonly presets: Presets;
  readonly environments: {
    create(options?: EnvironmentOptions): Promise<Environment>;
    connect(id: string, options?: { signal?: AbortSignal }): Promise<Environment>;
  };
  constructor(options: { baseUrl?: string; apiKey: string; fetch?: typeof fetch; config?: SdkConfig | string }) {
    let url: URL;
    try { url = new URL(options.baseUrl === undefined ? "https://putered.com/api/compute" : options.baseUrl); }
    catch (error) { throw new PuteredError("Invalid Putered base URL.", "INVALID_INPUT", { cause: error }); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw new PuteredError("Invalid Putered base URL.", "INVALID_INPUT");
    if (typeof options.apiKey !== "string" || options.apiKey.length < 32)
      throw new PuteredError("Putered API key must be at least 32 characters.", "INVALID_INPUT");
    const transport = new Transport(url.href.replace(/\/$/, ""), options.apiKey, options.fetch ?? fetch);
    const config = loadSdkConfig(options.config);
    const checkNetwork = (network: EnvironmentRecord["settings"]["network"]) => {
      if (config.network?.mode === "disabled" && network?.mode === "internet")
        throw new PuteredError("SDK config disables internet. Use an offline environment.", "POLICY_DENIED");
      if (config.network?.mode === "internet" && network?.mode === "internet") {
        if (!preservesNetworkRules(config.network, network))
          throw new PuteredError("Environment network rules do not preserve this SDK's configured restrictions.", "POLICY_DENIED");
        if (config.network.maxBytesPerExecution !== undefined &&
            (network.maxBytesPerExecution ?? DEFAULT_INTERNET_BYTES) > config.network.maxBytesPerExecution)
          throw new PuteredError("Environment network limit exceeds this SDK's configured limit.", "POLICY_DENIED");
      }
    };
    this.tools = new Tools(transport);
    this.assets = new Assets(transport);
    this.presets = new Presets(transport);
    this.environments = {
      create: async (value = {}) => {
        if (!value || typeof value !== "object" || Array.isArray(value) ||
            Object.keys(value).some(key => !["name", "template", "tools", "settings", "persistence", "execution"].includes(key)))
          throw new PuteredError("Unknown or invalid environment creation option.", "INVALID_INPUT");
        const persistence = value.persistence === undefined ? config.persistence
          : inputContract(persistenceSchema, value.persistence);
        const execution = value.execution === undefined ? config.execution
          : inputContract(createEnvironmentSchema.shape.execution!, value.execution);
        const requestedNetwork = value.settings?.network;
        const network = config.network?.mode === "internet" && requestedNetwork?.mode === "internet"
          ? { ...config.network, ...requestedNetwork } : requestedNetwork ?? config.network;
        const request = inputContract(createEnvironmentSchema, {
          ...(persistence === undefined ? {} : { persistence }),
          ...(execution === undefined ? {} : { execution }),
          ...(value.name === undefined ? {} : { name: value.name }),
          ...(value.template === undefined ? {} : { template: value.template }),
          ...(value.tools === undefined ? {} : { tools: value.tools.map(tool => tool.id) }),
          settings: { ...value.settings, ...(network === undefined ? {} : { network }) },
        });
        checkNetwork(request.settings?.network);
        const record = await transport.request("/environments", "POST", environmentResponseSchema, request);
        if (request.persistence !== undefined && (record.persistence === undefined || !samePersistence(request.persistence, record.persistence)))
          throw new PuteredError("Environment response does not preserve the requested persistence policy.", "PROTOCOL_ERROR");
        const expectedExecution = request.execution === undefined ? undefined
          : { default: request.execution.default ?? "native", ...(request.execution.programs === undefined ? {} : { programs: request.execution.programs }) };
        if (expectedExecution !== undefined && canonical(expectedExecution) !== canonical(record.execution ?? null))
          throw new PuteredError("Environment response does not preserve the requested execution preference.", "PROTOCOL_ERROR");
        if (request.name !== undefined && record.name !== request.name)
          throw new PuteredError("Environment response does not match the requested name.", "PROTOCOL_ERROR");
        if (request.tools && canonical([...new Set(request.tools)].sort()) !== canonical([...record.tools].sort()))
          throw new PuteredError("Environment response does not match the requested tools.", "PROTOCOL_ERROR");
        for (const key of ["git", "execution", "timeoutMs"] as const)
          if (request.settings?.[key] !== undefined && canonical(request.settings[key]) !== canonical(record.settings[key] ?? null))
            throw new PuteredError("Environment response does not match the requested settings.", "PROTOCOL_ERROR");
        const wanted = request.settings?.network, actual = record.settings.network;
        if (wanted && (wanted.mode !== actual?.mode || wanted.mode === "internet" && actual?.mode === "internet" &&
            (!preservesNetworkRules(wanted, actual) || (wanted.maxBytesPerExecution !== undefined &&
              (actual.maxBytesPerExecution ?? DEFAULT_INTERNET_BYTES) > wanted.maxBytesPerExecution))))
          throw new PuteredError("Environment response does not preserve the requested network policy.", "PROTOCOL_ERROR");
        checkNetwork(record.settings.network);
        return new Environment(transport, record);
      },
      connect: async (id, options = {}) => {
        inputContract(environmentSchema.shape.id, id);
        const record = await transport.request(`/environments/${id}`, "GET", environmentResponseSchema, undefined, options.signal);
        if (record.id !== id) throw new PuteredError("Environment response ID mismatch.", "PROTOCOL_ERROR");
        checkNetwork(record.settings.network);
        return new Environment(transport, record);
      },
    };
  }
}
