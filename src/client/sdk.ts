import { z } from "zod";
import { createEnvironmentSchema, environmentSchema, type EnvironmentRecord } from "../tool-contract.js";
import { canonical, type ToolMap } from "../tool-definition.js";
import { PuteredError } from "../errors.js";
import { samePersistence, type Persistence } from "../persistence-contract.js";
import { Transport } from "./transport.js";
import { Assets } from "./assets.js";
import { Presets } from "./presets.js";
import { Tools, type ToolReference } from "./tools.js";
import { Environment } from "./environment.js";
import { assertEnvAndOutboundPolicy, assertNetworkPreserved, inputContract, mergeResources } from "./input-contract.js";
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
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new PuteredError("Unknown or invalid environment creation option.", "INVALID_INPUT");
  const { tools, settings, ...rest } = value;
  const settingsObject = settings !== undefined && typeof settings === "object" && settings !== null && !Array.isArray(settings)
    ? settings : undefined;
  const persistence = value.persistence === undefined ? config.persistence : value.persistence;
  const execution = value.execution === undefined ? config.execution : value.execution;
  const requestedNetwork = settingsObject?.network;
  const network = config.network?.mode === "internet" && requestedNetwork?.mode === "internet"
    ? { ...config.network, ...requestedNetwork } : requestedNetwork ?? config.network;
  const resources = mergeResources(config.resources, settingsObject?.resources);
  return inputContract(createEnvironmentSchema, {
    ...rest,
    ...(persistence === undefined ? {} : { persistence }),
    ...(execution === undefined ? {} : { execution }),
    ...(tools === undefined ? {} : { tools: Array.isArray(tools) ? tools.map(tool => tool?.id) : tools }),
    settings: settings !== undefined && !settingsObject ? settings : {
      ...settingsObject,
      ...(Object.keys(resources).length ? { resources } : {}),
      ...(network === undefined ? {} : { network }),
    },
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
  assertEnvAndOutboundPolicy(request, record);
  if (request.tools && canonical([...new Set(request.tools)].sort()) !== canonical([...record.tools].sort()))
    throw new PuteredError("Environment response does not match the requested tools.", "PROTOCOL_ERROR");
  for (const key of ["git", "execution", "timeoutMs", "resources"] as const)
    if (request.settings?.[key] !== undefined && canonical(request.settings[key]) !== canonical(record.settings[key] ?? null))
      throw new PuteredError("Environment response does not match the requested settings.", "PROTOCOL_ERROR");
  const wanted = request.settings?.network;
  const actual = record.settings.network;
  if (wanted) {
    if (wanted.mode !== actual?.mode)
      throw new PuteredError("Environment response does not preserve the requested network policy.", "PROTOCOL_ERROR");
    assertNetworkPreserved(wanted, actual, "PROTOCOL_ERROR", {
      rules: "Environment response does not preserve the requested network policy.",
      limit: "Environment response does not preserve the requested network policy.",
    });
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
      assertNetworkPreserved(config.network, network, "POLICY_DENIED", {
        rules: "Environment network rules do not preserve this SDK's configured restrictions.",
        limit: "Environment network limit exceeds this SDK's configured limit.",
      });
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
        return new Environment(transport, record, config.resources);
      },
      connect: async (id, options = {}) => {
        inputContract(environmentSchema.shape.id, id);
        const record = await transport.request(`/environments/${id}`, "GET", environmentResponseSchema, undefined, options.signal);
        if (record.id !== id) throw new PuteredError("Environment response ID mismatch.", "PROTOCOL_ERROR");
        checkNetwork(record.settings.network);
        return new Environment(transport, record, config.resources);
      },
    };
  }
}
