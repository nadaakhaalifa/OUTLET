import { sql, type Kysely } from "kysely";
import { z } from "zod";
import type { AdStatsRow, AdsConfig, Campaign, CampaignStatus } from "../domain/bridge";
import type {
  AdsStore,
  BidRecord,
  BillClick,
  ClickRecheck,
  ClickSignalsQuery,
  ClickSignalsResult,
  ClickRecord,
  IdPort,
  ImpressionRecord,
  OutboxDraft,
  ServableBid,
  TopUpRecord,
} from "../domain/ports";

/** Raw SQL with Zod validated rows, as in the budget, rewards and gift-card adapters. */
export type AdsDb = Kysely<Record<string, never>>;
type Trx = AdsDb;

const Ms = z.string().regex(/^-?\d+$/).transform((s) => Number(s));
const Big = z.string().regex(/^-?\d+$/).transform((s) => BigInt(s));
const STATUS = z.enum(["ACTIVE", "PAUSED", "PAUSED_NO_BALANCE", "SUSPENDED", "ENDED"]);
const REASON = z.enum([
  "token_expired",
  "too_fast",
  "duplicate_window",
  "burst",
  "self_click",
  "bot",
  "campaign_drain",
  "budget_exhausted",
  "no_balance",
  "kill_switch",
  "credited_back",
]);

const CampaignRow = z.object({
  id: z.string(),
  store_id: z.string(),
  name: z.string(),
  status: STATUS,
  daily_budget: Big,
  max_cpc: Big,
  keywords: z.array(z.string()),
  categories: z.array(z.string()),
  starts_ms: Ms,
  ends_ms: Ms.nullable(),
  created_ms: Ms,
  updated_ms: Ms,
});
const TopUpRow = z.object({
  id: z.string(),
  store_id: z.string(),
  net: Big,
  vat: Big,
  gross: Big,
  status: z.enum(["PENDING_PAYMENT", "CREDITED", "FAILED"]),
  intent_ref: z.string().nullable(),
  idempotency_key: z.string(),
  created_ms: Ms,
  credited_ms: Ms.nullable(),
});
const ClickRow = z.object({
  id: z.string(),
  token_jti: z.string(),
  campaign_id: z.string(),
  store_id: z.string(),
  product_id: z.string(),
  impression_id: z.string(),
  session_hash: z.string(),
  valid: z.boolean(),
  invalid_reason: REASON.nullable(),
  cost: Big,
  day_key: z.string(),
  ts_ms: Ms,
  posted_entry_id: z.string().nullable(),
  credited_back: Big,
});
const ConfigRow = z.object({
  floor_price: Big,
  slots: z.number().int(),
  pricing: z.enum(["gsp", "first_price"]),
  frequency_cap_per_session_day: z.number().int(),
  click_token_ttl_ms: z.number().int(),
  click_dedupe_window_ms: z.number().int(),
  min_dwell_ms: z.number().int(),
  max_clicks_per_session_per_minute: z.number().int(),
  max_clicks_per_campaign_session_day: z.number().int(),
  bot_score_block_bps: z.number().int(),
  vat_bps: z.number().int(),
  min_top_up: Big,
  max_top_up: Big,
});

const EPOCH = (col: string) => sql.raw(`floor(extract(epoch from ${col}) * 1000)::text`);
const iso = (ms: number): string => new Date(ms).toISOString();
const ts = (ms: number | null) => (ms === null ? sql`null::timestamptz` : sql`${iso(ms)}::timestamptz`);
const big = (n: bigint) => sql`${n.toString()}::bigint`;

const CAMPAIGN_COLS = sql`id::text as id, store_id::text as store_id, name, status, daily_budget::text as daily_budget,
  max_cpc::text as max_cpc, keywords, categories, ${EPOCH("starts_at")} as starts_ms, ${EPOCH("ends_at")} as ends_ms,
  ${EPOCH("created_at")} as created_ms, ${EPOCH("updated_at")} as updated_ms`;
