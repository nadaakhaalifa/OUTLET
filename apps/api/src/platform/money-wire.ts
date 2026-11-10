import { money } from "@outlet/money";
import type { Currency, Money } from "@outlet/money";
import { z } from "zod";

/** Contract Money: `amount_minor` is a bigint as a decimal string (never a float), `currency` ISO 4217. */
export const MoneyDto = z.strictObject({ amount_minor: z.string().regex(/^-?[0-9]{1,19}$/), currency: z.string().regex(/^[A-Z]{3}$/) });
export type MoneyDto = z.infer<typeof MoneyDto>;

export const wireMoney = (m: Money): MoneyDto => ({ amount_minor: m.amountMinor.toString(), currency: m.currency });

/** Parses a client Money; only EGP exists in this market. */
export const readMoney = (m: MoneyDto): Money => money(BigInt(m.amount_minor), m.currency as Currency);
