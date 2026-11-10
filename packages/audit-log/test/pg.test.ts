import { contextClient } from "@outlet/db";
import type { SqlClient } from "@outlet/db";
import { createTestClient, roleClient } from "@outlet/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgAuditStore, PiiAccessLog } from "../src/index.js";
import type { AuditEntryInput } from "../src/index.js";

const base: AuditEntryInput = {
  marketId: "EG", actorType: "staff", actorId: "staff-1", action: "refund.approved",
  targetType: "refund", targetId: "r1", diff: { before: { s: 1 }, after: { s: 2, phone: "+201001234567" } },
  ipHash: "a".repeat(64), deviceId: "d1", requestId: "req1",
};

let admin: SqlClient; // superuser (migrations owner) for tampering and inspection
let close: () => Promise<void>;
let appEG: SqlClient;
let appXX: SqlClient;

beforeAll(async () => {
  const t = await createTestClient();
  admin = t.client;
  close = t.close;
  const app = roleClient(admin, "outlet_app");
  appEG = contextClient(app, { kind: "user", marketId: "EG" });
  appXX = contextClient(app, { kind: "user", marketId: "XX" });
});
afterAll(async () => close());

const reset = async (): Promise<void> => {
  await admin.query("ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_truncate");
  await admin.query("ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update_delete");
  await admin.query("DELETE FROM audit_log");
  await admin.query("ALTER TABLE audit_log ENABLE ALWAYS TRIGGER audit_log_no_truncate");
  await admin.query("ALTER TABLE audit_log ENABLE ALWAYS TRIGGER audit_log_no_update_delete");
};
const withTamper = async (fn: () => Promise<void>): Promise<void> => {
  await admin.query("ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update_delete");
  try {
    await fn();
  } finally {
    await admin.query("ALTER TABLE audit_log ENABLE ALWAYS TRIGGER audit_log_no_update_delete");
  }
};
const fill = async (n: number): Promise<PgAuditStore> => {
  await reset();
  const store = new PgAuditStore(appEG);
  for (let i = 1; i <= n; i++) await store.append({ ...base, targetId: `r${String(i)}` });
  return store;
};

