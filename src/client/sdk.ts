import { z } from "zod";
import { artifactId, callOptionsSchema, createEnvironmentSchema, environmentSchema,
  toolIdSchema, toolOptionsSchema, type EnvironmentRecord, type StoredTool } from "../tool-contract.js";
import { canonical, freezeRecord, jsonValue, type DeepReadonly, type Json, type ToolMap, type ToolPlugin } from "../tool-definition.js";
import { packageOf } from "../tool-artifact.js";
import { Transport } from "./transport.js";
import { asyncExecution } from "./execution.js";
import { commandResult, type CommandResult } from "./command-output.js";
export { CommandError } from "./command-output.js";
export type { OutputStream } from "./command-output.js";
import { Assets } from "./assets.js";
import { Presets, capturePreset, type CapturePresetOptions } from "./presets.js";
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
import { environmentResponseSchema, storedToolResponseSchema, execResultSchema, toolCallResponseSchema } from "./responses.js";
export type { SdkConfig } from "./config.js";
export type { InternetPolicy, NetworkRuntime } from "../network-policy.js";

function inputContract<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  try { return schema.parse(value); }
  catch (error) { throw new PuteredError("Input does not match the SDK contract.", "INVALID_INPUT", { cause: error }); }
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
export interface ExecOptions extends CallOptions { async?: boolean }
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
  readonly tools: EnvironmentTools;
  readonly id: string;
  constructor(private readonly transport: Transport, private readonly record: EnvironmentRecord) {
    this.id = record.id;
    this.tools = new EnvironmentTools(transport, record);
  }
  capturePreset(options: CapturePresetOptions) {
    return capturePreset(this.transport, this.id, options);
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
    const input = {
      command,
      ...inputContract(callOptionsSchema, { ...(options.wait === undefined ? {} : { wait: options.wait }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) }),
    };
    const result = options.async
      ? await asyncExecution(this.transport, this.id, input, options.signal)
      : await this.transport.request(`/environments/${this.id}/exec`, "POST", execResultSchema, input, options.signal);
    return commandResult(result);
  }
}
export interface EnvironmentOptions {
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
  constructor(options: { baseUrl: string; apiKey: string; fetch?: typeof fetch; config?: SdkConfig | string }) {
    let url: URL;
    try { url = new URL(options.baseUrl); }
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
        const requestedNetwork = value.settings?.network;
        const network = config.network?.mode === "internet" && requestedNetwork?.mode === "internet"
          ? { ...config.network, ...requestedNetwork } : requestedNetwork ?? config.network;
        const request = inputContract(createEnvironmentSchema, {
          ...(value.template === undefined ? {} : { template: value.template }),
          ...(value.tools === undefined ? {} : { tools: value.tools.map(tool => tool.id) }),
          settings: { ...value.settings, ...(network === undefined ? {} : { network }) },
        });
        checkNetwork(request.settings?.network);
        const record = await transport.request("/environments", "POST", environmentResponseSchema, request);
        if (request.tools && canonical([...new Set(request.tools)].sort()) !== canonical([...record.tools].sort()))
          throw new PuteredError("Environment response does not match the requested tools.", "PROTOCOL_ERROR");
        for (const key of ["git", "execution", "saveScope", "timeoutMs"] as const)
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
