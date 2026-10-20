import { afterAll, describe, expect, it } from "vitest";
import { InMemoryBrandReviewOverlay } from "../in-memory";
import { KyselyBrandReviewOverlay, type BrandReviewDb } from "../kysely-overlay";
import { createOverlayDatabase, migrationSql } from "./pglite-db";
import { describeOverlayContract } from "./overlay-contract";

const open: BrandReviewDb[] = [];

describeOverlayContract("in-memory", async () => new InMemoryBrandReviewOverlay());

describeOverlayContract("kysely/pglite", async () => {
  const { db } = await createOverlayDatabase();
  open.push(db);
  return new KyselyBrandReviewOverlay(db);
});

afterAll(async () => {
  await Promise.all(open.map((d) => d.destroy()));
});

const A = "00000000-0000-4000-8000-0000000000a1";

describe("kysely overlay specifics", () => {
  it("uses the injected clock for failed_at and last_retry_at", async () => {
    const { pg, db } = await createOverlayDatabase();
    open.push(db);
    const o = new KyselyBrandReviewOverlay(db, { nowMs: () => 1_760_000_000_000 });
    await o.setFailure(A, "provisioning_error");
    await o.recordRetry(A);
    await o.recordRetry(A);
    const r = await pg.query<{ f: string; l: string; n: number }>(
      `select (extract(epoch from failed_at)*1000)::bigint::text as f, (extract(epoch from last_retry_at)*1000)::bigint::text as l, retry_count as n from brand_review_overlay`,
    );
    expect(r.rows[0]).toEqual({ f: "1760000000000", l: "1760000000000", n: 2 });
  });

  it("rejects a half-written cosign pair and an inconsistent failure state at the database", async () => {
    const { pg, db } = await createOverlayDatabase();
    open.push(db);
    await expect(pg.exec(`insert into brand_review_overlay (application_id, cosign_first_approver_id) values ('${A}', '${A}')`)).rejects.toThrow();
    await expect(pg.exec(`insert into brand_review_overlay (application_id, provisioning_state) values ('${A}', 'PROVISIONING_FAILED')`)).rejects.toThrow();
  });

  it("migration enables row level security with system-only policies", async () => {
    const { pg, db } = await createOverlayDatabase();
    open.push(db);
    const r = await pg.query<{ relrowsecurity: boolean }>(`select relrowsecurity from pg_class where relname = 'brand_review_overlay'`);
    expect(r.rows[0]?.relrowsecurity).toBe(true);
    expect(migrationSql("0054_brand_review_overlay.sql")).toContain("app_role() = 'system'");
  });
});
