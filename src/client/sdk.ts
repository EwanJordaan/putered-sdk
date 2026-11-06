import { z } from "zod";
import { createEnvironmentSchema, environmentSchema, type EnvironmentRecord } from "../tool-contract.js";
import { canonical, type ToolMap } from "../tool-definition.js";
import { PuteredError } from "../errors.js";
import { DEFAULT_INTERNET_BYTES, preservesNetworkRules } from "../network-policy.js";
import { persistenceSchema, samePersistence, type Persistence } from "../persistence-contract.js";
import { redactOutboundPolicy } from "../outbound-policy.js";
import { Transport } from "./transport.js";
import { Assets } from "./assets.js";
import { Presets } from "./presets.js";
import { Tools, type ToolReference } from "./tools.js";
import { Environment } from "./environment.js";
import { inputContract } from "./input-contract.js";
import { loadSdkConfig, type SdkConfig } from "./config.js";
import { environmentResponseSchema } from "./responses.js";

export { Tools } from "./tools.js";
export type { ToolReference, ToolUseOptions } from "./tools.js";
export { Environment } from "./environment.js";
export type { ExecOptions, ExecResult, RunOptions } from "./environment.js";
export type { CallOptions } from "./input-contract.js";
export { CommandError } from "./command-output.js";
export { CommandHandle } from "./commands.js";
export type { CommandSignal, OutputChunk, OutputBytesChunk, LogOptions, GetCommandOptions } from "./commands.js";
export { TerminalSession } from "./terminals.js";
export type { TerminalState } from "./terminals.js";
export { PuteredError, ERROR_CODES } from "../errors.js";
export type { ErrorCode } from "../errors.js";
export type { AssetReference, AssetPlatform } from "../asset-contract.js";
export type { AssetUploadOptions } from "./assets.js";
export type { Preset, PresetSaveScope } from "../preset-contract.js";
export type { CapturePresetOptions, PresetRequestOptions, PresetTransferOptions, PresetUploadOptions, PresetDownloadOptions } from "./presets.js";
export type { Persistence } from "../persistence-contract.js";
export type { OutboundPolicy } from "../outbound-policy.js";
export type { SdkConfig } from "./config.js";
export type { InternetPolicy, NetworkRuntime } from "../network-policy.js";

export interface EnvironmentOptions {
  persistence?: Persistence;
  /** Default execution backend preference for commands in the new environment. */
  execution?: z.input<typeof createEnvironmentSchema>["execution"];
  /** Optional display name, trimmed to 1–100 characters. Supported by hosted accounts. */
  name?: string;
  template?: string;
  tools?: readonly ToolReference<ToolMap | null>[];
  settings?: z.input<typeof createEnvironmentSchema>["settings"];
  /** Environment variables stored for commands in this environment. */
  env?: z.input<typeof createEnvironmentSchema>["env"];
  /** Outbound HTTP request policy for this environment. */
  networkPolicy?: z.input<typeof createEnvironmentSchema>["networkPolicy"];
}
function environmentRequest(value: EnvironmentOptions, config: SdkConfig) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => !["name", "template", "tools", "settings", "persistence", "execution", "env", "networkPolicy"].includes(key)))
    throw new PuteredError("Unknown or invalid environment creation option.", "INVALID_INPUT");
  const persistence = value.persistence === undefined ? config.persistence
    : inputContract(persistenceSchema, value.persistence);
  const execution = value.execution === undefined ? config.execution
    : inputContract(createEnvironmentSchema.shape.execution!, value.execution);
  const requestedNetwork = value.settings?.network;
  const network = config.network?.mode === "internet" && requestedNetwork?.mode === "internet"
    ? { ...config.network, ...requestedNetwork } : requestedNetwork ?? config.network;
  return inputContract(createEnvironmentSchema, {
    ...(persistence === undefined ? {} : { persistence }),
    ...(execution === undefined ? {} : { execution }),
    ...(value.name === undefined ? {} : { name: value.name }),
    ...(value.template === undefined ? {} : { template: value.template }),
    ...(value.tools === undefined ? {} : { tools: value.tools.map(tool => tool.id) }),
    settings: { ...value.settings, ...(network === undefined ? {} : { network }) },
    ...(value.env === undefined ? {} : { env: value.env }),
    ...(value.networkPolicy === undefined ? {} : { networkPolicy: value.networkPolicy }),
  });
}

function checkEnvironmentResponse(request: z.output<typeof createEnvironmentSchema>, record: EnvironmentRecord): void {
  if (request.persistence !== undefined && (record.persistence === undefined || !samePersistence(request.persistence, record.persistence)))
    throw new PuteredError("Environment response does not preserve the requested persistence policy.", "PROTOCOL_ERROR");
  const expectedExecution = request.execution === undefined ? undefined
    : { default: request.execution.default ?? "native", ...(request.execution.programs === undefined ? {} : { programs: request.execution.programs }) };
  if (expectedExecution !== undefined && canonical(expectedExecution) !== canonical(record.execution ?? null))
    throw new PuteredError("Environment response does not preserve the requested execution preference.", "PROTOCOL_ERROR");
  if (request.name !== undefined && record.name !== request.name)
    throw new PuteredError("Environment response does not match the requested name.", "PROTOCOL_ERROR");
  if (request.env !== undefined && canonical(record.env ?? null) !== canonical(request.env))
    throw new PuteredError("Environment response does not preserve the requested environment variables.", "PROTOCOL_ERROR");
  if (request.networkPolicy !== undefined && canonical(record.networkPolicy ?? null) !== canonical(redactOutboundPolicy(request.networkPolicy)))
    throw new PuteredError("Environment response does not preserve the requested outbound network policy.", "PROTOCOL_ERROR");
  if (request.tools && canonical([...new Set(request.tools)].sort()) !== canonical([...record.tools].sort()))
    throw new PuteredError("Environment response does not match the requested tools.", "PROTOCOL_ERROR");
  for (const key of ["git", "execution", "timeoutMs"] as const)
    if (request.settings?.[key] !== undefined && canonical(request.settings[key]) !== canonical(record.settings[key] ?? null))
      throw new PuteredError("Environment response does not match the requested settings.", "PROTOCOL_ERROR");
  const wanted = request.settings?.network;
  const actual = record.settings.network;
  if (wanted) {
    const modeChanged = wanted.mode !== actual?.mode;
    const rulesChanged = wanted.mode === "internet" && actual?.mode === "internet" && !preservesNetworkRules(wanted, actual);
    const limitExceeded = wanted.mode === "internet" && actual?.mode === "internet" &&
      wanted.maxBytesPerExecution !== undefined &&
      (actual.maxBytesPerExecution ?? DEFAULT_INTERNET_BYTES) > wanted.maxBytesPerExecution;
    if (modeChanged || rulesChanged || limitExceeded)
      throw new PuteredError("Environment response does not preserve the requested network policy.", "PROTOCOL_ERROR");
  }
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
        const request = environmentRequest(value, config);
        checkNetwork(request.settings?.network);
        const record = await transport.request("/environments", "POST", environmentResponseSchema, request);
        checkEnvironmentResponse(request, record);
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
