import { sql, type Kysely } from "kysely";
import { z } from "zod";
import { SLOTS, type FeedbackSignal, type MissingSlot } from "../domain/bridge";
import type {
  FeedbackRecord,
  IdPort,
  OutfitRecord,
  StoredItem,
  StylistEvent,
  StylistStore,
} from "../domain/ports";

/** Raw SQL with Zod validated rows, as in the reviews and wishlists adapters. */
export type StylistDb = Kysely<Record<string, never>>;

const Int = z.string().regex(/^-?\d+$/);
const Slot = z.enum(SLOTS);
const ItemJson = z.object({
  itemId: z.string(),
  storeId: z.string(),
  slot: Slot,
  pricePiastres: z.string().regex(/^\d+$/),
  verifiedDiscountPct: z.number().int(),
});
const MissingJson = z.object({
  slot: Slot,
  reason: z.enum(["budget", "no_item_in_size"]),
  addPiastres: z.string().regex(/^\d+$/).nullable(),
});
const RequestJson = z.object({
  occasion: z.string().nullable(),
  season: z.enum(["summer", "winter", "spring", "autumn", "all"]),
  modest: z.boolean(),
  world: z.enum(["local", "global", "everything", "my_stores"]),
  budgetSource: z.enum(["none", "user", "budget_suite"]),
});
const ScoresJson = z.object({ score: z.number().int(), missing: z.array(MissingJson) });

const OutfitRow = z.object({
  id: z.string(),
  generation_id: z.string(),
  user_id: z.string(),
  kind: z.enum(["outfit", "complete_look", "capsule", "wishlist"]),
  source: z.enum(["ml", "rules"]),
  complete: z.boolean(),
  items: z.array(ItemJson),
  request: RequestJson,
  scores: ScoresJson,
  total: Int,
  budget: Int.nullable(),
  created_ms: Int,
  added_ms: Int.nullable(),
});

const FeedbackRow = z.object({
  id: z.string(),
  outfit_id: z.string(),
  user_id: z.string(),
  item_id: z.string(),
  signal: z.enum(["like", "dislike", "swap_in", "swap_out"]),
  at_ms: Int,
});

const EPOCH_MS = (col: string) => sql.raw(`floor(extract(epoch from ${col}) * 1000)::text`);
const OUTFIT_COLS = sql`id::text as id, generation_id::text as generation_id, user_id::text as user_id, kind, source,
  complete, items, request, scores, total_piastres::text as total, budget_piastres::text as budget,
  ${EPOCH_MS("created_at")} as created_ms, ${EPOCH_MS("added_to_bag_at")} as added_ms`;

const toItemJson = (i: StoredItem) => ({
  itemId: i.itemId,
  storeId: i.storeId,
  slot: i.slot,
  pricePiastres: i.pricePiastres.toString(),
  verifiedDiscountPct: i.verifiedDiscountPct,
});

const toRecord = (raw: unknown): OutfitRecord => {
  const r = OutfitRow.parse(raw);
  return {
    id: r.id,
    generationId: r.generation_id,
    userId: r.user_id,
    kind: r.kind,
    source: r.source,
    complete: r.complete,
    items: r.items.map((i) => ({ ...i, pricePiastres: BigInt(i.pricePiastres) })),
    missing: r.scores.missing.map(
      (m): MissingSlot => ({ slot: m.slot, reason: m.reason, addPiastres: m.addPiastres === null ? null : BigInt(m.addPiastres) }),
    ),
    score: r.scores.score,
    totalPiastres: BigInt(r.total),
    budgetPiastres: r.budget === null ? null : BigInt(r.budget),
    request: r.request,
    createdAtMs: Number(r.created_ms),
    addedToBagAtMs: r.added_ms === null ? null : Number(r.added_ms),
  };
};

/** Payloads carry ids, counters and enums. Never item titles, notes or exact budgets. */
function aggregateOf(e: StylistEvent): { type: string; id: string } {
  switch (e.type) {
    case "outfit.generated":
      return { type: "outfit", id: e.outfitIds[0] ?? e.userId };
    case "outfit.added_to_bag":
    case "stylist.feedback":
      return { type: "outfit", id: e.outfitId };
  }
}

export class KyselyStylistStore implements StylistStore {
  constructor(
    private readonly db: StylistDb,
    private readonly ids: IdPort,
  ) {}

