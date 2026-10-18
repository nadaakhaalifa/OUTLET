import type { Problem } from "../generated/schemas";

/** Same shape as the global `fetch`; injected so tests and React Native can supply their own. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiOk<T> {
  readonly notModified: false;
  readonly status: number;
  readonly data: T;
  /** ETag of the representation, when the server sent one. Pass it back as `If-None-Match`. */
  readonly etag: string | null;
  /** True when the server replayed a stored response for a reused Idempotency-Key. */
  readonly replayed: boolean;
  readonly requestId: string | null;
}

export interface ApiNotModified {
  readonly notModified: true;
  readonly status: 304;
  readonly etag: string | null;
  readonly requestId: string | null;
}

export type ApiResponse<T> = ApiOk<T> | ApiNotModified;

/**
 * Returned by operations marked `x-status: planned` (ADR-0050). No request is sent: the route does not exist yet.
 * Pages render an honest "not available yet" state; `ok` is the discriminant (the other variants have no `ok`).
 */
export interface ApiNotImplemented {
  readonly ok: false;
  readonly error: "not_implemented";
}

export interface CallOptions {
  readonly signal?: AbortSignal;
  /** Overrides the client-wide timeout for this call. */
  readonly timeoutMs?: number;
  /** Supply a key to make a logical attempt span several calls (e.g. a persisted checkout attempt). */
  readonly idempotencyKey?: string;
}

export interface ClientEvent {
  readonly operationId: string;
  readonly method: string;
  /** The path template, never the resolved URL: no ids, no query, no token. */
  readonly pathTemplate: string;
  readonly attempt: number;
  readonly status: number | null;
  readonly outcome: "ok" | "not_modified" | "api_error" | "network_error" | "timeout" | "aborted" | "contract_drift" | "retry";
  readonly durationMs: number;
}

export interface ClientConfig {
  readonly baseUrl: string;
  /** Returns the current access token, or null when signed out. Never logged. */
  readonly getToken?: () => string | null | Promise<string | null>;
  /**
   * Called at most once per 401, shared by concurrent requests. Returns the new access token, or null
   * when the session is over (the original 401 is then surfaced).
   */
  readonly refreshToken?: () => Promise<string | null>;
  readonly fetch?: FetchLike;
  /** Extra headers for every request (App Attest, platform, Accept-Language, device id). */
  readonly getHeaders?: () => Record<string, string> | Promise<Record<string, string>>;
  readonly timeoutMs?: number;
  /** Extra attempts after the first, for safe or idempotency-keyed requests only. */
  readonly maxRetries?: number;
  readonly retryBaseMs?: number;
  readonly maxRetryDelayMs?: number;
  readonly onEvent?: (e: ClientEvent) => void;
  readonly clock?: () => number;
  readonly random?: () => number;
  readonly randomBytes?: (n: number) => Uint8Array;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface ContractIssue {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export type ProblemBody = Problem;
