import { sql, type Kysely } from "kysely";
import { z } from "zod";
import { GAMES, OUTCOME_KINDS, TIERS, type Game, type OddsOutcome, type OddsTable, type RewardsConfig } from "../domain/bridge";
import {
  COIN_EVENT_KINDS,
  type ChallengeRow,
  type CoinEventKind,
  type CoinEventRow,
  type IdPort,
  type OddsVersion,
  type PlayRow,
  type RewardEvent,
  type RewardsStore,
  type SpendRow,
  type TierRow,
} from "../domain/ports";

/** Raw SQL with Zod validated rows, as in the reviews and referrals adapters. */
export type RewardsDb = Kysely<Record<string, never>>;

const Int = z.string().regex(/^-?\d+$/);
const Ms = Int.transform((s) => Number(s));
const Big = Int.transform((s) => BigInt(s));
const EPOCH_MS = (col: string) => sql.raw(`floor(extract(epoch from ${col}) * 1000)::text`);
const iso = (ms: number): string => new Date(ms).toISOString();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CoinRow = z.object({
  id: z.string(),
  user_id: z.string(),
  kind: z.enum(COIN_EVENT_KINDS),
  sub: z.enum(["cashback_coins", "referral_credit"]),
  amount: Big,
  debt_delta: Big,
  parent_id: z.string().nullable(),
  source_ref: z.string(),
  journal_entry_id: z.string().nullable(),
  expires_ms: Ms.nullable(),
  piastres_per_coin: Big,
  config_version: z.number().int(),
  created_ms: Ms,
});
const COIN_COLS = sql`id::text as id, user_id::text as user_id, kind, sub, amount::text as amount,
  debt_delta::text as debt_delta, parent_id::text as parent_id, source_ref, journal_entry_id::text as journal_entry_id,
  ${EPOCH_MS("expires_at")} as expires_ms, piastres_per_coin::text as piastres_per_coin,
  config_version::int as config_version, ${EPOCH_MS("created_at")} as created_ms`;
const toCoin = (raw: unknown): CoinEventRow => {
  const r = CoinRow.parse(raw);
  return {
    id: r.id,
    userId: r.user_id,
    kind: r.kind,
    sub: r.sub,
    amount: r.amount,
    debtDelta: r.debt_delta,
    parentId: r.parent_id,
    sourceRef: r.source_ref,
    journalEntryId: r.journal_entry_id,
    expiresAtMs: r.expires_ms,
    piastresPerCoin: r.piastres_per_coin,
    configVersion: r.config_version,
    createdAtMs: r.created_ms,
  };
};

const SpendDbRow = z.object({ id: z.string(), user_id: z.string(), source_ref: z.string(), amount: Big, at_ms: Ms });
const TierDbRow = z.object({
  user_id: z.string(),
  tier: z.enum(TIERS),
  net_spend_12m: Big,
  evaluated_ms: Ms,
  pending_tier: z.enum(TIERS).nullable(),
  pending_ms: Ms.nullable(),
});
const ChallengeDbRow = z.object({
  id: z.string(),
  code: z.string(),
  rule: z.object({ kind: z.literal("orders_closed"), count: z.number().int().min(1) }),
  start_ms: Ms,
  end_ms: Ms,
  reward_coins: Big,
  active: z.boolean(),
  created_ms: Ms,
});
const OddsJson = z.array(
  z.object({
    id: z.string(),
    kind: z.enum(OUTCOME_KINDS),
    ppm: z.number().int(),
    coins: z.string().nullable(),
    voucherTemplateId: z.string().nullable(),
  }),
);
const OddsDbRow = z.object({
  id: z.string(),
  game: z.enum(GAMES),
  version: z.number().int(),
  odds: OddsJson,
  published_ms: Ms,
  effective_ms: Ms,
  approval_id: z.string(),
});
const ODDS_COLS = sql`id::text as id, game, version::int as version, odds, ${EPOCH_MS("published_at")} as published_ms,
  ${EPOCH_MS("effective_from")} as effective_ms, approval_id`;
