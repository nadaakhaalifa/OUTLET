import { afterAll, describe, expect, it } from "vitest";
import { createStylistDatabase } from "../test/pglite-db";
import { KyselyAuditStore, KyselyTokenUsage, type GatewayDb } from "./kysely-stores";
import { describeGatewayStoresContract } from "./stores.contract";

const open: GatewayDb[] = [];
afterAll(async () => {
  await Promise.all(open.map((d) => d.destroy()));
});

const fresh = async () => {
  const { pg, db } = await createStylistDatabase();
  open.push(db);
  return { pg, db };
};

describeGatewayStoresContract("kysely/pglite", async () => {
  const { pg, db } = await fresh();
  return {
    audit: new KyselyAuditStore(db),
    usage: new KyselyTokenUsage(db),
    ensureUser: async (id) => {
      await pg.query(`insert into users (id, status) values ($1, 'active') on conflict do nothing`, [id]);
    },
  };
});

describe("llm_audit_log schema", () => {
  it("has no text or user column and refuses updates and bad hashes", async () => {
    const { pg, db } = await fresh();
    const cols = await pg.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name = 'llm_audit_log'`,
    );
    const names = cols.rows.map((c) => c.column_name);
    expect(names).not.toContain("user_id");
    expect(names.some((n) => /text|prompt$|body|content/.test(n))).toBe(false);
    const audit = new KyselyAuditStore(db);
    await expect(
      audit.record({
        id: "00000000-0000-7000-8000-000000000001",
        feature: "stylist",
        promptId: "x@1",
        promptHash: "nothex",
        model: "m",
        tokensIn: 1,
        tokensOut: 1,
        latencyMs: 1,
        outcome: "ok",
        atMs: 1_800_000_000_000,
      }),
    ).rejects.toThrow();
  });

  it("app_user cannot update or delete audit rows and non-system roles cannot read them", async () => {
    const { pg, db } = await fresh();
    await new KyselyAuditStore(db).record({
      id: "00000000-0000-7000-8000-000000000001",
      feature: "stylist",
      promptId: "x@1",
      promptHash: "b".repeat(64),
      model: "m",
      tokensIn: 1,
      tokensOut: 1,
      latencyMs: 1,
      outcome: "ok",
      atMs: 1_800_000_000_000,
    });
    await pg.exec(`set role app_user; select set_config('app.role', 'user', false);`);
    try {
      expect((await pg.query(`select id from llm_audit_log`)).rows).toHaveLength(0);
      await expect(pg.query(`update llm_audit_log set model = 'x'`)).rejects.toThrow();
      await expect(pg.query(`delete from llm_audit_log`)).rejects.toThrow();
    } finally {
      await pg.exec(`reset role`);
    }
  });
});
