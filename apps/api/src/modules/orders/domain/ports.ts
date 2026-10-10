import type {
  ActorType,
  CancelInitiator,
  GroupRollup,
  Money,
  OrderGroupState,
  PaymentType,
  RejectReason,
  SellerOrderState,
  Transition,
} from "./bridge";

export type { PaymentType, SellerOrderState };

export interface LocalizedText {
  readonly ar: string;
  readonly en?: string;
}

export interface OrderLineRecord {
  readonly id: string;
  readonly skuId: string;
  readonly productId: string;
  readonly qty: number;
  readonly unitPrice: Money;
  readonly discountAlloc: Money;
  readonly vat: Money;
  readonly title: LocalizedText;
  readonly sizeLabel: string | null;
}

/** Seller-safe buyer projection (first name, relay number, governorate). Never the raw phone. */
export interface BuyerContactRecord {
  readonly firstName: string | null;
  readonly phoneRelay: string | null;
  readonly governorateCode: string;
}

export interface SellerOrderRecord {
  readonly id: string;
  readonly orderGroupId: string;
  readonly storeId: string;
  readonly userId: string;
  readonly status: SellerOrderState;
  readonly version: number;
  readonly paymentType: PaymentType;
  readonly subtotal: Money;
  readonly shipping: Money;
  readonly discount: Money;
  readonly vat: Money;
  readonly total: Money;
  readonly commissionRateBps: number;
  readonly paidAtMs: number | null;
  readonly acceptByMs: number | null;
  readonly dispatchByMs: number | null;
  readonly acceptedAtMs: number | null;
  readonly packedAtMs: number | null;
  readonly shippedAtMs: number | null;
  readonly deliveredAtMs: number | null;
  readonly closedAtMs: number | null;
  readonly cancelledAtMs: number | null;
  readonly cancelInitiator: CancelInitiator | null;
  readonly cancelReason: string | null;
  readonly rejectReason: RejectReason | null;
  readonly createdAtMs: number;
  readonly lines: readonly OrderLineRecord[];
  /** Null when the caller's scope may not read it (shopper scope) or none was captured. */
  readonly buyer: BuyerContactRecord | null;
}

export interface OrderGroupRecord {
  readonly id: string;
  readonly userId: string;
  readonly status: OrderGroupState;
  readonly paymentMethod: PaymentMethodCode;
  readonly paymentType: PaymentType;
  readonly subtotal: Money;
  readonly shipping: Money;
  readonly discount: Money;
  readonly vat: Money;
  readonly storeCredit: Money;
  readonly total: Money;
  readonly version: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly sellerOrders: readonly SellerOrderRecord[];
}

export const PAYMENT_METHODS = [
  "card",
  "apple_pay",
  "meeza",
  "mobile_wallet",
  "instapay",
  "fawry",
  "bnpl",
  "cod",
] as const;
export type PaymentMethodCode = (typeof PAYMENT_METHODS)[number];

/** Who is reading or writing. The Kysely adapter maps it to RLS session settings. */
export type OrderScope =
  | { readonly kind: "seller"; readonly userId: string; readonly storeIds: readonly string[] }
  | { readonly kind: "shopper"; readonly userId: string }
  | { readonly kind: "system" };

// ---------------------------------------------------------------- intake

export interface NewOrderLine {
  readonly id: string;
  readonly skuId: string;
  readonly productId: string;
  readonly qty: number;
  readonly unitPrice: Money;
  readonly discountAlloc: Money;
  readonly vat: Money;
  readonly title: LocalizedText;
  readonly sizeLabel?: string;
}

export interface NewSellerOrder {
  readonly id: string;
  readonly storeId: string;
  /** Intake only takes paid or COD-confirmed orders (PENDING_PAYMENT never reaches sellers). */
  readonly status: "PAID" | "CONFIRMED_COD";
  readonly paidAtMs: number;
  readonly acceptByMs: number;
  readonly subtotal: Money;
  readonly shipping: Money;
  readonly discount: Money;
  readonly vat: Money;
  readonly total: Money;
  readonly commissionRateBps: number;
  readonly lines: readonly NewOrderLine[];
  readonly buyer: BuyerContactRecord;
}