const toOdds = (raw: unknown): OddsVersion => {
  const r = OddsDbRow.parse(raw);
  const outcomes: OddsOutcome[] = r.odds.map((o) => ({
    id: o.id,
    kind: o.kind,
    ppm: o.ppm,
    coins: o.coins === null ? null : BigInt(o.coins),
    voucherTemplateId: o.voucherTemplateId,
  }));
  const table: OddsTable = { outcomes };
  return { id: r.id, game: r.game, version: r.version, table, publishedAtMs: r.published_ms, effectiveFromMs: r.effective_ms, approvalId: r.approval_id };
};
const oddsJson = (t: OddsTable): string =>
  JSON.stringify(t.outcomes.map((o) => ({ id: o.id, kind: o.kind, ppm: o.ppm, coins: o.coins === null ? null : o.coins.toString(), voucherTemplateId: o.voucherTemplateId })));

const PlayDbRow = z.object({
  id: z.string(),
  user_id: z.string(),
  game: z.enum(GAMES),
  intent_id: z.string(),
  day_key: z.string(),
  seq: z.number().int(),
  odds_version_id: z.string(),
  roll_ppm: z.number().int(),
  outcome_id: z.string(),
  outcome_kind: z.enum(OUTCOME_KINDS),
  coins: Big.nullable(),
  voucher_template_id: z.string().nullable(),
  server_seed: z.string(),
  server_seed_hash: z.string(),
  source_ref: z.string().nullable(),
  reward_ref: z.string().nullable(),
  settled_ms: Ms.nullable(),
  created_ms: Ms,
});
const PLAY_COLS = sql`id::text as id, user_id::text as user_id, game, intent_id, to_char(day_key, 'YYYY-MM-DD') as day_key,
  seq::int as seq, odds_version_id::text as odds_version_id, roll_ppm::int as roll_ppm, outcome_id, outcome_kind,
  coins::text as coins, voucher_template_id, server_seed, server_seed_hash, source_ref, reward_ref,
  ${EPOCH_MS("settled_at")} as settled_ms, ${EPOCH_MS("created_at")} as created_ms`;
const toPlay = (raw: unknown): PlayRow => {
  const r = PlayDbRow.parse(raw);
  return {
    id: r.id,
    userId: r.user_id,
    game: r.game,
    intentId: r.intent_id,
    dayKey: r.day_key,
    seq: r.seq,
    oddsVersionId: r.odds_version_id,
    rollPpm: r.roll_ppm,
    outcomeId: r.outcome_id,
    outcomeKind: r.outcome_kind,
    coins: r.coins,
    voucherTemplateId: r.voucher_template_id,
    serverSeed: r.server_seed,
    serverSeedHash: r.server_seed_hash,
    sourceRef: r.source_ref,
    rewardRef: r.reward_ref,
    settledAtMs: r.settled_ms,
    createdAtMs: r.created_ms,
  };
};

const ConfigJson = z.record(z.string(), z.unknown());
const configToJson = (c: RewardsConfig): string =>
  JSON.stringify(c, (_k, v: unknown) => (typeof v === "bigint" ? { $big: v.toString() } : v));
const configFromJson = (raw: unknown): RewardsConfig => {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o["$big"] === "string") return BigInt(o["$big"]);
      return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return walk(ConfigJson.parse(raw)) as RewardsConfig;
};

const aggregateOf = (e: RewardEvent): { type: string; id: string } => {
  switch (e.type) {
    case "coins.earned":
    case "coins.clawed_back":
    case "coins.expired":
    case "tier.changed":
    case "game.played":
      return { type: "rewards_user", id: e.userId };
    case "rewards.config_changed":
      return { type: "rewards_config", id: "00000000-0000-0000-0000-000000000000" };
    case "game.odds_published":
      return { type: "game_odds", id: e.oddsVersionId };
  }
};

/** Outbox payload: ids, enums and integer amounts (bigint as string). Never text or contact data. */
const payloadOf = (e: RewardEvent): Record<string, string | number | null> => {
  switch (e.type) {
    case "coins.earned":
      return { user_id: e.userId, kind: e.kind, coins: e.coins.toString(), source_ref: e.sourceRef, expires_at_ms: e.expiresAtMs };
    case "coins.clawed_back":
      return { user_id: e.userId, coins: e.coins.toString(), debt_added: e.debtAdded.toString(), source_ref: e.sourceRef };
    case "coins.expired":
      return { user_id: e.userId, coins: e.coins.toString(), lot_id: e.lotId };
    case "tier.changed":
      return { user_id: e.userId, from: e.from, to: e.to, change: e.change, effective_at_ms: e.effectiveAtMs };
    case "game.played":
      return { user_id: e.userId, game: e.game, play_id: e.playId, outcome_kind: e.outcomeKind, coins: e.coins === null ? null : e.coins.toString(), odds_version_id: e.oddsVersionId };
    case "rewards.config_changed":
      return { version: e.version, actor_id: e.actorId, approval_id: e.approvalId };
    case "game.odds_published":
      return { game: e.game, odds_version_id: e.oddsVersionId, version: e.version, effective_from_ms: e.effectiveFromMs, actor_id: e.actorId };
  }
};

