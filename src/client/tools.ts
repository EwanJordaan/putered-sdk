import { z } from "zod";
import { artifactId, toolIdSchema, toolOptionsSchema, type EnvironmentRecord, type StoredTool } from "../tool-contract.js";
import { canonical, freezeRecord, jsonValue, type DeepReadonly, type Json, type ToolMap, type ToolPlugin } from "../tool-definition.js";
import { packageOf } from "../tool-artifact.js";
import { PuteredError } from "../errors.js";
import { compileToolSchema, toolValidator } from "../tool-validation.js";
import type { Transport } from "./transport.js";
import { callOptions, inputContract, mergeResources, type CallOptions } from "./input-contract.js";
import { storedToolResponseSchema, toolCallResponseSchema } from "./responses.js";

declare const toolTypes: unique symbol;
export interface ToolReference<T extends ToolMap | null = null> {
  readonly id: string;
  readonly visibility: "private";
  readonly manifest: DeepReadonly<StoredTool["manifest"]>;
  readonly [toolTypes]: T;
}
export interface ToolUseOptions { visibility?: "private" }

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

export class EnvironmentTools {
  constructor(private readonly transport: Transport, private readonly record: EnvironmentRecord,
    private readonly configResources?: { cpu?: number; memoryMiB?: number }) {}
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
    const resources = mergeResources(this.configResources, this.record.settings.resources, options.resources);
    const result = await this.transport.request(`/environments/${this.record.id}/tools/call`, "POST",
      toolCallResponseSchema, {
        id: reference.id, tool: name, input: value,
        ...callOptions({ ...options, ...(Object.keys(resources).length ? { resources } : {}) }),
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

