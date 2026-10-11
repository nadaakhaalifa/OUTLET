import type { EnforcementAction, ExternalEvidence, PriceEvent, ViolationKind } from "../domain/domain";
import {
  PriceEventConflictError,
  type ClaimRecord,
  type ClaimStats,
  type ClaimStore,
  type EnforcementRecord,
  type EnforcementStore,
  type ExternalEvidencePort,
  type NewPriceEvent,
  type PriceEventStore,
  type ProductSkus,
  type SkuDirectory,
} from "../domain/ports";

interface Stored {
  readonly event: PriceEvent;
  readonly storeId: string;
  readonly key: string;
}

export class InMemoryPriceEventStore implements PriceEventStore {
  private readonly bySku = new Map<string, Stored[]>();

  async append(e: NewPriceEvent): Promise<{ event: PriceEvent; created: boolean }> {
    const list = this.bySku.get(e.skuId) ?? [];
    const same = list.find((s) => s.key === e.idempotencyKey);
    if (same !== undefined) {
      if (same.event.priceAmount !== e.priceAmount || same.event.validFromMs !== e.validFromMs || same.storeId !== e.storeId) {
        throw new PriceEventConflictError("idempotency_conflict", "idempotency key reused with a different payload");
      }
      return { event: same.event, created: false };
    }
    const latest = list[list.length - 1];
    if (latest !== undefined) {
      if (latest.storeId !== e.storeId) throw new PriceEventConflictError("store_mismatch", "sku belongs to another store");
      if (e.validFromMs < latest.event.validFromMs) throw new PriceEventConflictError("out_of_order", "price event is older than the latest event");
    }
    const event: PriceEvent = {
      id: e.id,
      skuId: e.skuId,
      priceAmount: e.priceAmount,
      validFromMs: e.validFromMs,
      source: e.source,
      actorId: e.actorId,
    };
    list.push({ event, storeId: e.storeId, key: e.idempotencyKey });
    this.bySku.set(e.skuId, list);
    return { event, created: true };
  }

  async history(skuId: string): Promise<readonly PriceEvent[]> {
    return (this.bySku.get(skuId) ?? []).map((s) => s.event);
  }

  async historyMany(skuIds: readonly string[]): Promise<ReadonlyMap<string, readonly PriceEvent[]>> {
    const out = new Map<string, readonly PriceEvent[]>();
    for (const id of skuIds) {
      const h = this.bySku.get(id);
      if (h !== undefined) out.set(id, h.map((s) => s.event));
    }
    return out;
  }

  async storeOf(skuId: string): Promise<string | null> {
    return this.bySku.get(skuId)?.[0]?.storeId ?? null;
  }
}

export class InMemoryExternalEvidence implements ExternalEvidencePort {
  private readonly bySku = new Map<string, ExternalEvidence>();
  set(skuId: string, e: ExternalEvidence): void {
    this.bySku.set(skuId, e);
  }
  clear(): void {
    this.bySku.clear();
  }
  async lookup(skuIds: readonly string[]): Promise<ReadonlyMap<string, ExternalEvidence>> {
    const out = new Map<string, ExternalEvidence>();
    for (const id of skuIds) {
      const e = this.bySku.get(id);
      if (e !== undefined) out.set(id, e);
    }
    return out;
  }
}

/** Phase 1 default: no crawler yet, so there is never external evidence. */
export class NoExternalEvidence implements ExternalEvidencePort {
  async lookup(): Promise<ReadonlyMap<string, ExternalEvidence>> {
    return new Map();
  }
}

export class InMemoryClaimStore implements ClaimStore {
  private readonly rows = new Map<string, ClaimRecord>();
  async record(claim: ClaimRecord): Promise<boolean> {
    if (this.rows.has(claim.id)) return false;
    this.rows.set(claim.id, claim);
    return true;
  }
  async statsSince(storeId: string, sinceMs: number): Promise<ClaimStats> {
    const mine = [...this.rows.values()].filter((c) => c.storeId === storeId && c.computedAtMs >= sinceMs);
    return { evaluated: mine.length, verified: mine.filter((c) => c.status === "verified_discount").length };
  }
}

export class InMemoryEnforcementStore implements EnforcementStore {
  private rows: EnforcementRecord[] = [];

  async record(r: EnforcementRecord): Promise<boolean> {
    if (this.rows.some((x) => x.dedupeKey === r.dedupeKey)) return false;
    if (r.skuId !== null && r.kind === "cross_channel_cheaper" && r.resolvedAtMs === null && this.rows.some((x) => x.skuId === r.skuId && x.kind === r.kind && x.resolvedAtMs === null)) {
      return false;
    }
    this.rows.push(r);
    return true;
  }
  async countSince(storeId: string, sinceMs: number): Promise<number> {
    return this.rows.filter((r) => r.storeId === storeId && r.openedAtMs >= sinceMs).length;
  }
  async countKindSince(storeId: string, kind: ViolationKind, sinceMs: number): Promise<number> {
    return this.rows.filter((r) => r.storeId === storeId && r.kind === kind && r.openedAtMs >= sinceMs).length;
  }
  async openCrossChannelSince(skuId: string): Promise<number | null> {
    return this.rows.find((r) => r.skuId === skuId && r.kind === "cross_channel_cheaper" && r.resolvedAtMs === null)?.openedAtMs ?? null;
  }
  async resolveCrossChannel(skuId: string, atMs: number): Promise<number> {
    let n = 0;
    this.rows = this.rows.map((r) => {
      if (r.skuId === skuId && r.kind === "cross_channel_cheaper" && r.resolvedAtMs === null) {
        n += 1;
        return { ...r, resolvedAtMs: atMs };
      }
      return r;
    });
    return n;
  }
  async openCrossChannelCount(storeId: string): Promise<number> {
    return this.rows.filter((r) => r.storeId === storeId && r.kind === "cross_channel_cheaper" && r.resolvedAtMs === null).length;
  }
  async recent(storeId: string, limit: number): Promise<readonly EnforcementRecord[]> {
    return this.rows
      .filter((r) => r.storeId === storeId)
      .sort((a, b) => b.openedAtMs - a.openedAtMs || (a.id < b.id ? 1 : -1))
      .slice(0, limit);
  }
}

export class InMemorySkuDirectory implements SkuDirectory {
  private readonly products = new Map<string, ProductSkus>();
  set(productId: string, p: ProductSkus): void {
    this.products.set(productId, p);
  }
  async forProduct(productId: string): Promise<ProductSkus | null> {
    return this.products.get(productId) ?? null;
  }
}

export interface PriceIntegrityDevFixtures {
  readonly events: InMemoryPriceEventStore;
  readonly external: InMemoryExternalEvidence;
  readonly claims: InMemoryClaimStore;
  readonly enforcement: InMemoryEnforcementStore;
  readonly directory: InMemorySkuDirectory;
}

export function createPriceIntegrityDevFixtures(): PriceIntegrityDevFixtures {
  return {
    events: new InMemoryPriceEventStore(),
    external: new InMemoryExternalEvidence(),
    claims: new InMemoryClaimStore(),
    enforcement: new InMemoryEnforcementStore(),
    directory: new InMemorySkuDirectory(),
  };
}

export type { EnforcementAction };