  private async tx<T>(run: (trx: StylistDb) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      await sql`select set_config('app.role', 'system', true)`.execute(trx);
      return run(trx as unknown as StylistDb);
    });
  }

  private async emit(trx: StylistDb, events: readonly StylistEvent[]): Promise<void> {
    for (const e of events) {
      const agg = aggregateOf(e);
      await sql`
        insert into outbox_events (id, aggregate_type, aggregate_id, event_type, ordering_key, payload)
        values (${this.ids.uuidV7()}::uuid, ${agg.type}, ${agg.id}::uuid, ${e.type},
                ${`${agg.type}:${agg.id}`}, ${JSON.stringify(e)}::jsonb)`.execute(trx);
    }
  }

  async insertOutfits(records: readonly OutfitRecord[], events: readonly StylistEvent[]): Promise<void> {
    await this.tx(async (trx) => {
      for (const r of records) {
        await sql`
          insert into outfits (id, generation_id, user_id, request, items, scores, source, complete,
                               total_piastres, budget_piastres, kind, created_at)
          values (${r.id}::uuid, ${r.generationId}::uuid, ${r.userId}::uuid, ${JSON.stringify(r.request)}::jsonb,
                  ${JSON.stringify(r.items.map(toItemJson))}::jsonb,
                  ${JSON.stringify({
                    score: r.score,
                    missing: r.missing.map((m) => ({ slot: m.slot, reason: m.reason, addPiastres: m.addPiastres === null ? null : m.addPiastres.toString() })),
                  })}::jsonb,
                  ${r.source}, ${r.complete}, ${r.totalPiastres.toString()}::bigint,
                  ${r.budgetPiastres === null ? null : r.budgetPiastres.toString()}::bigint, ${r.kind},
                  to_timestamp(${r.createdAtMs}::double precision / 1000))`.execute(trx);
      }
      await this.emit(trx, events);
    });
  }

  async getOutfit(id: string): Promise<OutfitRecord | null> {
    return this.tx(async (trx) => {
      const res = await sql`select ${OUTFIT_COLS} from outfits where id = ${id}::uuid`.execute(trx);
      const row = res.rows[0];
      return row === undefined ? null : toRecord(row);
    });
  }

  async countSince(userId: string, sinceMs: number): Promise<number> {
    return this.tx(async (trx) => {
      const res = await sql`
        select count(distinct generation_id)::text as n from outfits
        where user_id = ${userId}::uuid and created_at >= to_timestamp(${sinceMs}::double precision / 1000)`.execute(trx);
      const row = res.rows[0];
      return row === undefined ? 0 : Number(z.object({ n: z.string() }).parse(row).n);
    });
  }

  async markAddedToBag(outfitId: string, userId: string, atMs: number, events: readonly StylistEvent[]): Promise<"marked" | "already"> {
    return this.tx(async (trx) => {
      // The conditional UPDATE is the idempotency point: only one concurrent caller sees a row.
      const res = await sql`
        update outfits set added_to_bag_at = to_timestamp(${atMs}::double precision / 1000)
        where id = ${outfitId}::uuid and user_id = ${userId}::uuid and added_to_bag_at is null
        returning id`.execute(trx);
      if (res.rows.length === 0) return "already";
      await this.emit(trx, events);
      return "marked";
    });
  }

  async upsertFeedback(f: FeedbackRecord, events: readonly StylistEvent[]): Promise<void> {
    await this.tx(async (trx) => {
      await sql`
        insert into stylist_feedback (id, outfit_id, user_id, item_id, signal, created_at)
        values (${f.id}::uuid, ${f.outfitId}::uuid, ${f.userId}::uuid, ${f.itemId}::uuid, ${f.signal},
                to_timestamp(${f.atMs}::double precision / 1000))
        on conflict (outfit_id, item_id) do update set signal = excluded.signal, created_at = excluded.created_at`.execute(trx);
      await this.emit(trx, events);
    });
  }

  async getFeedback(outfitId: string): Promise<readonly FeedbackRecord[]> {
    return this.tx(async (trx) => {
      const res = await sql`
        select id::text as id, outfit_id::text as outfit_id, user_id::text as user_id, item_id::text as item_id, signal,
               ${EPOCH_MS("created_at")} as at_ms
        from stylist_feedback where outfit_id = ${outfitId}::uuid order by item_id`.execute(trx);
      return res.rows.map((raw) => {
        const r = FeedbackRow.parse(raw);
        return {
          id: r.id,
          outfitId: r.outfit_id,
          userId: r.user_id,
          itemId: r.item_id,
          signal: r.signal as FeedbackSignal,
          atMs: Number(r.at_ms),
        };
      });
    });
  }

  async getStyleVector(userId: string): Promise<readonly number[] | null> {
    return this.tx(async (trx) => {
      const res = await sql`select vec from user_style_vectors where user_id = ${userId}::uuid`.execute(trx);
      const row = res.rows[0];
      return row === undefined ? null : z.object({ vec: z.array(z.number()) }).parse(row).vec;
    });
  }

  async putStyleVector(userId: string, vec: readonly number[], atMs: number): Promise<void> {
    await this.tx(async (trx) => {
      await sql`
        insert into user_style_vectors (user_id, vec, version, updated_at)
        values (${userId}::uuid, ${JSON.stringify(vec)}::jsonb, 1, to_timestamp(${atMs}::double precision / 1000))
        on conflict (user_id) do update set vec = excluded.vec, version = user_style_vectors.version + 1,
                                           updated_at = excluded.updated_at`.execute(trx);
    });
  }

  async eraseForUser(userId: string): Promise<void> {
    await this.tx(async (trx) => {
      await sql`delete from stylist_feedback where user_id = ${userId}::uuid`.execute(trx);
      await sql`delete from outfits where user_id = ${userId}::uuid`.execute(trx);
      await sql`delete from user_style_vectors where user_id = ${userId}::uuid`.execute(trx);
    });
  }
}
