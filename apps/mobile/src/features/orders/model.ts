/** Orders list and detail (spec §20.1, §7 resume). Pure model, port and in-memory fake. */
import { PortError, type PortFailure } from "../worlds/model";
import type { LocalizedText } from "../checkout/model";

export { PortError };
export type { PortFailure, LocalizedText };

export type SellerOrderStatus =
  | "PENDING_PAYMENT" | "PAID" | "CONFIRMED_COD" | "ACCEPTED" | "PACKED" | "SHIPPED" | "OUT_FOR_DELIVERY"
  | "DELIVERED" | "CLOSED" | "CANCELLED" | "REJECTED_BY_SELLER" | "DELIVERY_FAILED" | "RTO" | "RETURNED_TO_SELLER"
  | "RETURN_REQUESTED" | "REFUNDED" | "DISPUTED";

export type OrderGroupState = "pending_payment" | "paid" | "confirmed_cod" | "failed" | "expired";

export interface TrackingEvent {
  readonly status: string;
  readonly label: LocalizedText;
  readonly at: string;
}

export interface ShipmentInfo {
  readonly courier: string;
  readonly awb: string;
  readonly events: readonly TrackingEvent[];
  readonly etaAt: string | null;
}

export interface EReceipt {
  readonly uuid: string;
  readonly url: string | null;
}

export interface OrderLineInfo {
  readonly id: string;
  readonly title: string;
  readonly qty: number;
  readonly unitPrice: bigint;
}

export interface SellerOrder {
  readonly id: string;
  readonly storeName: string;
  readonly status: SellerOrderStatus;
  readonly lines: readonly OrderLineInfo[];
  readonly total: bigint;
  readonly shipment: ShipmentInfo | null;
  readonly eReceipt: EReceipt | null;
  readonly deliveredAt: string | null;
}

export interface OrderGroup {
  readonly id: string;
  readonly placedAt: string;
  readonly state: OrderGroupState;
  readonly total: bigint;
  readonly sellerOrders: readonly SellerOrder[];
}

export interface OrdersPort {
  list(): Promise<readonly OrderGroup[]>;
  cancel(sellerOrderId: string, idempotencyKey: string): Promise<{ readonly ok: boolean }>;
}

const BEFORE_SHIPPED: ReadonlySet<SellerOrderStatus> = new Set(["PENDING_PAYMENT", "PAID", "CONFIRMED_COD", "ACCEPTED", "PACKED"]);

/** Free cancellation before SHIPPED (spec §20.1). After that it is a refusal or a return. */
export function canCancel(s: SellerOrderStatus): boolean {
  return BEFORE_SHIPPED.has(s);
}

