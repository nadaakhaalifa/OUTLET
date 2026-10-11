/**
 * Retention classes. Only `analytics_25m` is a fixed number from the spec (§B1: "analytics events:
 * 25 months, then aggregated"). Every other class is a placeholder that must be confirmed by
 * Legal/DPO: all are flagged `verify: true`.
 */
export const RETENTION_POLICIES = {
  analytics_25m: {
    description: "25 months, then aggregated (spec §B1, §13 user_events).",
    verify: false,
  },
  financial_tax_period_verify: {
    description: "Tax-law period for orders, invoices and refunds. Spec assumes 5-7 years. VERIFY BEFORE LAUNCH.",
    verify: true,
  },
  account_lifetime_verify: {
    description: "Lifetime of the account, then deleted or anonymised per the deletion flow (§2). VERIFY BEFORE LAUNCH.",
    verify: true,
  },
  legal_proof_verify: {
    description: "Proof of consent or data-subject-request handling, kept for a limitation period that Legal/DPO must set. VERIFY BEFORE LAUNCH.",
    verify: true,
  },
  outbox_published_30d_verify: {
    description: "Published outbox rows are purged after 30 days (proposed in docs/data-model/platform.md). Business truth lives in module tables under their own policy. VERIFY BEFORE LAUNCH.",
    verify: true,
  },
  operational_proposed_verify: {
    description: "Operational record. Spec gives no period; proposed default is 25 months to align with analytics. VERIFY BEFORE LAUNCH.",
    verify: true,
  },
} as const;

export type RetentionPolicyId = keyof typeof RETENTION_POLICIES;
