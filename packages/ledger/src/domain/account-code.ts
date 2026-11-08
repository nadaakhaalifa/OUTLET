import { CURRENCIES } from "@outlet/money";
import type { Currency } from "@outlet/money";
import { z } from "zod";
import { ACCOUNT_TYPES, RESERVED_ACCOUNT_TYPES, isAccountType, isStoreCreditSub } from "./chart.js";
import type { AccountType } from "./chart.js";
import { LedgerError } from "./errors.js";

const SEGMENT = /^[A-Za-z0-9_-]+$/;
const MARKET = /^[A-Z]{2}$/;

export interface AccountCodeParts {
  readonly type: AccountType;
  readonly market: string;
  readonly currency: Currency;
  readonly owner?: string;
  readonly sub?: string;
}

export const accountCodePartsSchema = z.strictObject({
  type: z.string().refine(isAccountType, "unknown account type"),
  market: z.string().regex(MARKET, "market must be ISO 3166-1 alpha-2"),
  currency: z.enum(CURRENCIES),
  owner: z.string().regex(SEGMENT).max(64).optional(),
  sub: z.string().regex(SEGMENT).max(64).optional(),
});

const invalid = (message: string): LedgerError => new LedgerError("LEDGER_INVALID_ACCOUNT_CODE", message);

/** Validates parts against the per-type shape in the chart (owner required or forbidden, sub only on store_credit). */
export function accountCode(parts: AccountCodeParts): string {
  const parsed = accountCodePartsSchema.safeParse(parts);
  if (!parsed.success) throw invalid(`invalid account code parts: ${parsed.error.issues[0]?.message ?? "unknown"}`);
  const spec = ACCOUNT_TYPES[parts.type];
  const hasOwner = parts.owner !== undefined;
  const hasSub = parts.sub !== undefined;
  if ((spec.owner !== "none") !== hasOwner) {
    throw invalid(`${parts.type} ${spec.owner === "none" ? "takes no owner" : "requires an owner"}`);
  }
  if (spec.sub !== hasSub) throw invalid(`${parts.type} ${spec.sub ? "requires a sub-balance" : "takes no sub-balance"}`);
  if (spec.sub && parts.sub !== undefined && !isStoreCreditSub(parts.sub)) throw invalid(`unknown store_credit sub-balance ${parts.sub}`);
  return [parts.type, parts.market, parts.currency, parts.owner, parts.sub].filter((s) => s !== undefined).join(":");
}

/** Inverse of accountCode. Reserved names (spec 3.5) get their own error code. */
export function parseAccountCode(code: string): AccountCodeParts & { readonly code: string } {
  const segments = code.split(":");
  if (segments.length < 3 || segments.length > 5) throw invalid("account code must have 3 to 5 segments");
  const [type, market, currency, owner, sub] = segments;
  if (type !== undefined && RESERVED_ACCOUNT_TYPES.includes(type)) {
    throw new LedgerError("LEDGER_RESERVED_ACCOUNT", `${type} is reserved and cannot be posted to`);
  }
  if (type === undefined || market === undefined || currency === undefined) throw invalid("account code is incomplete");
  const parts = accountCodePartsSchema.safeParse({
    type,
    market,
    currency,
    ...(owner !== undefined ? { owner } : {}),
    ...(sub !== undefined ? { sub } : {}),
  });
  if (!parts.success) throw invalid(`invalid account code: ${parts.error.issues[0]?.message ?? "unknown"}`);
  const built: AccountCodeParts = {
    type: type as AccountType,
    market,
    currency: currency as Currency,
    ...(owner !== undefined ? { owner } : {}),
    ...(sub !== undefined ? { sub } : {}),
  };
  return { ...built, code: accountCode(built) };
}
