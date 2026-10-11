import type {
  GroupRecord,
  HubEvent,
  HubFlagsPort,
  HubLedgerPort,
  HubMetrics,
  HubRecord,
  HubStore,
  JournalLine,
  LegRecord,
  OutboundCourierPort,
  OutboundResult,
  ParcelFacts,
  ParcelFactsPort,
  ParcelRecord,
  ReceiptRecord,
} from "../domain/ports";
import type { LegState } from "../domain/bridge";
import { moveLeg } from "../domain/bridge";

export class InMemoryHubStore implements HubStore {
  private readonly hubs = new Map<string, HubRecord>();
  private readonly groups = new Map<string, GroupRecord>();
  private readonly legs = new Map<string, LegRecord>();
  private readonly parcels = new Map<string, ParcelRecord>();
  private readonly receipts = new Map<string, ReceiptRecord>();
  /** Outbox as written, in order. */
  readonly outbox: HubEvent[] = [];

  async upsertHub(h: HubRecord): Promise<void> {
    this.hubs.set(h.id, h);
  }
  async getHub(id: string): Promise<HubRecord | null> {
    return this.hubs.get(id) ?? null;
  }
  async openGroup(group: GroupRecord, legs: readonly LegRecord[]): Promise<"opened" | "exists"> {
    if (this.groups.has(group.orderGroupId)) return "exists";
    this.groups.set(group.orderGroupId, group);
    for (const l of legs) this.legs.set(l.sellerOrderId, l);
    return "opened";
  }
  async getGroup(id: string): Promise<GroupRecord | null> {
    return this.groups.get(id) ?? null;
  }
  async getLeg(id: string): Promise<LegRecord | null> {
    return this.legs.get(id) ?? null;
  }
  async listLegs(orderGroupId: string): Promise<readonly LegRecord[]> {
    return [...this.legs.values()].filter((l) => l.orderGroupId === orderGroupId);
  }
  async getParcel(id: string): Promise<ParcelRecord | null> {
    return this.parcels.get(id) ?? null;
  }
  async listParcels(orderGroupId: string): Promise<readonly ParcelRecord[]> {
    return [...this.parcels.values()].filter((p) => p.orderGroupId === orderGroupId).sort((a, b) => a.createdAtMs - b.createdAtMs);
  }
  async getReceipt(sellerOrderId: string): Promise<ReceiptRecord | null> {
    return this.receipts.get(sellerOrderId) ?? null;
  }
  async recordReceipt(input: {
    receipt: ReceiptRecord;
    expectedVersion: number;
    next: LegState;
    events: readonly HubEvent[];
  }): Promise<"ok" | "duplicate" | "conflict"> {
    if (this.receipts.has(input.receipt.sellerOrderId)) return "duplicate";
    const leg = this.legs.get(input.receipt.sellerOrderId);
    if (leg === undefined || leg.version !== input.expectedVersion) return "conflict";
    this.receipts.set(input.receipt.sellerOrderId, input.receipt);
    this.legs.set(leg.sellerOrderId, { ...leg, state: moveLeg(leg.state, input.next), version: leg.version + 1 });
    this.outbox.push(...input.events);
    return "ok";
  }
  async createParcel(input: {
    parcel: ParcelRecord;
    legs: readonly { sellerOrderId: string; expectedVersion: number }[];
    events: readonly HubEvent[];
  }): Promise<"ok" | "conflict"> {
    for (const l of input.legs) {
      const cur = this.legs.get(l.sellerOrderId);
      if (cur === undefined || cur.version !== l.expectedVersion || cur.state !== "RECEIVED") return "conflict";
    }
    for (const l of input.legs) {
      const cur = this.legs.get(l.sellerOrderId) as LegRecord;
      this.legs.set(cur.sellerOrderId, {
        ...cur,
        state: moveLeg(cur.state, "CONSOLIDATED"),
        consolidationId: input.parcel.id,
        version: cur.version + 1,
      });
    }
    this.parcels.set(input.parcel.id, input.parcel);
    this.outbox.push(...input.events);
    return "ok";
  }
  async dispatchParcel(input: {
    parcelId: string;
    awb: string;
    courierCode: string;
    estimate: { gCo2e: bigint; factorsVersion: string };
    nowMs: number;
    events: readonly HubEvent[];
  }): Promise<"ok" | "not_ready" | "not_found"> {
    const p = this.parcels.get(input.parcelId);
    if (p === undefined) return "not_found";
    if (p.status !== "READY") return "not_ready";
    this.parcels.set(p.id, {
      ...p,
      status: "DISPATCHED",
      awb: input.awb,
      courierCode: input.courierCode,
      gCo2e: input.estimate.gCo2e,
      factorsVersion: input.estimate.factorsVersion,
      dispatchedAtMs: input.nowMs,
    });
    for (const id of p.sellerOrderIds) {
      const cur = this.legs.get(id);
      if (cur !== undefined) this.legs.set(id, { ...cur, state: moveLeg(cur.state, "DISPATCHED"), version: cur.version + 1 });
    }
    this.outbox.push(...input.events);
    return "ok";
  }
  async groupsWithOpenLegs(limit: number): Promise<readonly GroupRecord[]> {
    const open = new Set(
      [...this.legs.values()].filter((l) => l.state === "AT_HUB_EXPECTED" || l.state === "RECEIVED").map((l) => l.orderGroupId),
    );
    return [...this.groups.values()]
      .filter((g) => open.has(g.orderGroupId))
      .sort((a, b) => a.paidAtMs - b.paidAtMs)
      .slice(0, limit);
  }
}

