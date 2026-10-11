import { DomainError } from "../errors";

export const MS_PER_HOUR = 3_600_000;

/** Per seller order state at the hub (spec 09 part B). */
export const LEG_STATES = ["AT_HUB_EXPECTED", "RECEIVED", "CONSOLIDATED", "DISPATCHED", "CANCELLED", "EXCEPTION"] as const;
export type LegState = (typeof LEG_STATES)[number];

export const RECEIPT_CONDITIONS = ["ok", "damaged"] as const;
export type ReceiptCondition = (typeof RECEIPT_CONDITIONS)[number];

/** A seller order travelling to the hub. Amounts are integer piastres. */
export interface HubLeg {
  readonly sellerOrderId: string;
  readonly state: LegState;
  readonly lineIds: readonly string[];
  /** Merchandise subtotal in piastres; the weight for the fee allocation. */
  readonly subtotal: bigint;
}

export interface HubConfig {
  /** Seller handoff SLA to the hub, from payment. Default 48 h. */
  readonly handoffSlaMs: number;
  /** "Ship together" wait before split, from payment. Default 72 h. */
  readonly shipTogetherWaitMs: number;
}

export const DEFAULT_HUB_CONFIG: HubConfig = {
  handoffSlaMs: 48 * MS_PER_HOUR,
  shipTogetherWaitMs: 72 * MS_PER_HOUR,
};

export class InvalidLegTransitionError extends DomainError {
  constructor(
    readonly from: LegState,
    readonly to: LegState,
  ) {
    super(`hub leg cannot move ${from} -> ${to}`);
  }
}

export class InvalidHubInputError extends DomainError {}