export const PROGRESS_STEPS = ["PAID", "ACCEPTED", "PACKED", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"] as const;
export type ProgressStep = (typeof PROGRESS_STEPS)[number];

export interface Progress {
  readonly steps: readonly { readonly step: ProgressStep; readonly done: boolean; readonly current: boolean }[];
  /** Null when the order left the happy path (cancelled, returned, failed). */
  readonly onPath: boolean;
}

export function progress(status: SellerOrderStatus): Progress {
  const norm: SellerOrderStatus = status === "CONFIRMED_COD" ? "PAID" : status === "CLOSED" ? "DELIVERED" : status;
  const idx = PROGRESS_STEPS.indexOf(norm as ProgressStep);
  const onPath = idx >= 0;
  return {
    onPath,
    steps: PROGRESS_STEPS.map((step, i) => ({ step, done: onPath && i <= idx, current: onPath && i === idx })),
  };
}

/** Only https links are ever opened; anything else is treated as "not yet available". */
export function safeReceiptUrl(r: EReceipt | null): string | null {
  if (r === null || r.url === null) return null;
  return r.url.startsWith("https://") ? r.url : null;
}

export function resumable(g: OrderGroup): boolean {
  return g.state === "pending_payment";
}

export function returnable(o: SellerOrder): boolean {
  return o.status === "DELIVERED" || o.status === "CLOSED";
}

/** Newest first; ties by id so the order is deterministic. */
export function sortOrders(gs: readonly OrderGroup[]): readonly OrderGroup[] {
  return [...gs].sort((a, b) => (a.placedAt === b.placedAt ? a.id.localeCompare(b.id) : a.placedAt < b.placedAt ? 1 : -1));
}

export function trackingTimeline(s: ShipmentInfo): readonly TrackingEvent[] {
  return [...s.events].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

export type OrdersScreenState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly offline: boolean }
  | { readonly status: "ready"; readonly groups: readonly OrderGroup[] };

export function ordersFailureState(e: unknown): OrdersScreenState {
  return { status: "error", offline: e instanceof PortError && e.kind === "offline" };
}

export function applyCancelled(groups: readonly OrderGroup[], sellerOrderId: string): readonly OrderGroup[] {
  return groups.map((g) => ({
    ...g,
    sellerOrders: g.sellerOrders.map((o) => (o.id === sellerOrderId ? { ...o, status: "CANCELLED" as const } : o)),
  }));
}

export const FIXTURE_ORDERS: readonly OrderGroup[] = [
  {
    id: "og-2", placedAt: "2026-10-09T10:00:00Z", state: "paid", total: 205_000n,
    sellerOrders: [
      { id: "so-1", storeName: "Cairo Denim", status: "SHIPPED", total: 195_000n, deliveredAt: null,
        lines: [{ id: "l1", title: "Straight jeans", qty: 1, unitPrice: 119_000n }, { id: "l2", title: "Denim jacket", qty: 1, unitPrice: 76_000n }],
        shipment: { courier: "Bosta", awb: "BST-1001", etaAt: "2026-10-12T00:00:00Z", events: [
          { status: "picked_up", label: { ar: "تم الاستلام من المتجر", en: "Picked up from store" }, at: "2026-10-10T09:00:00Z" },
          { status: "in_transit", label: { ar: "في الطريق", en: "In transit" }, at: "2026-10-10T18:00:00Z" } ] },
        eReceipt: { uuid: "ETA-0001", url: "https://example.invalid/receipt/ETA-0001" } },
      { id: "so-2", storeName: "Atlas Sport", status: "PACKED", total: 10_000n, deliveredAt: null, lines: [{ id: "l3", title: "Sport socks", qty: 1, unitPrice: 9_000n }], shipment: null, eReceipt: null },
    ],
  },
  {
    id: "og-1", placedAt: "2026-09-20T10:00:00Z", state: "paid", total: 90_000n,
    sellerOrders: [
      { id: "so-0", storeName: "Delta Dresses", status: "DELIVERED", total: 90_000n, deliveredAt: "2026-09-25T12:00:00Z",
        lines: [{ id: "l9", title: "Linen dress", qty: 1, unitPrice: 90_000n }], shipment: null, eReceipt: { uuid: "ETA-0000", url: null } },
    ],
  },
  { id: "og-3", placedAt: "2026-10-10T08:00:00Z", state: "pending_payment", total: 50_000n, sellerOrders: [] },
];

export class InMemoryOrdersPort implements OrdersPort {
  cancelled: string[] = [];
  constructor(private readonly groups: readonly OrderGroup[] = FIXTURE_ORDERS, private failure: PortFailure | null = null) {}
  setFailure(f: PortFailure | null): void { this.failure = f; }
  async list(): Promise<readonly OrderGroup[]> {
    if (this.failure !== null) throw new PortError(this.failure);
    return this.groups;
  }
  async cancel(sellerOrderId: string): Promise<{ ok: boolean }> {
    if (this.failure !== null) throw new PortError(this.failure);
    this.cancelled.push(sellerOrderId);
    return { ok: true };
  }
}

/** Calendar day from an ISO instant in UTC, as "2026-10-09" with locale digits (no Intl dependency). */
export function formatDay(iso: string, digits: (ascii: string) => string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return digits(`${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`);
}
