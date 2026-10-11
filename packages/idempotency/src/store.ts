import type { IdempotencyRecord, IdempotencyScope, StoredResponse } from "./types";

export interface ClaimRequest {
  readonly scope: IdempotencyScope;
  readonly route: string;
  readonly requestHash: string;
  readonly claimToken: string;
  readonly nowMs: number;
  readonly ttlMs: number;
  readonly leaseMs: number;
}

export type ClaimResult =
  | { readonly kind: "acquired" }
  | { readonly kind: "existing"; readonly record: IdempotencyRecord };

/**
 * Key store port. `claim` MUST be atomic (insert-if-absent-or-expired, e.g. INSERT ... ON CONFLICT
 * in Postgres). Expired records (past TTL, or in-flight past lease) are replaced by `claim`.
 */
export interface IdempotencyStore {
  claim(req: ClaimRequest): Promise<ClaimResult>;
  /** Transition in_flight -> completed, only if claimToken still owns the record. Returns false otherwise. */
  complete(scope: IdempotencyScope, claimToken: string, response: StoredResponse, nowMs: number): Promise<boolean>;
  /** Delete an in-flight claim, only if claimToken still owns it. */
  release(scope: IdempotencyScope, claimToken: string): Promise<boolean>;
}
