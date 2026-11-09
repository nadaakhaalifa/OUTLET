import { z } from "zod";

/**
 * Admin dashboard contract (docs/api/admin-dashboard-contract.md section 3), re-parsed here at the BFF boundary.
 * Pure shaping only: no fetching, no formatting, no invented numbers.
 */
export const RANGES = ["7d", "30d", "90d"] as const;
export type Range = (typeof RANGES)[number];
export const DEFAULT_RANGE: Range = "30d";

/** Anything but a known range falls back to the default (the API would answer 400). */
export const parseRange = (raw: string | undefined): Range => (RANGES as readonly string[]).includes(raw ?? "") ? (raw as Range) : DEFAULT_RANGE;

const Count = z.int().nonnegative();
const Iso = z.iso.datetime({ offset: true });
const Day = z.iso.date();
export const Money = z.object({ amount_minor: z.string().regex(/^-?\d{1,19}$/), currency: z.string().regex(/^[A-Z]{3}$/) }).strict();
export type MoneyWire = z.infer<typeof Money>;
const Point = z.object({ day: Day, value: Count }).strict();
const MoneyPoint = z.object({ day: Day, value: Money }).strict();

const tile = <K extends string, D extends z.ZodType>(key: K, data: D) =>
  z.discriminatedUnion("status", [
    z.object({ key: z.literal(key), status: z.literal("ok"), as_of: Iso, data }).strict(),
    z.object({ key: z.literal(key), status: z.literal("forbidden") }).strict(),
    z.object({ key: z.literal(key), status: z.literal("unavailable"), reason: z.enum(["not_connected", "read_failed", "stale"]) }).strict(),
  ]);

const Oldest = { oldest_at: Iso.nullable() };

export const DashboardResponse = z.object({
  market_id: z.string().min(2),
  range: z.enum(RANGES),
  timezone: z.string(),
  today: Day,
  generated_at: Iso,
  sections: z.object({
    today: z.object({
      orders_today: tile("orders_today", z.object({ count: Count, series_14d: z.array(Point).max(14) }).strict()),
      gmv_today: tile("gmv_today", z.object({ gmv: Money, refunded: Money, gmv_7d: Money }).strict()),
    }).strict(),
    sales: z.object({
      sales_series: tile("sales_series", z.object({ orders: z.array(Point).nullable(), gmv: z.array(MoneyPoint).nullable(), total_orders: Count.nullable(), total_gmv: Money.nullable() }).strict()),
      orders_by_step: tile("orders_by_step", z.object({ paid_awaiting_accept: Count, accepted: Count, packed: Count, in_transit: Count, delivery_failed: Count }).strict()),
      top_stores: tile("top_stores", z.object({
        items: z.array(z.object({ store_id: z.uuid(), name_ar: z.string(), name_en: z.string().nullable(), orders: Count, gmv: Money }).strict()).max(5),
        other: z.object({ stores: Count, orders: Count, gmv: Money }).strict(),
      }).strict()),
      verified_discount_share: tile("verified_discount_share", z.object({ verified: Count, live_skus: Count }).strict()),
    }).strict(),
    orders: z.object({
      seller_sla_breaches: tile("seller_sla_breaches", z.object({ late_accept: Count, late_dispatch: Count.nullable(), ...Oldest }).strict()),
      cod_awaiting_confirmation: tile("cod_awaiting_confirmation", z.object({ count: Count, ...Oldest }).strict()),
      returns_pipeline: tile("returns_pipeline", z.object({ requested: Count, in_transit: Count, awaiting_inspection: Count, inspection_overdue: Count }).strict()),
      disputes_open: tile("disputes_open", z.object({ open: Count, past_sla: Count, ...Oldest }).strict()),
    }).strict(),
    money: z.object({
      refunds_waiting: tile("refunds_waiting", z.object({ count: Count, amount: Money, manual_review: Count, failed: Count, ...Oldest }).strict()),
      refunds_overdue: tile("refunds_overdue", z.object({ count: Count, amount: Money, oldest_due_at: Iso.nullable() }).strict()),
      payouts: tile("payouts", z.object({ due_count: Count, due_net: Money, on_hold_count: Count, on_hold_net: Money, failed: Count, open_holds: Count }).strict()),
      recon_unmatched: tile("recon_unmatched", z.object({ open: Count, escalated: Count, aged_over_3d: Count, ...Oldest }).strict()),
      cod_unremitted: tile("cod_unremitted", z.object({ parcels: Count, amount: Money }).strict()),
      ledger_integrity: tile("ledger_integrity", z.object({ balanced: z.boolean(), chain_ok: z.boolean(), checked_at: Iso }).strict()),
    }).strict(),
    trust: z.object({
      kyc_queue: tile("kyc_queue", z.object({ submitted: Count, needs_info: Count, ...Oldest }).strict()),
      stores_moderation: tile("stores_moderation", z.object({ pending_review: Count, suspended: Count }).strict()),
      price_enforcement: tile("price_enforcement", z.object({ active: Count, pending_review: Count, suspensions_awaiting_review: Count }).strict()),
      listings_by_status: tile("listings_by_status", z.object({ published: Count, in_review: Count, paused: Count, blocked: Count }).strict()),
    }).strict(),
    privacy: z.object({
      breaches_open: tile("breaches_open", z.object({ open: Count, next_pdpc_deadline_at: Iso.nullable(), next_subjects_deadline_at: Iso.nullable() }).strict()),
      dsar_queue: tile("dsar_queue", z.object({ open: Count, due_7d: Count, overdue: Count }).strict()),
    }).strict(),
    platform: z.object({
      attention_open: tile("attention_open", z.object({ open: Count, acked: Count, by_kind: z.record(z.string().regex(/^[a-z_.]{1,60}$/), Count), ...Oldest }).strict()),
      approvals_pending: tile("approvals_pending", z.object({ for_me: Count, soonest_expires_at: Iso.nullable() }).strict()),
      elevations_active: tile("elevations_active", z.object({ active: Count, pending: Count, scope: z.enum(["own", "market"]) }).strict()),
      kill_switches: tile("kill_switches", z.object({ engaged_money: z.array(z.string()), engaged_ui: z.array(z.string()) }).strict()),
    }).strict(),
  }).strict(),
}).strict();
export type DashboardResponse = z.infer<typeof DashboardResponse>;

