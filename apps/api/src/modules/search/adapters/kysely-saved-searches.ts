import { sql } from "kysely";
import { z } from "zod";
import type { SearchFilter } from "../domain/bridge";
import type {
  SavedSearchCursor,
  SavedSearchPatch,
  SavedSearchRecord,
  SavedSearchRepository,
} from "../domain/ports";
import { filterFromStored, filterToWire } from "../domain/schema";
import type { SearchDb } from "./postgres-fts";

const Ms = z.string().regex(/^-?\d+$/u).transform((s) => Number(s));
const Row = z.object({
  id: z.string(),
  user_id: z.string(),
  name: z.string(),
  query_text: z.string().nullable(),
  filter_json: z.unknown(),
  alert_enabled: z.boolean(),
  last_run_ms: Ms.nullable(),
  created_ms: Ms,
  updated_ms: Ms,
});

const COLS = sql`id::text as id, user_id::text as user_id, name, query_text, filter_json, alert_enabled,
  floor(extract(epoch from last_run_at) * 1000)::text as last_run_ms,
  floor(extract(epoch from created_at) * 1000)::text as created_ms,
  floor(extract(epoch from updated_at) * 1000)::text as updated_ms`;

const toRecord = (raw: unknown): SavedSearchRecord => {
  const r = Row.parse(raw);
  return {
    id: r.id,
    userId: r.user_id,
    name: r.name,
    query: r.query_text,
    filter: filterFromStored(r.filter_json),
    alertEnabled: r.alert_enabled,
    lastRunAtMs: r.last_run_ms,
    createdAtMs: r.created_ms,
    updatedAtMs: r.updated_ms,
  };
};

const json = (f: SearchFilter): string => JSON.stringify(filterToWire(f));

/**
 * Postgres saved searches. Runs under the `system` DB role like the other adapters (ADR-0020);
 * ownership is enforced by the `user_id = $caller` predicate on every statement, so another user's
 * row is indistinguishable from a missing one. RLS stays on for every other role.
 */
export class KyselySavedSearchRepository implements SavedSearchRepository {
  constructor(private readonly db: SearchDb) {}

  private async tx<T>(run: (trx: SearchDb) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      await sql`select set_config('app.role', 'system', true)`.execute(trx);
      return run(trx as unknown as SearchDb);
    });
  }

  list(userId: string, limit: number, after: SavedSearchCursor | null): Promise<readonly SavedSearchRecord[]> {
    return this.tx(async (trx) => {
      const cursor =
        after === null
          ? sql``
          : sql`and (created_at, id) < (to_timestamp(${after.createdAtMs.toString()}::double precision / 1000), ${after.id}::uuid)`;
      const r = await sql<unknown>`
        select ${COLS} from saved_searches where user_id = ${userId}::uuid ${cursor}
         order by created_at desc, id desc limit ${limit}`.execute(trx);
      return r.rows.map(toRecord);
    });
  }

  get(userId: string, id: string): Promise<SavedSearchRecord | null> {
    return this.tx(async (trx) => {
      const r = await sql<unknown>`
        select ${COLS} from saved_searches where user_id = ${userId}::uuid and id = ${id}::uuid`.execute(trx);
      const row = r.rows[0];
      return row === undefined ? null : toRecord(row);
    });
  }

  count(userId: string): Promise<number> {
    return this.tx(async (trx) => {
      const r = await sql<{ n: string }>`select count(*)::text as n from saved_searches where user_id = ${userId}::uuid`.execute(trx);
      return Number(r.rows[0]?.n ?? "0");
    });
  }

  create(rec: SavedSearchRecord): Promise<void> {
    return this.tx(async (trx) => {
      await sql`
        insert into saved_searches (id, user_id, name, query_text, filter_json, alert_enabled, last_run_at, created_at, updated_at)
        values (${rec.id}::uuid, ${rec.userId}::uuid, ${rec.name}, ${rec.query}, ${json(rec.filter)}::jsonb,
                ${rec.alertEnabled}, null,
                to_timestamp(${rec.createdAtMs.toString()}::double precision / 1000),
                to_timestamp(${rec.updatedAtMs.toString()}::double precision / 1000))`.execute(trx);
    });
  }

  update(userId: string, id: string, patch: SavedSearchPatch, _nowMs: number): Promise<SavedSearchRecord | null> {
    return this.tx(async (trx) => {
      const r = await sql<unknown>`
        update saved_searches set
          name = coalesce(${patch.name?.trim() ?? null}, name),
          alert_enabled = coalesce(${patch.alertEnabled ?? null}::boolean, alert_enabled),
          filter_json = coalesce(${patch.filter === undefined ? null : json(patch.filter)}::jsonb, filter_json)
        where user_id = ${userId}::uuid and id = ${id}::uuid
        returning ${COLS}`.execute(trx);
      const row = r.rows[0];
      return row === undefined ? null : toRecord(row);
    });
  }

  delete(userId: string, id: string): Promise<boolean> {
    return this.tx(async (trx) => {
      const r = await sql`delete from saved_searches where user_id = ${userId}::uuid and id = ${id}::uuid`.execute(trx);
      return Number(r.numAffectedRows ?? 0n) > 0;
    });
  }
}
