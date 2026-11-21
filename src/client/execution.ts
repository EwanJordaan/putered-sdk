import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import { PuteredError } from "../errors.js";
import { execResultSchema } from "./responses.js";
import { parseWireError, type Transport } from "./transport.js";
import { commandJobBaseSchema, commandTicketSchema, registerCommandTicket, snapshotSchema } from "./commands.js";
import type { CallOptions } from "./input-contract.js";

/** Submit exactly once. Polling reads the saved result; it never replays execution. */
export async function asyncExecution(transport: Transport, environmentId: string,
  input: ({ command: string; requestId?: string } | { program: string; args: string[]; requestId?: string }) &
    Pick<CallOptions, "timeoutMs" | "wait" | "resources" | "queueTimeoutMs">,
  signal?: AbortSignal, endpoint: "exec" | "run" = "exec", cancelOnAbort = true): Promise<z.infer<typeof execResultSchema>> {
  const accepted = await transport.request(`/environments/${environmentId}/${endpoint}?async=1`, "POST",
    z.union([commandTicketSchema, execResultSchema]), input, signal);
  // Direct core servers may return their ordinary result instead of a job ticket.
  if ("stdout" in accepted) return accepted;
  const commandPath = registerCommandTicket(transport, environmentId, accepted, input.requestId);
  let cancelCommand: (() => void) | undefined;
  if (cancelOnAbort && signal) {
    cancelCommand = () => {
      void transport.request(`${commandPath}/signal`, "POST", snapshotSchema, { signal: "SIGKILL" })
        .then(snapshot => {
          if (snapshot.id !== accepted.jobId || snapshot.environmentId !== environmentId)
            throw new PuteredError("Command result identity mismatch.", "PROTOCOL_ERROR");
        }).catch(() => undefined);
    };
    if (signal.aborted) cancelCommand();
    else signal.addEventListener("abort", cancelCommand, { once: true });
  }
  const deadline = AbortSignal.timeout(30 * 60 * 1000);
  const pollingSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    for (;;) {
      pollingSignal.throwIfAborted();
      const job = await transport.request(accepted.commandPath ? `${commandPath}?cursor=0` : commandPath, "GET", commandJobBaseSchema, undefined, pollingSignal);
      if (job.id !== accepted.jobId || job.environmentId !== environmentId)
        throw new PuteredError("Execution result identity mismatch.", "PROTOCOL_ERROR");
      if (job.state === "unknown")
        throw new PuteredError(job.error ?? "Execution outcome is unknown.", "CONFLICT");
      if (job.state === "failed") {
        if (job.httpStatus === undefined || job.httpStatus < 300)
          throw new PuteredError("Invalid saved execution failure.", "PROTOCOL_ERROR");
        throw parseWireError(job.result, job.error ?? "Execution failed.", job.httpStatus);
      }
      if (job.state === "completed") {
        const result = execResultSchema.safeParse(job.result);
        if (!result.success || job.httpStatus === undefined || job.httpStatus < 200 || job.httpStatus >= 300)
          throw new PuteredError("Invalid saved execution result.", "PROTOCOL_ERROR");
        return result.data;
      }
      await delay(1000, undefined, { signal: pollingSignal });
    }
  } catch (error) {
    const code = signal?.aborted ? "CANCELLED" : deadline.aborted ? "TIMEOUT" : error instanceof PuteredError ? error.code : "NETWORK_ERROR";
    throw new PuteredError(`${error instanceof Error ? error.message : "Could not collect execution result."} Execution ID: ${accepted.jobId}. Inspect this execution before retrying; the command was not replayed.`,
      code, { ...(error instanceof PuteredError && error.code === code ? { status: error.status } : {}), cause: error });
  } finally {
    if (cancelCommand) signal?.removeEventListener("abort", cancelCommand);
  }
}
