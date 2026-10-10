import type { Violation } from "@outlet/validation";

/**
 * RFC 9457 problem. `type` is a stable relative URI, `code` a machine code for client
 * branching and Arabic localisation. Never carries stack traces or internal identifiers.
 */
export interface ProblemBody {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail?: string;
  readonly code?: string;
  readonly request_id?: string;
  readonly errors?: readonly Violation[];
  readonly [extension: string]: unknown;
}

export interface ProblemOptions {
  readonly detail?: string;
  readonly code?: string;
  readonly errors?: readonly Violation[];
  /** Extra machine readable members (for example attempts_remaining). Must not contain PII. */
  readonly extensions?: Readonly<Record<string, string | number | boolean | null>>;
  readonly headers?: Readonly<Record<string, string>>;
}

export class ProblemError extends Error {
  constructor(
    readonly status: number,
    readonly slug: string,
    readonly title: string,
    readonly options: ProblemOptions = {},
  ) {
    super(`${slug}: ${title}`);
    this.name = "ProblemError";
  }
}

export const Problems = {
  validation: (errors: readonly Violation[]) =>
    new ProblemError(400, "validation-failed", "Request validation failed", { code: "validation_failed", errors }),
  malformedBody: () => new ProblemError(400, "malformed-body", "Request body could not be parsed", { code: "malformed_body" }),
  invalidIdempotencyKey: () =>
    new ProblemError(400, "invalid-idempotency-key", "Idempotency-Key is missing or malformed", {
      detail: "Send a UUIDv7 in the Idempotency-Key header.",
      code: "invalid_idempotency_key",
    }),
  unauthenticated: (code = "unauthenticated") =>
    new ProblemError(401, "unauthenticated", "Authentication is required", {
      code,
      headers: { "WWW-Authenticate": "Bearer" },
    }),
  forbidden: (code = "forbidden") => new ProblemError(403, "forbidden", "You are not allowed to do this", { code }),
  notFound: () => new ProblemError(404, "not-found", "Resource not found", { code: "not_found" }),
  idempotencyKeyReuse: () =>
    new ProblemError(422, "idempotency-key-reuse", "Idempotency-Key was used with a different request", {
      code: "idempotency_key_reuse",
    }),
  idempotencyInFlight: () =>
    new ProblemError(409, "idempotency-in-flight", "A request with this Idempotency-Key is still in progress", {
      code: "idempotency_in_flight",
      headers: { "Retry-After": "1" },
    }),
  rateLimited: (retryAfterSeconds: number) =>
    new ProblemError(429, "rate-limited", "Too many requests", {
      code: "rate_limited",
      headers: { "Retry-After": String(Math.max(1, Math.ceil(retryAfterSeconds))) },
    }),
  unavailable: (code = "service_unavailable") =>
    new ProblemError(503, "service-unavailable", "The service is temporarily unavailable", {
      code,
      headers: { "Retry-After": "5" },
    }),
  internal: () => new ProblemError(500, "internal-error", "Internal server error", { code: "internal_error" }),
} as const;

export function problemBody(error: ProblemError, requestId: string | undefined): ProblemBody {
  return {
    ...(error.options.extensions ?? {}),
    type: `/problems/${error.slug}`,
    title: error.title,
    status: error.status,
    ...(error.options.detail !== undefined ? { detail: error.options.detail } : {}),
    ...(error.options.code !== undefined ? { code: error.options.code } : {}),
    ...(requestId !== undefined ? { request_id: requestId } : {}),
    ...(error.options.errors !== undefined ? { errors: error.options.errors } : {}),
  };
}
