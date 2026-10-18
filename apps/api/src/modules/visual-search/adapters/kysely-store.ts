import { sql, type Kysely } from "kysely";
import { z } from "zod";
import {
  IndexUnavailableError,
  type EvalRunRecord,
  type IdPort,
  type ImageMime,
  type Neighbor,
  type QuotaResult,
  type RequestLog,
  type VisualIndexPort,
  type VisualSearchStore,
} from "../domain/ports";
import { cosine } from "../domain/similarity";

export type VisualDb = Kysely<Record<string, never>>;

const ts = (ms: number) => sql`to_timestamp(${ms}::double precision / 1000.0)`;
const utcDay = (ms: number) => sql`((to_timestamp(${ms}::double precision / 1000.0)) at time zone 'UTC')::date`;
const IdRow = z.object({ id: z.string() });
const CountRow = z.object({ n: z.string().regex(/^\d+$/).transform((s) => Number(s)) });

export class KyselyVisualStore implements VisualSearchStore {
  constructor(
    private readonly db: VisualDb,
    private readonly ids: IdPort,
  ) {}

  async recordUpload(u: { id: string; ownerId: string; contentType: ImageMime; createdAtMs: number; expiresAtMs: number }): Promise<void> {
    await sql`
      insert into visual_search_uploads (id, owner_id, content_type, created_at, expires_at)
      values (${u.id}, ${u.ownerId}::uuid, ${u.contentType}, ${ts(u.createdAtMs)}, ${ts(u.expiresAtMs)})`.execute(this.db);
  }

  async claimUpload(ownerId: string, id: string, nowMs: number): Promise<boolean> {
    const r = await sql`
      update visual_search_uploads set consumed_at = ${ts(nowMs)}
      where id = ${id} and owner_id = ${ownerId}::uuid and consumed_at is null and deleted_at is null
        and expires_at > ${ts(nowMs)}
      returning id`.execute(this.db);
    return r.rows.length === 1;
  }

  async expiredUploads(nowMs: number, limit: number): Promise<readonly string[]> {
    const r = await sql`
      select id from visual_search_uploads
      where deleted_at is null and expires_at <= ${ts(nowMs)}
      order by expires_at limit ${limit}`.execute(this.db);
    return r.rows.map((x) => IdRow.parse(x).id);
  }

  async markUploadsDeleted(ids: readonly string[], nowMs: number): Promise<void> {
    if (ids.length === 0) return;
    await sql`update visual_search_uploads set deleted_at = ${ts(nowMs)}
              where id = any(${ids as string[]}::text[]) and deleted_at is null`.execute(this.db);
  }

  async consumeQuota(i: { userId: string; nowMs: number; userDailyLimit: number; globalDailyLimit: number }): Promise<QuotaResult> {
    return this.db.transaction().execute(async (trx): Promise<QuotaResult> => {
      const bump = async (subject: string, limit: number): Promise<boolean> => {
        const r = await sql`
          insert into visual_search_usage (day, subject, used) values (${utcDay(i.nowMs)}, ${subject}, 1)
          on conflict (day, subject) do update set used = visual_search_usage.used + 1
            where visual_search_usage.used < ${limit}
          returning used`.execute(trx);
        return r.rows.length === 1;
      };
      if (!(await bump("global", i.globalDailyLimit))) return "global_limit";
      if (!(await bump(i.userId, i.userDailyLimit))) {
        await sql`update visual_search_usage set used = used - 1 where day = ${utcDay(i.nowMs)} and subject = 'global'`.execute(trx);
        return "user_limit";
      }
      return "ok";
    });
  }

  async recordRequest(r: RequestLog): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await sql`
        insert into visual_search_requests (id, ts, mode, outcome, latency_ms, result_count, category_guess, model_version)
        values (${r.id}::uuid, ${ts(r.tsMs)}, ${r.mode}, ${r.outcome}, ${r.latencyMs}, ${r.resultCount}, ${r.categoryGuess}, ${r.modelVersion})`.execute(trx);
      const payload = { mode: r.mode, outcome: r.outcome, result_count: r.resultCount, latency_ms: r.latencyMs, category: r.categoryGuess };
      await sql`
        insert into outbox_events (id, aggregate_type, aggregate_id, event_type, ordering_key, payload)
        values (${this.ids.uuidV7()}::uuid, 'visual_search', ${r.id}::uuid, 'visual_search.performed',
                ${`visual_search:${r.id}`}, ${JSON.stringify(payload)}::jsonb)`.execute(trx);
    });
  }

  async purge(beforeMs: number): Promise<{ uploads: number; requests: number; usage: number }> {
    const count = async (q: ReturnType<typeof sql>): Promise<number> => CountRow.parse((await q.execute(this.db)).rows[0]).n;
    const uploads = await count(sql`with d as (delete from visual_search_uploads where expires_at < ${ts(beforeMs)} and deleted_at is not null returning 1) select count(*)::text as n from d`);
    const requests = await count(sql`with d as (delete from visual_search_requests where ts < ${ts(beforeMs)} returning 1) select count(*)::text as n from d`);
    const usage = await count(sql`with d as (delete from visual_search_usage where day < ${utcDay(beforeMs)} returning 1) select count(*)::text as n from d`);
    return { uploads, requests, usage };
  }

  async saveEvalRun(r: EvalRunRecord): Promise<void> {
    await sql`
      insert into visual_search_eval_runs (id, set_name, model_version, k, queries, recall_at_k, mrr, coverage, passed, ran_at)
      values (${r.id}::uuid, ${r.setName}, ${r.modelVersion}, ${r.k}, ${r.queries}, ${r.recallAtK}, ${r.mrr}, ${r.coverage}, ${r.passed}, ${ts(r.ranAtMs)})`.execute(this.db);
  }
}

