/**
 * Admin console vocabulary (spec 23, A2, T5). Pure data: no clock, no I/O.
 * Role names mirror packages/policy ADMIN_ROLES; they are redeclared here because the domain
 * package must not depend on the policy package.
 */
export const ADMIN_ROLE_NAMES = [
  "ops",
  "finance",
  "trust_safety",
  "support",
  "marketing",
  "dpo",
  "security",
  "super_admin",
] as const;
export type AdminRoleName = (typeof ADMIN_ROLE_NAMES)[number];

/** Mandatory, enumerated reason codes for PII views, elevation and break-glass (spec 23, T5). */
export const ADMIN_REASON_CODES = [
  "customer_support_ticket",
  "fraud_investigation",
  "kyc_review",
  "dsar_fulfilment",
  "legal_request",
  "finance_reconciliation",
  "security_investigation",
  "incident_response",
  "break_glass_emergency",
] as const;
export type AdminReasonCode = (typeof ADMIN_REASON_CODES)[number];

export function isAdminReasonCode(value: string): value is AdminReasonCode {
  return (ADMIN_REASON_CODES as readonly string[]).includes(value);
}

export function isAdminRoleName(value: string): value is AdminRoleName {
  return (ADMIN_ROLE_NAMES as readonly string[]).includes(value);
}

export const MS_PER_MINUTE = 60_000;
export const MS_PER_HOUR = 3_600_000;
export const MS_PER_DAY = 86_400_000;
