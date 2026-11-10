import type { Queryable } from "@outlet/db";
import type { SnapshotTileData, SnapshotTileKey } from "./schemas.js";

/**
 * One read per snapshot tile. Every query is pinned to the market in SQL as well as by the `reporting.rollup` policies, uses an injected `now`
 * (never the database clock, so tests and replays are deterministic) and returns counts, timestamps and sums only: no ids of people or orders.
 */
export interface SnapshotCtx {
  readonly tx: Queryable;
  readonly marketId: string;
  /** Market currency: money tiles sum only rows in this currency (EG is single-currency; ADR-0006 keeps the field). */
  readonly currency: string;
  readonly now: Date;
}

type Reader<K extends SnapshotTileKey> = (c: SnapshotCtx) => Promise<SnapshotTileData<K>>;

const iso = (v: Date | string | null): string | null => (v === null ? null : (v instanceof Date ? v : new Date(v)).toISOString());
const money = (amount: string | null, currency: string): { amount_minor: string; currency: string } => ({ amount_minor: amount ?? "0", currency });
const one = async <R extends object>(c: SnapshotCtx, sql: string, params: readonly unknown[]): Promise<R> => {
  const r = (await c.tx.query<R>(sql, params)).rows[0];
  if (r === undefined) throw new Error("snapshot aggregate returned no row");
  return r;
};
const nowIso = (c: SnapshotCtx): string => c.now.toISOString();

