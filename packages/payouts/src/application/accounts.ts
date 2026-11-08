import { accountCode } from "@outlet/ledger";
import type { AccountType } from "@outlet/ledger";
import type { Currency } from "@outlet/money";

export const acct = (type: AccountType, market: string, currency: Currency, owner?: string): string =>
  accountCode({ type, market, currency, ...(owner === undefined ? {} : { owner }) });

/** Same mapping as checkout's clearingFor: the `fake` PSP stands in for the seeded paymob account; unseeded PSPs fail closed in the ledger. */
export const pspClearingOwner = (provider: string): string => (provider === "fake" ? "paymob" : provider);

/** Platform bank account that holds collections (chart 3.1, model (b)); seeded as bank_collections:EG:EGP:main. */
export const BANK_OWNER = "main";
