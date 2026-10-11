import type { ReviewWire, SellerKycWire } from "../api/schemas";
import { countdown, type Countdown } from "../lib/format";

export interface SellerRow {
  readonly sellerId: string;
  readonly state: string;
  readonly storeNames: readonly string[];
  readonly canSuspend: boolean;
  readonly canReinstate: boolean;
  /** Needs a human decision soon: submitted and waiting for review. */
  readonly inQueue: boolean;
  readonly updatedAtMs: number;
}

/** States where suspend makes sense (kycMachine: APPROVED -> SUSPENDED) and where reinstate does (SUSPENDED -> APPROVED). */
export function sellerRow(s: SellerKycWire): SellerRow {
  return {
    sellerId: s.seller_id,
    state: s.kyc_state,
    storeNames: s.store_names,
    canSuspend: s.kyc_state === "APPROVED",
    canReinstate: s.kyc_state === "SUSPENDED",
    inQueue: s.kyc_state === "SUBMITTED" || s.kyc_state === "AUTO_CHECKS" || s.kyc_state === "NEEDS_INFO",
    updatedAtMs: Date.parse(s.updated_at),
  };
}

export function sellerQueue(items: readonly SellerKycWire[]): readonly SellerRow[] {
  // Queue first (oldest waiting first), then suspended, then the rest.
  const rank = (r: SellerRow): number => (r.inQueue ? 0 : r.state === "SUSPENDED" ? 1 : 2);
  return items.map(sellerRow).sort((a, b) => rank(a) - rank(b) || a.updatedAtMs - b.updatedAtMs || a.sellerId.localeCompare(b.sellerId));
}

export interface ReviewRow {
  readonly id: string;
  readonly sellerId: string;
  readonly state: ReviewWire["state"];
  readonly automatic: boolean;
  readonly reasonCode: string;
  readonly dueAtMs: number;
  readonly clock: Countdown | null;
  readonly overdue: boolean;
  /** 0..1 of the 5-business-day window consumed (server clock). */
  readonly elapsed: number;
  /** Decisions are only offered while OPEN. The API refuses the suspender as reviewer (403). */
  readonly canDecide: boolean;
}

export function reviewRow(r: ReviewWire, serverNowMs: number): ReviewRow {
  const due = Date.parse(r.due_at);
  const start = Date.parse(r.suspended_at);
  const open = r.state === "OPEN";
  const span = Math.max(1, due - start);
  return {
    id: r.id,
    sellerId: r.seller_id,
    state: r.state,
    automatic: r.automatic,
    reasonCode: r.reason_code,
    dueAtMs: due,
    clock: open ? countdown(due, serverNowMs) : null,
    overdue: open && serverNowMs > due,
    elapsed: open ? Math.min(1, Math.max(0, (serverNowMs - start) / span)) : 1,
    canDecide: open,
  };
}

/** Overdue first, then soonest due. Closed reviews last. */
export function reviewQueue(items: readonly ReviewWire[], serverNowMs: number): readonly ReviewRow[] {
  const rows = items.map((r) => reviewRow(r, serverNowMs));
  const rank = (r: ReviewRow): number => (r.state !== "OPEN" ? 2 : r.overdue ? 0 : 1);
  return rows.sort((a, b) => rank(a) - rank(b) || a.dueAtMs - b.dueAtMs || a.id.localeCompare(b.id));
}
