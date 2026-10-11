import { sql, type Kysely } from "kysely";
import { z } from "zod";
import { money, promotions } from "../domain/bridge";
import type {
  OwnerFilter,
  PromotionPatch,
  PromotionRecord,
  PromotionRepository,
  RedemptionInput,
  RedemptionOutcome,
} from "../domain/ports";

/** Raw SQL only, rows validated with Zod (same approach as the cart and inventory adapters, ADR-0020). */
export type PromotionDb = Kysely<Record<string, never>>;

const Int = z.string().regex(/^-?\d+$/);
const Ms = Int.transform((s) => Number(s));
const Amount = Int.transform((s) => BigInt(s));
const Uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const UUID = Uuid;

const Row = z.object({
  id: Uuid,
  owner_kind: z.enum(["platform", "store"]),
  store_id: Uuid.nullable(),
  kind: z.enum(promotions.PROMOTION_KINDS),
  scope: z.enum(promotions.PROMOTION_SCOPES),
  code: z.string().nullable(),
  auto_apply: z.boolean(),
  title_ar: z.string(),
  title_en: z.string().nullable(),
  funding_platform_pct: z.number().int(),
  funding_seller_pct: z.number().int(),
  percent_bp: z.number().int().nullable(),
  fixed_amount: Amount.nullable(),
  bogo_buy_qty: z.number().int().nullable(),
  bogo_get_qty: z.number().int().nullable(),
  bogo_get_percent_bp: z.number().int().nullable(),
  tiers: z.array(z.object({ min_subtotal: z.string(), percent_bp: z.number().int() })).nullable(),
  min_order_amount: Amount.nullable(),
  max_discount_amount: Amount.nullable(),
  total_budget_amount: Amount.nullable(),
  per_user_cap: z.number().int().nullable(),
  per_day_cap: z.number().int().nullable(),
  target_store_ids: z.array(Uuid),
  target_sku_ids: z.array(Uuid),
  target_payment_methods: z.array(z.enum(promotions.PAYMENT_METHODS)),
  plus_only: z.boolean(),
  starts_ms: Ms,
  ends_ms: Ms,
  status: z.enum(promotions.PROMOTION_STATUSES),
  version: z.number().int(),
  created_by: Uuid,
  created_ms: Ms,
  updated_ms: Ms,
});

const COLUMNS = sql`
  id::text as id, owner_kind, store_id::text as store_id, kind, scope, code, auto_apply, title_ar, title_en,
  funding_platform_pct, funding_seller_pct, percent_bp, fixed_amount::text as fixed_amount,
  bogo_buy_qty, bogo_get_qty, bogo_get_percent_bp, tiers,
  min_order_amount::text as min_order_amount, max_discount_amount::text as max_discount_amount,
  total_budget_amount::text as total_budget_amount, per_user_cap, per_day_cap,
  array_to_json(target_store_ids) as target_store_ids, array_to_json(target_sku_ids) as target_sku_ids,
  array_to_json(target_payment_methods) as target_payment_methods, plus_only,
  floor(extract(epoch from starts_at) * 1000)::text as starts_ms,
  floor(extract(epoch from ends_at) * 1000)::text as ends_ms,
  status, version, created_by::text as created_by,
  floor(extract(epoch from created_at) * 1000)::text as created_ms,
  floor(extract(epoch from updated_at) * 1000)::text as updated_ms`;

const iso = (ms: number): string => new Date(ms).toISOString();
const text = (m: { amount: bigint } | null): string | null => (m === null ? null : m.amount.toString());

function value(r: z.infer<typeof Row>): promotions.PromotionValue {
  switch (r.kind) {
    case "percent":
      return { kind: "percent", percentBps: r.percent_bp ?? 0 };
    case "fixed":
      return { kind: "fixed", amount: money(r.fixed_amount ?? 0n) };
    case "free_shipping":
      return { kind: "free_shipping" };
    case "bogo":
      return {
        kind: "bogo",
        buyQty: r.bogo_buy_qty ?? 0,
        getQty: r.bogo_get_qty ?? 0,
        getPercentBps: r.bogo_get_percent_bp ?? 0,
      };
    case "tiered":
      return {
        kind: "tiered",
        tiers: (r.tiers ?? []).map((t) => ({ minSubtotal: money(BigInt(t.min_subtotal)), percentBps: t.percent_bp })),
      };
  }
}

