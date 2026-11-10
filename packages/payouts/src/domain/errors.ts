export type PayoutsErrorCode =
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "INVALID_STATE"
  | "INVALID_INPUT"
  | "APPROVAL_NOT_READY"
  | "INSUFFICIENT_PENDING"
  | "CURRENCY_MISMATCH"
  | "STALE_ATTEMPT";

export class PayoutsError extends Error {
  constructor(readonly code: PayoutsErrorCode, message: string) {
    super(message);
    this.name = "PayoutsError";
  }
}
