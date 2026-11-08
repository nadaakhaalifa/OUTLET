import { equals } from "@outlet/money";
import type { PaymentMethod } from "../ports.js";
import type { PriceDelta, Quote, QuoteLine } from "./types.js";

/**
 * Price-lock option B (README section 5): compares the quote the shopper saw (echo) with a fresh one. An empty list means the
 * amount charged equals the amount shown. Money-visible changes only: ETA or shipping quote reference changes do not block.
 */
export function compareLock(echo: Quote, fresh: Quote, method: PaymentMethod): PriceDelta[] {
  const lines = (q: Quote): Map<string, QuoteLine> => new Map(q.stores.flatMap((s) => s.lines).map((l) => [l.skuId, l]));
  const a = lines(echo);
  const b = lines(fresh);
  const out: PriceDelta[] = [];
  for (const [skuId, l] of a) {
    const f = b.get(skuId);
    if (f === undefined) out.push({ kind: "line_unavailable", skuId });
    else if (!equals(l.unitPrice, f.unitPrice)) out.push({ kind: "line_price", skuId, before: l.unitPrice, after: f.unitPrice });
  }
  for (const skuId of b.keys()) if (!a.has(skuId)) out.push({ kind: "line_added", skuId });
  const ship = (q: Quote): Map<string, QuoteLine["unitPrice"]> => new Map(q.stores.map((s) => [s.storeId, s.shipping.gross]));
  const sa = ship(echo);
  const sb = ship(fresh);
  for (const [storeId, before] of sa) {
    const after = sb.get(storeId);
    if (after !== undefined && !equals(before, after)) out.push({ kind: "shipping", storeId, before, after });
  }
  const fee = (q: Quote) => q.fees.find((x) => x.code === "payment_method" && x.method === method)?.amount;
  const fa = fee(echo);
  const fb = fee(fresh);
  if (fa !== undefined && fb !== undefined && !equals(fa, fb)) out.push({ kind: "method_fee", method, before: fa, after: fb });
  if (!equals(echo.storeCredit, fresh.storeCredit)) out.push({ kind: "store_credit", before: echo.storeCredit, after: fresh.storeCredit });
  if (!equals(echo.total, fresh.total)) out.push({ kind: "total", before: echo.total, after: fresh.total });
  return out;
}
