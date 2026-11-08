/**
 * Pure quote (README section 4). No I/O; the hash function is injected because domain/ may not import node:crypto.
 * Every amount is bigint piastres via @outlet/money; the only rounding is splitInclusive / fraction (half-even, once per line).
 */
import { add, compare, fraction, money, sub } from "@outlet/money";
import type { Money } from "@outlet/money";
import type { PaymentMethod } from "../ports.js";
import { allocateVatWithLineDiscounts } from "@outlet/tax";
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
  const disc = input.discounts;
  const stores: StoreQuote[] = storeIds.map((storeId) => {
    const sorted = byKey(
      input.lines.filter((l) => l.storeId === storeId),
      (l) => l.skuId,
    );
    const grossOf = (l: (typeof sorted)[number]): Money => fraction(l.unitPrice, BigInt(l.qty), 1n);
    // one allocation per store: seller discounts reduce the VAT base, platform ones do not unless V62 says so (CONSERVATIVE_VAT_BASE)
    const allocated = new Map(
      allocateVatWithLineDiscounts(sorted.map((l) => ({ id: l.cartLineId, gross: grossOf(l), bps: l.vatBp, platformDiscount: disc?.lines.get(l.cartLineId)?.platform ?? zero(cur), sellerDiscount: disc?.lines.get(l.cartLineId)?.seller ?? zero(cur) }))).lines.map((a) => [a.id, a] as const),
    );
    const lines: QuoteLine[] = sorted.map((l) => {
      const lineGross = grossOf(l);
      const a = allocated.get(l.cartLineId);
      if (a === undefined) throw new Error("quote: line allocation missing");
      const verifiedRef = l.claimType === "verified_discount" && l.vrp !== null && compare(l.vrp, l.unitPrice) > 0 ? l.vrp : null;
      return {
        cartLineId: l.cartLineId, skuId: l.skuId, storeId, qty: l.qty, unitPrice: l.unitPrice, lineGross, platformDiscount: a.platformDiscount, sellerDiscount: a.sellerDiscount, payable: a.payable, vat: a.vat, vatBp: l.vatBp,
        taxCategory: l.taxCategory, vrp: l.vrp, claimType: l.claimType,
        verifiedSaving: verifiedRef === null ? zero(cur) : fraction(sub(verifiedRef, l.unitPrice), BigInt(l.qty), 1n),
      };
    });
    const ship = input.shipping.get(storeId);
    if (ship === undefined) throw new Error(`quote: no shipping quote for store ${storeId}`);
    const itemsSubtotal = sum(cur, lines.map((x) => x.lineGross));
    const shipVat = vatInside(ship.fee, input.shippingTaxBp);
    const shipDisc = disc?.shipping.get(storeId) ?? { platform: zero(cur), seller: zero(cur) };
    const platformDiscount = add(sum(cur, lines.map((x) => x.platformDiscount)), shipDisc.platform);
    const sellerDiscount = add(sum(cur, lines.map((x) => x.sellerDiscount)), shipDisc.seller);
    if (compare(add(platformDiscount, sellerDiscount), add(itemsSubtotal, ship.fee)) > 0) throw new Error(`quote: discounts exceed the store total for ${storeId}`);
    return {
      storeId, lines, itemsSubtotal,
      shipping: { gross: ship.fee, vat: shipVat, quoteRef: ship.quoteRef, etaDaysMin: ship.etaDaysMin, etaDaysMax: ship.etaDaysMax },
      shippingDiscount: shipDisc, platformDiscount, sellerDiscount,
      vat: add(sum(cur, lines.map((x) => x.vat)), shipVat),
      total: sub(add(itemsSubtotal, ship.fee), add(platformDiscount, sellerDiscount)),
    };
  });

  const itemsSubtotal = sum(cur, stores.map((s) => s.itemsSubtotal));
  const shipping = sum(cur, stores.map((s) => s.shipping.gross));
  const discount = sum(cur, stores.flatMap((s) => [s.platformDiscount, s.sellerDiscount]));
  const total = sub(add(itemsSubtotal, shipping), discount);
  const storeCredit = min(min(input.creditRequested, input.creditAvailable), total);
  const methods = byKey([...input.methods.keys()], (m) => m);
  const fees: Fee[] = [
    ...stores.map((s): Fee => ({ code: "delivery", storeId: s.storeId, method: null, amount: s.shipping.gross })),
    ...methods.map((m): Fee => ({ code: "payment_method", storeId: null, method: m, amount: input.methods.get(m)?.fee ?? zero(cur) })),
  ];
  const payableByMethod = new Map<PaymentMethod, Money>(methods.map((m) => [m, sub(add(total, input.methods.get(m)?.fee ?? zero(cur)), storeCredit)]));
  const body = {
    stores, fees, itemsSubtotal, shipping, discount, promotions: [...(disc?.promotions ?? [])].sort((a, b) => (a.promotionId < b.promotionId ? -1 : 1)), discountLabels: [...(disc?.labels ?? [])].sort((a, b) => (a.promotionId < b.promotionId ? -1 : 1)), vat: sum(cur, stores.map((s) => s.vat)), total, storeCredit, payableByMethod,
    verifiedSavings: sum(cur, stores.flatMap((s) => s.lines.map((l) => l.verifiedSaving))),
  };
  return { ...body, hash: sha256Hex(canonicalQuote(body)) };
}
