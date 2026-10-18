import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { z } from "zod";
import { ProblemError } from "../../../platform/problem";
import { ProviderNotConfiguredError } from "../../unconfigured";
import type { ProviderResult } from "../../../modules/notifications";

/**
 * Shared plumbing for the communication adapters (ADR-0034). Everything here is vendor neutral:
 * typed errors, an injected-fetch HTTP call with a 10 s timeout, masking and timing-safe compares.
 * Request bodies, tokens, phone numbers and addresses never reach a log line or an error message.
 */

export { ProviderNotConfiguredError };

/** 502: timeout, network failure, 5xx, exhausted 429. Safe for the caller to try the next provider. */
export class ProviderUnavailableError extends ProblemError {
  constructor(
    readonly vendor: string,
    readonly operation: string,
    readonly reason: string,
  ) {
    super(502, "provider-unavailable", "A provider is unavailable", {
      code: "provider_unavailable",
      detail: `Provider ${vendor} could not complete ${operation}.`,
      extensions: { provider: vendor },
    });
    this.name = "ProviderUnavailableError";
  }
}

/** Permanent refusal (4xx class). Retrying the same message will not help. */
export class RejectedByProviderError extends ProblemError {
  constructor(
    readonly vendor: string,
    readonly operation: string,
    readonly rejection: "invalid_recipient" | "template_rejected" | "destination_not_allowed" | "budget_exceeded" | "other",
    readonly vendorCode: string,
  ) {
    super(502, "rejected-by-provider", "A provider rejected the request", {
      code: "rejected_by_provider",
      detail: `Provider ${vendor} rejected ${operation} (${rejection}).`,
      extensions: { provider: vendor, permanent: true },
    });
    this.name = "RejectedByProviderError";
  }
}

/** A 2xx whose body does not match the documented shape. The message may have been sent: never auto-retry. */
export class ProviderDriftError extends ProblemError {
  constructor(
    readonly vendor: string,
    readonly operation: string,
  ) {
    super(502, "provider-drift", "A provider answered with an unexpected shape", {
      code: "provider_drift",
      detail: `Provider ${vendor} answered ${operation} with an unexpected shape.`,
      extensions: { provider: vendor },
    });
    this.name = "ProviderDriftError";
  }
}

export interface CommsLogEvent {
  readonly provider: string;
  readonly operation: string;
  readonly outcome: "ok" | "http_error" | "timeout" | "network" | "retry";
  readonly status: number | null;
  readonly requestId: string | null;
}
export type CommsLogger = (event: CommsLogEvent) => void;

export interface HttpDeps {
  readonly fetch: typeof fetch;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: CommsLogger;
  readonly timeoutMs: number;
}

export const DEFAULT_TIMEOUT_MS = 10_000;
export const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export const noLog: CommsLogger = () => undefined;

export function httpDeps(partial: Partial<HttpDeps> = {}): HttpDeps {
  return {
    fetch: partial.fetch ?? fetch,
    sleep: partial.sleep ?? realSleep,
    log: partial.log ?? noLog,
    timeoutMs: partial.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

export interface CallSpec {
  readonly vendor: string;
  readonly operation: string;
  readonly url: string;
  readonly method: "GET" | "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly requestId?: string;
  /**
   * "safe": the call is idempotent (read, or carries a vendor idempotency key) so 5xx and network
   * failures may be retried. "none": only a 429 (request not processed) is retried.
   */
  readonly retry: "safe" | "none";
  readonly maxAttempts?: number;
}

export interface RawResponse {
  readonly status: number;
  readonly json: unknown;
  readonly text: string;
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * One HTTP exchange with a hard timeout. Returns 2xx and 4xx (the adapter maps vendor error codes);
 * throws ProviderUnavailableError for timeout, network failure, 5xx and a 429 that outlasts retries.
 */
export async function call(deps: HttpDeps, spec: CallSpec): Promise<RawResponse> {
  const max = spec.maxAttempts ?? 3;
  const requestId = spec.requestId ?? null;
  let last: ProviderUnavailableError = new ProviderUnavailableError(spec.vendor, spec.operation, "no_attempt");
  for (let attempt = 1; attempt <= max; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), deps.timeoutMs);
    let retryable: boolean;
    let waitMs = Math.min(200 * 2 ** (attempt - 1), 2_000) + Math.floor(Math.random() * 100);
    try {
      const init: RequestInit = { method: spec.method, headers: { ...spec.headers }, signal: ctl.signal };
      if (spec.body !== undefined) init.body = spec.body;
      const res = await deps.fetch(spec.url, init);
      const text = await res.text();
      deps.log({ provider: spec.vendor, operation: spec.operation, outcome: res.status >= 400 ? "http_error" : "ok", status: res.status, requestId });
      if (res.status === 429) {
        last = new ProviderUnavailableError(spec.vendor, spec.operation, "rate_limited");
        retryable = true;
        const ra = Number(res.headers.get("retry-after"));
        if (Number.isFinite(ra) && ra > 0) waitMs = Math.min(ra * 1000, 10_000);
      } else if (res.status >= 500) {
        last = new ProviderUnavailableError(spec.vendor, spec.operation, `http_${res.status}`);
        retryable = spec.retry === "safe";
      } else {
        return { status: res.status, json: tryJson(text), text };
      }
    } catch {
      const aborted = ctl.signal.aborted;
      deps.log({ provider: spec.vendor, operation: spec.operation, outcome: aborted ? "timeout" : "network", status: null, requestId });
      last = new ProviderUnavailableError(spec.vendor, spec.operation, aborted ? "timeout" : "network");
      retryable = spec.retry === "safe";
    } finally {
      clearTimeout(timer);
    }
    if (!retryable || attempt === max) break;
    deps.log({ provider: spec.vendor, operation: spec.operation, outcome: "retry", status: null, requestId });
    await deps.sleep(waitMs);
  }
  throw last;
}

/** Zod parse of a 2xx body. A mismatch is drift, never a silent success. */
export function parseOrDrift<S extends z.ZodType>(schema: S, value: unknown, vendor: string, operation: string): z.infer<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw new ProviderDriftError(vendor, operation);
  return r.data;
}

/** Maps a typed error to the notification dispatcher's result vocabulary. */
export function toProviderResult(e: unknown): ProviderResult {
  if (e instanceof ProviderUnavailableError) return { kind: "unavailable" };
  if (e instanceof RejectedByProviderError) {
    if (e.rejection === "invalid_recipient") return { kind: "invalid_recipient" };
    if (e.rejection === "template_rejected") return { kind: "template_rejected" };
    return { kind: "failed", code: e.rejection };
  }
  if (e instanceof ProviderDriftError) return { kind: "failed", code: "provider_drift" };
  throw e;
}

// ---- masking and secrets ----------------------------------------------------------------

export const maskPhone = (p: string): string => (p.length <= 4 ? "***" : `${p.slice(0, 3)}***${p.slice(-2)}`);
export const maskEmail = (a: string): string => {
  const at = a.indexOf("@");
  return at < 1 ? "***" : `${a.slice(0, 1)}***${a.slice(at)}`;
};
export const maskToken = (t: string): string => (t.length <= 8 ? "***" : `${t.slice(0, 4)}***`);

/** Timing-safe string compare; both sides are hashed first so a length difference leaks nothing. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export const hmacHex = (algo: "sha256" | "sha1", key: string, data: string): string => createHmac(algo, key).update(data).digest("hex");
export const hmacBase64 = (algo: "sha256" | "sha1", key: string, data: string): string => createHmac(algo, key).update(data).digest("base64");

export const basicAuth = (user: string, pass: string): string => `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
