import type { ClaimRequest, ClaimResult, IdempotencyStore } from "./store";
import type { IdempotencyRecord, IdempotencyScope, StoredResponse } from "./types";

const id = (s: IdempotencyScope): string => JSON.stringify([s.actor, s.key]);

/** Development/test adapter. Single process only; not durable. */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<string, IdempotencyRecord>();

  claim(req: ClaimRequest): Promise<ClaimResult> {
    const k = id(req.scope);
    const existing = this.records.get(k);
    if (existing && !this.isExpired(existing, req.nowMs)) {
      return Promise.resolve({ kind: "existing", record: existing });
    }
    this.records.set(k, {
      state: "in_flight",
      scope: req.scope,
      route: req.route,
      requestHash: req.requestHash,
      claimToken: req.claimToken,
      createdAtMs: req.nowMs,
      leaseExpiresAtMs: req.nowMs + req.leaseMs,
      expiresAtMs: req.nowMs + req.ttlMs,
    });
    return Promise.resolve({ kind: "acquired" });
  }

  complete(scope: IdempotencyScope, claimToken: string, response: StoredResponse, _nowMs: number): Promise<boolean> {
    const k = id(scope);
    const rec = this.records.get(k);
    if (rec?.state !== "in_flight" || rec.claimToken !== claimToken) return Promise.resolve(false);
    this.records.set(k, {
      state: "completed",
      scope: rec.scope,
      route: rec.route,
      requestHash: rec.requestHash,
      response,
      createdAtMs: rec.createdAtMs,
      expiresAtMs: rec.expiresAtMs,
    });
    return Promise.resolve(true);
  }

  release(scope: IdempotencyScope, claimToken: string): Promise<boolean> {
    const k = id(scope);
    const rec = this.records.get(k);
    if (rec?.state !== "in_flight" || rec.claimToken !== claimToken) return Promise.resolve(false);
    this.records.delete(k);
    return Promise.resolve(true);
  }

  get size(): number {
    return this.records.size;
  }

  private isExpired(rec: IdempotencyRecord, nowMs: number): boolean {
    if (nowMs >= rec.expiresAtMs) return true;
    return rec.state === "in_flight" && nowMs >= rec.leaseExpiresAtMs;
  }
}
