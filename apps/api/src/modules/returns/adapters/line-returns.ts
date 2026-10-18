import type { ReturnRepository } from "../domain/ports";

/**
 * Read-only implementation of the orders module's LineReturnsPort (structural: returns never
 * imports orders). Internal wiring only, there is no HTTP route. Counts returns in a non-terminal
 * state per order line of one seller order; lines with none are absent from the map.
 */
export class ReturnsLineReturns {
  constructor(private readonly repo: Pick<ReturnRepository, "openReturnCountsBySellerOrder">) {}

  openReturnsByLine(sellerOrderId: string): Promise<ReadonlyMap<string, number>> {
    return this.repo.openReturnCountsBySellerOrder(sellerOrderId);
  }
}
