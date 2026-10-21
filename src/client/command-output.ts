import { PuteredError } from "../errors.js";
import type { z } from "zod";
import type { execResultSchema } from "./responses.js";

export type ExecutionData = z.infer<typeof execResultSchema>;

/** A completed command failed. Both original streams remain available. */
export class CommandError extends PuteredError {
  readonly output: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly result: CommandResult;
  constructor(result: CommandResult) {
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
  /** Collected stdout followed by stderr; no extra request or chronological ordering. */
  readonly output: string;
}

export function commandResult(result: ExecutionData, check = true): CommandResult {
  const command = Object.defineProperty(result, "output", {
    enumerable: false,
    value: result.stdout + result.stderr,
  }) as CommandResult;
  if (check && command.exitCode !== 0) throw new CommandError(command);
  return command;
}
