import { sql, type Kysely } from "kysely";
import { z } from "zod";
import type { BrandReviewOverlay, OverlayFailureCode, PendingCosign } from "./domain";

/** Raw SQL with Zod-validated rows (same approach as brand-verification and ads). */
export type BrandReviewDb = Kysely<Record<string, never>>;

const Ms = z.string().regex(/^-?\d+$/).transform((s) => Number(s));
const CosignRow = z.object({ approver: z.string(), requested_ms: Ms });
const FailureRow = z.object({ code: z.enum(["store_name_conflict", "provisioning_error"]) });
const ConflictRow = z.object({ store_id: z.string().nullable() });
const IdRow = z.object({ id: z.string() });

const ts = (ms: number) => sql`to_timestamp(${ms}::double precision / 1000.0)`;

/**
 * Postgres overlay (migration 0054, `brand_review_overlay`): one row per application, system role only.
 * Cosign and failure columns are independent, so each write touches only its own columns.
 */
export class KyselyBrandReviewOverlay implements BrandReviewOverlay {
  constructor(
    private readonly db: BrandReviewDb,
    private readonly clock: { nowMs(): number } = { nowMs: () => Date.now() },
  ) {}

  private async tx<T>(fn: (t: BrandReviewDb) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      await sql`select set_config('app.role', 'system', true)`.execute(trx);
      return fn(trx as unknown as BrandReviewDb);
    });
  }

  getCosign(id: string): Promise<PendingCosign | null> {
    return this.tx(async (t) => {
      const r = await sql`
        select cosign_first_approver_id::text as approver, (extract(epoch from cosign_requested_at) * 1000)::bigint::text as requested_ms
        from brand_review_overlay where application_id = ${id}::uuid and cosign_first_approver_id is not null`.execute(t);
      const row = r.rows[0];
      if (row === undefined) return null;
      const p = CosignRow.parse(row);
      return { firstApproverId: p.approver, requestedAtMs: p.requested_ms };
    });
  }

  setCosign(id: string, c: PendingCosign): Promise<void> {
    return this.tx(async (t) => {
      await sql`
        insert into brand_review_overlay (application_id, cosign_first_approver_id, cosign_requested_at)
        values (${id}::uuid, ${c.firstApproverId}::uuid, ${ts(c.requestedAtMs)})
        on conflict (application_id) do update
          set cosign_first_approver_id = excluded.cosign_first_approver_id, cosign_requested_at = excluded.cosign_requested_at`.execute(t);
    });
  }

  clearCosign(id: string): Promise<void> {
    return this.tx(async (t) => {
      await sql`update brand_review_overlay set cosign_first_approver_id = null, cosign_requested_at = null
        where application_id = ${id}::uuid`.execute(t);
    });
  }

  getFailure(id: string): Promise<OverlayFailureCode | null> {
    return this.tx(async (t) => {
      const r = await sql`select provisioning_failure as code from brand_review_overlay
        where application_id = ${id}::uuid and provisioning_state = 'PROVISIONING_FAILED'`.execute(t);
      const row = r.rows[0];
      return row === undefined ? null : FailureRow.parse(row).code;
    });
  }

  setFailure(id: string, code: OverlayFailureCode): Promise<void> {
    const at = this.clock.nowMs();
    return this.tx(async (t) => {
      // failed_at keeps the FIRST failure time so the retry sweep is oldest-first and fair.
      await sql`
        insert into brand_review_overlay (application_id, provisioning_state, provisioning_failure, failed_at)
        values (${id}::uuid, 'PROVISIONING_FAILED', ${code}, ${ts(at)})
        on conflict (application_id) do update
          set provisioning_state = 'PROVISIONING_FAILED', provisioning_failure = excluded.provisioning_failure,
              failed_at = coalesce(case when brand_review_overlay.provisioning_state = 'PROVISIONING_FAILED'
                                        then brand_review_overlay.failed_at end, excluded.failed_at)`.execute(t);
    });
  }

  clearFailure(id: string): Promise<void> {
    return this.tx(async (t) => {
      await sql`update brand_review_overlay
        set provisioning_state = 'NONE', provisioning_failure = null, failed_at = null, conflicting_store_id = null,
            retry_count = 0, last_retry_at = null
        where application_id = ${id}::uuid`.execute(t);
    });
  }

  listFailures(limit: number): Promise<readonly string[]> {
    const n = Math.min(Math.max(Math.trunc(limit), 1), 200);
    return this.tx(async (t) => {
      const r = await sql`select application_id::text as id from brand_review_overlay
        where provisioning_state = 'PROVISIONING_FAILED' order by failed_at, application_id limit ${n}`.execute(t);
      return r.rows.map((x) => IdRow.parse(x).id);
    });
  }

  recordConflict(id: string, conflictingStoreId: string): Promise<void> {
    return this.tx(async (t) => {
      await sql`
        insert into brand_review_overlay (application_id, conflicting_store_id)
        values (${id}::uuid, ${conflictingStoreId}::uuid)
        on conflict (application_id) do update set conflicting_store_id = excluded.conflicting_store_id`.execute(t);
    });
  }

  conflictingStoreId(id: string): Promise<string | null> {
    return this.tx(async (t) => {
      const r = await sql`select conflicting_store_id::text as store_id from brand_review_overlay
        where application_id = ${id}::uuid`.execute(t);
      const row = r.rows[0];
      return row === undefined ? null : ConflictRow.parse(row).store_id;
    });
  }

  recordRetry(id: string): Promise<void> {
    const at = this.clock.nowMs();
    return this.tx(async (t) => {
      await sql`update brand_review_overlay set retry_count = retry_count + 1, last_retry_at = ${ts(at)}
        where application_id = ${id}::uuid`.execute(t);
    });
  }
}
