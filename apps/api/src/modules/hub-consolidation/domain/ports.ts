import type { Money } from "@outlet/domain";
import type { CarbonEstimate, LegState, ReceiptCondition } from "./bridge";

export interface HubRecord {
  readonly id: string;
  readonly name: string;
  readonly governorate: string;
}

export interface GroupRecord {
  readonly orderGroupId: string;
  readonly userId: string;
  readonly hubId: string;
  /** The single delivery fee of the OrderGroup, integer piastres. */
  readonly deliveryFee: bigint;
  readonly shipTogether: boolean;
  readonly paidAtMs: number;
}

export interface LegRecord {
  readonly sellerOrderId: string;
  readonly orderGroupId: string;
  readonly hubId: string;
  readonly storeId: string;
  readonly state: LegState;
  readonly lineIds: readonly string[];
  readonly subtotal: bigint;
  readonly handoffDueAtMs: number;
  readonly consolidationId: string | null;
  readonly version: number;
}

export type ParcelStatus = "READY" | "DISPATCHED";

export interface ParcelRecord {
  readonly id: string;
  readonly orderGroupId: string;
  readonly hubId: string;
  readonly sellerOrderIds: readonly string[];
  readonly status: ParcelStatus;
  readonly awb: string | null;
  readonly courierCode: string | null;
  /** Fee the shopper was charged for this parcel (0 for a waived follow-up parcel). */
  readonly shopperFee: bigint;
  readonly gCo2e: bigint | null;
  readonly factorsVersion: string | null;
  readonly createdAtMs: number;
  readonly dispatchedAtMs: number | null;
}

export interface ReceiptRecord {
  readonly id: string;
  readonly sellerOrderId: string;
  readonly hubId: string;
  readonly operatorId: string;
  readonly condition: ReceiptCondition;
  readonly scannedAtMs: number;
}

/** Outbox events. Payloads carry ids, enums and integers only (no names, no addresses). */
export type HubEvent =
  | { readonly type: "hub.receipt_recorded"; readonly orderGroupId: string; readonly sellerOrderId: string; readonly condition: ReceiptCondition }
  | { readonly type: "hub.leg_exception"; readonly orderGroupId: string; readonly sellerOrderId: string }
  | { readonly type: "hub.parcel_ready"; readonly orderGroupId: string; readonly parcelId: string; readonly legCount: number; readonly split: boolean }
  | { readonly type: "hub.parcel_dispatched"; readonly orderGroupId: string; readonly parcelId: string; readonly awb: string; readonly courierCode: string; readonly gco2e: string };

export interface HubStore {
  upsertHub(h: HubRecord): Promise<void>;
  getHub(id: string): Promise<HubRecord | null>;
  /** One transaction. `exists` when the group was already opened (idempotent by order group). */
  openGroup(group: GroupRecord, legs: readonly LegRecord[]): Promise<"opened" | "exists">;
  getGroup(orderGroupId: string): Promise<GroupRecord | null>;
  getLeg(sellerOrderId: string): Promise<LegRecord | null>;
  listLegs(orderGroupId: string): Promise<readonly LegRecord[]>;
  getParcel(id: string): Promise<ParcelRecord | null>;
  listParcels(orderGroupId: string): Promise<readonly ParcelRecord[]>;
  getReceipt(sellerOrderId: string): Promise<ReceiptRecord | null>;
  /**
   * One transaction: insert the receipt (unique per seller order), move the leg
   * AT_HUB_EXPECTED -> `next` by compare-and-set on `expectedVersion`, append outbox events.
   */
  recordReceipt(input: {
    readonly receipt: ReceiptRecord;
    readonly expectedVersion: number;
    readonly next: LegState;
    readonly events: readonly HubEvent[];
  }): Promise<"ok" | "duplicate" | "conflict">;
  /** One transaction: insert the READY parcel and move each leg RECEIVED -> CONSOLIDATED (CAS). */
  createParcel(input: {
    readonly parcel: ParcelRecord;
    readonly legs: readonly { readonly sellerOrderId: string; readonly expectedVersion: number }[];
    readonly events: readonly HubEvent[];
  }): Promise<"ok" | "conflict">;
  /** One transaction: parcel READY -> DISPATCHED, legs CONSOLIDATED -> DISPATCHED, outbox. */
  dispatchParcel(input: {
    readonly parcelId: string;
    readonly awb: string;
    readonly courierCode: string;
    readonly estimate: CarbonEstimate;
    readonly nowMs: number;
    readonly events: readonly HubEvent[];
  }): Promise<"ok" | "not_ready" | "not_found">;
  /** Groups that still hold AT_HUB_EXPECTED or RECEIVED legs, oldest payment first. */
  groupsWithOpenLegs(limit: number): Promise<readonly GroupRecord[]>;
}

export interface HubFlagsPort {
  /** `kill.hub_consolidation`: true means consolidation may run. Fails closed. */
  consolidationEnabled(): Promise<boolean>;
}

export interface ParcelFacts {
  readonly weightG: number;
  readonly pieces: number;
  readonly cod: Money | null;
  readonly recipient: {
    readonly name: string;
    readonly phone: string;
    readonly governorate: string;
    readonly city: string;
    readonly addressLine: string;
  };
  readonly pickup: { readonly label: string; readonly governorate: string; readonly city: string; readonly addressLine: string };
  /** Distances for the carbon estimate; VERIFY BEFORE LAUNCH (assumed table, register row 18). */
  readonly hubToShopperKm: number;
  readonly inbound: readonly { readonly sellerOrderId: string; readonly km: number; readonly weightG: number }[];
}

export interface ParcelFactsPort {
  facts(parcel: ParcelRecord): Promise<ParcelFacts | null>;
}

export interface OutboundResult {
  readonly awb: string;
  readonly courierCode: string;
  /** What the courier charges HAUL for the outbound parcel. Zero when no rate card exists. */
  readonly costPiastres: bigint;
}

export interface OutboundCourierPort {
  /** Idempotent by `parcel.id`. Throws the fulfillment CourierUnavailableError / CourierRejectedError. */
  createOutbound(parcel: ParcelRecord, facts: ParcelFacts): Promise<OutboundResult>;
}

export interface JournalLine {
  readonly account: string;
  /** Signed piastres: debit positive, credit negative. The lines of one entry sum to zero. */
  readonly amount: bigint;
}

export interface HubLedgerPort {
  /** Idempotent by key. The fake rejects an unbalanced entry. */
  post(entry: { readonly idempotencyKey: string; readonly lines: readonly JournalLine[] }): Promise<void>;
}

export interface HubMetrics {
  increment(name: string, labels?: Readonly<Record<string, string>>): void;
}
