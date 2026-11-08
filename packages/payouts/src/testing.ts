import type { PayoutDestination, PayoutDestinationPort, PayoutRailPort, PayoutRailRequest, PayoutRailResult } from "./application/ports.js";

/** In-memory rail: idempotent by key (same key returns the first result), can be told to reject or to throw. */
export class FakePayoutRail implements PayoutRailPort {
  readonly calls: PayoutRailRequest[] = [];
  readonly results = new Map<string, PayoutRailResult>();
  rejectWith: string | null = null;
  throwOnce = false;

  send(req: PayoutRailRequest): Promise<PayoutRailResult> {
    this.calls.push(req);
    if (this.throwOnce) {
      this.throwOnce = false;
      return Promise.reject(new Error("rail timeout"));
    }
    const prior = this.results.get(req.idempotencyKey);
    if (prior) return Promise.resolve(prior);
    const res: PayoutRailResult = this.rejectWith === null
      ? { status: "accepted", provider: "fakebank", providerRef: `fb-${req.payoutId}` }
      : { status: "rejected", code: this.rejectWith };
    this.results.set(req.idempotencyKey, res);
    return Promise.resolve(res);
  }

  /** Distinct transfers actually created (the rail dedups by key). */
  get transfers(): number {
    return this.results.size;
  }
}

export class FakePayoutDestinations implements PayoutDestinationPort {
  private readonly byStore = new Map<string, PayoutDestination>();
  set(storeId: string, d: PayoutDestination | null): void {
    if (d === null) this.byStore.delete(storeId);
    else this.byStore.set(storeId, d);
  }
  resolve(storeId: string): Promise<PayoutDestination | null> {
    return Promise.resolve(this.byStore.get(storeId) ?? null);
  }
}