const TOPUP_COLS = sql`id::text as id, store_id::text as store_id, net::text as net, vat::text as vat, gross::text as gross,
  status, intent_ref, idempotency_key, ${EPOCH("created_at")} as created_ms, ${EPOCH("credited_at")} as credited_ms`;
const CLICK_COLS = sql`id::text as id, token_jti, campaign_id::text as campaign_id, store_id::text as store_id,
  product_id::text as product_id, impression_id::text as impression_id, session_hash, valid, invalid_reason,
  cost::text as cost, day_key, ${EPOCH("ts")} as ts_ms, posted_entry_id, credited_back::text as credited_back`;

const toCampaign = (raw: unknown): Campaign => {
  const r = CampaignRow.parse(raw);
  return {
    id: r.id,
    storeId: r.store_id,
    name: r.name,
    status: r.status,
    dailyBudget: r.daily_budget,
    maxCpc: r.max_cpc,
    keywords: r.keywords,
    categories: r.categories,
    startsAtMs: r.starts_ms,
    endsAtMs: r.ends_ms,
    createdAtMs: r.created_ms,
    updatedAtMs: r.updated_ms,
  };
};
const toTopUp = (raw: unknown): TopUpRecord => {
  const r = TopUpRow.parse(raw);
  return {
    id: r.id,
    storeId: r.store_id,
    net: r.net,
    vat: r.vat,
    gross: r.gross,
    status: r.status,
    intentRef: r.intent_ref,
    idempotencyKey: r.idempotency_key,
    createdAtMs: r.created_ms,
    creditedAtMs: r.credited_ms,
  };
};
const toClick = (raw: unknown): ClickRecord => {
  const r = ClickRow.parse(raw);
  return {
    id: r.id,
    tokenJti: r.token_jti,
    campaignId: r.campaign_id,
    storeId: r.store_id,
    productId: r.product_id,
    impressionId: r.impression_id,
    sessionHash: r.session_hash,
    valid: r.valid,
    invalidReason: r.invalid_reason,
    cost: r.cost,
    dayKey: r.day_key,
    atMs: r.ts_ms,
    postedEntryId: r.posted_entry_id,
    creditedBack: r.credited_back,
  };
};

/**
 * Postgres store. Every method runs in one transaction as `app.role = 'system'` (the module is the
 * only writer; sellers are filtered by the policy guard and RLS stays on for every other role).
 * Billing locks the balance and the campaign-day row so the budget can never be overspent.
 */
export class KyselyAdsStore implements AdsStore {
  constructor(
    private readonly db: AdsDb,
    private readonly ids: IdPort,
  ) {}

