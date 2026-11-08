export type MoneyErrorCode =
  | "CURRENCY_MISMATCH"
  | "INVALID_AMOUNT"
  | "INVALID_RATIOS"
  | "INVALID_DIVISOR"
  | "INVALID_BPS"
  | "UNKNOWN_CURRENCY";

export class MoneyError extends Error {
  readonly code: MoneyErrorCode;
  constructor(code: MoneyErrorCode, message: string) {
    super(message);
    this.name = "MoneyError";
    this.code = code;
  }
}
