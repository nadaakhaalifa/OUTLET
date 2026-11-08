/**
 * Pure quote (README section 4). No I/O; the hash function is injected because domain/ may not import node:crypto.
 * Every amount is bigint piastres via @outlet/money; the only rounding is splitInclusive / fraction (half-even, once per line).
 */
import { add, compare, fraction, money, sub } from "@outlet/money";
import type { Money } from "@outlet/money";
import type { PaymentMethod } from "../ports.js";
import type { Fee, Quote, QuoteInput, QuoteLine, StoreQuote } from "./types.js";

const zero = (c: Money["currency"]): Money => money(0n, c);
const sum = (c: Money["currency"], xs: readonly Money[]): Money => xs.reduce((a, b) => add(a, b), zero(c));
const min = (a: Money, b: Money): Money => (compare(a, b) <= 0 ? a : b);

/** VAT contained in a VAT-inclusive amount: gross * bps / (10000 + bps), half-even once. */
export const vatInside = (gross: Money, bps: number): Money => fraction(gross, BigInt(bps), 10_000n + BigInt(bps));

/** Deterministic JSON: sorted keys, bigint and Money as decimal strings, Map as sorted entries, Date as ISO. */
export const canonical = (v: unknown): string => {
  if (v === null || v === undefined) return "null";
  if (typeof v === "bigint") return JSON.stringify(v.toString());
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return JSON.stringify(v);
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (v instanceof Map) {
    const entries = [...(v as Map<unknown, unknown>).entries()].map(([k, val]) => [String(k), val] as const).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return `[${entries.map(([k, val]) => `[${JSON.stringify(k)},${canonical(val)}]`).join(",")}]`;
  }
  if (Array.isArray(v)) return `[${(v as unknown[]).map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
};

/** The hashed serialisation of a quote: everything except its own `hash`. */
export const canonicalQuote = (q: Omit<Quote, "hash"> | Quote): string => {
  return canonical(Object.fromEntries(Object.entries(q).filter(([k]) => k !== "hash")));
};

const byKey = <T>(xs: readonly T[], key: (x: T) => string): T[] => [...xs].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));

export function quote(input: QuoteInput, sha256Hex: (canonicalJson: string) => string): Quote {
  const cur = input.currency;
  const storeIds = [...new Set(input.lines.map((l) => l.storeId))].sort();
  const stores: StoreQuote[] = storeIds.map((storeId) => {
    const lines: QuoteLine[] = byKey(
      input.lines.filter((l) => l.storeId === storeId),
      (l) => l.skuId,
    ).map((l) => {
      const lineGross = fraction(l.unitPrice, BigInt(l.qty), 1n);
      const verifiedRef = l.claimType === "verified_discount" && l.vrp !== null && compare(l.vrp, l.unitPrice) > 0 ? l.vrp : null;
      return {
        cartLineId: l.cartLineId, skuId: l.skuId, storeId, qty: l.qty, unitPrice: l.unitPrice, lineGross, vat: vatInside(lineGross, l.vatBp), vatBp: l.vatBp,
        taxCategory: l.taxCategory, vrp: l.vrp, claimType: l.claimType,
        verifiedSaving: verifiedRef === null ? zero(cur) : fraction(sub(verifiedRef, l.unitPrice), BigInt(l.qty), 1n),
      };
    });
    const ship = input.shipping.get(storeId);
    if (ship === undefined) throw new Error(`quote: no shipping quote for store ${storeId}`);
    const itemsSubtotal = sum(cur, lines.map((x) => x.lineGross));
    const shipVat = vatInside(ship.fee, input.shippingTaxBp);
    return {
      storeId, lines, itemsSubtotal,
      shipping: { gross: ship.fee, vat: shipVat, quoteRef: ship.quoteRef, etaDaysMin: ship.etaDaysMin, etaDaysMax: ship.etaDaysMax },
      vat: add(sum(cur, lines.map((x) => x.vat)), shipVat),
      total: add(itemsSubtotal, ship.fee),
    };
  });

  const itemsSubtotal = sum(cur, stores.map((s) => s.itemsSubtotal));
  const shipping = sum(cur, stores.map((s) => s.shipping.gross));
  const discount = input.discount;
  const total = add(sub(itemsSubtotal, discount), shipping);
  const storeCredit = min(min(input.creditRequested, input.creditAvailable), total);
  const methods = byKey([...input.methods.keys()], (m) => m);
  const fees: Fee[] = [
    ...stores.map((s): Fee => ({ code: "delivery", storeId: s.storeId, method: null, amount: s.shipping.gross })),
    ...methods.map((m): Fee => ({ code: "payment_method", storeId: null, method: m, amount: input.methods.get(m)?.fee ?? zero(cur) })),
  ];
  const payableByMethod = new Map<PaymentMethod, Money>(methods.map((m) => [m, sub(add(total, input.methods.get(m)?.fee ?? zero(cur)), storeCredit)]));
  const body = {
    stores, fees, itemsSubtotal, shipping, discount, vat: sum(cur, stores.map((s) => s.vat)), total, storeCredit, payableByMethod,
    verifiedSavings: sum(cur, stores.flatMap((s) => s.lines.map((l) => l.verifiedSaving))),
  };
  return { ...body, hash: sha256Hex(canonicalQuote(body)) };
}
