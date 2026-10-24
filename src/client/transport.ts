import { z } from "zod";
import { encodeJson } from "../json.js";
import { ERROR_CODES, PuteredError, codeForStatus } from "../errors.js";
import { MAX_BYTES } from "../limits.js";
export class Transport {
  private readonly commandPaths = new Map<string, string>();
  get accountApi() { return this.apiKey.startsWith('pk_live_'); }
  constructor(private readonly baseUrl: string, private readonly apiKey: string,
    private readonly fetcher: typeof fetch) {}
  rememberCommandPath(environmentId: string, commandId: string, path: string): void {
    const key = `${environmentId}:${commandId}`;
    this.commandPaths.delete(key);
    this.commandPaths.set(key, path);
    if (this.commandPaths.size > 256) this.commandPaths.delete(this.commandPaths.keys().next().value!);
  }
  commandPath(environmentId: string, commandId: string): string {
    const known = this.commandPaths.get(`${environmentId}:${commandId}`);
    if (known) return known;
    const hosted = new URL(this.baseUrl).pathname.replace(/\/$/, "").endsWith("/api/compute");
    return hosted ? `/execution-jobs/${commandId}` : `/environments/${environmentId}/commands/${commandId}`;
  }
  async request<S extends z.ZodType>(path: string, method: string, schema: S,
    input?: unknown, signal?: AbortSignal, bytes?: Uint8Array): Promise<z.output<S>> {
    const body = bytes ? new Uint8Array(bytes).buffer : input === undefined ? undefined : encodeJson(input);
    return this.parse(await this.send(path, {
      method, signal,
      headers: { "Content-Type": bytes ? "application/octet-stream" : "application/json" },
      ...(body === undefined ? {} : { body }),
    }), schema, signal);
  }
  async upload<S extends z.ZodType>(path: string, schema: S, body: AsyncIterable<Uint8Array>,
    contentType: string, contentLength: number, signal?: AbortSignal): Promise<z.output<S>> {
    return this.parse(await this.send(path, {
      method: "POST", signal, headers: { "Content-Type": contentType, "Content-Length": String(contentLength) },
      body: body as unknown as BodyInit, duplex: "half",
    } as RequestInit), schema, signal);
  }
  async download(path: string, signal?: AbortSignal): Promise<Response> {
    const response = await this.send(path, { method: "GET", signal });
    if (!response.ok) await this.parse(response, z.unknown(), signal);
    return response;
  }
  private async send(path: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try { response = await this.fetcher(`${this.baseUrl}/v1${path}`, {
      ...init, redirect: "manual",
      headers: { ...init.headers, Authorization: `Bearer ${this.apiKey}` },
    }); } catch (error) {
      throw new PuteredError(init.signal?.aborted ? "Request cancelled; execution may have partial side effects." : "Could not reach Putered; do not retry execution blindly.",
        init.signal?.aborted ? "CANCELLED" : "NETWORK_ERROR", { cause: error });
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new PuteredError("Putered redirected the request; it was not followed or retried.", "NETWORK_ERROR", { status: response.status });
    }
    return response;
  }
  private async parse<S extends z.ZodType>(response: Response, schema: S, signal?: AbortSignal): Promise<z.output<S>> {
    const reader = response.body?.getReader();
    if (!reader) throw new PuteredError(`Empty Putered response (HTTP ${response.status}).`, response.ok ? "PROTOCOL_ERROR" : codeForStatus(response.status),
      response.ok ? {} : { status: response.status });
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        // A valid byte can require six JSON escape bytes plus base64/text copies.
        if (size > MAX_BYTES * 8) throw new PuteredError("Putered response exceeds limit.", "PAYLOAD_TOO_LARGE");
        chunks.push(next.value);
      }
    } catch (error) {
      if (error instanceof PuteredError) throw error;
      throw new PuteredError(signal?.aborted ? "Request cancelled." : "Could not read the Putered response.",
        signal?.aborted ? "CANCELLED" : "NETWORK_ERROR", { cause: error });
    } finally { await reader.cancel().catch(() => undefined); }
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
    catch (error) { throw new PuteredError(`Invalid JSON response from Putered (HTTP ${response.status}); execution was not retried.`,
      response.ok ? "PROTOCOL_ERROR" : codeForStatus(response.status), { cause: error, ...(response.ok ? {} : { status: response.status }) }); }
    if (!response.ok) {
      const error = z.object({ error: z.string(), code: z.string().optional() }).safeParse(value);
      const code = error.success ? z.enum(ERROR_CODES).safeParse(error.data.code) : undefined;
      throw new PuteredError(error.success ? error.data.error : "Putered request failed.",
        code?.success ? code.data : codeForStatus(response.status), { status: response.status });
    }
    try { return await schema.parseAsync(value); }
    catch (error) { throw new PuteredError("Putered response does not match its contract.", "PROTOCOL_ERROR", { cause: error }); }
  }
}