const NeighborRow = z.object({ product_id: z.string(), sim: z.string() });
const ExactRow = z.object({ product_id: z.string(), vec: z.string() });
const VecRow = z.object({ vec: z.string(), model_version: z.string() });
const NumberArray = z.array(z.number());

export interface KyselyVisualIndexOptions {
  /**
   * Permit the bounded exact scan over the jsonb column when pgvector's vec_pg column is absent.
   * Tests and tiny catalogs only: production composition leaves this false, so a missing index is a
   * 503 and the PDP falls back to attributes, never a silent empty result.
   */
  readonly allowExactScan?: boolean;
  readonly exactScanCap?: number;
}

/**
 * ADR-0023 default: pgvector HNSW on product_embeddings.vec_pg (migration 0069) with cosine distance,
 * filtered by model_version. Reads a replica in production.
 */
export class KyselyVisualIndex implements VisualIndexPort {
  private pg: boolean | null = null;
  constructor(
    private readonly db: VisualDb,
    private readonly opts: KyselyVisualIndexOptions = {},
  ) {}

  async mode(): Promise<"pgvector" | "exact-scan" | "unavailable"> {
    if (this.pg === null) {
      const r = await sql`select 1 as one from information_schema.columns
        where table_name = 'product_embeddings' and column_name = 'vec_pg' limit 1`.execute(this.db);
      this.pg = r.rows.length > 0;
    }
    return this.pg ? "pgvector" : this.opts.allowExactScan === true ? "exact-scan" : "unavailable";
  }

  async search(input: { vector: readonly number[]; modelVersion: string; k: number }): Promise<readonly Neighbor[]> {
    try {
      const mode = await this.mode();
      if (mode === "unavailable") throw new IndexUnavailableError("pgvector column vec_pg is not available");
      if (mode === "pgvector") {
        const lit = `[${input.vector.join(",")}]`;
        const r = await sql`
          select product_id::text as product_id, (1 - (vec_pg <=> ${lit}::vector))::text as sim
          from product_embeddings
          where model_version = ${input.modelVersion} and vec_pg is not null
          order by vec_pg <=> ${lit}::vector, product_id
          limit ${input.k}`.execute(this.db);
        return r.rows.map((raw) => {
          const x = NeighborRow.parse(raw);
          return { productId: x.product_id, similarity: Number(x.sim) };
        });
      }
      const cap = this.opts.exactScanCap ?? 5000;
      const r = await sql`
        select product_id::text as product_id, vec::text as vec from product_embeddings
        where model_version = ${input.modelVersion} order by product_id limit ${cap + 1}`.execute(this.db);
      if (r.rows.length > cap) throw new IndexUnavailableError("exact scan cap exceeded");
      return r.rows
        .map((raw) => {
          const x = ExactRow.parse(raw);
          return { productId: x.product_id, similarity: cosine(input.vector, NumberArray.parse(JSON.parse(x.vec))) };
        })
        .sort((a, b) => b.similarity - a.similarity || (a.productId < b.productId ? -1 : 1))
        .slice(0, input.k);
    } catch (e) {
      if (e instanceof IndexUnavailableError) throw e;
      throw new IndexUnavailableError(e instanceof Error ? e.message : "index error");
    }
  }

  async vectorOf(productId: string) {
    try {
      const r = await sql`select vec::text as vec, model_version from product_embeddings where product_id = ${productId}::uuid`.execute(this.db);
      const raw = r.rows[0];
      if (raw === undefined) return null;
      const x = VecRow.parse(raw);
      return { vector: NumberArray.parse(JSON.parse(x.vec)), modelVersion: x.model_version };
    } catch (e) {
      throw new IndexUnavailableError(e instanceof Error ? e.message : "index error");
    }
  }
}
