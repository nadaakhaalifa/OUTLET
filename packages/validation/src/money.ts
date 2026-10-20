import { z } from "zod";
import { money, type Money } from "@outlet/domain";

/**
 * Wire format for money (OpenAPI `Money`): an integer string of minor units plus currency.
 * Never a JSON number, so no float can enter a money path. Parses to the domain `Money` (bigint).
 */
const INTEGER_STRING = /^-?(0|[1-9][0-9]{0,29})$/;

export const MoneyWireSchema = z
  .object({
    amount: z.string().regex(INTEGER_STRING, "amount must be an integer string of minor units"),
    currency: z.literal("EGP"),
  })
  .strict();
export type MoneyWire = z.input<typeof MoneyWireSchema>;

export const MoneySchema = MoneyWireSchema.transform((w): Money => money(BigInt(w.amount), w.currency));

/** Non-negative variant for prices, fees and limits. */
export const NonNegativeMoneySchema = MoneySchema.refine((m) => m.amount >= 0n, {
  message: "amount must not be negative",
});

export function moneyToWire(m: Money): MoneyWire {
  return { amount: m.amount.toString(10), currency: m.currency };
}