type Sections = DashboardResponse["sections"];
export type Tiles = Sections["today"] & Sections["sales"] & Sections["orders"] & Sections["money"] & Sections["trust"] & Sections["privacy"] & Sections["platform"];
export type TileKey = keyof Tiles;

export const flattenTiles = (r: DashboardResponse): Tiles => ({ ...r.sections.today, ...r.sections.sales, ...r.sections.orders, ...r.sections.money, ...r.sections.trust, ...r.sections.privacy, ...r.sections.platform });

/** Refresh windows after which a tile is called stale (2x its refresh: sales rollup 5 min, snapshots and live reads 1 min). */
const STALE_AFTER_MS: Readonly<Partial<Record<TileKey, number>>> = { orders_today: 10 * 60_000, gmv_today: 10 * 60_000, sales_series: 10 * 60_000, top_stores: 10 * 60_000 };
const STALE_DEFAULT_MS = 2 * 60_000;

export type TileState<D> =
  | { readonly kind: "hidden" }
  | { readonly kind: "unavailable"; readonly reason: "not_connected" | "read_failed" | "stale"; readonly staleSince?: undefined }
  | { readonly kind: "ok"; readonly data: D; readonly asOf: string; readonly staleSince: string | null };

type AnyTile = { readonly key: string; readonly status: "ok"; readonly as_of: string; readonly data: unknown } | { readonly key: string; readonly status: "forbidden" } | { readonly key: string; readonly status: "unavailable"; readonly reason: "not_connected" | "read_failed" | "stale" };

/** forbidden -> hidden (never rendered); unavailable keeps its reason; ok past its window keeps the numbers but says since when. */
export function tileState<K extends TileKey>(key: K, tile: Tiles[K], now: Date): TileState<Extract<Tiles[K], { status: "ok" }>["data"]> {
  const t = tile as unknown as AnyTile;
  if (t.status === "forbidden") return { kind: "hidden" };
  if (t.status === "unavailable") return { kind: "unavailable", reason: t.reason };
  const age = now.getTime() - Date.parse(t.as_of);
  const stale = Number.isFinite(age) && age > (STALE_AFTER_MS[key] ?? STALE_DEFAULT_MS);
  return { kind: "ok", data: t.data as Extract<Tiles[K], { status: "ok" }>["data"], asOf: t.as_of, staleSince: stale ? t.as_of : null };
}

