import { balanceOf, type AccountId, type JournalEntry } from "../ledger";
import { negate, type Money } from "../money";
import { InvalidAccountError } from "./errors";

export type AccountCategory = "asset" | "liability" | "revenue" | "expense";
export type NormalBalance = "debit" | "credit";
export type AccountOwner =
  | "platform"
  | "psp"
  | "courier"
  | "bnpl_provider"
  | "bank"
  | "seller"
  | "shopper";

export type AccountTypeName =
  | "psp_clearing"
  | "cod_clearing"
  | "bnpl_clearing"
  | "bank_settlement"
  | "seller_payable"
  | "store_credit"
  | "gift_card_liability"
  | "refund_reserve"
  | "deferred_plus_revenue"
  | "platform_vat_output"
  | "platform_commission"
  | "shipping_revenue"
  | "plus_revenue"
  | "promo_expense_platform"
  | "promo_receivable_seller"
  | "provider_fee_expense"
  | "courier_fee_expense";

export interface AccountTypeDefinition {
  readonly type: AccountTypeName;
  readonly category: AccountCategory;
  /** Debit-normal accounts grow with debits (positive raw sum); credit-normal with credits (negative raw sum). */
  readonly normalBalance: NormalBalance;
  readonly owner: AccountOwner;
  /** Names of the id parameters after the type, in order. Empty for singleton accounts. */
  readonly parameters: readonly string[];
  readonly purpose: string;
  readonly lifecycle: string;
  /** What this account is reconciled against, when it is. */
  readonly reconciledAgainst?: string;
  /** True when the account is in spec §T4. False means it is an addition made by this chart. */
  readonly inSpecT4: boolean;
  /** "reserved" accounts exist in the chart but no builder posts to them yet. */
  readonly status: "active" | "reserved";
  readonly verify?: string;
}

