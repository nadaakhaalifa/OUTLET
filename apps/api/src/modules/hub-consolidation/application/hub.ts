import {
  DEFAULT_HUB_CONFIG,
  estimateParcelGco2e,
  moveLeg,
  planConsolidation,
  type CarbonEstimate,
  type HubConfig,
  type LegState,
  type ReceiptCondition,
} from "../domain/bridge";
import type {
  GroupRecord,
  HubEvent,
  HubFlagsPort,
  HubLedgerPort,
  HubMetrics,
  HubStore,
  LegRecord,
  OutboundCourierPort,
  ParcelFactsPort,
  ParcelRecord,
} from "../domain/ports";

export interface HubDeps {
  readonly store: HubStore;
  readonly flags: HubFlagsPort;
  readonly facts: ParcelFactsPort;
  readonly outbound: OutboundCourierPort;
  readonly ledger: HubLedgerPort;
  readonly metrics: HubMetrics;
  readonly clock: { nowMs(): number };
  readonly ids: { uuidV7(): string };
  readonly config?: HubConfig;
}

const cfgOf = (d: HubDeps): HubConfig => d.config ?? DEFAULT_HUB_CONFIG;

// ---- open (called by the order.paid consumer, no HTTP) ----

export interface OpenGroupInput {
  readonly orderGroupId: string;
  readonly userId: string;
  readonly hubId: string;
  readonly deliveryFee: bigint;
  readonly shipTogether: boolean;
  readonly paidAtMs: number;
  readonly legs: readonly {
    readonly sellerOrderId: string;
    readonly storeId: string;
    readonly lineIds: readonly string[];
    readonly subtotal: bigint;
  }[];
}

export type OpenGroupResult =
  | { readonly kind: "opened" | "exists" }
  | { readonly kind: "disabled" }
  | { readonly kind: "unknown_hub" }
  | { readonly kind: "invalid" };

export class OpenHubGroup {
  constructor(private readonly d: HubDeps) {}
  async execute(i: OpenGroupInput): Promise<OpenGroupResult> {
    if (!(await this.d.flags.consolidationEnabled())) {
      this.d.metrics.increment("hub_group_open_disabled");
      return { kind: "disabled" };
    }
    if (i.legs.length === 0 || i.deliveryFee < 0n || i.legs.some((l) => l.subtotal < 0n)) return { kind: "invalid" };
    if ((await this.d.store.getHub(i.hubId)) === null) return { kind: "unknown_hub" };
    const group: GroupRecord = {
      orderGroupId: i.orderGroupId,
      userId: i.userId,
      hubId: i.hubId,
      deliveryFee: i.deliveryFee,
      shipTogether: i.shipTogether,
      paidAtMs: i.paidAtMs,
    };
    const legs: LegRecord[] = i.legs.map((l) => ({
      sellerOrderId: l.sellerOrderId,
      orderGroupId: i.orderGroupId,
      hubId: i.hubId,
      storeId: l.storeId,
      state: "AT_HUB_EXPECTED",
      lineIds: l.lineIds,
      subtotal: l.subtotal,
      handoffDueAtMs: i.paidAtMs + cfgOf(this.d).handoffSlaMs,
      consolidationId: null,
      version: 0,
    }));
    const r = await this.d.store.openGroup(group, legs);
    return { kind: r };
  }
}

// ---- evaluate: plan and form a parcel ----

export type EvaluateResult =
  | { readonly kind: "nothing" | "waiting" | "not_found" }
  | { readonly kind: "parcel_ready"; readonly parcel: ParcelRecord; readonly split: boolean }
  | { readonly kind: "conflict" };

