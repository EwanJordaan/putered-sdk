import { z } from "zod";
import { encodeJson } from "../json.js";
import { ERROR_CODES, PuteredError, codeForStatus } from "../errors.js";
import { MAX_BYTES } from "../limits.js";
export class Transport {
  constructor(private readonly baseUrl: string, private readonly apiKey: string,
    private readonly fetcher: typeof fetch) {}
  async request<S extends z.ZodType>(path: string, method: string, schema: S,
    input?: unknown, signal?: AbortSignal, bytes?: Uint8Array): Promise<z.output<S>> {
    const body = bytes ? new Uint8Array(bytes).buffer : input === undefined ? undefined : encodeJson(input);
    let response: Response;
    try { response = await this.fetcher(`${this.baseUrl}/v1${path}`, {
      method, signal, redirect: "error",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": bytes ? "application/octet-stream" : "application/json" },
      ...(body === undefined ? {} : { body }),
    }); } catch (error) {
      throw new PuteredError(signal?.aborted ? "Request cancelled; execution may have partial side effects." : "Could not reach Putered; do not retry execution blindly.",
        signal?.aborted ? "CANCELLED" : "NETWORK_ERROR", { cause: error });
    }
    const reader = response.body?.getReader();
    if (!reader) throw new PuteredError("Empty Putered response.", "PROTOCOL_ERROR", { status: response.status });
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
    try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch (error) { throw new PuteredError("Invalid JSON response from Putered.", "PROTOCOL_ERROR", { cause: error }); }
    if (!response.ok) {
      const error = z.object({ error: z.string(), code: z.enum(ERROR_CODES).optional() }).safeParse(value);
      throw new PuteredError(error.success ? error.data.error : "Putered request failed.",
        error.success && error.data.code ? error.data.code : codeForStatus(response.status), { status: response.status });
    }
    try { return await schema.parseAsync(value); }
    catch (error) { throw new PuteredError("Putered response does not match its contract.", "PROTOCOL_ERROR", { cause: error }); }
  }
}
