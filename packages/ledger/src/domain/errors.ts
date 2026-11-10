export type LedgerErrorCode =
  | "LEDGER_INVALID_ACCOUNT_CODE"
  | "LEDGER_RESERVED_ACCOUNT"
  | "LEDGER_INVALID_KIND"
  | "LEDGER_TOO_FEW_POSTINGS"
  | "LEDGER_ZERO_POSTING"
  | "LEDGER_UNBALANCED"
  | "LEDGER_MARKET_MISMATCH"
  | "LEDGER_CURRENCY_MISMATCH"
  | "LEDGER_INVALID_DRAFT"
  | "LEDGER_ACCOUNT_NOT_FOUND"
  | "LEDGER_IDEMPOTENCY_CONFLICT"
  | "LEDGER_ENTRY_NOT_FOUND"
  | "LEDGER_ALREADY_REVERSED"
  | "LEDGER_CANNOT_REVERSE_REVERSAL"
  | "LEDGER_INVALID_LIMIT"
  | "LEDGER_INVALID_CURSOR";

/** Typed ledger failure. Messages never contain amounts of other tenants; codes are the contract. */
export class LedgerError extends Error {
  constructor(
    readonly code: LedgerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LedgerError";
  }
}
