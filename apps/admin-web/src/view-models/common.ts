import { admin } from "@outlet/domain";
import type { ApiError } from "../api/client";
import type { MessageKey } from "../i18n";

export type Role = admin.AdminRoleName;

export const REASON_CODES: readonly { readonly code: admin.AdminReasonCode; readonly labelKey: MessageKey }[] = [
  { code: "customer_support_ticket", labelKey: "reason.customer_support_ticket" },
  { code: "fraud_investigation", labelKey: "reason.fraud_investigation" },
  { code: "kyc_review", labelKey: "reason.kyc_review" },
  { code: "dsar_fulfilment", labelKey: "reason.dsar_fulfilment" },
  { code: "legal_request", labelKey: "reason.legal_request" },
  { code: "finance_reconciliation", labelKey: "reason.finance_reconciliation" },
  { code: "security_investigation", labelKey: "reason.security_investigation" },
  { code: "incident_response", labelKey: "reason.incident_response" },
  { code: "break_glass_emergency", labelKey: "reason.break_glass_emergency" },
];

export const reasonLabelKey = (code: string): MessageKey | null =>
  REASON_CODES.find((r) => r.code === code)?.labelKey ?? null;

/** Reason codes offered where the action is NOT a break-glass: the emergency code is reserved for super_admin elevation. */
export const ORDINARY_REASON_CODES = REASON_CODES.filter((r) => r.code !== "break_glass_emergency");

export function isReasonCode(v: string): v is admin.AdminReasonCode {
  return admin.isAdminReasonCode(v);
}

export type ScreenState<T> =
  | { readonly kind: "ready"; readonly data: T; readonly serverNowMs: number }
  | { readonly kind: "empty" }
  | { readonly kind: "error"; readonly messageKey: MessageKey; readonly requestId: string | null };

const ERROR_KEYS: Readonly<Record<ApiError["kind"], MessageKey>> = {
  unauthorized: "state.sessionExpired",
  forbidden: "state.forbidden",
  not_found: "state.notFound",
  rate_limited: "state.rateLimited",
  validation: "state.error",
  conflict: "state.conflict",
  offline: "state.offline",
  server: "state.error",
  contract: "state.contract",
  not_configured: "state.notConfigured",
  unavailable: "state.unavailable",
};

export function errorState(e: ApiError): ScreenState<never> {
  return { kind: "error", messageKey: ERROR_KEYS[e.kind], requestId: e.requestId ?? null };
}

/** Server clock for deadlines; falls back to the device clock only when the server sent no Date header. */
export const serverNow = (header: number | null, deviceNowMs: number): number => header ?? deviceNowMs;
