/** Retryable: the payment facts are not available yet. The message is not marked processed. */
export class RefundFactsUnavailableError extends Error {
  constructor(readonly sellerOrderId: string) {
    super(`payment facts for seller order ${sellerOrderId} are not available yet`);
    this.name = "RefundFactsUnavailableError";
  }
}

/** Retryable: another intent for the same seller order committed between the capacity read and the write. */
export class RefundIntakeConflictError extends Error {
  readonly retryable = true;
  constructor(readonly sellerOrderId: string) {
    super(`a concurrent refund for seller order ${sellerOrderId} changed its capacity; retry`);
    this.name = "RefundIntakeConflictError";
  }
}

/**
 * Retryable: the order's recognition entry (order_paid / order_cod_confirmed) is not in the ledger,
 * so a refund would debit value that was never credited (F-8). Fails closed until it appears.
 */
export class RefundRecognitionMissingError extends Error {
  readonly retryable = true;
  constructor(
    readonly refundId: string,
    readonly keys: readonly string[],
  ) {
    super(`refund ${refundId}: order recognition entry (${keys.join(" or ")}) is not in the ledger`);
    this.name = "RefundRecognitionMissingError";
  }
}
