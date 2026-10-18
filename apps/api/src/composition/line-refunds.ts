import type { LineRefundsPort } from "../modules/orders";
import type { RefundStore } from "../modules/refunds";

/**
 * Orders `LineRefundsPort` over the refunds module's store: goods value already committed (refunds
 * not CANCELLED) per order line of a seller order. Conservative at closure: an in-flight refund
 * counts, so a commission is never accrued on value that is on its way back to the shopper. A
 * refund that is later cancelled leaves the creator under-accrued (documented gap, never over).
 */
export class RefundStoreLineRefunds implements LineRefundsPort {
  constructor(private readonly store: Pick<RefundStore, "committedForSellerOrder">) {}

  async refundedGoodsByLine(sellerOrderId: string): Promise<ReadonlyMap<string, bigint>> {
    return (await this.store.committedForSellerOrder(sellerOrderId)).byLine;
  }
}