export class EvaluateHubGroup {
  constructor(private readonly d: HubDeps) {}
  async execute(orderGroupId: string): Promise<EvaluateResult> {
    const group = await this.d.store.getGroup(orderGroupId);
    if (group === null) return { kind: "not_found" };
    const legs = await this.d.store.listLegs(orderGroupId);
    const decision = planConsolidation({
      legs: legs.map((l) => ({ sellerOrderId: l.sellerOrderId, state: l.state, lineIds: l.lineIds, subtotal: l.subtotal })),
      shipTogether: group.shipTogether,
      paidAtMs: group.paidAtMs,
      nowMs: this.d.clock.nowMs(),
      deliveryFee: group.deliveryFee,
      config: cfgOf(this.d),
    });
    if (decision.kind === "nothing") return { kind: "nothing" };
    if (decision.kind === "wait") return { kind: "waiting" };
    const planned = decision.parcels[0];
    if (planned === undefined) return { kind: "nothing" };
    const byId = new Map(legs.map((l) => [l.sellerOrderId, l] as const));
    const parcel: ParcelRecord = {
      id: this.d.ids.uuidV7(),
      orderGroupId,
      hubId: group.hubId,
      sellerOrderIds: planned.sellerOrderIds,
      status: "READY",
      awb: null,
      courierCode: null,
      shopperFee: planned.shopperFee,
      gCo2e: null,
      factorsVersion: null,
      createdAtMs: this.d.clock.nowMs(),
      dispatchedAtMs: null,
    };
    const events: HubEvent[] = [
      { type: "hub.parcel_ready", orderGroupId, parcelId: parcel.id, legCount: planned.sellerOrderIds.length, split: decision.split },
    ];
    const r = await this.d.store.createParcel({
      parcel,
      legs: planned.sellerOrderIds.map((id) => ({ sellerOrderId: id, expectedVersion: byId.get(id)?.version ?? 0 })),
      events,
    });
    if (r === "conflict") return { kind: "conflict" };
    this.d.metrics.increment("hub_parcels_ready", { split: String(decision.split) });
    return { kind: "parcel_ready", parcel, split: decision.split };
  }
}

// ---- receipt ----

export type ReceiptResult =
  | { readonly kind: "recorded"; readonly state: LegState; readonly duplicate: boolean; readonly parcelId: string | null }
  | { readonly kind: "not_found" }
  | { readonly kind: "wrong_state" }
  | { readonly kind: "conflict" };

export class RecordHubReceipt {
  constructor(
    private readonly d: HubDeps,
    private readonly evaluate: EvaluateHubGroup,
  ) {}

  /** `hubIds` are the operator's hubs: a leg of any other hub is a 404, never a 403. */
  async execute(i: {
    readonly sellerOrderId: string;
    readonly operatorId: string;
    readonly hubIds: readonly string[];
    readonly condition: ReceiptCondition;
  }): Promise<ReceiptResult> {
    const leg = await this.d.store.getLeg(i.sellerOrderId);
    if (leg === null || !i.hubIds.includes(leg.hubId)) return { kind: "not_found" };
    const existing = await this.d.store.getReceipt(i.sellerOrderId);
    if (existing !== null) return { kind: "recorded", state: leg.state, duplicate: true, parcelId: leg.consolidationId };
    if (leg.state !== "AT_HUB_EXPECTED") return { kind: "wrong_state" };
    const next: LegState = moveLeg(leg.state, i.condition === "ok" ? "RECEIVED" : "EXCEPTION");
    const events: HubEvent[] = [
      { type: "hub.receipt_recorded", orderGroupId: leg.orderGroupId, sellerOrderId: leg.sellerOrderId, condition: i.condition },
    ];
    if (next === "EXCEPTION") events.push({ type: "hub.leg_exception", orderGroupId: leg.orderGroupId, sellerOrderId: leg.sellerOrderId });
    const r = await this.d.store.recordReceipt({
      receipt: {
        id: this.d.ids.uuidV7(),
        sellerOrderId: leg.sellerOrderId,
        hubId: leg.hubId,
        operatorId: i.operatorId,
        condition: i.condition,
        scannedAtMs: this.d.clock.nowMs(),
      },
      expectedVersion: leg.version,
      next,
      events,
    });
    if (r === "conflict") return { kind: "conflict" };
    if (r === "duplicate") return { kind: "recorded", state: leg.state, duplicate: true, parcelId: leg.consolidationId };
    this.d.metrics.increment("hub_receipts", { condition: i.condition });
    const ev = await this.evaluate.execute(leg.orderGroupId);
    return { kind: "recorded", state: next, duplicate: false, parcelId: ev.kind === "parcel_ready" ? ev.parcel.id : null };
  }
}

// ---- dispatch ----

export type DispatchResult =
  | { readonly kind: "dispatched"; readonly parcel: ParcelRecord; readonly replay: boolean }
  | { readonly kind: "not_found" }
  | { readonly kind: "no_facts" }
  | { readonly kind: "courier_unavailable" }
  | { readonly kind: "courier_rejected"; readonly code: string };