export class StaticHubFlags implements HubFlagsPort {
  constructor(public enabled = true) {}
  async consolidationEnabled(): Promise<boolean> {
    return this.enabled;
  }
}

export class FakeParcelFacts implements ParcelFactsPort {
  weightG = 1200;
  async facts(parcel: ParcelRecord): Promise<ParcelFacts | null> {
    return {
      weightG: this.weightG * parcel.sellerOrderIds.length,
      pieces: parcel.sellerOrderIds.length,
      cod: null,
      recipient: { name: "Test Recipient", phone: "+201000000000", governorate: "Giza", city: "Dokki", addressLine: "1 Test St" },
      pickup: { label: "Cairo hub", governorate: "Cairo", city: "Nasr City", addressLine: "Hub 1" },
      hubToShopperKm: 20,
      inbound: parcel.sellerOrderIds.map((id) => ({ sellerOrderId: id, km: 30, weightG: this.weightG })),
    };
  }
}

export class FakeOutboundCourier implements OutboundCourierPort {
  readonly created = new Map<string, OutboundResult>();
  calls = 0;
  fail: "none" | "down" | "reject" = "none";
  cost = 4500n;
  async createOutbound(parcel: ParcelRecord): Promise<OutboundResult> {
    this.calls += 1;
    if (this.fail === "down") {
      const e = new Error("down");
      e.name = "CourierUnavailableError";
      throw e;
    }
    if (this.fail === "reject") {
      const e = Object.assign(new Error("rejected"), { code: "not_covered" });
      e.name = "CourierRejectedError";
      throw e;
    }
    const prev = this.created.get(parcel.id);
    if (prev !== undefined) return prev;
    const r: OutboundResult = { awb: `ARX${String(this.created.size + 1).padStart(6, "0")}`, courierCode: "aramex", costPiastres: this.cost };
    this.created.set(parcel.id, r);
    return r;
  }
}

/** Rejects unbalanced entries the way the real ledger does. */
export class FakeHubLedger implements HubLedgerPort {
  readonly entries = new Map<string, readonly JournalLine[]>();
  async post(entry: { idempotencyKey: string; lines: readonly JournalLine[] }): Promise<void> {
    if (this.entries.has(entry.idempotencyKey)) return;
    const sum = entry.lines.reduce((s, l) => s + l.amount, 0n);
    if (sum !== 0n) throw new Error("unbalanced journal entry");
    this.entries.set(entry.idempotencyKey, entry.lines);
  }
}

export class InMemoryHubMetrics implements HubMetrics {
  readonly counts = new Map<string, number>();
  increment(name: string, labels: Readonly<Record<string, string>> = {}): void {
    const key = `${name}${JSON.stringify(labels)}`;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }
}
