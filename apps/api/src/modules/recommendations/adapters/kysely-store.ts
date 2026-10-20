import { sql, type Kysely } from "kysely";
import { z } from "zod";
import type { ExplorationStats, Neighbor } from "../domain/bridge";
import type {
  CooccurrenceKind,
  CooccurrenceRow,
  IdPort,
  RecModule,
  RecOutboxEvent,
  RecoStore,
  VectorIndexPort,
} from "../domain/ports";

export type RecoDb = Kysely<Record<string, never>>;

const Int = z.string().regex(/^-?\d+$/).transform((s) => Number(s));
const NeighborRow = z.object({ product_id: z.string(), score: Int });
const StatRow = z.object({ product_id: z.string(), impressions: Int, clicks: Int });
const ts = (ms: number) => sql`to_timestamp(${ms}::double precision / 1000.0)`;

const payloadOf = (e: RecOutboxEvent): Record<string, unknown> =>
  e.type === "recommendation.impression"
    ? { module: e.module, model_version: e.modelVersion, product_ids: e.productIds, personalized: e.personalized }
    : { module: e.module, model_version: e.modelVersion, product_id: e.productId };

export class KyselyRecoStore implements RecoStore {
  constructor(
    private readonly db: RecoDb,
    private readonly ids: IdPort,
  ) {}

  async neighbors(productId: string, kind: CooccurrenceKind, limit: number): Promise<readonly Neighbor[]> {
    const r = await sql`
      select item_b::text as product_id, score::text as score from item_cooccurrence
      where item_a = ${productId}::uuid and kind = ${kind}
      order by item_cooccurrence.score desc, item_b limit ${limit}`.execute(this.db);
    return r.rows.map((raw) => {
      const x = NeighborRow.parse(raw);
      return { productId: x.product_id, score: x.score };
    });
  }

  async upsertCooccurrence(rows: readonly CooccurrenceRow[], nowMs: number): Promise<number> {
    let n = 0;
    await this.db.transaction().execute(async (trx) => {
      for (const r of rows) {
        if (r.itemA === r.itemB || r.score <= 0) continue;
        await sql`
          insert into item_cooccurrence (item_a, item_b, kind, score, window_days, computed_at)
          values (${r.itemA}::uuid, ${r.itemB}::uuid, ${r.kind}, ${r.score}, ${r.windowDays}, ${ts(nowMs)})
          on conflict (item_a, item_b, kind) do update set score = excluded.score,
            window_days = excluded.window_days, computed_at = excluded.computed_at`.execute(trx);
        n++;
      }
    });
    return n;
  }

  async activeModelVersion(): Promise<string | null> {
    const r = await sql<{ version: string }>`select version from ranking_models where status = 'active' limit 1`.execute(this.db);
    return r.rows[0]?.version ?? null;
  }

  async explorationStats(productIds: readonly string[]): Promise<ReadonlyMap<string, ExplorationStats>> {
    const out = new Map<string, ExplorationStats>();
    if (productIds.length === 0) return out;
    const r = await sql`
      select product_id::text as product_id, impressions::text as impressions, clicks::text as clicks
      from recommendation_item_stats
      where module = 'exploration' and product_id = any(${productIds as string[]}::uuid[])`.execute(this.db);
    for (const raw of r.rows) {
      const x = StatRow.parse(raw);
      out.set(x.product_id, { impressions: x.impressions, clicks: x.clicks });
    }
    return out;
  }

  private async emit(trx: RecoDb, e: RecOutboxEvent): Promise<void> {
    const aggId = e.type === "recommendation.click" ? e.productId : this.ids.uuidV7();
    await sql`
      insert into outbox_events (id, aggregate_type, aggregate_id, event_type, ordering_key, payload)
      values (${this.ids.uuidV7()}::uuid, 'recommendation', ${aggId}::uuid, ${e.type},
              ${`recommendation:${aggId}`}, ${JSON.stringify(payloadOf(e))}::jsonb)`.execute(trx);
  }

  async recordImpressions(module: RecModule, productIds: readonly string[], event: RecOutboxEvent, nowMs: number): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      for (const id of [...new Set(productIds)].sort()) {
        await sql`
          insert into recommendation_item_stats (product_id, module, impressions, clicks, updated_at)
          values (${id}::uuid, ${module}, 1, 0, ${ts(nowMs)})
          on conflict (product_id, module) do update set impressions = recommendation_item_stats.impressions + 1,
            updated_at = excluded.updated_at`.execute(trx);
      }
      await this.emit(trx, event);
    });
  }

  async recordClick(module: RecModule, productId: string, event: RecOutboxEvent, nowMs: number): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await sql`
        insert into recommendation_item_stats (product_id, module, impressions, clicks, updated_at)
        values (${productId}::uuid, ${module}, 1, 1, ${ts(nowMs)})
        on conflict (product_id, module) do update set clicks = recommendation_item_stats.clicks + 1,
          impressions = greatest(recommendation_item_stats.impressions, recommendation_item_stats.clicks + 1),
          updated_at = excluded.updated_at`.execute(trx);
      await this.emit(trx, event);
    });
  }
}

/**
 * pgvector retrieval (ADR-0023 default). Reads `product_embeddings(product_id uuid, vec vector(768))`
 * owned by the embeddings pipeline, on the read replica. Cosine distance operator `<=>` with an HNSW
 * index (vector_cosine_ops). Throws when the extension or table is unavailable so callers degrade to
 * category rules; there is deliberately no silent empty result for a broken index.
 */
export class PgVectorIndex implements VectorIndexPort {
  constructor(
    private readonly db: RecoDb,
    private readonly table: "product_embeddings" = "product_embeddings",
  ) {}

  async nearest(productId: string, k: number): Promise<readonly Neighbor[]> {
    const rows = await sql`
      select b.product_id::text as product_id,
             round((1 - (b.vec <=> a.vec)) * 1000000)::text as score
      from ${sql.table(this.table)} a
      join lateral (
        select product_id, vec from ${sql.table(this.table)}
        where product_id <> a.product_id
        order by vec <=> a.vec
        limit ${k}
      ) b on true
      where a.product_id = ${productId}::uuid
      order by b.vec <=> a.vec`.execute(this.db);
    return rows.rows.map((raw) => {
      const x = NeighborRow.parse(raw);
      return { productId: x.product_id, score: x.score / 1_000_000 };
    });
  }
}
