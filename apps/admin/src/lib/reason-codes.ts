/** Mirror of @outlet/admin-access REASON_CODES (a unit test asserts they stay equal; the package barrel pulls server-only code). */
export const REASON_CODES = ["support_ticket", "fraud_review", "legal_request", "dsar", "finance_reconciliation", "other_with_note"] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

const TICKET = /^[A-Za-z0-9-]{1,40}$/;

/** X-Reason-Code value: `code` or `code:ticket`. Null when invalid (other_with_note needs a reference). */
export function reasonHeader(code: string, ticket: string): string | null {
  if (!(REASON_CODES as readonly string[]).includes(code)) return null;
  const ref = ticket.trim();
  if (ref === "") return code === "other_with_note" ? null : code;
  return TICKET.test(ref) ? `${code}:${ref}` : null;
}