function toRecord(raw: unknown): PromotionRecord {
  const r = Row.parse(raw);
  const m = (a: bigint | null) => (a === null ? null : money(a));
  return {
    id: r.id,
    version: r.version,
    owner: r.owner_kind === "store" && r.store_id !== null ? { kind: "store", storeId: r.store_id } : { kind: "platform" },
    scope: r.scope,
    value: value(r),
    code: r.code,
    autoApply: r.auto_apply,
    funding: { platformPct: r.funding_platform_pct, sellerPct: r.funding_seller_pct },
    targeting: {
      storeIds: r.target_store_ids,
      skuIds: r.target_sku_ids,
      paymentMethods: r.target_payment_methods,
      plusOnly: r.plus_only,
    },
    minOrder: m(r.min_order_amount),
    maxDiscount: m(r.max_discount_amount),
    perUserCap: r.per_user_cap,
    perDayCap: r.per_day_cap,
    totalBudget: m(r.total_budget_amount),
    startsAtMs: r.starts_ms,
    endsAtMs: r.ends_ms,
    status: r.status,
    title: { ar: r.title_ar, ...(r.title_en !== null ? { en: r.title_en } : {}) },
    createdBy: r.created_by,
    createdAtMs: r.created_ms,
    updatedAtMs: r.updated_ms,
  };
}

/** Thrown inside a transaction to roll the whole batch back, then mapped to a result. */
class Rejected extends Error {
  constructor(readonly outcome: Extract<RedemptionOutcome, { kind: "rejected" }>) {
    super("redemption rejected");
  }
}

const uuidArray = (xs: readonly string[]): string => {
  for (const x of xs) if (!UUID.safeParse(x).success) throw new Error("invalid uuid in array");
  return `{${xs.join(",")}}`;
};
const textArray = (xs: readonly string[]): string => {
  for (const x of xs) if (!/^[a-z_]+$/.test(x)) throw new Error("invalid text array element");
  return `{${xs.join(",")}}`;
};

/**
 * Postgres adapter. Each call is one transaction under the `system` DB role (authorization is the
 * route-level policy decision; RLS stays on for every other role). Redemptions lock the promotion
 * row (`FOR UPDATE`, ids in sorted order) before counting, so caps and budget cannot be overspent.
 */
export class KyselyPromotionRepository implements PromotionRepository {
  constructor(private readonly db: PromotionDb) {}

