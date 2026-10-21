import { PuteredError } from "../errors.js";
import type { z } from "zod";
import type { execResultSchema } from "./responses.js";

export type ExecutionData = z.infer<typeof execResultSchema>;
export type OutputStream = "both" | "stdout" | "stderr";

/** A completed command failed. Both original streams remain available. */
export class CommandError extends PuteredError {
  readonly output: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly result: ExecutionData;
  constructor(result: ExecutionData) {
    super(`Command exited with code ${result.exitCode}.`, "EXECUTION_FAILED");
    this.name = "CommandError";
    this.output = result.stdout + result.stderr;
    this.stdout = result.stdout;
    this.stderr = result.stderr;
    this.exitCode = result.exitCode;
    this.result = result;
  }
}

export interface CommandResult extends ExecutionData {
  /** Read collected text without another request. Throws CommandError on nonzero exit. */
  output(stream?: OutputStream): Promise<string>;
}

export function commandResult(result: ExecutionData): CommandResult {
  return Object.defineProperty(result, "output", {
    enumerable: false,
    async value(stream: OutputStream = "both") {
      if (!["both", "stdout", "stderr"].includes(stream))
        throw new PuteredError("Output stream must be both, stdout or stderr.", "INVALID_INPUT");
      if (result.exitCode !== 0) throw new CommandError(result);
      return stream === "both" ? result.stdout + result.stderr : result[stream];
    },
  }) as CommandResult;
}
