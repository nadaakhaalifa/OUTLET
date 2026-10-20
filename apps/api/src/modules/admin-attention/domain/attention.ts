import { adminGateDenial, ROUTE_ROLES, type AdminAccess } from "../../admin";
import type { AdminRoleName } from "./ports";

/**
 * Attention queue items (docs/specs/dashboard-foundations.md section 7.2). Visibility is a named,
 * exported predicate per item (M7), never an inline role list. Wave 2's `me` capability map is not
 * merged yet, so these predicates evaluate the same exported gate (`adminGateDenial`) over the same
 * role tables; when `me` lands, `capabilityPredicates` should be swapped for its map (assumption A1).
 */
export const ATTENTION_GROUPS = ["page", "legal_clock", "money", "approvals", "trust", "anomaly"] as const;
export type AttentionGroup = (typeof ATTENTION_GROUPS)[number];
export type AttentionSeverity = "info" | "warning" | "critical";

export const ATTENTION_COUNT_CAP = 1000;
/** One config constant each so the DPO can change them (spec 7.2). Proposed, owner/counsel decision. */
export const ATTENTION_THRESHOLDS = { dsarNearSlaDays: 23, dsarSlaDays: 30, breachClockHours: 72 } as const;

type Roles = readonly AdminRoleName[] | "any_standing";
/** Deny by default: a capability not listed here is never granted (ADR-0049 safe default, assumption A2). */
export const CAPABILITY_ROLES = {
  "ledger.integrity.read": ["finance"],
  "flags.read": ROUTE_ROLES.flagsRead,
  "privacy.read": ["dpo"],
  "kyc_review.read": ROUTE_ROLES.kycReviewRead,
  "recon.read": ["finance", "ops"],
  "payout.read": ["finance", "ops"],
  "tax.read": ["finance", "ops"],
  "console.access": "any_standing",
  "brand_review.read": ["ops", "trust_safety"],
} as const satisfies Readonly<Record<string, Roles>>;
export type AttentionCapability = keyof typeof CAPABILITY_ROLES;

export const capabilityPredicates: Readonly<Record<AttentionCapability, (access: AdminAccess) => boolean>> = Object.fromEntries(
  (Object.entries(CAPABILITY_ROLES) as [AttentionCapability, Roles][]).map(([cap, roles]) => [
    cap,
    (access: AdminAccess) => adminGateDenial(access, roles) === null,
  ]),
) as Record<AttentionCapability, (access: AdminAccess) => boolean>;

export interface AttentionItemDef {
  readonly id: string;
  readonly group: AttentionGroup;
  readonly capability: AttentionCapability;
  readonly severity: AttentionSeverity;
  readonly href: string;
  /** Per-user sources are never cached. */
  readonly perUser: boolean;
}

export const ATTENTION_ITEMS: readonly AttentionItemDef[] = [
  { id: "ledger.integrity", group: "page", capability: "ledger.integrity.read", severity: "critical", href: "/finance/integrity", perUser: false },
  { id: "outbox.dead_lettered", group: "page", capability: "flags.read", severity: "critical", href: "/operations", perUser: false },
  { id: "privacy.breaches_open", group: "legal_clock", capability: "privacy.read", severity: "critical", href: "/privacy/breaches", perUser: false },
  { id: "privacy.requests_near_sla", group: "legal_clock", capability: "privacy.read", severity: "warning", href: "/privacy/requests", perUser: false },
  { id: "kyc.suspension_reviews_overdue", group: "legal_clock", capability: "kyc_review.read", severity: "critical", href: "/suspensions", perUser: false },
  { id: "recon.tickets_aged", group: "money", capability: "recon.read", severity: "warning", href: "/finance/reconciliation", perUser: false },
  { id: "payouts.on_hold_or_failed", group: "money", capability: "payout.read", severity: "warning", href: "/finance/payouts", perUser: false },
  { id: "tax.rejected", group: "money", capability: "tax.read", severity: "warning", href: "/tax", perUser: false },
  { id: "approvals.waiting_on_me", group: "approvals", capability: "console.access", severity: "info", href: "/approvals", perUser: true },
  { id: "elevations.expiring", group: "approvals", capability: "console.access", severity: "info", href: "/approvals", perUser: true },
  { id: "brand_applications.sla_late", group: "trust", capability: "brand_review.read", severity: "warning", href: "/brands", perUser: false },
];

export const visibleAttentionItems = (access: AdminAccess): readonly AttentionItemDef[] =>
  ATTENTION_ITEMS.filter((i) => capabilityPredicates[i.capability](access));
