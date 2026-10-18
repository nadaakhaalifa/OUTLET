import type { AnalyticsOutboxDraft } from "./events";

/** `kill.analytics.ingest` (allowed-when-true, default blocked). Fails closed. */
export interface IngestGate {
  enabled(): Promise<boolean>;
}

/** The user's CURRENT `analytics` consent. Implementations must not cache (M4). */
export interface ConsentReader {
  analyticsConsent(userId: string): Promise<boolean>;
}

export type AttestationVerdictLite = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * App Attest / Play Integrity check, backed by the auth verifier port. Known gap (VR-DASH-07): the
 * verifier still receives an empty challenge until a server-issued challenge exists, so enabling
 * ingest for real users is a Security decision.
 */
export interface AttestationCheck {
  verify(platform: "ios" | "android", token: string): Promise<AttestationVerdictLite>;
}

/** Redis-shaped store for dedupe and windows. Any throw means unavailable: the batch fails closed (503). */
export interface PlausibilityStore {
  /** SET NX EX. True when the key was newly set. */
  setIfAbsent(key: string, ttlSeconds: number): Promise<boolean>;
  /** Adds `by` to a fixed window counter (TTL set on first write) and returns the new total. */
  addToWindow(key: string, windowSeconds: number, by: number): Promise<number>;
  /** Removes keys set by this batch when the outbox write failed, so the client's retry is not seen as a duplicate. */
  release(keys: readonly string[]): Promise<void>;
}

/** The only write ingest performs: one outbox row per accepted batch. */
export interface BatchOutbox {
  append(draft: AnalyticsOutboxDraft): Promise<void>;
}

export interface IngestCounters {
  inc(reason: string, by?: number): void;
}

export class PlausibilityUnavailableError extends Error {
  constructor() {
    super("analytics plausibility store unavailable");
    this.name = "PlausibilityUnavailableError";
  }
}
export class IngestStoreUnavailableError extends Error {
  constructor() {
    super("analytics outbox unavailable");
    this.name = "IngestStoreUnavailableError";
  }
}
export class IngestRateLimitedError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("analytics event rate limit");
    this.name = "IngestRateLimitedError";
  }
}
export class InvalidBatchError extends Error {
  constructor(readonly code: string) {
    super(`invalid analytics batch: ${code}`);
    this.name = "InvalidBatchError";
  }
}
export class IngestDisabledError extends Error {
  constructor() {
    super("analytics ingest is blocked (kill.analytics.ingest)");
    this.name = "IngestDisabledError";
  }
}
export class AttestationRequiredError extends Error {
  constructor() {
    super("a valid device attestation is required");
    this.name = "AttestationRequiredError";
  }
}
