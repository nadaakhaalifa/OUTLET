export type SellerAccountsErrorCode =
  | "not_found"
  | "forbidden"
  | "conflict"
  | "validation"
  | "invalid_transition"
  | "kyc_incomplete"
  | "signatory_under_21"
  | "reason_required"
  | "last_owner"
  | "passkey_required";

/**
 * Typed failure. HTTP mapping: not_found 404, forbidden 403, conflict 409, validation 422, invalid_transition 409,
 * kyc_incomplete 422, signatory_under_21 422, reason_required 422, last_owner 409, passkey_required 403 (step-up).
 */
export class SellerAccountsError extends Error {
  constructor(
    readonly code: SellerAccountsErrorCode,
    message: string,
    readonly details: readonly string[] = [],
  ) {
    super(message);
    this.name = "SellerAccountsError";
  }
}

export const notFound = (what: string): SellerAccountsError => new SellerAccountsError("not_found", `${what} not found`);
export const validation = (message: string, details: readonly string[] = []): SellerAccountsError => new SellerAccountsError("validation", message, details);
