import type { ReturnService } from "@outlet/returns";

export interface ReturnLineRow {
  readonly id: string;
  readonly orderLineId: string;
  readonly qty: number;
  readonly conditionReceived: string | null;
  readonly restockDecision: string | null;
}

export interface ReturnRow {
  readonly id: string;
  readonly sellerOrderId: string;
  readonly status: string;
  readonly reasonCode: string;
  readonly fault: string;
  readonly windowBasis: string;
  readonly deliveredAtSnapshot: Date;
  readonly windowEndsAt: Date;
  readonly method: string;
  readonly resolution: string;
  readonly receivedAt: Date | null;
  readonly inspectionDueAt: Date | null;
  readonly refundDueAt: Date | null;
  readonly rejectionReason: string | null;
  readonly createdAt: Date;
  readonly lines: readonly ReturnLineRow[];
}

export interface ReturnPage { readonly items: readonly ReturnRow[]; readonly nextCursor: string | null }
export interface PageQuery { readonly limit: number; readonly cursor?: string; readonly status?: string }

/** Read side of returns. User context for the shopper (a foreign id is invisible under RLS), store context for the seller. */
export interface ReturnReaderPort {
  listOwn(userId: string, q: PageQuery): Promise<ReturnPage>;
  getOwn(userId: string, id: string): Promise<ReturnRow | null>;
  listStore(storeId: string, q: PageQuery): Promise<ReturnPage>;
  getStore(storeId: string, id: string): Promise<ReturnRow | null>;
  /** True when every line id is a line of that seller order and belongs to the caller (user context). */
  linesBelong(userId: string, sellerOrderId: string, lineIds: readonly string[]): Promise<boolean>;
}

/**
 * Shopper cancellation of an unshipped order group. NOT a package feature: @outlet/returns refunds only what a return produced, and no
 * consumer of `seller_order.cancelled` / `inventory.release_required` or cancellation refund saga exists, so moving the order to
 * CANCELLED here would strand the shopper's money and the claimed stock. The production adapter therefore fails closed (503) until that
 * saga is designed; the eligibility rules (ownership 404, after SHIPPED 409) are enforced before the port is called.
 */
export interface OrderCancellationPort {
  cancel(input: { readonly userId: string; readonly orderGroupId: string; readonly reasonCode: string; readonly refundPreference: "original" | "store_credit" | undefined }): Promise<void>;
}

export interface ReturnsServices {
  readonly returns: Pick<ReturnService, "request" | "cancel" | "openDispute" | "inspect">;
  readonly reader: ReturnReaderPort;
  readonly cancellation: OrderCancellationPort;
}
