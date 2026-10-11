import { money, type Money } from "../money";
import { LIMITS } from "./types";

const EGP_DECIMAL = /^[0-9]{1,10}(\.[0-9]{1,2})?$/;

/** Parses "1299" or "1299.50" into piastres with integer arithmetic. Null when not strictly a decimal. */
export function parseEgpDecimal(text: string): Money | null {
  const t = text.trim();
  if (t.length > 14 || !EGP_DECIMAL.test(t)) return null;
  const [whole, frac = ""] = t.split(".");
  const piastres = BigInt(whole ?? "0") * 100n + BigInt(frac.padEnd(2, "0"));
  return money(piastres, "EGP");
}

export function isPriceInRange(price: Money): boolean {
  return price.currency === "EGP" && price.amount > 0n && price.amount <= LIMITS.priceMaxPiastres;
}
