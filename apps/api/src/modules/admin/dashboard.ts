import { KILL_SWITCHES } from "@outlet/flags";
import type { FlagRecord } from "@outlet/flags";
import type { Logger } from "@outlet/logger";
import { authorize } from "@outlet/policy";
import type { Principal } from "@outlet/policy";
import { SNAPSHOT_TILE_DATA, SNAPSHOT_TILE_KEYS, SNAPSHOT_VERSION, addDays, localDay } from "@outlet/reporting";
import type { SnapshotTileKey } from "@outlet/reporting";
import type { DashboardQuery, DashboardResponse } from "./dto-dashboard.js";
import type { AdminServices } from "./services.js";
import type { SalesDailyRow } from "./ports.js";

// ---------------------------------------------------------------- ports

export type { SnapshotRow, SalesDailyRow, SalesDaily, StoreTop, DashboardReaderPort } from "./ports.js";

export interface DashboardDeps {
  readonly now: () => Date;
  readonly logger: Logger;
  /** Market timezone and currency (markets-config). */
  readonly market: (marketId: string) => { readonly timezone: string; readonly currency: string };
}

// ---------------------------------------------------------------- tile registry

/** Policy action that gates each snapshot tile. A denied tile is never read. */
export const SNAPSHOT_TILE_ACTION: Readonly<Record<SnapshotTileKey, string>> = {
  orders_by_step: "order.read", seller_sla_breaches: "order.read", cod_awaiting_confirmation: "order.read",
  returns_pipeline: "return.read", disputes_open: "dispute.decide", refunds_waiting: "refund.approve", refunds_overdue: "refund.approve",
  payouts: "payout.read", recon_unmatched: "finance.summary.read", stores_moderation: "store.read", price_enforcement: "price_integrity.read",
  verified_discount_share: "price_integrity.read", listings_by_status: "listing.read", breaches_open: "breach.manage", dsar_queue: "breach.manage",
};
const LIVE_ACTION = { kyc_queue: "seller_kyc.review", approvals_pending: "approval.read", elevations_active: "elevation.request", attention_open: "attention.read", kill_switches: "kill_switch.read" } as const;
const FINANCE = "finance.summary.read";
const ORDERS = "order.read";

/** A snapshot older than this is not shown (money numbers fail closed, contract section 3). */
export const STALE_AFTER_MS = 15 * 60_000;
const RANGE_DAYS = { "7d": 7, "30d": 30, "90d": 90 } as const;
const TOP_STORES = 5;

type Tile<D> = { key: string; status: "ok"; as_of: string; data: D } | { key: string; status: "forbidden" } | { key: string; status: "unavailable"; reason: "not_connected" | "read_failed" | "stale" };
const ok = <D>(key: string, asOf: string, data: D): Tile<D> => ({ key, status: "ok", as_of: asOf, data });
const forbidden = (key: string): { key: string; status: "forbidden" } => ({ key, status: "forbidden" });
const unavailable = (key: string, reason: "not_connected" | "read_failed" | "stale"): { key: string; status: "unavailable"; reason: typeof reason } => ({ key, status: "unavailable", reason });

type Settled<T> = { readonly state: "skipped" } | { readonly state: "ok"; readonly value: T } | { readonly state: "failed" };

/**
 * Builds the Home dashboard (docs/api/admin-dashboard-contract.md). Every tile is authorized with `authorize(principal, tileAction, admin_console)` BEFORE anything is
 * read: a denied tile costs zero queries. Reads run together (`Promise.allSettled`); a failed read only makes its own tiles `unavailable/read_failed`. A tile with no
 * backing read, or a read that is not composed, is `unavailable/not_connected`; a missing or stale snapshot is `not_connected` / `stale`. Never a made-up zero.
 */
export class DashboardService {
  constructor(private readonly services: AdminServices, private readonly deps: DashboardDeps) {}

