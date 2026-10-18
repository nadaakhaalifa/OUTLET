import { createTestDatabaseUpTo } from "@outlet/db";
import type { Kysely } from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import { KyselyBrandApplicationRepository, type SellersDb } from "../adapters/kysely-store";
import { createPgliteDatabase, type PgliteInstance } from "../../../platform/db";
import { APPLICANT_A, APPLICANT_B, appRow, hist } from "./fixtures";
import { describeSellersRepositoryContract } from "./repository-contract";

const open: Kysely<Record<string, never>>[] = [];

const fresh = async () => {
  const raw = await createTestDatabaseUpTo(51);
  const db: SellersDb = createPgliteDatabase<Record<string, never>>(raw as unknown as PgliteInstance);
  open.push(db);
  return {
    raw,
    repo: new KyselyBrandApplicationRepository(db),
    outboxTypes: async () => (await raw.query<{ t: string }>(`select event_type as t from outbox_events order by occurred_at, id`)).rows.map((r) => r.t),
  };
};

afterAll(async () => {
  await Promise.all(open.map((d) => d.destroy()));
});

describeSellersRepositoryContract("kysely/pglite", fresh);

describe("KyselyBrandApplicationRepository specifics", () => {
  it("RLS hides other applicants even for a direct query as app_user", async () => {
    const c = await fresh();
    await c.repo.insert(appRow(1), hist(1, "DRAFT", "DRAFT"), []);
    await c.repo.insert(appRow(2, { applicantId: APPLICANT_B, brandNameNorm: "x" }), hist(2, "DRAFT", "DRAFT"), []);
    await c.raw.exec("BEGIN");
    await c.raw.exec("SET LOCAL ROLE app_user");
    await c.raw.query("select set_config('app.role','seller',true), set_config('app.user_id',$1,true)", [APPLICANT_A]);
    const own = await c.raw.query<{ n: string }>("select count(*)::text as n from brand_applications");
    expect(own.rows[0]?.n).toBe("1");
    const hist1 = await c.raw.query<{ n: string }>("select count(*)::text as n from brand_application_history");
    expect(hist1.rows[0]?.n).toBe("1");
    await c.raw.exec("ROLLBACK");
  });

  it("rolls the whole commit back when an outbox event is rejected", async () => {
    const c = await fresh();
    const a = appRow(1);
    await c.repo.insert(a, hist(1, "DRAFT", "DRAFT"), []);
    const bad = c.repo.commit({
      scope: { kind: "applicant", applicantId: APPLICANT_A }, expectedVersion: 0, app: { ...a, status: "SUBMITTED", version: 1 },
      documentsUpsert: [], documentsDelete: [], history: hist(2, "DRAFT", "SUBMITTED"),
      events: [{ id: "00000000-0000-4000-8000-0000000008ff", type: "NOT A VALID TYPE", aggregateId: a.id, occurredAtMs: 0, payload: {} }],
    });
    await expect(bad).rejects.toThrow();
    const got = await c.repo.get(a.id, { kind: "applicant", applicantId: APPLICANT_A });
    expect(got?.app).toMatchObject({ status: "DRAFT", version: 0 });
    expect((await c.repo.history(a.id)).length).toBe(1);
  });

  it("history rows are immutable", async () => {
    const c = await fresh();
    await c.repo.insert(appRow(1), hist(1, "DRAFT", "DRAFT"), []);
    await expect(c.raw.query("update brand_application_history set event = 'x'")).rejects.toThrow();
    await expect(c.raw.query("delete from brand_application_history")).rejects.toThrow();
  });
});