export class DispatchHubParcel {
  constructor(private readonly d: HubDeps) {}
  async execute(parcelId: string): Promise<DispatchResult> {
    const parcel = await this.d.store.getParcel(parcelId);
    if (parcel === null) return { kind: "not_found" };
    if (parcel.status === "DISPATCHED") return { kind: "dispatched", parcel, replay: true };
    const facts = await this.d.facts.facts(parcel);
    if (facts === null) return { kind: "no_facts" };
    let out;
    try {
      out = await this.d.outbound.createOutbound(parcel, facts);
    } catch (e) {
      const name = e instanceof Error ? e.name : "";
      if (name === "CourierRejectedError") {
        const code = (e as { code?: unknown }).code;
        return { kind: "courier_rejected", code: typeof code === "string" ? code : "rejected" };
      }
      return { kind: "courier_unavailable" };
    }
    const estimate: CarbonEstimate = estimateParcelGco2e([
      ...facts.inbound.map((l) => ({ distanceKm: l.km, weightG: l.weightG })),
      { distanceKm: facts.hubToShopperKm, weightG: facts.weightG },
    ]);
    const nowMs = this.d.clock.nowMs();
    const r = await this.d.store.dispatchParcel({
      parcelId,
      awb: out.awb,
      courierCode: out.courierCode,
      estimate,
      nowMs,
      events: [
        {
          type: "hub.parcel_dispatched",
          orderGroupId: parcel.orderGroupId,
          parcelId,
          awb: out.awb,
          courierCode: out.courierCode,
          gco2e: estimate.gCo2e.toString(),
        },
      ],
    });
    if (r === "not_found") return { kind: "not_found" };
    if (r === "not_ready") {
      const again = await this.d.store.getParcel(parcelId);
      return again === null ? { kind: "not_found" } : { kind: "dispatched", parcel: again, replay: true };
    }
    if (out.costPiastres > 0n) {
      // One balanced entry, idempotent by parcel: Dr consolidation cost / Cr hub clearing.
      await this.d.ledger.post({
        idempotencyKey: `hub-dispatch:${parcelId}`,
        lines: [
          { account: "consolidation_cost_expense", amount: out.costPiastres },
          { account: `hub_clearing:${parcel.hubId}`, amount: -out.costPiastres },
        ],
      });
    }
    this.d.metrics.increment("hub_parcels_dispatched", { courier: out.courierCode });
    const done = await this.d.store.getParcel(parcelId);
    return done === null ? { kind: "not_found" } : { kind: "dispatched", parcel: done, replay: false };
  }
}

// ---- sweeper (cron): split at the wait window ----

export class SweepHubGroups {
  constructor(
    private readonly d: HubDeps,
    private readonly evaluate: EvaluateHubGroup,
  ) {}
  async execute(limit = 200): Promise<{ readonly evaluated: number; readonly parcels: number }> {
    const groups = await this.d.store.groupsWithOpenLegs(limit);
    let parcels = 0;
    for (const g of groups) {
      const r = await this.evaluate.execute(g.orderGroupId);
      if (r.kind === "parcel_ready") parcels += 1;
    }
    return { evaluated: groups.length, parcels };
  }
}

// ---- tracking (shopper): a single parcel, one fee ----

export interface TrackingView {
  readonly orderGroupId: string;
  readonly deliveryFee: bigint;
  readonly parcels: readonly {
    readonly id: string;
    readonly status: "ready_at_hub" | "dispatched";
    readonly awb: string | null;
    readonly courierCode: string | null;
    readonly sellerOrderCount: number;
    readonly shopperFee: bigint;
  }[];
  /** Seller orders not yet at the hub. */
  readonly waitingSellerOrders: number;
}

export class GetHubTracking {
  constructor(private readonly d: HubDeps) {}
  async execute(orderGroupId: string): Promise<TrackingView | null> {
    const group = await this.d.store.getGroup(orderGroupId);
    if (group === null) return null;
    const [parcels, legs] = await Promise.all([this.d.store.listParcels(orderGroupId), this.d.store.listLegs(orderGroupId)]);
    return {
      orderGroupId,
      deliveryFee: group.deliveryFee,
      parcels: parcels.map((p) => ({
        id: p.id,
        status: p.status === "DISPATCHED" ? "dispatched" : "ready_at_hub",
        awb: p.awb,
        courierCode: p.courierCode,
        sellerOrderCount: p.sellerOrderIds.length,
        shopperFee: p.shopperFee,
      })),
      waitingSellerOrders: legs.filter((l) => l.state === "AT_HUB_EXPECTED").length,
    };
  }
}
