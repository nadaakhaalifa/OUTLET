export type CartErrorCode =
  | "not_found"
  | "forbidden"
  | "line_limit"
  | "qty_limit"
  | "invalid_qty"
  | "unavailable"
  | "currency_mismatch"
  | "idempotency_conflict"
  | "idempotency_in_progress";

/** Typed cart failure. HTTP mapping: not_found 404, forbidden 403, line_limit/qty_limit/invalid_qty/currency_mismatch 422, unavailable 409, idempotency_conflict 422, idempotency_in_progress 409. */
export class CartError extends Error {
  constructor(
    readonly code: CartErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CartError";
  }
}
