import type { Actor } from "@outlet/policy";
import type { AccessClaims } from "@outlet/auth-core";

/** Per-request correlation data. No user data lives here. */
export interface RequestContext {
  readonly requestId: string;
  /** W3C trace id (32 hex), continued from an incoming traceparent or newly started. */
  readonly traceId: string;
  /** Span id of this service's server span (16 hex). */
  readonly spanId: string;
  /** Caller's span id when a traceparent was supplied. */
  readonly parentSpanId: string | null;
  /** Trace flags (2 hex), propagated unchanged. */
  readonly traceFlags: string;
}

/** Minimal structural view of the HTTP request, so the code does not depend on Express types. */
export interface ApiRequest {
  readonly method: string;
  readonly path?: string;
  readonly ip?: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly params: Readonly<Record<string, string | undefined>>;
  readonly query: unknown;
  readonly body: unknown;
  readonly route?: { readonly path?: string };
  ctx?: RequestContext;
  principal?: Principal | null;
}

export interface ApiResponse {
  statusCode: number;
  status(code: number): ApiResponse;
  setHeader(name: string, value: string | number): void;
  getHeader(name: string): unknown;
  end(body?: string): void;
}

/** Result of authenticating a bearer token: policy actor plus the verified claims. */
export interface Principal {
  readonly actor: Actor;
  readonly claims: AccessClaims;
}

export function headerValue(req: Pick<ApiRequest, "headers">, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}