describe("PgAuditStore", () => {
  it("chains entries gaplessly, redacts the diff and verifies", async () => {
    const store = await fill(3);
    const page = await store.list();
    expect(page.items.map((e) => e.seq)).toEqual([3, 2, 1]);
    expect(JSON.stringify(page.items[0]?.diff)).not.toContain("+2010012");
    expect(page.items[2]?.prevHash).toBe("0".repeat(64));
    expect(page.items[1]?.prevHash).toBe(page.items[2]?.hash);
    expect(await store.verifyChain("EG")).toEqual({ ok: true, checked: 3, headSeq: 3 });
    expect(await store.verifyChain("EG", 2)).toEqual({ ok: true, checked: 2, headSeq: 3 });
    expect(await store.verifyChain("EG", 3)).toEqual({ ok: true, checked: 1, headSeq: 3 });
  });

  it("keeps null diff and null optional columns through the round trip", async () => {
    await reset();
    const store = new PgAuditStore(appEG);
    await store.append({ ...base, actorId: null, diff: null, ipHash: null, deviceId: null, requestId: null });
    expect(await store.verifyChain("EG")).toMatchObject({ ok: true, checked: 1 });
  });

  it("serialises concurrent appends: no gaps, no duplicate seq, chain verifies", async () => {
    await reset();
    const store = new PgAuditStore(appEG);
    await Promise.all(Array.from({ length: 25 }, (_, i) => store.append({ ...base, targetId: `c${String(i)}` })));
    const seqs = (await store.list({}, undefined, 200)).items.map((e) => e.seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    expect(await store.verifyChain("EG")).toMatchObject({ ok: true, checked: 25 });
  });

  it("a rolled-back append leaves no hole", async () => {
    const store = await fill(2);
    await expect(
      appEG.transaction(async (tx) => {
        await store.appendIn(tx, { ...base, targetId: "ghost" });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const next = await store.append({ ...base, targetId: "after" });
    expect(next.seq).toBe(3);
    expect(await store.verifyChain("EG")).toMatchObject({ ok: true, checked: 3 });
  });

  it("filters and pages with a keyset cursor", async () => {
    const store = await fill(5);
    await store.append({ ...base, action: "kill_switch.engage", targetType: "kill_switch", targetId: "k1", actorId: "staff-2" });
    const p1 = await store.list({}, undefined, 4);
    expect(p1.items.map((e) => e.seq)).toEqual([6, 5, 4, 3]);
    expect(p1.nextCursor).toBe(3);
    const p2 = await store.list({}, p1.nextCursor, 4);
    expect(p2.items.map((e) => e.seq)).toEqual([2, 1]);
    expect(p2.nextCursor).toBeUndefined();
    expect((await store.list({ action: "kill_switch.engage" })).items).toHaveLength(1);
    expect((await store.list({ actorId: "staff-2", targetType: "kill_switch", targetId: "k1" })).items).toHaveLength(1);
    expect((await store.list({ targetId: "r3" })).items.map((e) => e.seq)).toEqual([3]);
    expect((await store.list({}, undefined, 0)).items).toHaveLength(1);
    await expect(store.list({ action: "" })).rejects.toThrow();
  });

  it("detects an edited row", async () => {
    const store = await fill(4);
    await withTamper(async () => { await admin.query("UPDATE audit_log SET action = 'x' WHERE seq = 2"); });
    expect(await store.verifyChain("EG")).toEqual({ ok: false, brokenSeq: 2, reason: "hash" });
    expect(await store.verifyChain("EG", 3)).toMatchObject({ ok: true });
  });

  it("detects a re-linked row and a deleted middle row", async () => {
    const store = await fill(4);
    await withTamper(async () => { await admin.query("UPDATE audit_log SET prev_hash = $1 WHERE seq = 3", ["b".repeat(64)]); });
    expect(await store.verifyChain("EG")).toEqual({ ok: false, brokenSeq: 3, reason: "link" });
    const s2 = await fill(4);
    await withTamper(async () => { await admin.query("DELETE FROM audit_log WHERE seq = 2"); });
    expect(await s2.verifyChain("EG")).toEqual({ ok: false, brokenSeq: 3, reason: "gap" });
    expect(await s2.verifyChain("EG", 3)).toEqual({ ok: false, brokenSeq: 3, reason: "gap" });
  });

  it("flags rows of another market and verifies an empty market as ok", async () => {
    const store = await fill(2);
    expect(await store.verifyChain("XX")).toEqual({ ok: false, brokenSeq: 1, reason: "market" });
    expect(await new PgAuditStore(appXX).verifyChain("XX")).toEqual({ ok: true, checked: 0, headSeq: undefined });
  });

  it("isolates markets: a foreign market sees nothing and a mismatched insert is refused", async () => {
    await fill(2);
    expect((await new PgAuditStore(appXX).list()).items).toHaveLength(0);
    await expect(new PgAuditStore(appXX).append({ ...base, marketId: "EG" })).rejects.toThrow(/row-level security/);
    const xx = new PgAuditStore(appXX);
    expect((await xx.append({ ...base, marketId: "XX" })).seq).toBe(1);
  });

  it("is append-only for every runtime role and for the owner (triggers fire under replica mode)", async () => {
    await fill(1);
    for (const role of ["outlet_app", "outlet_auth", "outlet_worker"] as const) {
      const c = roleClient(admin, role);
      await expect(c.query("SELECT * FROM audit_log")).rejects.toThrow(/permission denied/);
      await expect(c.query("UPDATE audit_log SET action = 'x'")).rejects.toThrow(/permission denied/);
      await expect(c.query("DELETE FROM audit_log")).rejects.toThrow(/permission denied/);
      await expect(c.query("TRUNCATE audit_log")).rejects.toThrow(/permission denied/);
    }
    await expect(
      roleClient(admin, "outlet_auth").query("INSERT INTO audit_log (id) VALUES (gen_random_uuid())"),
    ).rejects.toThrow(/permission denied/);
    await expect(admin.transaction(async (tx) => {
      await tx.query("SET LOCAL session_replication_role = replica");
      await tx.query("UPDATE audit_log SET action = 'x'");
    })).rejects.toThrow(/append-only/);
    await expect(admin.query("DELETE FROM audit_log")).rejects.toThrow(/append-only/);
    await expect(admin.query("TRUNCATE audit_log")).rejects.toThrow(/append-only/);
  });

  it("denies the read functions to other roles", async () => {
    await expect(roleClient(admin, "outlet_worker").query("SELECT * FROM audit_log_head()")).rejects.toThrow(/permission denied/);
    await expect(roleClient(admin, "outlet_auth").query("SELECT * FROM pii_access_log_page(NULL, NULL, 5, NULL, NULL, NULL)")).rejects.toThrow(/permission denied/);
  });
});

describe("PiiAccessLog", () => {
  const input = { marketId: "EG", actorId: "staff-1", targetType: "user", targetId: "u1", action: "user.read", reasonCode: "support_ticket", requestId: "req-1" };

  it("records, lists newest first with a keyset cursor and filters", async () => {
    await admin.query("ALTER TABLE pii_access_log DISABLE TRIGGER pii_access_log_no_truncate");
    await admin.query("ALTER TABLE pii_access_log DISABLE TRIGGER pii_access_log_no_update_delete");
    await admin.query("DELETE FROM pii_access_log");
    await admin.query("ALTER TABLE pii_access_log ENABLE ALWAYS TRIGGER pii_access_log_no_truncate");
    await admin.query("ALTER TABLE pii_access_log ENABLE ALWAYS TRIGGER pii_access_log_no_update_delete");
    let t = Date.UTC(2026, 10, 8, 12);
    const log = new PiiAccessLog(appEG, { now: () => new Date((t += 1000)) });
    for (let i = 1; i <= 5; i++) await log.record({ ...input, targetId: i === 5 ? "u9" : "u1", actorId: i === 4 ? "staff-2" : "staff-1" });
    await log.record({ marketId: "EG", actorId: "s", targetType: "user", targetId: "u1", action: "user.read", reasonCode: "dsar" });
    const p1 = await log.list({}, undefined, 4);
    expect(p1.items).toHaveLength(4);
    expect(p1.items[0]?.reasonCode).toBe("dsar");
    expect(p1.items[0]?.requestId).toBeNull();
    const p2 = await log.list({}, p1.nextCursor, 4);
    expect(p2.items).toHaveLength(2);
    expect(p2.nextCursor).toBeUndefined();
    expect((await log.list({ actorId: "staff-2" })).items).toHaveLength(1);
    expect((await log.list({ targetId: "u9", targetType: "user" })).items).toHaveLength(1);
    await expect(log.list({}, "garbage")).rejects.toThrow("invalid pii access cursor");
    expect((await new PiiAccessLog(appXX).list()).items).toHaveLength(0);
  });

  it("requires a reason code and a matching market", async () => {
    const log = new PiiAccessLog(appEG);
    await expect(log.record({ ...input, reasonCode: "" })).rejects.toThrow();
    await expect(new PiiAccessLog(appXX).record(input)).rejects.toThrow(/row-level security/);
  });

  it("is append-only and unreadable directly for runtime roles", async () => {
    await new PiiAccessLog(appEG).record(input);
    const app = roleClient(admin, "outlet_app");
    await expect(app.query("SELECT * FROM pii_access_log")).rejects.toThrow(/permission denied/);
    await expect(app.query("UPDATE pii_access_log SET reason_code = 'x'")).rejects.toThrow(/permission denied/);
    await expect(app.query("DELETE FROM pii_access_log")).rejects.toThrow(/permission denied/);
    await expect(admin.query("UPDATE pii_access_log SET reason_code = 'x'")).rejects.toThrow(/append-only/);
  });
});
