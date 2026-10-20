export const ERROR_CODES = [
  "INVALID_INPUT", "INVALID_OUTPUT", "PAYLOAD_TOO_LARGE", "NOT_FOUND",
  "UNAUTHORIZED", "POLICY_DENIED", "CONFLICT", "TIMEOUT", "CANCELLED",
  "QUOTA_EXCEEDED", "PACKAGE_INVALID", "STORAGE_ERROR", "EXECUTION_FAILED",
  "PROTOCOL_ERROR", "NETWORK_ERROR", "INTERNAL_ERROR",
] as const;
export type ErrorCode = typeof ERROR_CODES[number];

export function errorStatus(code: ErrorCode): number {
  switch (code) {
    case "INVALID_INPUT": case "PACKAGE_INVALID": return 400;
    case "UNAUTHORIZED": return 401;
    case "POLICY_DENIED": return 403;
    case "NOT_FOUND": return 404;
    case "CONFLICT": return 409;
    case "PAYLOAD_TOO_LARGE": return 413;
    case "QUOTA_EXCEEDED": return 429;
    case "CANCELLED": return 499;
    case "INVALID_OUTPUT": case "PROTOCOL_ERROR": return 502;
    case "NETWORK_ERROR": return 503;
    case "TIMEOUT": return 504;
    default: return 500;
  }
}
export function codeForStatus(status: number): ErrorCode {
  return ({ 400: "INVALID_INPUT", 401: "UNAUTHORIZED", 403: "POLICY_DENIED",
    404: "NOT_FOUND", 409: "CONFLICT", 413: "PAYLOAD_TOO_LARGE", 429: "QUOTA_EXCEEDED",
    499: "CANCELLED", 502: "PROTOCOL_ERROR", 503: "NETWORK_ERROR", 504: "TIMEOUT",
    520: "NETWORK_ERROR", 521: "NETWORK_ERROR", 522: "TIMEOUT", 523: "NETWORK_ERROR",
    524: "TIMEOUT", 525: "NETWORK_ERROR", 526: "NETWORK_ERROR" } as Record<number, ErrorCode>)[status] ?? "INTERNAL_ERROR";
}
export class PuteredError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  constructor(message: string, codeOrStatus: ErrorCode | number = "INTERNAL_ERROR",
    options: { status?: number; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = "PuteredError";
    this.code = typeof codeOrStatus === "number" ? codeForStatus(codeOrStatus) : codeOrStatus;
    this.status = options.status ?? (typeof codeOrStatus === "number" ? codeOrStatus : errorStatus(this.code));
  }
}