  private async tx<T>(run: (trx: PromotionDb) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      await sql`select set_config('app.role', 'system', true)`.execute(trx);
      return run(trx as unknown as PromotionDb);
    });
  }

  async insert(r: PromotionRecord): Promise<"created" | "code_taken"> {
    const v = r.value;
    const tiers =
      v.kind === "tiered"
        ? JSON.stringify(v.tiers.map((t) => ({ min_subtotal: t.minSubtotal.amount.toString(), percent_bp: t.percentBps })))
        : null;
    const res = await this.tx((trx) =>
      sql<{ id: string }>`
        insert into promotions (id, owner_kind, store_id, kind, scope, code, auto_apply, title_ar, title_en,
          funding_platform_pct, funding_seller_pct, percent_bp, fixed_amount, bogo_buy_qty, bogo_get_qty,
          bogo_get_percent_bp, tiers, min_order_amount, max_discount_amount, total_budget_amount,
          per_user_cap, per_day_cap, target_store_ids, target_sku_ids, target_payment_methods, plus_only,
          starts_at, ends_at, status, version, created_by, created_at, updated_at)
        values (${r.id}::uuid, ${r.owner.kind}, ${r.owner.kind === "store" ? r.owner.storeId : null}::uuid,
          ${v.kind}, ${r.scope}, ${r.code}, ${r.autoApply}, ${r.title.ar}, ${r.title.en ?? null},
          ${r.funding.platformPct}, ${r.funding.sellerPct},
          ${v.kind === "percent" ? v.percentBps : null}::integer,
          ${v.kind === "fixed" ? v.amount.amount.toString() : null}::bigint,
          ${v.kind === "bogo" ? v.buyQty : null}::integer, ${v.kind === "bogo" ? v.getQty : null}::integer,
          ${v.kind === "bogo" ? v.getPercentBps : null}::integer, ${tiers}::jsonb,
          ${text(r.minOrder)}::bigint, ${text(r.maxDiscount)}::bigint, ${text(r.totalBudget)}::bigint,
          ${r.perUserCap}::integer, ${r.perDayCap}::integer,
          ${uuidArray(r.targeting.storeIds)}::uuid[], ${uuidArray(r.targeting.skuIds)}::uuid[],
          ${textArray(r.targeting.paymentMethods)}::text[], ${r.targeting.plusOnly},
          ${iso(r.startsAtMs)}::timestamptz, ${iso(r.endsAtMs)}::timestamptz, ${r.status}, ${r.version},
          ${r.createdBy}::uuid, ${iso(r.createdAtMs)}::timestamptz, ${iso(r.updatedAtMs)}::timestamptz)
        on conflict (code) where code is not null do nothing
        returning id::text as id`.execute(trx),
    );
    return res.rows.length === 1 ? "created" : "code_taken";
  }

  async get(id: string): Promise<PromotionRecord | null> {
    if (!UUID.safeParse(id).success) return null;
    const r = await this.tx((trx) => sql<unknown>`select ${COLUMNS} from promotions where id = ${id}::uuid`.execute(trx));
    const row = r.rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async list(q: { owner: OwnerFilter; afterId: string | null; limit: number }): Promise<readonly PromotionRecord[]> {
    const after = q.afterId !== null && UUID.safeParse(q.afterId).success ? q.afterId : null;
    const r = await this.tx((trx) =>
      q.owner.kind === "platform"
        ? sql<unknown>`
            select ${COLUMNS} from promotions
             where owner_kind = 'platform' and (${after}::uuid is null or id > ${after}::uuid)
             order by id limit ${q.limit}`.execute(trx)
        : sql<unknown>`
            select ${COLUMNS} from promotions
             where owner_kind = 'store' and store_id = ${q.owner.storeId}::uuid
               and (${after}::uuid is null or id > ${after}::uuid)
             order by id limit ${q.limit}`.execute(trx),
    );
    return r.rows.map(toRecord);
  }

  async update(
    id: string,
    expectedVersion: number,
    patch: PromotionPatch,
    nowMs: number,
  ): Promise<PromotionRecord | "stale" | null> {
    if (!UUID.safeParse(id).success) return null;
    return this.tx(async (trx) => {
      const hasTitle = patch.title !== undefined;
      const res = await sql<{ id: string }>`
        update promotions set
          title_ar = case when ${hasTitle} then ${patch.title?.ar ?? ""} else title_ar end,
          title_en = case when ${hasTitle} then ${patch.title?.en ?? null}::text else title_en end,
          status = coalesce(${patch.status ?? null}::text, status),
          ends_at = coalesce(${patch.endsAtMs === undefined ? null : iso(patch.endsAtMs)}::timestamptz, ends_at),
          total_budget_amount = coalesce(${patch.totalBudget === undefined ? null : patch.totalBudget.amount.toString()}::bigint, total_budget_amount),
          max_discount_amount = coalesce(${patch.maxDiscount === undefined ? null : patch.maxDiscount.amount.toString()}::bigint, max_discount_amount),
          version = version + 1,
          updated_at = ${iso(nowMs)}::timestamptz
        where id = ${id}::uuid and version = ${expectedVersion}
        returning id::text as id`.execute(trx);
      if (res.rows.length === 1) {
        const r = await sql<unknown>`select ${COLUMNS} from promotions where id = ${id}::uuid`.execute(trx);
        const row = r.rows[0];
        return row === undefined ? null : toRecord(row);
      }
      const exists = await sql`select 1 from promotions where id = ${id}::uuid`.execute(trx);
      return exists.rows.length === 0 ? null : "stale";
    });
  }

  async candidates(q: {
    atMs: number;
    storeIds: readonly string[];
    codes: readonly string[];
  }): Promise<readonly PromotionRecord[]> {
    const stores = q.storeIds.filter((s) => UUID.safeParse(s).success);
    const r = await this.tx((trx) =>
      sql<unknown>`
        select ${COLUMNS} from promotions
         where status = 'active'
           and starts_at <= ${iso(q.atMs)}::timestamptz and ends_at > ${iso(q.atMs)}::timestamptz
           and ((auto_apply and (store_id is null or store_id::text = any (${stores}::text[])))
                or (code is not null and code = any (${[...q.codes]}::text[])))
         order by id`.execute(trx),
    );
    return r.rows.map(toRecord);
  }

  async usage(ids: readonly string[], userId: string, dayKey: string): Promise<ReadonlyMap<string, promotions.Usage>> {
    const out = new Map<string, promotions.Usage>(ids.map((i) => [i, { userRedemptions: 0, dayRedemptions: 0, spent: 0n }]));
    const valid = ids.filter((i) => UUID.safeParse(i).success);
    if (valid.length === 0) return out;
    const r = await this.tx((trx) =>
      sql<unknown>`
        select promotion_id::text as promotion_id,
               (count(*) filter (where user_id = ${userId}::uuid))::text as user_n,
               (count(*) filter (where day_key = ${dayKey}::date))::text as day_n,
               coalesce(sum(discount_amount), 0)::text as spent
          from promotion_redemptions
         where status = 'APPLIED' and promotion_id = any (${valid}::uuid[])
         group by promotion_id`.execute(trx),
    );
    const Usage = z.object({ promotion_id: z.string(), user_n: Int, day_n: Int, spent: Int });
    for (const raw of r.rows) {
      const u = Usage.parse(raw);
      out.set(u.promotion_id, {
        userRedemptions: Number(u.user_n),
        dayRedemptions: Number(u.day_n),
        spent: BigInt(u.spent),
      });
    }
    return out;
  }

  async recordRedemptions(inputs: readonly RedemptionInput[]): Promise<RedemptionOutcome> {
    const sorted = [...inputs].sort((a, b) => (a.promotionId < b.promotionId ? -1 : a.promotionId > b.promotionId ? 1 : 0));
    try {
      return await this.tx(async (trx) => {
        let recorded = 0;
        let existing = 0;
        for (const r of sorted) {
          const locked = await sql<unknown>`
            select per_user_cap, per_day_cap, total_budget_amount::text as budget
              from promotions where id = ${r.promotionId}::uuid for update`.execute(trx);
          const head = z
            .object({ per_user_cap: z.number().int().nullable(), per_day_cap: z.number().int().nullable(), budget: Int.nullable() })
            .safeParse(locked.rows[0]);
          if (!head.success) throw new Rejected({ kind: "rejected", promotionId: r.promotionId, reason: "not_found" });
          const dup = await sql`
            select 1 from promotion_redemptions
             where promotion_id = ${r.promotionId}::uuid and order_group_id = ${r.orderGroupId}::uuid`.execute(trx);
          if (dup.rows.length > 0) {
            existing += 1;
            continue;
          }
          const c = z
            .object({ user_n: Int, day_n: Int, spent: Int })
            .parse(
              (
                await sql<unknown>`
                  select (count(*) filter (where user_id = ${r.userId}::uuid))::text as user_n,
                         (count(*) filter (where day_key = ${r.dayKey}::date))::text as day_n,
                         coalesce(sum(discount_amount), 0)::text as spent
                    from promotion_redemptions
                   where promotion_id = ${r.promotionId}::uuid and status = 'APPLIED'`.execute(trx)
              ).rows[0],
            );
          const h = head.data;
          if (h.per_user_cap !== null && Number(c.user_n) >= h.per_user_cap) {
            throw new Rejected({ kind: "rejected", promotionId: r.promotionId, reason: "cap_reached" });
          }
          if (h.per_day_cap !== null && Number(c.day_n) >= h.per_day_cap) {
            throw new Rejected({ kind: "rejected", promotionId: r.promotionId, reason: "cap_reached" });
          }
          if (h.budget !== null && BigInt(c.spent) + r.amount > BigInt(h.budget)) {
            throw new Rejected({ kind: "rejected", promotionId: r.promotionId, reason: "budget_exhausted" });
          }
          await sql`
            insert into promotion_redemptions (promotion_id, promotion_version, user_id, order_group_id,
              discount_amount, platform_funded_amount, seller_funded_amount, day_key, redeemed_at)
            values (${r.promotionId}::uuid, ${r.promotionVersion}, ${r.userId}::uuid, ${r.orderGroupId}::uuid,
              ${r.amount.toString()}::bigint, ${r.platformFunded.toString()}::bigint,
              ${r.sellerFunded.toString()}::bigint, ${r.dayKey}::date, ${iso(r.atMs)}::timestamptz)`.execute(trx);
          recorded += 1;
        }
        return { kind: "recorded", recorded, existing } as const;
      });
    } catch (e) {
      if (e instanceof Rejected) return e.outcome;
      throw e;
    }
  }

  async reinstate(orderGroupId: string, nowMs: number): Promise<number> {
    if (!UUID.safeParse(orderGroupId).success) return 0;
    const r = await this.tx((trx) =>
      sql<{ id: string }>`
        update promotion_redemptions set status = 'REINSTATED', reinstated_at = ${iso(nowMs)}::timestamptz
         where order_group_id = ${orderGroupId}::uuid and status = 'APPLIED'
        returning id::text as id`.execute(trx),
    );
    return r.rows.length;
  }
}