  async build(p: Principal, marketId: string, q: DashboardQuery): Promise<DashboardResponse> {
    const now = this.deps.now();
    const { timezone, currency } = this.deps.market(marketId);
    const today = localDay(now, timezone);
    const days = RANGE_DAYS[q.range];
    const allow = (action: string): boolean => authorize(p, action, { type: "admin_console", marketId }).effect === "allow";
    const reader = this.services.dashboard;

    const snapKeys = SNAPSHOT_TILE_KEYS.filter((k) => allow(SNAPSHOT_TILE_ACTION[k]));
    const wantOrders = allow(ORDERS);
    const wantGmv = allow(FINANCE);
    const wantSales = wantOrders || wantGmv;
    const wantTop = wantGmv;
    const live = {
      kyc: allow(LIVE_ACTION.kyc_queue), approvals: allow(LIVE_ACTION.approvals_pending), elevations: allow(LIVE_ACTION.elevations_active),
      attention: allow(LIVE_ACTION.attention_open), flags: allow(LIVE_ACTION.kill_switches),
    };
    const seesAllElevations = allow("elevation.approve");
    // Series window: the longest of the selected range and the 14-day sparkline, ending today (market-local).
    const seriesFrom = addDays(today, -(Math.max(days, 14) - 1));
    const rangeFrom = addDays(today, -(days - 1));

    const run = async <T>(tile: string, wanted: boolean, fn: (() => Promise<T>) | undefined): Promise<Settled<T>> => {
      if (!wanted || fn === undefined) return { state: "skipped" };
      try {
        return { state: "ok", value: await fn() };
      } catch (e) {
        this.deps.logger.error("admin dashboard: tile read failed", { tile, error: e instanceof Error ? e.name : "unknown" });
        return { state: "failed" };
      }
    };
    const ops = this.services.ops;
    const [snap, sales, top, kyc, approvals, elevations, attention, flags] = await Promise.all([
      run("snapshots", snapKeys.length > 0, reader === undefined ? undefined : () => reader.snapshots(marketId, snapKeys)),
      run("sales", wantSales, reader === undefined ? undefined : () => reader.salesDaily(marketId, currency, seriesFrom, today)),
      run("top_stores", wantTop, reader === undefined ? undefined : () => reader.storeSalesTop(marketId, currency, rangeFrom, today, TOP_STORES)),
      run("kyc_queue", live.kyc, () => this.services.kyc.count(marketId)),
      run("approvals_pending", live.approvals, () => this.services.approvals.countPending(p)),
      run("elevations_active", live.elevations, ops?.elevations === undefined ? undefined : () => (ops.elevations ?? never()).countActive(p, seesAllElevations)),
      run("attention_open", live.attention, ops?.attention === undefined ? undefined : () => (ops.attention ?? never()).countOpen(p)),
      run("kill_switches", live.flags, ops === undefined ? undefined : () => ops.flags.list(marketId)),
    ]);
    const nowIso = now.toISOString();
    const stale = (asOf: string): boolean => now.getTime() - Date.parse(asOf) > STALE_AFTER_MS;

    // ---- snapshot tiles
    const byKey = new Map(snap.state === "ok" ? snap.value.map((r) => [r.key, r] as const) : []);
    const snapTile = <K extends SnapshotTileKey>(key: K): Tile<ReturnType<(typeof SNAPSHOT_TILE_DATA)[K]["parse"]>> => {
      if (!snapKeys.includes(key)) return forbidden(key);
      if (reader === undefined) return unavailable(key, "not_connected");
      if (snap.state === "failed") return unavailable(key, "read_failed");
      const row = byKey.get(key);
      if (row === undefined) return unavailable(key, "not_connected");
      if (row.version !== SNAPSHOT_VERSION) return unavailable(key, "read_failed");
      const parsed = SNAPSHOT_TILE_DATA[key].safeParse(row.payload);
      if (!parsed.success) {
        this.deps.logger.error("admin dashboard: snapshot payload rejected", { tile: key });
        return unavailable(key, "read_failed");
      }
      if (stale(row.asOf)) return unavailable(key, "stale");
      return ok(key, row.asOf, parsed.data) as never;
    };

    // ---- sales tiles (rollup of order_groups)
    type SalesState = { kind: "forbidden" } | { kind: "unavailable"; reason: "not_connected" | "read_failed" | "stale" } | { kind: "ok"; asOf: string; first: string; byDay: Map<string, SalesDailyRow> };
    const salesState = ((): SalesState => {
      if (!wantSales) return { kind: "forbidden" };
      if (reader === undefined) return { kind: "unavailable", reason: "not_connected" };
      if (sales.state !== "ok") return { kind: "unavailable", reason: "read_failed" };
      const v = sales.value;
      if (v.firstDay === null || v.refreshedAt === null) return { kind: "unavailable", reason: "not_connected" };
      if (stale(v.refreshedAt)) return { kind: "unavailable", reason: "stale" };
      return { kind: "ok", asOf: v.refreshedAt, first: v.firstDay, byDay: new Map(v.rows.map((r) => [r.day, r])) };
    })();
    const money = (v: bigint): { amount_minor: string; currency: string } => ({ amount_minor: v.toString(), currency });
    /** One point per day from `from`, oldest first; days before the first rollup run are absent, quiet days inside the covered window are 0. */
    const dayList = (from: string, first: string): string[] => {
      const out: string[] = [];
      for (let d = from; d <= today; d = addDays(d, 1)) if (d >= first) out.push(d);
      return out;
    };
    const salesTile = <D>(key: string, allowed: boolean, build: (s: Extract<SalesState, { kind: "ok" }>) => D): Tile<D> => {
      if (!allowed) return forbidden(key);
      if (salesState.kind === "forbidden") return forbidden(key);
      if (salesState.kind === "unavailable") return unavailable(key, salesState.reason);
      return ok(key, salesState.asOf, build(salesState));
    };
    const sum = (s: Extract<SalesState, { kind: "ok" }>, from: string, pick: (r: SalesDailyRow) => bigint): bigint =>
      dayList(from, s.first).reduce((a, d) => a + (s.byDay.get(d) === undefined ? 0n : pick(s.byDay.get(d) ?? never())), 0n);

    const ordersToday = salesTile("orders_today", wantOrders, (s) => ({
      count: s.byDay.get(today)?.orders ?? 0,
      series_14d: dayList(addDays(today, -13), s.first).map((d) => ({ day: d, value: s.byDay.get(d)?.orders ?? 0 })),
    }));
    const gmvToday = salesTile("gmv_today", wantGmv, (s) => ({
      gmv: money(s.byDay.get(today)?.gmvMinor ?? 0n), refunded: money(s.byDay.get(today)?.refundedMinor ?? 0n), gmv_7d: money(sum(s, addDays(today, -6), (r) => r.gmvMinor)),
    }));
    const salesSeries = salesTile("sales_series", wantSales, (s) => {
      const list = dayList(rangeFrom, s.first);
      return {
        orders: wantOrders ? list.map((d) => ({ day: d, value: s.byDay.get(d)?.orders ?? 0 })) : null,
        gmv: wantGmv ? list.map((d) => ({ day: d, value: money(s.byDay.get(d)?.gmvMinor ?? 0n) })) : null,
        total_orders: wantOrders ? list.reduce((a, d) => a + (s.byDay.get(d)?.orders ?? 0), 0) : null,
        total_gmv: wantGmv ? money(sum(s, rangeFrom, (r) => r.gmvMinor)) : null,
      };
    });
    const topStores = ((): Tile<unknown> => {
      if (!wantTop) return forbidden("top_stores");
      if (reader === undefined) return unavailable("top_stores", "not_connected");
      if (top.state !== "ok") return unavailable("top_stores", "read_failed");
      const v = top.value;
      if (v.asOf === null) return unavailable("top_stores", "not_connected");
      if (stale(v.asOf)) return unavailable("top_stores", "stale");
      return ok("top_stores", v.asOf, {
        items: v.items.map((i) => ({ store_id: i.storeId, name_ar: i.nameAr, name_en: i.nameEn, orders: i.orders, gmv: money(i.gmvMinor) })),
        other: { stores: v.other.stores, orders: v.other.orders, gmv: money(v.other.gmvMinor) },
      });
    })();

    // ---- live tiles
    const liveTile = <T, D>(key: string, allowed: boolean, r: Settled<T>, notComposed: boolean, build: (v: T) => D): Tile<D> => {
      if (!allowed) return forbidden(key);
      if (notComposed) return unavailable(key, "not_connected");
      if (r.state !== "ok") return unavailable(key, "read_failed");
      return ok(key, nowIso, build(r.value));
    };
    const kycTile = liveTile("kyc_queue", live.kyc, kyc, false, (v) => ({ submitted: v.submitted, needs_info: v.needsInfo, oldest_at: v.oldestAt }));
    const approvalsTile = liveTile("approvals_pending", live.approvals, approvals, false, (v) => ({ for_me: v.forMe, soonest_expires_at: v.soonestExpiresAt }));
    const elevationsTile = liveTile("elevations_active", live.elevations, elevations, ops?.elevations === undefined, (v) => ({ active: v.active, pending: v.pending, scope: seesAllElevations ? ("market" as const) : ("own" as const) }));
    const attentionTile = liveTile("attention_open", live.attention, attention, ops?.attention === undefined, (v) => ({ open: v.open, acked: v.acked, by_kind: { ...v.byKind }, oldest_at: v.oldestAt }));
    const killTile = liveTile("kill_switches", live.flags, flags, ops === undefined, (records) => engaged(records, marketId));

    const finance = (key: string): Tile<never> => (wantGmv ? (unavailable(key, "not_connected")) : (forbidden(key)));

    // The tile unions are checked against DashboardResponse by the route's response schema and by the contract tests.
    return {
      market_id: marketId, range: q.range, timezone, today, generated_at: nowIso,
      sections: {
        today: { orders_today: ordersToday, gmv_today: gmvToday },
        sales: { sales_series: salesSeries, orders_by_step: snapTile("orders_by_step"), top_stores: topStores, verified_discount_share: snapTile("verified_discount_share") },
        orders: { seller_sla_breaches: snapTile("seller_sla_breaches"), cod_awaiting_confirmation: snapTile("cod_awaiting_confirmation"), returns_pipeline: snapTile("returns_pipeline"), disputes_open: snapTile("disputes_open") },
        money: {
          refunds_waiting: snapTile("refunds_waiting"), refunds_overdue: snapTile("refunds_overdue"), payouts: snapTile("payouts"), recon_unmatched: snapTile("recon_unmatched"),
          // No courier adapter, no persisted integrity-job result: honest "Not connected yet" (plan section 2), never computed on the request path.
          cod_unremitted: finance("cod_unremitted"), ledger_integrity: finance("ledger_integrity"),
        },
        trust: { kyc_queue: kycTile, stores_moderation: snapTile("stores_moderation"), price_enforcement: snapTile("price_enforcement"), listings_by_status: snapTile("listings_by_status") },
        privacy: { breaches_open: snapTile("breaches_open"), dsar_queue: snapTile("dsar_queue") },
        platform: { attention_open: attentionTile, approvals_pending: approvalsTile, elevations_active: elevationsTile, kill_switches: killTile },
      },
    } as DashboardResponse;
  }
}

const never = (): never => {
  throw new Error("unreachable");
};

/** Registered kill switches whose effective row (the market's, else the global one) is enabled=false, split by class. */
const engaged = (records: readonly FlagRecord[], marketId: string): { engaged_money: string[]; engaged_ui: string[] } => {
  const out = { engaged_money: [] as string[], engaged_ui: [] as string[] };
  for (const name of Object.keys(KILL_SWITCHES).sort() as (keyof typeof KILL_SWITCHES)[]) {
    const rows = records.filter((r) => r.key === name);
    const row = rows.find((r) => r.marketId === marketId) ?? rows.find((r) => r.marketId === null);
    if (row === undefined || row.enabled) continue;
    (KILL_SWITCHES[name].class === "ui" ? out.engaged_ui : out.engaged_money).push(name);
  }
  return out;
};