export const ACCOUNT_TYPES: Readonly<Record<AccountTypeName, AccountTypeDefinition>> = {
  psp_clearing: {
    type: "psp_clearing",
    category: "asset",
    normalBalance: "debit",
    owner: "psp",
    parameters: ["psp"],
    purpose: "Money the PSP holds for us: card and wallet captures not yet settled to the bank.",
    lifecycle: "Opened when a PSP integration is enabled. Never closed. Drains to bank_settlement on each settlement file.",
    reconciledAgainst: "PSP settlement files (nightly)",
    inSpecT4: true,
    status: "active",
  },
  cod_clearing: {
    type: "cod_clearing",
    category: "asset",
    normalBalance: "debit",
    owner: "courier",
    parameters: ["courier"],
    purpose: "Cash the courier has collected on delivery and still owes us.",
    lifecycle: "Opened per courier contract. Debited at delivery, credited at remittance. Aging above 3 days escalates to Finance.",
    reconciledAgainst: "Courier COD remittance reports",
    inSpecT4: true,
    status: "active",
  },
  bnpl_clearing: {
    type: "bnpl_clearing",
    category: "asset",
    normalBalance: "debit",
    owner: "bnpl_provider",
    parameters: ["provider"],
    purpose: "What the BNPL provider owes us for approved orders, before its fee and settlement.",
    lifecycle: "Opened per provider. Debited when the provider approves an order, credited at settlement or on a loan cancellation.",
    reconciledAgainst: "BNPL provider settlement statements",
    inSpecT4: true,
    status: "active",
  },
  bank_settlement: {
    type: "bank_settlement",
    category: "asset",
    normalBalance: "debit",
    owner: "bank",
    parameters: ["account"],
    purpose: "Cash that has actually arrived in, or left, a bank account that settlements and payouts run through.",
    lifecycle: "One per bank account actually used. Opened when the flow of funds is decided. Never closed.",
    reconciledAgainst: "Bank statements",
    inSpecT4: false,
    status: "active",
    verify:
      "VERIFY BEFORE LAUNCH: not in spec T4. Whether Z-OUTLET ever holds funds in its own account depends on open question 4 (flow of funds, CBE and PSP licensing).",
  },
  seller_payable: {
    type: "seller_payable",
    category: "liability",
    normalBalance: "credit",
    owner: "seller",
    parameters: ["store"],
    purpose: "What we owe a seller for goods sold, net of commission and VAT on commission. Negative means the seller owes us.",
    lifecycle: "Opened with the seller's first order. Credited per order, debited by payouts, refunds and netting. Closed only at seller offboarding when it is zero.",
    reconciledAgainst: "Payout batches and seller statements",
    inSpecT4: true,
    status: "active",
  },
  store_credit: {
    type: "store_credit",
    category: "liability",
    normalBalance: "credit",
    owner: "shopper",
    parameters: ["user", "sub_balance"],
    purpose: "Closed-loop HAUL credit owed to a shopper, one account per sub-balance.",
    lifecycle:
      "Opened on first grant. Sub-balances: refund_credit (no expiry), gift_card:{cardId}, cashback_coins (12 months), referral_credit (6 months), goodwill (90 days). Never negative.",
    reconciledAgainst: "Cached wallet projection (nightly)",
    inSpecT4: true,
    status: "active",
  },
  gift_card_liability: {
    type: "gift_card_liability",
    category: "liability",
    normalBalance: "credit",
    owner: "platform",
    parameters: [],
    purpose: "Unredeemed gift-card value that has been sold.",
    lifecycle: "Credited at sale, debited at redemption into a gift_card sub-balance. Breakage on expiry is not modelled.",
    reconciledAgainst: "Gift-card table (issued minus redeemed)",
    inSpecT4: true,
    status: "active",
    verify: "VERIFY BEFORE LAUNCH: VAT point for gift cards (sale or redemption) and expiry or breakage treatment.",
  },
  refund_reserve: {
    type: "refund_reserve",
    category: "liability",
    normalBalance: "credit",
    owner: "platform",
    parameters: [],
    purpose: "Reserved for holding back value against expected refunds.",
    lifecycle: "Reserved. No builder posts to it in Phase 1. Must stay at zero until a spec defines its use.",
    inSpecT4: true,
    status: "reserved",
  },
  deferred_plus_revenue: {
    type: "deferred_plus_revenue",
    category: "liability",
    normalBalance: "credit",
    owner: "platform",
    parameters: [],
    purpose: "Plus subscription fees collected for periods not yet served.",
    lifecycle: "Credited at charge (net of VAT), debited each period as revenue is recognised. Zero after the last period.",
    inSpecT4: true,
    status: "active",
  },
  platform_vat_output: {
    type: "platform_vat_output",
    category: "liability",
    normalBalance: "credit",
    owner: "platform",
    parameters: [],
    purpose: "Output VAT owed on Z-OUTLET's own supplies: commission, shipping fees and Plus.",
    lifecycle: "Credited when a taxable supply is invoiced. Cleared by the periodic VAT return, outside this ledger for now.",
    reconciledAgainst: "ETA e-invoice and e-receipt submissions",
    inSpecT4: true,
    status: "active",
    verify: "VERIFY BEFORE LAUNCH: VAT base when the platform funds a discount, and VAT on coins, vouchers and gift cards.",
  },
  platform_commission: {
    type: "platform_commission",
    category: "revenue",
    normalBalance: "credit",
    owner: "platform",
    parameters: [],
    purpose: "Commission earned from sellers, net of VAT.",
    lifecycle: "Credited when an order is recognised, debited on refunds. Closed to retained earnings at period end.",
    inSpecT4: true,
    status: "active",
  },
  shipping_revenue: {
    type: "shipping_revenue",
    category: "revenue",
    normalBalance: "credit",
    owner: "platform",
    parameters: [],
    purpose: "Delivery fees charged to shoppers, net of VAT.",
    lifecycle: "Credited with the order, debited when a fee is refunded.",
    inSpecT4: true,
    status: "active",
  },
  plus_revenue: {
    type: "plus_revenue",
    category: "revenue",
    normalBalance: "credit",
    owner: "platform",
    parameters: [],
    purpose: "Plus subscription revenue recognised for periods served.",
    lifecycle: "Credited from deferred_plus_revenue once per period.",
    inSpecT4: true,
    status: "active",
  },
  promo_expense_platform: {
    type: "promo_expense_platform",
    category: "expense",
    normalBalance: "debit",
    owner: "platform",
    parameters: [],
    purpose: "Cost of promotions the platform funds: vouchers, coins, referral credit and goodwill.",
    lifecycle: "Debited when a platform-funded discount is applied or credit is granted. Credited when coins expire or the discounted line is refunded.",
    inSpecT4: true,
    status: "active",
    verify: "VERIFY BEFORE LAUNCH: whether coins and vouchers are an expense or a reduction of revenue, and the VAT effect.",
  },
  promo_receivable_seller: {
    type: "promo_receivable_seller",
    category: "asset",
    normalBalance: "debit",
    owner: "seller",
    parameters: ["store"],
    purpose: "Discount value Z-OUTLET fronted to shoppers that a seller agreed to fund, recovered by netting from seller_payable.",
    lifecycle: "Debited when a seller-funded discount is applied, credited when netted against the seller payable.",
    inSpecT4: true,
    status: "active",
    verify:
      "Parameterised by store here, while T4 lists it without a parameter, so that netting is per seller.",
  },
  provider_fee_expense: {
    type: "provider_fee_expense",
    category: "expense",
    normalBalance: "debit",
    owner: "platform",
    parameters: [],
    purpose: "Fees deducted by PSPs and BNPL providers at settlement.",
    lifecycle: "Debited at settlement.",
    inSpecT4: false,
    status: "active",
    verify: "VERIFY BEFORE LAUNCH: who bears provider fees (platform or seller) and their VAT treatment. Not in spec T4.",
  },
  courier_fee_expense: {
    type: "courier_fee_expense",
    category: "expense",
    normalBalance: "debit",
    owner: "platform",
    parameters: [],
    purpose: "COD handling fees a courier withholds from a remittance.",
    lifecycle: "Debited at remittance.",
    inSpecT4: false,
    status: "active",
    verify: "VERIFY BEFORE LAUNCH: courier contract terms. Not in spec T4.",
  },
};

