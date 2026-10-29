import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import { ERROR_CODES, PuteredError, codeForStatus } from "../errors.js";
import { execResultSchema } from "./responses.js";
import type { Transport } from "./transport.js";
import { snapshotSchema, validateCommandPath } from "./commands.js";

const ticketSchema = z.object({ jobId: z.string().uuid(), state: z.literal("running"), commandPath: z.string().optional() });
const jobSchema = z.object({
  id: z.string().uuid(), environmentId: z.string(), state: z.enum(["running", "completed", "failed", "unknown"]),
  httpStatus: z.number().int().min(100).max(599).optional(), result: z.unknown().optional(), error: z.string().optional(),
});

/** Submit exactly once. Polling reads the saved result; it never replays execution. */
export async function asyncExecution(transport: Transport, environmentId: string,
  input: { command: string; timeoutMs?: number; wait?: true; requestId?: string } | ({ program: string; args: string[] } & { timeoutMs?: number; wait?: true; requestId?: string }),
  signal?: AbortSignal, endpoint: "exec" | "run" = "exec", cancelOnAbort = false): Promise<z.infer<typeof execResultSchema>> {
  const accepted = await transport.request(`/environments/${environmentId}/${endpoint}?async=1`, "POST",
    z.union([ticketSchema, execResultSchema]), input, signal);
  // Direct core servers may return their ordinary result instead of a job ticket.
  if ("stdout" in accepted) return accepted;
  if (input.requestId !== undefined && accepted.jobId !== input.requestId)
    throw new PuteredError("Command ticket identity mismatch.", "PROTOCOL_ERROR");
  const commandPath = validateCommandPath(accepted.commandPath, environmentId, accepted.jobId);
  transport.rememberCommandPath(environmentId, accepted.jobId, commandPath);
  let cancelCommand: (() => void) | undefined;
  if (cancelOnAbort && signal) {
    cancelCommand = () => { void transport.request(`${commandPath}/signal`, "POST", snapshotSchema,
      { signal: "SIGKILL" }).then(snapshot => {
        if (snapshot.id !== accepted.jobId || snapshot.environmentId !== environmentId)
          throw new PuteredError("Command result identity mismatch.", "PROTOCOL_ERROR");
      }).catch(() => undefined); };
    if (signal.aborted) cancelCommand(); else signal.addEventListener("abort", cancelCommand, { once: true });
  }
  const deadline = AbortSignal.timeout(30 * 60 * 1000);
  const pollingSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    for (;;) {
      pollingSignal.throwIfAborted();
      const job = await transport.request(accepted.commandPath ? `${commandPath}?cursor=0` : commandPath, "GET", jobSchema, undefined, pollingSignal);
      if (job.id !== accepted.jobId || job.environmentId !== environmentId)
        throw new PuteredError("Execution result identity mismatch.", "PROTOCOL_ERROR");
      if (job.state === "unknown")
        throw new PuteredError(job.error ?? "Execution outcome is unknown.", "CONFLICT");
      if (job.state === "failed") {
        if (job.httpStatus === undefined || job.httpStatus < 300)
          throw new PuteredError("Invalid saved execution failure.", "PROTOCOL_ERROR");
        const error = z.object({ error: z.string(), code: z.string().optional() }).safeParse(job.result);
        const code = error.success ? z.enum(ERROR_CODES).safeParse(error.data.code) : undefined;
        throw new PuteredError(error.success ? error.data.error : job.error ?? "Execution failed.",
          code?.success ? code.data : codeForStatus(job.httpStatus), { status: job.httpStatus });
      }
      if (job.state === "completed") {
        const result = execResultSchema.safeParse(job.result);
        if (!result.success || job.httpStatus === undefined || job.httpStatus < 200 || job.httpStatus >= 300)
          throw new PuteredError("Invalid saved execution result.", "PROTOCOL_ERROR");
        if (cancelCommand) signal?.removeEventListener("abort", cancelCommand);
        return result.data;
      }
      await delay(1000, undefined, { signal: pollingSignal });
    }
  } catch (error) {
    if (cancelCommand) signal?.removeEventListener("abort", cancelCommand);
    const code = signal?.aborted ? "CANCELLED" : deadline.aborted ? "TIMEOUT" : error instanceof PuteredError ? error.code : "NETWORK_ERROR";
    throw new PuteredError(`${error instanceof Error ? error.message : "Could not collect execution result."} Execution ID: ${accepted.jobId}. Inspect this execution before retrying; the command was not replayed.`,
      code, { ...(error instanceof PuteredError && error.code === code ? { status: error.status } : {}), cause: error });
  }
}
