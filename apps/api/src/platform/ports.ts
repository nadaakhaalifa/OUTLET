import type { AuditRecord } from "@outlet/policy";
import type { AccessClaims } from "@outlet/auth-core";
import type { Actor, Resource } from "@outlet/policy";

export interface Clock {
  nowMs(): number;
}

export interface IdGenerator {
  /** Time ordered identifier for new aggregates. */
  uuidV7(): string;
  /** Random lowercase hex of `bytes` bytes (trace and span ids, claim tokens). */
  hex(bytes: number): string;
}

/** Verifies a bearer token and loads the actor it belongs to. Returns null for any invalid token. */
export interface Authenticator {
  authenticate(bearerToken: string, nowMs: number): Promise<{ readonly actor: Actor; readonly claims: AccessClaims } | null>;
}

/** Loads the object a route addresses so that policy can decide on real ownership. */
export interface ResourceResolver {
  resolve(input: { readonly id: string | undefined; readonly actor: Actor }): Promise<Resource | null>;
}

export interface AuditSink {
  record(entry: AuditRecord): Promise<void>;
}

export interface RateLimitRule {
  readonly limit: number;
  readonly windowMs: number;
}

export interface RateLimitOutcome {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  readonly resetAtMs: number;
}

/**
 * Rate-limit port. Adapters implement an atomic counter (Redis in production). `key` is already
 * namespaced and hashed by the guard, so adapters never see raw phone numbers or IPs.
 */
export interface RateLimiter {
  consume(key: string, rule: RateLimitRule, nowMs: number): Promise<RateLimitOutcome>;
}

export interface ReadinessCheck {
  readonly name: string;
  check(): Promise<boolean>;
}
