/**
 * RFC 9457 Problem Details. `type` is an absolute URN (no domain is provisioned, ADR-0002); `code` is the stable
 * machine code clients branch on and localise (AR required). Bodies never carry stack traces, messages of unknown
 * errors or personal data; `request_id` is always present.
 */
export interface ProblemViolation {
  readonly path: string;
  readonly code: string;
  readonly message_key?: string;
}

export interface ProblemBody {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly code: string;
  readonly request_id: string;
  readonly detail?: string;
  readonly retry_after_s?: number;
  readonly errors?: readonly ProblemViolation[];
}

export interface ProblemOptions {
  readonly detail?: string;
  readonly errors?: readonly ProblemViolation[];
  readonly retryAfterS?: number;
  readonly headers?: Readonly<Record<string, string>>;
}

export class ProblemError extends Error {
  constructor(
    readonly status: number,
    /** kebab-case machine code, also the URN suffix. */
    readonly code: string,
    readonly title: string,
    readonly options: ProblemOptions = {},
  ) {
    super(`${code}: ${title}`);
    this.name = "ProblemError";
  }
}

export const PROBLEM_TYPE_PREFIX = "urn:outlex:problem:";

export const Problems = {
  badRequest: (code = "bad-request", detail?: string) =>
    new ProblemError(400, code, "Bad request", detail === undefined ? {} : { detail }),
  validation: (errors: readonly ProblemViolation[]) => new ProblemError(400, "validation-failed", "Request validation failed", { errors: errors.slice(0, 50) }),
  unauthenticated: (code = "unauthenticated") =>
    new ProblemError(401, code, "Authentication is required", { headers: { "WWW-Authenticate": 'Bearer realm="outlex"' } }),
  forbidden: (code = "forbidden") => new ProblemError(403, code, "You are not allowed to do this"),
  notFound: (code = "not-found") => new ProblemError(404, code, "Resource not found"),
  conflict: (code = "conflict") => new ProblemError(409, code, "Conflict"),
  unprocessable: (code = "unprocessable", errors?: readonly ProblemViolation[]) =>
    new ProblemError(422, code, "Unprocessable request", errors === undefined ? {} : { errors: errors.slice(0, 50) }),
  idempotencyKeyInvalid: () =>
    new ProblemError(400, "idempotency-key-invalid", "Idempotency-Key is missing or invalid", {
      detail: "Send a client-generated UUIDv7 created within the last 24 hours.",
    }),
  idempotencyKeyReuse: () => new ProblemError(422, "idempotency-key-reuse", "Idempotency-Key was used with a different request"),
  idempotencyInFlight: () =>
    new ProblemError(409, "idempotency-in-flight", "A request with this Idempotency-Key is still in progress", { retryAfterS: 1, headers: { "Retry-After": "1" } }),
  idempotentReplayUnavailable: () =>
    new ProblemError(409, "idempotent-replay-unavailable", "The original response carried credentials and is not stored: retry with a new Idempotency-Key"),
  rateLimited: (retryAfterS: number) => {
    const s = Math.max(1, Math.ceil(retryAfterS));
    return new ProblemError(429, "rate-limited", "Too many requests", { retryAfterS: s, headers: { "Retry-After": String(s) } });
  },
  payloadTooLarge: () => new ProblemError(413, "payload-too-large", "Request body too large"),
  unsupportedMediaType: () => new ProblemError(415, "unsupported-media-type", "Unsupported media type"),
  unavailable: (code = "service-unavailable") =>
    new ProblemError(503, code, "The service is temporarily unavailable", { retryAfterS: 5, headers: { "Retry-After": "5" } }),
  internal: (code = "internal-error") => new ProblemError(500, code, "Internal server error"),
} as const;

export const problemBody = (p: ProblemError, requestId: string): ProblemBody => ({
  type: `${PROBLEM_TYPE_PREFIX}${p.code}`,
  title: p.title,
  status: p.status,
  code: p.code,
  request_id: requestId,
  ...(p.options.detail === undefined ? {} : { detail: p.options.detail }),
  ...(p.options.retryAfterS === undefined ? {} : { retry_after_s: p.options.retryAfterS }),
  ...(p.options.errors === undefined ? {} : { errors: p.options.errors }),
});
