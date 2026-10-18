import { z } from "zod";

/** Pure Odoo mapping rules. No IO, no clock. Money is integer piastres; no float arithmetic on money. */

export const MAX_PRICE_PIASTRES = 10_000_000_000n;
export const MAX_STOCK_QTY = 10_000_000;
export const PAGE_SIZE = 200;
export const MAX_PAGES = 5;
export const MAX_PRODUCTS_PER_POLL = PAGE_SIZE * MAX_PAGES;

/**
 * Odoo returns monetary fields as JSON numbers (or strings). Accepts at most 2 decimals and rejects
 * anything else instead of rounding: a price we cannot represent exactly is never shown.
 */
export function toPiastres(v: unknown): bigint | null {
  let s: string;
  if (typeof v === "number") {
    if (!Number.isFinite(v) || v <= 0 || v > 100_000_000) return null;
    s = v.toFixed(2);
    if (Math.abs(Number(s) - v) > 1e-9) return null;
  } else if (typeof v === "string" && /^\d{1,9}(\.\d{1,2})?$/.test(v.trim())) {
    const [i = "0", f = ""] = v.trim().split(".");
    s = `${i}.${f.padEnd(2, "0")}`;
  } else return null;
  const n = BigInt(s.replace(".", ""));
  return n > 0n && n <= MAX_PRICE_PIASTRES ? n : null;
}

/** Whole sellable units: on hand minus Odoo's own reservations, floored, never negative. */
export function availableUnits(quantity: number, reserved: number): number {
  if (!Number.isFinite(quantity) || !Number.isFinite(reserved)) return 0;
  return Math.min(MAX_STOCK_QTY, Math.max(0, Math.floor(quantity - reserved + 1e-9)));
}

/** Odoo `write_date` ("YYYY-MM-DD HH:MM:SS", UTC) to epoch seconds; null when unparseable. */
export function writeDateSeconds(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(v);
  if (m === null) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

const Id = z.number().int().positive();
/** Odoo many2one: `[id, "name"]` or `false`. */
const Many2One = z.union([z.tuple([Id, z.string()]), z.literal(false)]).transform((v) => (v === false ? null : v[0]));
const OptString = z.union([z.string(), z.literal(false)]).transform((v) => (v === false ? null : v));
const OptDate = z.union([z.string(), z.literal(false)]).transform((v) => (v === false ? null : v));

export const OdooProduct = z.object({
  id: Id,
  default_code: OptString,
  list_price: z.number(),
  write_date: OptDate,
  product_tmpl_id: Many2One,
});
export type OdooProduct = z.infer<typeof OdooProduct>;

export const OdooQuant = z.object({
  product_id: Many2One,
  quantity: z.number(),
  reserved_quantity: z.number().default(0),
  write_date: OptDate,
});
export type OdooQuant = z.infer<typeof OdooQuant>;

export const OdooPricelistItem = z.object({
  product_id: Many2One,
  product_tmpl_id: Many2One,
  fixed_price: z.number(),
  min_quantity: z.number().default(0),
  date_start: OptDate,
  date_end: OptDate,
  write_date: OptDate,
});
export type OdooPricelistItem = z.infer<typeof OdooPricelistItem>;

export const OdooPricelist = z.object({ id: Id, currency_id: z.union([z.tuple([Id, z.string()]), z.literal(false)]) });

export interface StockObservation {
  readonly available: number;
  /** Monotonic per product: newest write_date (epoch seconds) among its quants and the product row. */
  readonly sourceVersion: number;
}

export function aggregateStock(products: readonly OdooProduct[], quants: readonly OdooQuant[]): ReadonlyMap<number, StockObservation> {
  const out = new Map<number, { qty: number; reserved: number; version: number }>();
  for (const p of products) out.set(p.id, { qty: 0, reserved: 0, version: writeDateSeconds(p.write_date) ?? 0 });
  for (const q of quants) {
    if (q.product_id === null) continue;
    const a = out.get(q.product_id);
    if (a === undefined) continue;
    a.qty += q.quantity;
    a.reserved += q.reserved_quantity;
    a.version = Math.max(a.version, writeDateSeconds(q.write_date) ?? 0);
  }
  const res = new Map<number, StockObservation>();
  for (const [id, a] of out) res.set(id, { available: availableUnits(a.qty, a.reserved), sourceVersion: a.version });
  return res;
}

export interface PriceObservation {
  readonly priceAmount: bigint;
  /** Newest write_date (epoch seconds) of the rows that decided the price. */
  readonly version: number;
  readonly from: "pricelist_variant" | "pricelist_template" | "list_price";
}

const inWindow = (it: OdooPricelistItem, nowMs: number): boolean => {
  const s = it.date_start === null ? null : writeDateSeconds(it.date_start);
  const e = it.date_end === null ? null : writeDateSeconds(it.date_end);
  if (it.date_start !== null && s === null) return false;
  if (it.date_end !== null && e === null) return false;
  const now = Math.floor(nowMs / 1000);
  return (s === null || s <= now) && (e === null || now <= e);
};

/**
 * The sale price only. Odoo has no verified "was" price here, and none is ever derived from list_price
 * or compare-at fields: the price ledger and the VRP engine decide whether any claim is shown.
 * Fixed-price pricelist items for quantity 1 (variant first, then template), else list_price.
 */
export function resolvePrice(p: OdooProduct, items: readonly OdooPricelistItem[], nowMs: number): PriceObservation | null {
  const usable = items.filter((i) => i.min_quantity <= 1 && inWindow(i, nowMs));
  const variant = usable.filter((i) => i.product_id === p.id);
  const tmpl = p.product_tmpl_id === null ? [] : usable.filter((i) => i.product_id === null && i.product_tmpl_id === p.product_tmpl_id);
  const pick = (list: readonly OdooPricelistItem[], from: PriceObservation["from"]): PriceObservation | null => {
    // Several matching items: the lowest price wins (strictest, the safer reference).
    let best: PriceObservation | null = null;
    for (const i of list) {
      const amt = toPiastres(i.fixed_price);
      if (amt === null) continue;
      if (best === null || amt < best.priceAmount) best = { priceAmount: amt, version: writeDateSeconds(i.write_date) ?? 0, from };
    }
    return best;
  };
  const v = pick(variant, "pricelist_variant");
  if (v !== null) return v;
  const t = pick(tmpl, "pricelist_template");
  if (t !== null) return t;
  const lp = toPiastres(p.list_price);
  return lp === null ? null : { priceAmount: lp, version: writeDateSeconds(p.write_date) ?? 0, from: "list_price" };
}

// ---- JSON-RPC envelope ----

export const RpcEnvelope = z.object({
  jsonrpc: z.literal("2.0").optional(),
  id: z.union([z.number(), z.string(), z.null()]).optional(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number().optional(), message: z.string().optional() }).passthrough().optional(),
});

export function execute(i: { database: string; uid: number; model: string; method: string; args: unknown[]; kwargs: Record<string, unknown>; apiKeyPlaceholder: string; rpcId: number }): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    method: "call",
    params: { service: "object", method: "execute_kw", args: [i.database, i.uid, i.apiKeyPlaceholder, i.model, i.method, i.args, i.kwargs] },
    id: i.rpcId,
  });
}

export function authenticate(i: { database: string; loginPlaceholder: string; apiKeyPlaceholder: string; rpcId: number }): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    method: "call",
    params: { service: "common", method: "authenticate", args: [i.database, i.loginPlaceholder, i.apiKeyPlaceholder, {}] },
    id: i.rpcId,
  });
}