export interface NewOrderGroup {
  readonly id: string;
  readonly userId: string;
  readonly idempotencyKey: string;
  readonly paymentMethod: PaymentMethodCode;
  readonly paymentType: PaymentType;
  readonly subtotal: Money;
  readonly shipping: Money;
  readonly discount: Money;
  readonly vat: Money;
  readonly storeCredit: Money;
  readonly total: Money;
  readonly placedAtMs: number;
  readonly sellerOrders: readonly NewSellerOrder[];
}

/**
 * Port fed by checkout (later). Here it is fed by a fake. `place` is idempotent on
 * `idempotencyKey` and writes nothing on a duplicate.
 */
export interface OrderIntake {
  place(group: NewOrderGroup): Promise<{ readonly kind: "created" | "duplicate"; readonly groupId: string }>;
}

// ---------------------------------------------------------------- events and commands

export type EventPayload = Readonly<Record<string, string | number | boolean | null>>;

export interface OutboxEventDraft {
  readonly id: string;
  readonly type: string;
  readonly aggregateType: "seller_order" | "order_group";
  readonly aggregateId: string;
  readonly occurredAtMs: number;
  readonly payload: EventPayload;
}

export interface TransitionCommand {
  readonly sellerOrderId: string;
  readonly scope: OrderScope;
  readonly expectedVersion: number;
  /** Unique per (order, key). Prefixed with the command kind by the caller. */
  readonly commandKey: string;
  readonly transition: Transition;
  readonly actorId: string | null;
  readonly nowMs: number;
  readonly historyId: string;
  readonly events: readonly OutboxEventDraft[];
  /** Runs inside the transaction on the sibling states; returns group events to append or null. */
  readonly rollup: (group: { readonly id: string; readonly status: OrderGroupState }, siblings: readonly SellerOrderState[]) =>
    | { readonly rollup: GroupRollup; readonly events: readonly OutboxEventDraft[] }
    | null;
}

export type ApplyResult =
  | { readonly kind: "applied"; readonly order: SellerOrderRecord }
  | { readonly kind: "replayed"; readonly order: SellerOrderRecord }
  | { readonly kind: "conflict" }
  | { readonly kind: "not_found" };

export interface ListQuery {
  readonly scope: OrderScope;
  readonly storeIds: readonly string[];
  readonly status?: SellerOrderState;
  readonly after: { readonly createdAtMs: number; readonly id: string } | null;
  readonly limit: number;
}

export interface ListPage {
  readonly items: readonly SellerOrderRecord[];
  readonly next: { readonly createdAtMs: number; readonly id: string } | null;
}

export interface OrderRepository extends OrderIntake {
  /** Group with its seller orders, visible to the owner only (RLS and filter). Others get null. */
  getGroupForUser(groupId: string, userId: string): Promise<OrderGroupRecord | null>;
  /** Owner and store of an order, for resolvers. System scope; reveals nothing to callers by itself. */
  locate(sellerOrderId: string): Promise<{ readonly storeId: string; readonly userId: string } | null>;
  groupOwner(groupId: string): Promise<string | null>;
  getSellerOrder(sellerOrderId: string, scope: OrderScope): Promise<SellerOrderRecord | null>;
  listForStores(q: ListQuery): Promise<ListPage>;
  /** True when a command with this key already ran on the order (for replay before deciding). */
  hasCommand(sellerOrderId: string, commandKey: string): Promise<boolean>;
  applyTransition(cmd: TransitionCommand): Promise<ApplyResult>;
  /** Unaccepted orders whose accept_by has passed, oldest first. */
  findAcceptSlaExpired(nowMs: number, limit: number): Promise<readonly string[]>;
}

export interface StoreSummaryFacts {
  readonly id: string;
  readonly slug: string;
  readonly name: LocalizedText;
  readonly kind: "local" | "global";
  readonly verifiedBadge: boolean;
}

/** Read-only store directory (stores module in production). Missing ids are simply absent. */
export interface StoreLookupPort {
  summaries(storeIds: readonly string[]): Promise<ReadonlyMap<string, StoreSummaryFacts>>;
}

export type { ActorType };