export const SNAPSHOT_READERS: { readonly [K in SnapshotTileKey]: Reader<K> } = {
  async orders_by_step(c) {
    const r = await one<{ a: number; b: number; p: number; t: number; f: number }>(
      c,
      `SELECT count(*) FILTER (WHERE status IN ('PAID', 'CONFIRMED_COD'))::int AS a, count(*) FILTER (WHERE status = 'ACCEPTED')::int AS b,
              count(*) FILTER (WHERE status = 'PACKED')::int AS p, count(*) FILTER (WHERE status IN ('SHIPPED', 'OUT_FOR_DELIVERY'))::int AS t,
              count(*) FILTER (WHERE status = 'DELIVERY_FAILED')::int AS f
         FROM seller_orders WHERE market_id = $1 AND status IN ('PAID', 'CONFIRMED_COD', 'ACCEPTED', 'PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERY_FAILED')`,
      [c.marketId],
    );
    return { paid_awaiting_accept: r.a, accepted: r.b, packed: r.p, in_transit: r.t, delivery_failed: r.f };
  },

  async seller_sla_breaches(c) {
    // dispatch_by is not written by any code yet: late_dispatch is null (unknown), never a fabricated 0, until a row has it. oldest_at likewise ignores it.
    const r = await one<{ la: number; ld: number | null; oldest: Date | string | null }>(
      c,
      `SELECT count(*) FILTER (WHERE status IN ('PAID', 'CONFIRMED_COD') AND accept_by < $2::timestamptz)::int AS la,
              CASE WHEN count(dispatch_by) = 0 THEN NULL ELSE count(*) FILTER (WHERE status = 'ACCEPTED' AND dispatch_by < $2::timestamptz)::int END AS ld,
              min(CASE WHEN status IN ('PAID', 'CONFIRMED_COD') AND accept_by < $2::timestamptz THEN accept_by
                       WHEN status = 'ACCEPTED' AND dispatch_by < $2::timestamptz THEN dispatch_by END) AS oldest
         FROM seller_orders WHERE market_id = $1 AND status IN ('PAID', 'CONFIRMED_COD', 'ACCEPTED')`,
      [c.marketId, nowIso(c)],
    );
    return { late_accept: r.la, late_dispatch: r.ld, oldest_at: iso(r.oldest) };
  },

  async cod_awaiting_confirmation(c) {
    const r = await one<{ n: number; oldest: Date | string | null }>(c, "SELECT count(*)::int AS n, min(placed_at) AS oldest FROM order_groups WHERE market_id = $1 AND status = 'AWAITING_COD_CONFIRMATION'", [c.marketId]);
    return { count: r.n, oldest_at: iso(r.oldest) };
  },

  async returns_pipeline(c) {
    const r = await one<{ q: number; t: number; w: number; o: number }>(
      c,
      `SELECT count(*) FILTER (WHERE status = 'REQUESTED')::int AS q, count(*) FILTER (WHERE status = 'IN_TRANSIT')::int AS t,
              count(*) FILTER (WHERE status = 'RECEIVED')::int AS w, count(*) FILTER (WHERE status = 'RECEIVED' AND inspection_due_at < $2::timestamptz)::int AS o
         FROM return_requests WHERE market_id = $1 AND status IN ('REQUESTED', 'IN_TRANSIT', 'RECEIVED')`,
      [c.marketId, nowIso(c)],
    );
    return { requested: r.q, in_transit: r.t, awaiting_inspection: r.w, inspection_overdue: r.o };
  },

  async disputes_open(c) {
    const r = await one<{ n: number; late: number; oldest: Date | string | null }>(
      c,
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE sla_due_at < $2::timestamptz)::int AS late, min(created_at) AS oldest
         FROM disputes WHERE market_id = $1 AND status IN ('OPEN', 'UNDER_REVIEW')`,
      [c.marketId, nowIso(c)],
    );
    return { open: r.n, past_sla: r.late, oldest_at: iso(r.oldest) };
  },

  async refunds_waiting(c) {
    const r = await one<{ n: number; amt: string | null; mr: number; f: number; oldest: Date | string | null }>(
      c,
      `SELECT count(*)::int AS n, sum(amount_minor)::text AS amt, count(*) FILTER (WHERE status = 'MANUAL_REVIEW')::int AS mr,
              count(*) FILTER (WHERE status = 'FAILED')::int AS f, min(created_at) AS oldest
         FROM refunds WHERE market_id = $1 AND currency = $2 AND status IN ('REQUESTED', 'MANUAL_REVIEW', 'FAILED')`,
      [c.marketId, c.currency],
    );
    return { count: r.n, amount: money(r.amt, c.currency), manual_review: r.mr, failed: r.f, oldest_at: iso(r.oldest) };
  },

  async refunds_overdue(c) {
    const r = await one<{ n: number; amt: string | null; oldest: Date | string | null }>(
      c,
      `SELECT count(*)::int AS n, sum(amount_minor)::text AS amt, min(due_at) AS oldest
         FROM refunds WHERE market_id = $1 AND currency = $2 AND status <> 'COMPLETED' AND due_at < $3::timestamptz`,
      [c.marketId, c.currency, nowIso(c)],
    );
    return { count: r.n, amount: money(r.amt, c.currency), oldest_due_at: iso(r.oldest) };
  },

  async payouts(c) {
    const r = await one<{ dc: number; dn: string | null; hc: number; hn: string | null; f: number }>(
      c,
      `SELECT count(*) FILTER (WHERE status = 'SCHEDULED')::int AS dc, sum(net_minor) FILTER (WHERE status = 'SCHEDULED' AND currency = $2)::text AS dn,
              count(*) FILTER (WHERE status = 'ON_HOLD')::int AS hc, sum(net_minor) FILTER (WHERE status = 'ON_HOLD' AND currency = $2)::text AS hn,
              count(*) FILTER (WHERE status = 'FAILED')::int AS f
         FROM payouts WHERE market_id = $1 AND status IN ('SCHEDULED', 'ON_HOLD', 'FAILED')`,
      [c.marketId, c.currency],
    );
    const h = await one<{ n: number }>(c, "SELECT count(*)::int AS n FROM payout_holds WHERE market_id = $1 AND released_at IS NULL", [c.marketId]);
    return { due_count: r.dc, due_net: money(r.dn, c.currency), on_hold_count: r.hc, on_hold_net: money(r.hn, c.currency), failed: r.f, open_holds: h.n };
  },

  async recon_unmatched(c) {
    const r = await one<{ o: number; e: number; aged: number; oldest: Date | string | null }>(
      c,
      `SELECT count(*) FILTER (WHERE status = 'OPEN')::int AS o, count(*) FILTER (WHERE status = 'ESCALATED')::int AS e,
              count(*) FILTER (WHERE first_seen_at < ($2::timestamptz - interval '3 days'))::int AS aged, min(first_seen_at) AS oldest
         FROM reconciliation_exceptions WHERE market_id = $1 AND status IN ('OPEN', 'ESCALATED')`,
      [c.marketId, nowIso(c)],
    );
    return { open: r.o, escalated: r.e, aged_over_3d: r.aged, oldest_at: iso(r.oldest) };
  },

  async stores_moderation(c) {
    const r = await one<{ p: number; s: number }>(
      c,
      "SELECT count(*) FILTER (WHERE status = 'PENDING_REVIEW')::int AS p, count(*) FILTER (WHERE status = 'SUSPENDED')::int AS s FROM stores WHERE market_id = $1 AND status IN ('PENDING_REVIEW', 'SUSPENDED')",
      [c.marketId],
    );
    return { pending_review: r.p, suspended: r.s };
  },

  async price_enforcement(c) {
    const r = await one<{ a: number; p: number; s: number }>(
      c,
      `SELECT count(*) FILTER (WHERE status = 'active')::int AS a, count(*) FILTER (WHERE status = 'pending_review')::int AS p,
              count(*) FILTER (WHERE status = 'pending_review' AND action = 'suspend_store')::int AS s
         FROM enforcement_actions WHERE market_id = $1 AND status IN ('active', 'pending_review')`,
      [c.marketId],
    );
    return { active: r.a, pending_review: r.p, suspensions_awaiting_review: r.s };
  },

  async verified_discount_share(c) {
    const r = await one<{ live: number; verified: number }>(
      c,
      `SELECT count(*)::int AS live,
              count(*) FILTER (WHERE EXISTS (SELECT 1 FROM price_claims pc WHERE pc.sku_id = s.id AND pc.market_id = s.market_id AND pc.status = 'active'
                                              AND pc.display_allowed AND pc.claim_type = 'verified_discount'))::int AS verified
         FROM skus s JOIN products p ON p.id = s.product_id
        WHERE s.market_id = $1 AND s.status = 'active' AND p.status = 'PUBLISHED' AND p.deleted_at IS NULL`,
      [c.marketId],
    );
    return { verified: r.verified, live_skus: r.live };
  },

  async listings_by_status(c) {
    const r = await one<{ p: number; i: number; z: number; b: number }>(
      c,
      `SELECT count(*) FILTER (WHERE status = 'PUBLISHED')::int AS p, count(*) FILTER (WHERE status = 'IN_REVIEW')::int AS i,
              count(*) FILTER (WHERE status = 'PAUSED')::int AS z, count(*) FILTER (WHERE status = 'BLOCKED')::int AS b
         FROM products WHERE market_id = $1 AND deleted_at IS NULL AND status IN ('PUBLISHED', 'IN_REVIEW', 'PAUSED', 'BLOCKED')`,
      [c.marketId],
    );
    return { published: r.p, in_review: r.i, paused: r.z, blocked: r.b };
  },

  async breaches_open(c) {
    // breach_records has no RLS (0028): the worker has no grant on it; breach_open_summary() (0035, SECURITY DEFINER) pins the market and the job.
    const r = await one<{ n: number; pdpc: Date | string | null; subj: Date | string | null }>(
      c,
      "SELECT open AS n, next_pdpc AS pdpc, next_subjects AS subj FROM breach_open_summary()",
      [],
    );
    return { open: r.n, next_pdpc_deadline_at: iso(r.pdpc), next_subjects_deadline_at: iso(r.subj) };
  },

  async dsar_queue(c) {
    const r = await one<{ n: number; soon: number; late: number }>(
      c,
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE due_at >= $2::timestamptz AND due_at < ($2::timestamptz + interval '7 days'))::int AS soon,
              count(*) FILTER (WHERE due_at < $2::timestamptz)::int AS late
         FROM privacy_requests WHERE market_id = $1 AND status IN ('RECEIVED', 'VERIFIED', 'BLOCKED', 'COOLING', 'IN_PROGRESS')`,
      [c.marketId, nowIso(c)],
    );
    return { open: r.n, due_7d: r.soon, overdue: r.late };
  },
};