/** Parse failure fallback (contract section 4): every tile "Could not load", never partial guessing. */
export function allUnreadable(range: Range, today: string, now: Date): DashboardResponse {
  const bad = <K extends string>(key: K) => ({ key, status: "unavailable" as const, reason: "read_failed" as const });
  return {
    market_id: "xx", range, timezone: "Africa/Cairo", today, generated_at: now.toISOString(),
    sections: {
      today: { orders_today: bad("orders_today"), gmv_today: bad("gmv_today") },
      sales: { sales_series: bad("sales_series"), orders_by_step: bad("orders_by_step"), top_stores: bad("top_stores"), verified_discount_share: bad("verified_discount_share") },
      orders: { seller_sla_breaches: bad("seller_sla_breaches"), cod_awaiting_confirmation: bad("cod_awaiting_confirmation"), returns_pipeline: bad("returns_pipeline"), disputes_open: bad("disputes_open") },
      money: { refunds_waiting: bad("refunds_waiting"), refunds_overdue: bad("refunds_overdue"), payouts: bad("payouts"), recon_unmatched: bad("recon_unmatched"), cod_unremitted: bad("cod_unremitted"), ledger_integrity: bad("ledger_integrity") },
      trust: { kyc_queue: bad("kyc_queue"), stores_moderation: bad("stores_moderation"), price_enforcement: bad("price_enforcement"), listings_by_status: bad("listings_by_status") },
      privacy: { breaches_open: bad("breaches_open"), dsar_queue: bad("dsar_queue") },
      platform: { attention_open: bad("attention_open"), approvals_pending: bad("approvals_pending"), elevations_active: bad("elevations_active"), kill_switches: bad("kill_switches") },
    },
  };
}

/** Today cards: URL slug, tile and the page behind the "Open the full list" link (a console section path, or null when none exists yet). */
export interface CardDef {
  readonly slug: string;
  readonly tile: TileKey;
  readonly fullList: string | null;
}
export const CARDS: readonly CardDef[] = [
  { slug: "orders-today", tile: "orders_today", fullList: null },
  { slug: "gmv-today", tile: "gmv_today", fullList: null },
  { slug: "attention", tile: "attention_open", fullList: "/attention" },
  { slug: "approvals", tile: "approvals_pending", fullList: "/access" },
  { slug: "kyc-queue", tile: "kyc_queue", fullList: "/kyc" },
  { slug: "refunds-waiting", tile: "refunds_waiting", fullList: null },
  { slug: "cod-awaiting-confirmation", tile: "cod_awaiting_confirmation", fullList: null },
  { slug: "seller-sla-breaches", tile: "seller_sla_breaches", fullList: null },
];
export const cardBySlug = (slug: string): CardDef | undefined => CARDS.find((c) => c.slug === slug);
export const MAX_POP_ROWS = 50;

/** Integer ratio in permille (floor), or null with no denominator. No float maths on counts. */
export const permille = (part: number, whole: number): number | null => (whole <= 0 ? null : Number((BigInt(part) * 1000n) / BigInt(whole)));

export interface SeriesPoint { readonly day: string; readonly value: bigint }
export interface Bucket { readonly label: string; readonly from: string; readonly to: string; readonly value: bigint }

/** One column per day up to 14 days, weekly above, weeks anchored at the newest day (so the newest bucket is always a full week). */
export function bucketSeries(points: readonly SeriesPoint[]): Bucket[] {
  if (points.length <= 14) return points.map((p) => ({ label: p.day, from: p.day, to: p.day, value: p.value }));
  const out: Bucket[] = [];
  for (let end = points.length; end > 0; end -= 7) {
    const slice = points.slice(Math.max(0, end - 7), end);
    const first = slice[0];
    const last = slice[slice.length - 1];
    if (first === undefined || last === undefined) continue;
    out.unshift({ label: first.day, from: first.day, to: last.day, value: slice.reduce((s, p) => s + p.value, 0n) });
  }
  return out;
}
