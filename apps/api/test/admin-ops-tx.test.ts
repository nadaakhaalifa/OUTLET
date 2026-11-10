import { PgAuditStore } from "@outlet/audit-log";
import { roleClient } from "@outlet/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FlagAdmin } from "../src/modules/admin/index.js";
import { createTestApp } from "./harness.js";
import type { TestApp } from "./harness.js";

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

const principal = { kind: "admin" as const, userId: "00000000-0000-4000-8000-0000000000aa", marketId: "EG", roles: ["finance"], scopes: [] };
const n = async (sql: string): Promise<number> => Number((await t.raw.query<{ n: number }>(sql)).rows[0]?.n);

describe("kill switch flip and its audit entry are one transaction", () => {

  it("the flip and the chain entry commit together", async () => {
    const pg = new PgAuditStore(t.raw);
    const admin = new FlagAdmin(roleClient(t.raw, "outlet_app"), { appendIn: (tx, i) => pg.appendIn(tx, i) });
    const before = await n("SELECT count(*)::int AS n FROM audit_log WHERE action = 'kill_switch.engaged'");
    await admin.set(principal, "games.enabled", false, "drill one");
    expect(await n("SELECT count(*)::int AS n FROM audit_log WHERE action = 'kill_switch.engaged'")).toBe(before + 1);
    expect(await n("SELECT count(*)::int AS n FROM feature_flags WHERE key = 'games.enabled'")).toBe(1);
    expect((await admin.list("EG")).some((r) => r.key === "games.enabled")).toBe(true);
    expect((await admin.list("XX")).some((r) => r.key === "games.enabled")).toBe(false);
  });

  it("a failure after the audit append rolls the flip back too, leaving no chain entry", async () => {
    const pg = new PgAuditStore(t.raw);
    const failing = new FlagAdmin(roleClient(t.raw, "outlet_app"), { appendIn: async (tx, i) => { await pg.appendIn(tx, i); throw new Error("after audit"); } });
    const audits = await n("SELECT count(*)::int AS n FROM audit_log");
    await expect(failing.set(principal, "search.engine.enabled", false, "drill two")).rejects.toThrow("after audit");
    expect(await n("SELECT count(*)::int AS n FROM audit_log")).toBe(audits);
    expect(await n("SELECT count(*)::int AS n FROM feature_flags WHERE key = 'search.engine.enabled'")).toBe(0);
  });

  it("a failing flag write leaves no chain entry (audit append first would be undone)", async () => {
    const pg = new PgAuditStore(t.raw);
    const admin = new FlagAdmin(roleClient(t.raw, "outlet_app"), { appendIn: (tx, i) => pg.appendIn(tx, i) });
    await t.raw.query("CREATE FUNCTION flag_boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'flag boom'; END $$");
    await t.raw.query("CREATE TRIGGER flag_boom BEFORE INSERT ON feature_flags FOR EACH ROW EXECUTE FUNCTION flag_boom()");
    const audits = await n("SELECT count(*)::int AS n FROM audit_log");
    await expect(admin.set(principal, "drops.enabled", false, "drill three")).rejects.toThrow("flag boom");
    expect(await n("SELECT count(*)::int AS n FROM audit_log")).toBe(audits);
    await t.raw.query("DROP TRIGGER flag_boom ON feature_flags");
  });

  it("a staff principal without a user id cannot write a kill switch", async () => {
    const admin = new FlagAdmin(roleClient(t.raw, "outlet_app"), { appendIn: () => Promise.resolve() });
    await expect(admin.set({ ...principal, userId: undefined }, "games.enabled", false, "no actor")).rejects.toMatchObject({ status: 403 });
  });
});
