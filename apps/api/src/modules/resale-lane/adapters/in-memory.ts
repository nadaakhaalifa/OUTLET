import type { Ownership, ProceedsTerms } from "../domain/bridge";
import type {
  ListingCursor,
  ListingRecord,
  ProceedsRecord,
  ResaleCatalogPort,
  ResaleConsentPort,
  ResaleEvent,
  ResaleFlagsPort,
  ResaleLedgerPort,
  ResaleMetrics,
  ResaleStore,
  ResaleTermsPort,
  ReturnFacts,
  ReturnFactsPort,
} from "../domain/ports";

const newer = (a: ListingRecord, b: ListingRecord): number => b.listedAtMs - a.listedAtMs || (a.id < b.id ? 1 : -1);

export class InMemoryResaleStore implements ResaleStore {
  readonly listings = new Map<string, ListingRecord>();
  readonly proceeds = new Map<string, ProceedsRecord>();
  readonly outbox: ResaleEvent[] = [];

  async insertListing(l: ListingRecord, events: readonly ResaleEvent[]) {
    for (const x of this.listings.values()) {
      if (x.returnId === l.returnId) return "duplicate_return" as const;
      if (x.unitRef === l.unitRef) return "duplicate_unit" as const;
    }
    this.listings.set(l.id, l);
    this.outbox.push(...events);
    return "created" as const;
  }
  async getListing(id: string) {
    return this.listings.get(id) ?? null;
  }
  async countForUnit(unitRef: string) {
    return [...this.listings.values()].filter((l) => l.unitRef === unitRef).length;
  }
  async listLive(limit: number, after: ListingCursor | null) {
    return [...this.listings.values()]
      .filter((l) => l.status === "LISTED")
      .sort(newer)
      .filter((l) => after === null || l.listedAtMs < after.listedAtMs || (l.listedAtMs === after.listedAtMs && l.id < after.id))
      .slice(0, limit);
  }
  async listForStore(storeId: string, limit: number) {
    return [...this.listings.values()].filter((l) => l.storeId === storeId).sort(newer).slice(0, limit);
  }
  async getProceeds(listingId: string) {
    return this.proceeds.get(listingId) ?? null;
  }
  async markSold(i: { listingId: string; nowMs: number; proceeds: ProceedsRecord; events: readonly ResaleEvent[] }) {
    const l = this.listings.get(i.listingId);
    if (l === undefined) return "not_found" as const;
    if (l.status !== "LISTED") return "not_listed" as const;
    this.listings.set(l.id, { ...l, status: "SOLD", soldAtMs: i.nowMs });
    this.proceeds.set(l.id, i.proceeds);
    this.outbox.push(...i.events);
    return "ok" as const;
  }
  async withdraw(i: { listingId: string; events: readonly ResaleEvent[] }) {
    const l = this.listings.get(i.listingId);
    if (l === undefined) return "not_found" as const;
    if (l.status !== "LISTED") return "not_listed" as const;
    this.listings.set(l.id, { ...l, status: "WITHDRAWN" });
    this.outbox.push(...i.events);
    return "ok" as const;
  }
}

export class FakeReturnFacts implements ReturnFactsPort {
  readonly byId = new Map<string, ReturnFacts>();
  async facts(returnId: string) {
    return this.byId.get(returnId) ?? null;
  }
}
export class FakeResaleConsent implements ResaleConsentPort {
  readonly sellers = new Set<string>();
  readonly rtvUnits = new Set<string>();
  async sellerOptedIn(storeId: string) {
    return this.sellers.has(storeId);
  }
  async rtvTermsAccepted(unitRef: string) {
    return this.rtvUnits.has(unitRef);
  }
}
export class StaticResaleTerms implements ResaleTermsPort {
  constructor(
    public commissionBps = 1_500,
    public vendorShareBps = 6_000,
  ) {}
  async termsFor(_storeId: string, ownership: Ownership): Promise<ProceedsTerms> {
    return { ownership, commissionBps: this.commissionBps, vendorShareBps: this.vendorShareBps };
  }
}
export class FakeResaleCatalog implements ResaleCatalogPort {
  readonly created = new Map<string, string>();
  async createResaleSku(i: { listingId: string }) {
    const existing = this.created.get(i.listingId);
    if (existing !== undefined) return existing;
    const id = `00000000-0000-4000-9000-${i.listingId.slice(-12)}`;
    this.created.set(i.listingId, id);
    return id;
  }
}
export class StaticResaleFlags implements ResaleFlagsPort {
  constructor(public enabled = true) {}
  async listingEnabled() {
    return this.enabled;
  }
}
export class FakeResaleLedger implements ResaleLedgerPort {
  readonly entries = new Map<string, readonly { account: string; amount: bigint }[]>();
  async post(e: { idempotencyKey: string; lines: readonly { account: string; amount: bigint }[] }) {
    if (this.entries.has(e.idempotencyKey)) return;
    if (e.lines.reduce((s, l) => s + l.amount, 0n) !== 0n) throw new Error("unbalanced journal entry");
    this.entries.set(e.idempotencyKey, e.lines);
  }
}
export class InMemoryResaleMetrics implements ResaleMetrics {
  readonly counts = new Map<string, number>();
  increment(name: string, labels: Readonly<Record<string, string>> = {}) {
    const k = `${name}${JSON.stringify(labels)}`;
    this.counts.set(k, (this.counts.get(k) ?? 0) + 1);
  }
}