const SEGMENT = /^[A-Za-z0-9_-]+$/;

function segment(kind: string, value: string): string {
  if (!SEGMENT.test(value)) {
    throw new InvalidAccountError(`${kind} must match ${SEGMENT.source}, got "${value}"`);
  }
  return value;
}

export type StoreCreditSub =
  | { readonly kind: "refund_credit" }
  | { readonly kind: "cashback_coins" }
  | { readonly kind: "referral_credit" }
  | { readonly kind: "goodwill" }
  | { readonly kind: "gift_card"; readonly cardId: string };

export function subBalanceKey(sub: StoreCreditSub): string {
  return sub.kind === "gift_card" ? `gift_card:${segment("cardId", sub.cardId)}` : sub.kind;
}

/** Typed account id constructors. Ids are compatible with the `accounts` helpers in ledger.ts. */
export const chart = {
  pspClearing: (psp: string): AccountId => `psp_clearing:${segment("psp", psp)}`,
  codClearing: (courier: string): AccountId => `cod_clearing:${segment("courier", courier)}`,
  bnplClearing: (provider: string): AccountId => `bnpl_clearing:${segment("provider", provider)}`,
  bankSettlement: (account: string): AccountId => `bank_settlement:${segment("account", account)}`,
  sellerPayable: (store: string): AccountId => `seller_payable:${segment("store", store)}`,
  storeCredit: (user: string, sub: StoreCreditSub): AccountId =>
    `store_credit:${segment("user", user)}:${subBalanceKey(sub)}`,
  promoReceivableSeller: (store: string): AccountId =>
    `promo_receivable_seller:${segment("store", store)}`,
  giftCardLiability: "gift_card_liability" as AccountId,
  refundReserve: "refund_reserve" as AccountId,
  deferredPlusRevenue: "deferred_plus_revenue" as AccountId,
  platformVatOutput: "platform_vat_output" as AccountId,
  platformCommission: "platform_commission" as AccountId,
  shippingRevenue: "shipping_revenue" as AccountId,
  plusRevenue: "plus_revenue" as AccountId,
  promoExpensePlatform: "promo_expense_platform" as AccountId,
  providerFeeExpense: "provider_fee_expense" as AccountId,
  courierFeeExpense: "courier_fee_expense" as AccountId,
} as const;

export interface DescribedAccount {
  readonly definition: AccountTypeDefinition;
  readonly parameters: readonly string[];
}

function isAccountTypeName(value: string): value is AccountTypeName {
  return Object.prototype.hasOwnProperty.call(ACCOUNT_TYPES, value);
}

/** Resolves an account id to its type definition. Throws on an id that is not in the chart. */
export function describeAccount(id: AccountId): DescribedAccount {
  const parts = id.split(":");
  const typeName = parts[0] ?? "";
  if (!isAccountTypeName(typeName)) throw new InvalidAccountError(`unknown account type in "${id}"`);
  const definition = ACCOUNT_TYPES[typeName];
  const expected = definition.parameters.length;
  const rest = parts.slice(1);
  // The last parameter of store_credit (the sub-balance) may itself contain a colon.
  const parameters =
    typeName === "store_credit" && rest.length >= 2 ? [rest[0] ?? "", rest.slice(1).join(":")] : rest;
  if (parameters.length !== expected || parameters.some((p) => p.length === 0)) {
    throw new InvalidAccountError(`account "${id}" needs ${expected} parameter(s)`);
  }
  return { definition, parameters };
}

/**
 * Balance in the account's natural sign: positive means the account holds what its normal balance
 * says (a liability that is owed, an asset that is receivable). Derived from postings only.
 */
export function derivedBalance(
  id: AccountId,
  entries: readonly JournalEntry[],
): Money {
  const { definition } = describeAccount(id);
  const raw = balanceOf(id, entries);
  return definition.normalBalance === "debit" ? raw : negate(raw);
}