  private async tx<T>(fn: (t: Trx) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      await sql`select set_config('app.role', 'system', true)`.execute(trx);
      return fn(trx as unknown as Trx);
    });
  }

  private async emit(t: Trx, events: readonly OutboxDraft[]): Promise<void> {
    for (const e of events) {
      await sql`
        insert into outbox_events (id, aggregate_type, aggregate_id, event_type, ordering_key, payload)
        values (${this.ids.uuidV7()}::uuid, ${e.aggregateType}, ${e.aggregateId}::uuid, ${e.type},
                ${`${e.aggregateType}:${e.aggregateId}`}, ${JSON.stringify(e.payload)}::jsonb)`.execute(t);
    }
  }

  async getConfig(): Promise<AdsConfig | null> {
    return this.tx(async (t) => {
      const r = await sql<unknown>`select floor_price::text as floor_price, slots::int as slots, pricing,
        frequency_cap_per_session_day::int as frequency_cap_per_session_day, click_token_ttl_ms::int as click_token_ttl_ms,
        click_dedupe_window_ms::int as click_dedupe_window_ms, min_dwell_ms::int as min_dwell_ms,
        max_clicks_per_session_per_minute::int as max_clicks_per_session_per_minute,
        max_clicks_per_campaign_session_day::int as max_clicks_per_campaign_session_day,
        bot_score_block_bps::int as bot_score_block_bps, vat_bps::int as vat_bps,
        min_top_up::text as min_top_up, max_top_up::text as max_top_up from ad_config where id = 1`.execute(t);
      if (r.rows[0] === undefined) return null;
      const c = ConfigRow.parse(r.rows[0]);
      return {
        floorPrice: c.floor_price,
        slots: c.slots,
        pricing: c.pricing,
        frequencyCapPerSessionDay: c.frequency_cap_per_session_day,
        clickTokenTtlMs: c.click_token_ttl_ms,
        clickDedupeWindowMs: c.click_dedupe_window_ms,
        minDwellMs: c.min_dwell_ms,
        maxClicksPerSessionPerMinute: c.max_clicks_per_session_per_minute,
        maxClicksPerCampaignPerSessionDay: c.max_clicks_per_campaign_session_day,
        botScoreBlockBps: c.bot_score_block_bps,
        vatBps: BigInt(c.vat_bps),
        minTopUp: c.min_top_up,
        maxTopUp: c.max_top_up,
      };
    });
  }

  async putConfig(c: AdsConfig, actorId: string): Promise<void> {
    await this.tx(async (t) => {
      await sql`
        insert into ad_config (id, floor_price, slots, pricing, frequency_cap_per_session_day, click_token_ttl_ms,
          click_dedupe_window_ms, min_dwell_ms, max_clicks_per_session_per_minute, max_clicks_per_campaign_session_day,
          bot_score_block_bps, vat_bps, min_top_up, max_top_up, updated_by)
        values (1, ${big(c.floorPrice)}, ${c.slots}, ${c.pricing}, ${c.frequencyCapPerSessionDay}, ${c.clickTokenTtlMs},
          ${c.clickDedupeWindowMs}, ${c.minDwellMs}, ${c.maxClicksPerSessionPerMinute}, ${c.maxClicksPerCampaignPerSessionDay},
          ${c.botScoreBlockBps}, ${Number(c.vatBps)}, ${big(c.minTopUp)}, ${big(c.maxTopUp)}, ${actorId}::uuid)
        on conflict (id) do update set floor_price = excluded.floor_price, slots = excluded.slots, pricing = excluded.pricing,
          frequency_cap_per_session_day = excluded.frequency_cap_per_session_day,
          click_token_ttl_ms = excluded.click_token_ttl_ms, click_dedupe_window_ms = excluded.click_dedupe_window_ms,
          min_dwell_ms = excluded.min_dwell_ms, max_clicks_per_session_per_minute = excluded.max_clicks_per_session_per_minute,
          max_clicks_per_campaign_session_day = excluded.max_clicks_per_campaign_session_day,
          bot_score_block_bps = excluded.bot_score_block_bps, vat_bps = excluded.vat_bps,
          min_top_up = excluded.min_top_up, max_top_up = excluded.max_top_up, updated_by = excluded.updated_by,
          version = ad_config.version + 1, updated_at = now()`.execute(t);
    });
  }

  private async putBids(t: Trx, campaignId: string, bids: readonly BidRecord[]): Promise<void> {
    await sql`delete from ad_product_bids where campaign_id = ${campaignId}::uuid`.execute(t);
    for (const b of bids) {
      await sql`insert into ad_product_bids (campaign_id, product_id, bid, created_at)
        values (${campaignId}::uuid, ${b.productId}::uuid, ${big(b.bid)}, ${ts(b.createdAtMs)})`.execute(t);
    }
  }

  async insertCampaign(c: Campaign, bids: readonly BidRecord[]): Promise<void> {
    await this.tx(async (t) => {
      await sql`insert into ad_campaigns (id, store_id, name, status, daily_budget, max_cpc, keywords, categories,
          starts_at, ends_at, created_at, updated_at)
        values (${c.id}::uuid, ${c.storeId}::uuid, ${c.name}, ${c.status}, ${big(c.dailyBudget)}, ${big(c.maxCpc)},
          ${JSON.stringify(c.keywords)}::jsonb, ${JSON.stringify(c.categories)}::jsonb, ${ts(c.startsAtMs)},
          ${ts(c.endsAtMs)}, ${ts(c.createdAtMs)}, ${ts(c.updatedAtMs)})`.execute(t);
      await this.putBids(t, c.id, bids);
    });
  }

  async getCampaign(id: string): Promise<Campaign | null> {
    return this.tx(async (t) => {
      const r = await sql<unknown>`select ${CAMPAIGN_COLS} from ad_campaigns where id = ${id}::uuid`.execute(t);
      return r.rows[0] === undefined ? null : toCampaign(r.rows[0]);
    });
  }

  async listCampaigns(storeId: string, limit: number) {
    return this.tx(async (t) => {
      const r = await sql<unknown>`select ${CAMPAIGN_COLS} from ad_campaigns where store_id = ${storeId}::uuid
        order by created_at desc, id desc limit ${limit}`.execute(t);
      return r.rows.map(toCampaign);
    });
  }

  async listBids(campaignId: string): Promise<readonly BidRecord[]> {
    return this.tx(async (t) => {
      const r = await sql<{ product_id: string; bid: string; created_ms: string }>`
        select product_id::text as product_id, bid::text as bid, ${EPOCH("created_at")} as created_ms
        from ad_product_bids where campaign_id = ${campaignId}::uuid order by product_id`.execute(t);
      return r.rows.map((x) => ({ campaignId, productId: x.product_id, bid: BigInt(x.bid), createdAtMs: Number(x.created_ms) }));
    });
  }

  async updateCampaign(
    id: string,
    patch: Partial<Pick<Campaign, "name" | "dailyBudget" | "maxCpc" | "keywords" | "categories" | "endsAtMs">>,
    bids: readonly BidRecord[] | null,
    nowMs: number,
  ): Promise<Campaign | null> {
    return this.tx(async (t) => {
      const cur = await sql<unknown>`select ${CAMPAIGN_COLS} from ad_campaigns where id = ${id}::uuid for update`.execute(t);
      if (cur.rows[0] === undefined) return null;
      const c = toCampaign(cur.rows[0]);
      const n = { ...c, ...patch };
      const r = await sql<unknown>`update ad_campaigns set name = ${n.name}, daily_budget = ${big(n.dailyBudget)},
        max_cpc = ${big(n.maxCpc)}, keywords = ${JSON.stringify(n.keywords)}::jsonb,
        categories = ${JSON.stringify(n.categories)}::jsonb, ends_at = ${ts(n.endsAtMs)}, updated_at = ${ts(nowMs)}
        where id = ${id}::uuid returning ${CAMPAIGN_COLS}`.execute(t);
      if (bids !== null) await this.putBids(t, id, bids);
      return toCampaign(r.rows[0]);
    });
  }

  async setStatus(id: string, from: CampaignStatus, to: CampaignStatus, nowMs: number, events: readonly OutboxDraft[]) {
    return this.tx(async (t) => {
      const r = await sql<unknown>`update ad_campaigns set status = ${to}, updated_at = ${ts(nowMs)}
        where id = ${id}::uuid and status = ${from} returning ${CAMPAIGN_COLS}`.execute(t);
      if (r.rows[0] === undefined) return null;
      await this.emit(t, events);
      return toCampaign(r.rows[0]);
    });
  }

  async listByStatus(status: CampaignStatus, limit: number) {
    return this.tx(async (t) => {
      const r = await sql<unknown>`select ${CAMPAIGN_COLS} from ad_campaigns where status = ${status}
        order by created_at, id limit ${limit}`.execute(t);
      return r.rows.map(toCampaign);
    });
  }

  async listStoreCampaignsInStatus(storeId: string, status: CampaignStatus) {
    return this.tx(async (t) => {
      const r = await sql<unknown>`select ${CAMPAIGN_COLS} from ad_campaigns
        where store_id = ${storeId}::uuid and status = ${status} order by created_at, id`.execute(t);
      return r.rows.map(toCampaign);
    });
  }

  async getBalance(storeId: string): Promise<bigint> {
    return this.tx(async (t) => {
      const r = await sql<{ b: string }>`select balance::text as b from ad_balances where store_id = ${storeId}::uuid`.execute(t);
      return r.rows[0] === undefined ? 0n : BigInt(r.rows[0].b);
    });
  }

  async insertTopUp(rec: TopUpRecord) {
    return this.tx(async (t) => {
      const ins = await sql<unknown>`insert into ad_topups (id, store_id, net, vat, gross, status, intent_ref, idempotency_key, created_at)
        values (${rec.id}::uuid, ${rec.storeId}::uuid, ${big(rec.net)}, ${big(rec.vat)}, ${big(rec.gross)}, ${rec.status},
          ${rec.intentRef}, ${rec.idempotencyKey}, ${ts(rec.createdAtMs)})
        on conflict (store_id, idempotency_key) do nothing returning ${TOPUP_COLS}`.execute(t);
      if (ins.rows[0] !== undefined) return { kind: "created" as const, topUp: toTopUp(ins.rows[0]) };
      const ex = await sql<unknown>`select ${TOPUP_COLS} from ad_topups
        where store_id = ${rec.storeId}::uuid and idempotency_key = ${rec.idempotencyKey}`.execute(t);
      return { kind: "duplicate" as const, topUp: toTopUp(ex.rows[0]) };
    });
  }

  async getTopUp(id: string) {
    return this.tx(async (t) => {
      const r = await sql<unknown>`select ${TOPUP_COLS} from ad_topups where id = ${id}::uuid`.execute(t);
      return r.rows[0] === undefined ? null : toTopUp(r.rows[0]);
    });
  }

  async setTopUpIntent(id: string, intentRef: string) {
    await this.tx(async (t) => {
      await sql`update ad_topups set intent_ref = ${intentRef} where id = ${id}::uuid`.execute(t);
    });
  }

  async creditTopUp(id: string, nowMs: number, events: readonly OutboxDraft[]) {
    return this.tx(async (t) => {
      const cur = await sql<unknown>`select ${TOPUP_COLS} from ad_topups where id = ${id}::uuid for update`.execute(t);
      if (cur.rows[0] === undefined) return { kind: "not_found" as const, topUp: null, balance: 0n };
      const top = toTopUp(cur.rows[0]);
      if (top.status !== "PENDING_PAYMENT") {
        const b = await sql<{ b: string }>`select balance::text as b from ad_balances where store_id = ${top.storeId}::uuid`.execute(t);
        return { kind: "replayed" as const, topUp: top, balance: b.rows[0] === undefined ? 0n : BigInt(b.rows[0].b) };
      }
      const up = await sql<unknown>`update ad_topups set status = 'CREDITED', credited_at = ${ts(nowMs)}
        where id = ${id}::uuid returning ${TOPUP_COLS}`.execute(t);
      const bal = await sql<{ b: string }>`
        insert into ad_balances (store_id, balance, updated_at) values (${top.storeId}::uuid, ${big(top.net)}, now())
        on conflict (store_id) do update set balance = ad_balances.balance + excluded.balance, updated_at = now()
        returning balance::text as b`.execute(t);
      await this.emit(t, events);
      return { kind: "credited" as const, topUp: toTopUp(up.rows[0]), balance: BigInt(bal.rows[0]?.b ?? "0") };
    });
  }

  async failTopUp(id: string) {
    await this.tx(async (t) => {
      await sql`update ad_topups set status = 'FAILED' where id = ${id}::uuid and status = 'PENDING_PAYMENT'`.execute(t);
    });
  }

  async listTopUps(storeId: string, limit: number) {
    return this.tx(async (t) => {
      const r = await sql<unknown>`select ${TOPUP_COLS} from ad_topups where store_id = ${storeId}::uuid
        order by created_at desc, id desc limit ${limit}`.execute(t);
      return r.rows.map(toTopUp);
    });
  }

  async listServable(nowMs: number, dayKey: string): Promise<readonly ServableBid[]> {
    return this.tx(async (t) => {
      const r = await sql<Record<string, unknown>>`
        with c as (
          select ${CAMPAIGN_COLS} from ad_campaigns
          where status = 'ACTIVE' and starts_at <= ${ts(nowMs)} and (ends_at is null or ends_at > ${ts(nowMs)})
        )
        select c.*, b.product_id::text as bid_product, b.bid::text as bid_amount,
          ${sql.raw(`floor(extract(epoch from b.created_at) * 1000)::text`)} as bid_ms,
          coalesce(s.spent, 0)::text as spent_today, coalesce(bal.balance, 0)::text as balance
        from c
        join ad_product_bids b on b.campaign_id = c.id::uuid
        left join ad_daily_spend s on s.campaign_id = c.id::uuid and s.day_key = ${dayKey}
        left join ad_balances bal on bal.store_id = c.store_id::uuid
        order by c.id, b.product_id`.execute(t);
      return r.rows.map((row) => ({
        campaign: toCampaign(row),
        productId: String(row["bid_product"]),
        bid: BigInt(String(row["bid_amount"])),
        bidAtMs: Number(row["bid_ms"]),
        spentToday: BigInt(String(row["spent_today"])),
        balance: BigInt(String(row["balance"])),
      }));
    });
  }

  async recordImpressions(rows: readonly ImpressionRecord[]) {
    await this.tx(async (t) => {
      for (const i of rows) {
        await sql`insert into ad_impressions (id, campaign_id, store_id, product_id, position, query_hash, session_hash, ts)
          values (${i.id}::uuid, ${i.campaignId}::uuid, ${i.storeId}::uuid, ${i.productId}::uuid, ${i.position},
            ${i.queryHash}, ${i.sessionHash}, ${ts(i.atMs)})`.execute(t);
      }
    });
  }

  async getImpression(id: string): Promise<ImpressionRecord | null> {
    return this.tx(async (t) => {
      const r = await sql<Record<string, string>>`select id::text as id, campaign_id::text as campaign_id,
        store_id::text as store_id, product_id::text as product_id, position::text as position, query_hash,
        session_hash, ${EPOCH("ts")} as ts_ms from ad_impressions where id = ${id}::uuid limit 1`.execute(t);
      const x = r.rows[0];
      if (x === undefined) return null;
      return {
        id: String(x["id"]),
        campaignId: String(x["campaign_id"]),
        storeId: String(x["store_id"]),
        productId: String(x["product_id"]),
        position: Number(x["position"]),
        queryHash: x["query_hash"] ?? null,
        sessionHash: String(x["session_hash"]),
        atMs: Number(x["ts_ms"]),
      };
    });
  }

  async impressionsTodayBySession(sessionHash: string, campaignId: string, sinceMs: number) {
    return this.tx(async (t) => {
      const r = await sql<{ n: string }>`select count(*)::text as n from ad_impressions
        where session_hash = ${sessionHash} and campaign_id = ${campaignId}::uuid and ts >= ${ts(sinceMs)}`.execute(t);
      return Number(r.rows[0]?.n ?? "0");
    });
  }

  async billClick(click: ClickRecord, caps: { readonly dailyBudget: bigint }, events: readonly OutboxDraft[], recheck?: ClickRecheck): Promise<BillClick> {
    return this.tx(async (t) => {
      await sql`select pg_advisory_xact_lock(hashtext(${click.tokenJti}))`.execute(t);
      const dup = await sql<unknown>`select ${CLICK_COLS} from ad_clicks where token_jti = ${click.tokenJti}`.execute(t);
      if (dup.rows[0] !== undefined) return { kind: "duplicate" as const, click: toClick(dup.rows[0]) };

      const insert = async (c: ClickRecord): Promise<ClickRecord> => {
        const r = await sql<unknown>`insert into ad_clicks (id, token_jti, campaign_id, store_id, product_id, impression_id,
            session_hash, valid, invalid_reason, cost, day_key, ts)
          values (${c.id}::uuid, ${c.tokenJti}, ${c.campaignId}::uuid, ${c.storeId}::uuid, ${c.productId}::uuid,
            ${c.impressionId}::uuid, ${c.sessionHash}, ${c.valid}, ${c.invalidReason}, ${big(c.cost)}, ${c.dayKey}, ${ts(c.atMs)})
          returning ${CLICK_COLS}`.execute(t);
        return toClick(r.rows[0]);
      };

      if (!click.valid || click.cost === 0n) {
        return { kind: "rejected" as const, click: await insert({ ...click, cost: 0n }) };
      }
      await sql`insert into ad_daily_spend (campaign_id, day_key, spent) values (${click.campaignId}::uuid, ${click.dayKey}, 0)
        on conflict (campaign_id, day_key) do nothing`.execute(t);
      const spentRow = await sql<{ s: string }>`select spent::text as s from ad_daily_spend
        where campaign_id = ${click.campaignId}::uuid and day_key = ${click.dayKey} for update`.execute(t);
      if (recheck !== undefined) {
        // Under the campaign-day row lock: every other billing click of this campaign-day waits.
        const why = recheck.verdict(await this.signalsIn(t, recheck.query));
        if (why !== null) {
          return { kind: "rejected" as const, click: await insert({ ...click, valid: false, invalidReason: why as ClickRecord["invalidReason"], cost: 0n }) };
        }
      }
      const balRow = await sql<{ b: string }>`select balance::text as b from ad_balances
        where store_id = ${click.storeId}::uuid for update`.execute(t);
      const spent = BigInt(spentRow.rows[0]?.s ?? "0");
      const balance = balRow.rows[0] === undefined ? 0n : BigInt(balRow.rows[0].b);
      const reason = spent + click.cost > caps.dailyBudget ? "budget_exhausted" : balance < click.cost ? "no_balance" : null;
      if (reason !== null) {
        return { kind: "rejected" as const, click: await insert({ ...click, valid: false, invalidReason: reason, cost: 0n }) };
      }
      await sql`update ad_daily_spend set spent = spent + ${big(click.cost)}
        where campaign_id = ${click.campaignId}::uuid and day_key = ${click.dayKey}`.execute(t);
      await sql`update ad_balances set balance = balance - ${big(click.cost)}, updated_at = now()
        where store_id = ${click.storeId}::uuid`.execute(t);
      const saved = await insert(click);
      await this.emit(t, events);
      return { kind: "billed" as const, click: saved };
    });
  }

  private async signalsIn(t: Trx, i: ClickSignalsQuery): Promise<ClickSignalsResult> {
    const r = await sql<{ w: string; m: string; d: string }>`
      select
        count(*) filter (where valid and campaign_id = ${i.campaignId}::uuid and product_id = ${i.productId}::uuid
                         and ts >= ${ts(i.windowSinceMs)})::text as w,
        count(*) filter (where ts >= ${ts(i.minuteSinceMs)})::text as m,
        count(*) filter (where valid and campaign_id = ${i.campaignId}::uuid and day_key = ${i.dayKey})::text as d
      from ad_clicks where session_hash = ${i.sessionHash}`.execute(t);
    const x = r.rows[0];
    return { validInWindow: Number(x?.w ?? "0"), clicksLastMinute: Number(x?.m ?? "0"), campaignClicksToday: Number(x?.d ?? "0") };
  }

  async clickSignals(i: ClickSignalsQuery): Promise<ClickSignalsResult> {
    return this.tx((t) => this.signalsIn(t, i));
  }

  async creditBack(clickId: string, _nowMs: number) {
    void _nowMs;
    return this.tx(async (t) => {
      const cur = await sql<unknown>`select ${CLICK_COLS} from ad_clicks where id = ${clickId}::uuid for update`.execute(t);
      if (cur.rows[0] === undefined) return { kind: "not_found" as const, click: null };
      const c = toClick(cur.rows[0]);
      if (!c.valid || c.cost === 0n || c.creditedBack > 0n) return { kind: "replayed" as const, click: c };
      const up = await sql<unknown>`update ad_clicks set credited_back = cost where id = ${clickId}::uuid returning ${CLICK_COLS}`.execute(t);
      await sql`insert into ad_balances (store_id, balance, updated_at) values (${c.storeId}::uuid, ${big(c.cost)}, now())
        on conflict (store_id) do update set balance = ad_balances.balance + excluded.balance, updated_at = now()`.execute(t);
      await sql`update ad_daily_spend set spent = greatest(spent - ${big(c.cost)}, 0)
        where campaign_id = ${c.campaignId}::uuid and day_key = ${c.dayKey}`.execute(t);
      return { kind: "credited" as const, click: toClick(up.rows[0]) };
    });
  }

  async listUnposted(limit: number) {
    return this.tx(async (t) => {
      const r = await sql<unknown>`select ${CLICK_COLS} from ad_clicks
        where valid and cost > 0 and posted_at is null and credited_back = 0 order by ts, id limit ${limit}`.execute(t);
      return r.rows.map(toClick);
    });
  }

  async markPosted(clickId: string, entryId: string) {
    await this.tx(async (t) => {
      await sql`update ad_clicks set posted_entry_id = ${entryId}, posted_at = now() where id = ${clickId}::uuid`.execute(t);
    });
  }

  async getClick(id: string) {
    return this.tx(async (t) => {
      const r = await sql<unknown>`select ${CLICK_COLS} from ad_clicks where id = ${id}::uuid`.execute(t);
      return r.rows[0] === undefined ? null : toClick(r.rows[0]);
    });
  }

  async stats(i: { storeId: string; campaignId: string | null; fromMs: number; toMs: number }): Promise<Omit<AdStatsRow, "attributedRevenue">> {
    return this.tx(async (t) => {
      const camp = i.campaignId === null ? sql`true` : sql`campaign_id = ${i.campaignId}::uuid`;
      const imps = await sql<{ n: string }>`select count(*)::text as n from ad_impressions
        where store_id = ${i.storeId}::uuid and ${camp} and ts >= ${ts(i.fromMs)} and ts < ${ts(i.toMs)}`.execute(t);
      const cl = await sql<{ n: string; spend: string }>`select count(*)::text as n, coalesce(sum(cost - credited_back), 0)::text as spend
        from ad_clicks where store_id = ${i.storeId}::uuid and valid and ${camp} and ts >= ${ts(i.fromMs)} and ts < ${ts(i.toMs)}`.execute(t);
      return { impressions: Number(imps.rows[0]?.n ?? "0"), clicks: Number(cl.rows[0]?.n ?? "0"), spend: BigInt(cl.rows[0]?.spend ?? "0") };
    });
  }

  async productIdsFor(storeId: string, campaignId: string | null) {
    return this.tx(async (t) => {
      const camp = campaignId === null ? sql`true` : sql`c.id = ${campaignId}::uuid`;
      const r = await sql<{ p: string }>`select distinct b.product_id::text as p from ad_product_bids b
        join ad_campaigns c on c.id = b.campaign_id where c.store_id = ${storeId}::uuid and ${camp} order by p`.execute(t);
      return r.rows.map((x) => x.p);
    });
  }
}
