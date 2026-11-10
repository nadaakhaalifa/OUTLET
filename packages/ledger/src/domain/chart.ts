/**
 * Chart of accounts (docs/specs/ledger-chart-of-accounts.md section 3). Single source for account types,
 * entry kinds and the shape of each account code. Keep in sync with the CHECKs in migration 0008.
 */
export type NormalSide = "debit" | "credit";
export type OwnerKind = "none" | "psp" | "bnpl" | "courier" | "bank" | "store" | "user" | "stream";

export interface AccountTypeSpec {
  readonly normalSide: NormalSide;
  readonly owner: OwnerKind;
  /** store_credit carries a sub-balance (refund_credit, goodwill, ...); no other type does. */
  readonly sub: boolean;
  /** Owner-scoped types the service may create on first use. Everything else is seeded by a migration. */
  readonly lazy: boolean;
}

const t = (normalSide: NormalSide, owner: OwnerKind, extra: { sub?: boolean; lazy?: boolean } = {}): AccountTypeSpec => ({
  normalSide,
  owner,
  sub: extra.sub ?? false,
  lazy: extra.lazy ?? false,
});

export const ACCOUNT_TYPES = {
  psp_clearing: t("debit", "psp"),
  bnpl_clearing: t("debit", "bnpl"),
  cod_clearing: t("debit", "courier"),
  bank_operating: t("debit", "bank"),
  bank_collections: t("debit", "bank"),
  payouts_in_transit: t("debit", "none"),
  disputes_in_progress: t("debit", "psp"),
  vat_input: t("debit", "none"),
  seller_pending: t("credit", "store", { lazy: true }),
  seller_available: t("credit", "store", { lazy: true }),
  store_credit: t("credit", "user", { sub: true, lazy: true }),
  shopper_refunds_payable: t("credit", "none"),
  courier_payable: t("credit", "courier"),
  platform_vat_output: t("credit", "none"),
  deferred_revenue: t("credit", "stream"),
  commission_revenue: t("credit", "none"),
  shipping_revenue: t("credit", "none"),
  seller_plan_revenue: t("credit", "none"),
  recharge_revenue: t("credit", "none"),
  promo_expense_platform: t("debit", "none"),
  psp_fee_expense: t("debit", "none"),
  bnpl_fee_expense: t("debit", "none"),
  courier_cost_expense: t("debit", "none"),
  chargeback_loss_expense: t("debit", "none"),
  goodwill_expense: t("debit", "none"),
  referral_expense: t("debit", "none"),
  payout_fee_expense: t("debit", "none"),
} as const satisfies Record<string, AccountTypeSpec>;

export type AccountType = keyof typeof ACCOUNT_TYPES;
export const ACCOUNT_TYPE_NAMES = Object.keys(ACCOUNT_TYPES) as readonly AccountType[];

/** Spec 3.5: reserved names. Any posting fails (I19). */
export const RESERVED_ACCOUNT_TYPES: readonly string[] = [
  "gift_card_liability",
  "deferred_plus_revenue",
  "plus_revenue",
  "cashback_coins",
  "duties_payable",
  "fx_conversion",
];

export const ENTRY_KINDS = [
  "order_recognised",
  "order_delivered_cod",
  "refund_issued",
  "line_closed",
  "clearing_settled",
  "courier_cost_accrued",
  "courier_remitted",
  "recharge_issued",
  "plan_charged",
  "revenue_recognised",
  "payout_sent",
  "payout_settled",
  "dispute_opened",
  "dispute_resolved",
  "store_credit_granted",
  "store_credit_spent",
  "store_credit_expired",
  "reversal",
] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

export const isEntryKind = (value: string): value is EntryKind => (ENTRY_KINDS as readonly string[]).includes(value);

export const isAccountType = (value: string): value is AccountType => Object.hasOwn(ACCOUNT_TYPES, value);

/** store_credit sub-balances (spec 3.x). Keep in sync with ledger_accounts_store_credit_sub in migration 0008. */
export const STORE_CREDIT_SUBS = ["refund_credit", "gift_card", "cashback_coins", "referral_credit", "goodwill"] as const;
export type StoreCreditSub = (typeof STORE_CREDIT_SUBS)[number];
export const isStoreCreditSub = (value: string): value is StoreCreditSub => (STORE_CREDIT_SUBS as readonly string[]).includes(value);