/**
 * Postgres adapter. One transaction per method under the `system` role (authorization is the
 * policy guard; RLS stays on for every other role). Outbox rows commit with the state change.
 */
export class KyselyRewardsStore implements RewardsStore {
  constructor(
    private readonly db: RewardsDb,
    private readonly ids: IdPort,
  ) {}

  private async tx<T>(run: (trx: RewardsDb) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      await sql`select set_config('app.role', 'system', true)`.execute(trx);
      return run(trx as unknown as RewardsDb);
    });
  }

  private async emit(trx: RewardsDb, events: readonly RewardEvent[]): Promise<void> {
    for (const e of events) {
      const agg = aggregateOf(e);
      await sql`
        insert into outbox_events (id, aggregate_type, aggregate_id, event_type, ordering_key, payload)
        values (${this.ids.uuidV7()}::uuid, ${agg.type}, ${agg.id}::uuid, ${e.type},
                ${`${agg.type}:${agg.id}`}, ${JSON.stringify(payloadOf(e))}::jsonb)`.execute(trx);
    }
  }

  // ---- configuration ----

  async latestConfig(): Promise<RewardsConfig | null> {
    return this.tx(async (trx) => {
      const r = await sql<{ config: unknown }>`select config from reward_config_versions order by version desc limit 1`.execute(trx);
      const row = r.rows[0];
      return row === undefined ? null : configFromJson(row.config);
    });
  }

  async putConfig(cfg: RewardsConfig, meta: { approvalId: string; actorId: string; atMs: number }, events: readonly RewardEvent[]): Promise<"ok" | "stale"> {
    return this.tx(async (trx) => {
      const cur = await sql<{ v: number }>`select coalesce(max(version), 1)::int as v from reward_config_versions`.execute(trx);
      if (cfg.version !== (cur.rows[0]?.v ?? 1) + 1) return "stale";
      const ins = await sql<{ version: number }>`
        insert into reward_config_versions (version, config, approval_id, created_by, created_at)
        values (${cfg.version}, ${configToJson(cfg)}::jsonb, ${meta.approvalId}, ${meta.actorId}::uuid, ${iso(meta.atMs)}::timestamptz)
        on conflict (version) do nothing returning version::int as version`.execute(trx);
      if (ins.rows[0] === undefined) return "stale";
      await this.emit(trx, events);
      return "ok";
    });
  }

  // ---- coins ----

  async appendCoinEvent(row: CoinEventRow, events: readonly RewardEvent[]): Promise<"inserted" | "duplicate"> {
    return this.tx((trx) => this.insertCoin(trx, row, events));
  }

  private async insertCoin(trx: RewardsDb, row: CoinEventRow, events: readonly RewardEvent[]): Promise<"inserted" | "duplicate"> {
    const res = await sql<{ id: string }>`
      insert into coin_events (id, user_id, kind, sub, amount, debt_delta, parent_id, source_ref, journal_entry_id,
        expires_at, piastres_per_coin, config_version, created_at)
      values (${row.id}::uuid, ${row.userId}::uuid, ${row.kind}, ${row.sub}, ${row.amount.toString()}::bigint,
        ${row.debtDelta.toString()}::bigint, ${row.parentId}::uuid, ${row.sourceRef}, ${row.journalEntryId}::uuid,
        ${row.expiresAtMs === null ? null : iso(row.expiresAtMs)}::timestamptz, ${row.piastresPerCoin.toString()}::bigint,
        ${row.configVersion}, ${iso(row.createdAtMs)}::timestamptz)
      on conflict (kind, source_ref) do nothing returning id::text as id`.execute(trx);
    if (res.rows[0] === undefined) return "duplicate";
    if (row.debtDelta !== 0n) {
      const cur = await sql<{ a: string }>`select amount::text as a from coin_debts where user_id = ${row.userId}::uuid for update`.execute(trx);
      const next = BigInt(cur.rows[0]?.a ?? "0") + row.debtDelta;
      if (next < 0n) throw new Error("coin debt would become negative");
      await sql`
        insert into coin_debts (user_id, amount, updated_at)
        values (${row.userId}::uuid, ${next.toString()}::bigint, ${iso(row.createdAtMs)}::timestamptz)
        on conflict (user_id) do update set amount = excluded.amount, updated_at = excluded.updated_at`.execute(trx);
    }
    await this.emit(trx, events);
    return "inserted";
  }

  async reserveClawback(input: Parameters<RewardsStore["reserveClawback"]>[0]): ReturnType<RewardsStore["reserveClawback"]> {
    return this.tx(async (trx) => {
      // The lock: every clawback of this order starts by locking its earn row.
      const earnRes = await sql<unknown>`
        select ${COIN_COLS} from coin_events
        where kind = 'purchase' and source_ref = ${input.orderRef} for update`.execute(trx);
      const earnRaw = earnRes.rows[0];
      if (earnRaw === undefined) return { kind: "no_earn" as const };
      const earn = toCoin(earnRaw);
      if (earn.userId !== input.userId) return { kind: "no_earn" as const };
      const dupRes = await sql<unknown>`
        select ${COIN_COLS} from coin_events where kind = 'clawback' and source_ref = ${input.refundRef}`.execute(trx);
      const dupRaw = dupRes.rows[0];
      if (dupRaw !== undefined) return { kind: "duplicate" as const, row: toCoin(dupRaw) };
      const evRes = await sql<unknown>`
        select ${COIN_COLS} from coin_events where user_id = ${input.userId}::uuid order by created_at, id`.execute(trx);
      const userEvents = evRes.rows.map(toCoin);
      const pendingReversible = userEvents
        .filter((e) => e.kind === "clawback" && e.journalEntryId === null)
        .reduce((a, e) => a + (-e.amount - e.debtDelta), 0n);
      const decision = input.decide({ earn, userEvents, pendingReversible });
      if (decision === null) return { kind: "none" as const };
      const r = await this.insertCoin(trx, decision.row, decision.events);
      return r === "inserted" ? { kind: "reserved" as const, row: decision.row } : { kind: "duplicate" as const, row: decision.row };
    });
  }

  async coinEventBySource(kind: CoinEventKind, sourceRef: string): Promise<CoinEventRow | null> {
    return this.tx(async (trx) => {
      const r = await sql<unknown>`select ${COIN_COLS} from coin_events where kind = ${kind} and source_ref = ${sourceRef}`.execute(trx);
      const row = r.rows[0];
      return row === undefined ? null : toCoin(row);
    });
  }

  async coinEventsOf(userId: string): Promise<readonly CoinEventRow[]> {
    if (!UUID.test(userId)) return [];
    return this.tx(async (trx) => {
      const r = await sql<unknown>`select ${COIN_COLS} from coin_events where user_id = ${userId}::uuid order by created_at, id`.execute(trx);
      return r.rows.map(toCoin);
    });
  }

  async debtOf(userId: string): Promise<bigint> {
    if (!UUID.test(userId)) return 0n;
    return this.tx(async (trx) => {
      const r = await sql<{ a: string }>`select amount::text as a from coin_debts where user_id = ${userId}::uuid`.execute(trx);
      return BigInt(r.rows[0]?.a ?? "0");
    });
  }

  async pendingSettlements(userId: string | null, limit: number): Promise<readonly CoinEventRow[]> {
    return this.tx(async (trx) => {
      const r = await sql<unknown>`
        select ${COIN_COLS} from coin_events
        where parent_id is null and kind not in ('clawback', 'expire') and journal_entry_id is null
          and amount + debt_delta > 0 and (${userId === null}::boolean or user_id = ${userId ?? "00000000-0000-0000-0000-000000000000"}::uuid)
        order by created_at, id limit ${limit} for update skip locked`.execute(trx);
      return r.rows.map(toCoin);
    });
  }

  async setJournalEntry(eventId: string, journalEntryId: string): Promise<void> {
    await this.tx(async (trx) => {
      await sql`update coin_events set journal_entry_id = ${journalEntryId}::uuid where id = ${eventId}::uuid and journal_entry_id is null`.execute(trx);
    });
  }

  async usersWithDueLots(nowMs: number, limit: number): Promise<readonly string[]> {
    return this.tx(async (trx) => {
      const r = await sql<{ user_id: string }>`
        select distinct e.user_id::text as user_id from coin_events e
        where e.parent_id is null and e.kind not in ('clawback', 'expire') and e.expires_at <= ${iso(nowMs)}::timestamptz
          and not exists (select 1 from coin_events x where x.parent_id = e.id and x.kind = 'expire')
        order by 1 limit ${limit}`.execute(trx);
      return r.rows.map((x) => x.user_id);
    });
  }

  // ---- spend and tiers ----

  async addSpend(row: SpendRow): Promise<"inserted" | "duplicate"> {
    return this.tx(async (trx) => {
      const r = await sql<{ id: string }>`
        insert into spend_events (id, user_id, source_ref, amount, occurred_at)
        values (${row.id}::uuid, ${row.userId}::uuid, ${row.sourceRef}, ${row.amount.toString()}::bigint, ${iso(row.occurredAtMs)}::timestamptz)
        on conflict (source_ref) do nothing returning id::text as id`.execute(trx);
      return r.rows[0] === undefined ? "duplicate" : "inserted";
    });
  }

  async spendSince(userId: string, sinceMs: number): Promise<readonly SpendRow[]> {
    if (!UUID.test(userId)) return [];
    return this.tx(async (trx) => {
      const r = await sql<unknown>`
        select id::text as id, user_id::text as user_id, source_ref, amount::text as amount, ${EPOCH_MS("occurred_at")} as at_ms
        from spend_events where user_id = ${userId}::uuid and occurred_at > ${iso(sinceMs)}::timestamptz order by occurred_at, id`.execute(trx);
      return r.rows.map((x) => {
        const p = SpendDbRow.parse(x);
        return { id: p.id, userId: p.user_id, sourceRef: p.source_ref, amount: p.amount, occurredAtMs: p.at_ms };
      });
    });
  }

  async getTier(userId: string): Promise<TierRow | null> {
    if (!UUID.test(userId)) return null;
    return this.tx(async (trx) => {
      const r = await sql<unknown>`
        select user_id::text as user_id, tier, net_spend_12m::text as net_spend_12m, ${EPOCH_MS("evaluated_at")} as evaluated_ms,
          pending_tier, ${EPOCH_MS("pending_effective_at")} as pending_ms
        from tier_status where user_id = ${userId}::uuid`.execute(trx);
      const row = r.rows[0];
      if (row === undefined) return null;
      const p = TierDbRow.parse(row);
      return { userId: p.user_id, tier: p.tier, netSpend12m: p.net_spend_12m, evaluatedAtMs: p.evaluated_ms, pendingTier: p.pending_tier, pendingEffectiveAtMs: p.pending_ms };
    });
  }

  async saveTier(row: TierRow, events: readonly RewardEvent[]): Promise<void> {
    await this.tx(async (trx) => {
      await sql`
        insert into tier_status (user_id, tier, net_spend_12m, evaluated_at, pending_tier, pending_effective_at)
        values (${row.userId}::uuid, ${row.tier}, ${row.netSpend12m.toString()}::bigint, ${iso(row.evaluatedAtMs)}::timestamptz,
          ${row.pendingTier}, ${row.pendingEffectiveAtMs === null ? null : iso(row.pendingEffectiveAtMs)}::timestamptz)
        on conflict (user_id) do update set tier = excluded.tier, net_spend_12m = excluded.net_spend_12m,
          evaluated_at = excluded.evaluated_at, pending_tier = excluded.pending_tier,
          pending_effective_at = excluded.pending_effective_at`.execute(trx);
      await this.emit(trx, events);
    });
  }

  async usersForTierEvaluation(beforeMs: number, limit: number): Promise<readonly string[]> {
    return this.tx(async (trx) => {
      const r = await sql<{ user_id: string }>`
        select s.user_id::text as user_id from (select distinct user_id from spend_events) s
        left join tier_status t on t.user_id = s.user_id
        where t.user_id is null or t.evaluated_at < ${iso(beforeMs)}::timestamptz
        order by 1 limit ${limit}`.execute(trx);
      return r.rows.map((x) => x.user_id);
    });
  }

  // ---- challenges ----

  async insertChallenge(c: ChallengeRow): Promise<"inserted" | "duplicate_code"> {
    return this.tx(async (trx) => {
      const r = await sql<{ id: string }>`
        insert into challenges (id, code, rule, window_start, window_end, reward_coins, active, created_at)
        values (${c.id}::uuid, ${c.code}, ${JSON.stringify(c.rule)}::jsonb, ${iso(c.windowStartMs)}::timestamptz,
          ${iso(c.windowEndMs)}::timestamptz, ${c.rewardCoins.toString()}::bigint, ${c.active}, ${iso(c.createdAtMs)}::timestamptz)
        on conflict (code) do nothing returning id::text as id`.execute(trx);
      return r.rows[0] === undefined ? "duplicate_code" : "inserted";
    });
  }

  async listChallenges(f: { activeAtMs: number | null }): Promise<readonly ChallengeRow[]> {
    return this.tx(async (trx) => {
      const r = await sql<unknown>`
        select id::text as id, code, rule, ${EPOCH_MS("window_start")} as start_ms, ${EPOCH_MS("window_end")} as end_ms,
          reward_coins::text as reward_coins, active, ${EPOCH_MS("created_at")} as created_ms
        from challenges
        where (${f.activeAtMs === null}::boolean
               or (active and window_start <= ${iso(f.activeAtMs ?? 0)}::timestamptz and ${iso(f.activeAtMs ?? 0)}::timestamptz < window_end))
        order by created_at, id`.execute(trx);
      return r.rows.map((x) => {
        const p = ChallengeDbRow.parse(x);
        return { id: p.id, code: p.code, rule: p.rule, windowStartMs: p.start_ms, windowEndMs: p.end_ms, rewardCoins: p.reward_coins, active: p.active, createdAtMs: p.created_ms };
      });
    });
  }

  async deactivateChallenge(id: string): Promise<boolean> {
    if (!UUID.test(id)) return false;
    return this.tx(async (trx) => {
      const r = await sql<{ id: string }>`update challenges set active = false where id = ${id}::uuid and active returning id::text as id`.execute(trx);
      return r.rows[0] !== undefined;
    });
  }

  // ---- games ----

  async publishOdds(v: OddsVersion, events: readonly RewardEvent[]): Promise<"ok" | "stale"> {
    return this.tx(async (trx) => {
      const r = await sql<{ id: string }>`
        insert into game_odds_versions (id, game, version, odds, published_at, effective_from, approval_id)
        values (${v.id}::uuid, ${v.game}, ${v.version}, ${oddsJson(v.table)}::jsonb, ${iso(v.publishedAtMs)}::timestamptz,
          ${iso(v.effectiveFromMs)}::timestamptz, ${v.approvalId})
        on conflict (game, version) do nothing returning id::text as id`.execute(trx);
      if (r.rows[0] === undefined) return "stale";
      await this.emit(trx, events);
      return "ok";
    });
  }

  async latestOddsVersionNumber(game: Game): Promise<number> {
    return this.tx(async (trx) => {
      const r = await sql<{ v: number }>`select coalesce(max(version), 0)::int as v from game_odds_versions where game = ${game}`.execute(trx);
      return r.rows[0]?.v ?? 0;
    });
  }

  async effectiveOdds(game: Game, nowMs: number): Promise<OddsVersion | null> {
    return this.tx(async (trx) => {
      const r = await sql<unknown>`
        select ${ODDS_COLS} from game_odds_versions
        where game = ${game} and effective_from <= ${iso(nowMs)}::timestamptz order by version desc limit 1`.execute(trx);
      const row = r.rows[0];
      return row === undefined ? null : toOdds(row);
    });
  }

  async upcomingOdds(game: Game, nowMs: number): Promise<readonly OddsVersion[]> {
    return this.tx(async (trx) => {
      const r = await sql<unknown>`
        select ${ODDS_COLS} from game_odds_versions
        where game = ${game} and effective_from > ${iso(nowMs)}::timestamptz order by version`.execute(trx);
      return r.rows.map(toOdds);
    });
  }

  async oddsById(id: string): Promise<OddsVersion | null> {
    if (!UUID.test(id)) return null;
    return this.tx(async (trx) => {
      const r = await sql<unknown>`select ${ODDS_COLS} from game_odds_versions where id = ${id}::uuid`.execute(trx);
      const row = r.rows[0];
      return row === undefined ? null : toOdds(row);
    });
  }

  async playByIntent(userId: string, game: Game, intentId: string): Promise<PlayRow | null> {
    if (!UUID.test(userId)) return null;
    return this.tx(async (trx) => {
      const r = await sql<unknown>`
        select ${PLAY_COLS} from game_plays where user_id = ${userId}::uuid and game = ${game} and intent_id = ${intentId}`.execute(trx);
      const row = r.rows[0];
      return row === undefined ? null : toPlay(row);
    });
  }

  async playsOnDay(userId: string, game: Game, dayKey: string): Promise<number> {
    if (!UUID.test(userId)) return 0;
    return this.tx(async (trx) => {
      const r = await sql<{ n: number }>`
        select count(*)::int as n from game_plays where user_id = ${userId}::uuid and game = ${game} and day_key = ${dayKey}::date`.execute(trx);
      return r.rows[0]?.n ?? 0;
    });
  }

  async insertPlay(p: PlayRow): Promise<"inserted" | "duplicate" | "cap"> {
    return this.tx(async (trx): Promise<"inserted" | "duplicate" | "cap"> => {
      // ON CONFLICT DO NOTHING covers all three unique constraints; the reason is read back after.
      const r = await sql<{ id: string }>`
        insert into game_plays (id, user_id, game, intent_id, day_key, seq, odds_version_id, roll_ppm, outcome_id, outcome_kind,
          coins, voucher_template_id, server_seed, server_seed_hash, source_ref, reward_ref, settled_at, created_at)
        values (${p.id}::uuid, ${p.userId}::uuid, ${p.game}, ${p.intentId}, ${p.dayKey}::date, ${p.seq}, ${p.oddsVersionId}::uuid,
          ${p.rollPpm}, ${p.outcomeId}, ${p.outcomeKind}, ${p.coins === null ? null : p.coins.toString()}::bigint,
          ${p.voucherTemplateId}, ${p.serverSeed}, ${p.serverSeedHash}, ${p.sourceRef}, ${p.rewardRef},
          ${p.settledAtMs === null ? null : iso(p.settledAtMs)}::timestamptz, ${iso(p.createdAtMs)}::timestamptz)
        on conflict do nothing returning id::text as id`.execute(trx);
      if (r.rows[0] !== undefined) return "inserted";
      const same = await sql<{ id: string }>`
        select id::text as id from game_plays
        where (user_id = ${p.userId}::uuid and game = ${p.game} and intent_id = ${p.intentId})
           or (${p.sourceRef}::text is not null and game = ${p.game} and source_ref = ${p.sourceRef})`.execute(trx);
      return same.rows[0] === undefined ? "cap" : "duplicate";
    });
  }

  async settlePlay(playId: string, rewardRef: string | null, settledAtMs: number, events: readonly RewardEvent[]): Promise<void> {
    await this.tx(async (trx) => {
      const r = await sql<{ id: string }>`
        update game_plays set reward_ref = ${rewardRef}, settled_at = ${iso(settledAtMs)}::timestamptz
        where id = ${playId}::uuid and settled_at is null returning id::text as id`.execute(trx);
      if (r.rows[0] !== undefined) await this.emit(trx, events);
    });
  }

  async lastPlay(userId: string, game: Game): Promise<PlayRow | null> {
    if (!UUID.test(userId)) return null;
    return this.tx(async (trx) => {
      const r = await sql<unknown>`
        select ${PLAY_COLS} from game_plays where user_id = ${userId}::uuid and game = ${game} order by created_at desc, id desc limit 1`.execute(trx);
      const row = r.rows[0];
      return row === undefined ? null : toPlay(row);
    });
  }

  async addEntitlement(userId: string, sourceRef: string, atMs: number): Promise<"inserted" | "duplicate"> {
    return this.tx(async (trx) => {
      const r = await sql<{ id: string }>`
        insert into game_entitlements (id, user_id, source_ref, created_at)
        values (${this.ids.uuidV7()}::uuid, ${userId}::uuid, ${sourceRef}, ${iso(atMs)}::timestamptz)
        on conflict (source_ref) do nothing returning id::text as id`.execute(trx);
      return r.rows[0] === undefined ? "duplicate" : "inserted";
    });
  }

  async unusedEntitlement(userId: string, game: Game): Promise<string | null> {
    if (!UUID.test(userId)) return null;
    return this.tx(async (trx) => {
      const r = await sql<{ source_ref: string }>`
        select e.source_ref from game_entitlements e
        where e.user_id = ${userId}::uuid
          and not exists (select 1 from game_plays p where p.game = ${game} and p.source_ref = e.source_ref)
        order by e.created_at, e.id limit 1`.execute(trx);
      return r.rows[0]?.source_ref ?? null;
    });
  }
}
