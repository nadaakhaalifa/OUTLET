import { randomUUID } from "node:crypto";
import { roleClient } from "@outlet/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DlqAdmin } from "../src/modules/admin/index.js";
import { seedDlq } from "./admin-fixtures.js";
import { bearer, createTestApp, idemKey } from "./harness.js";
import type { TestApp } from "./harness.js";

let t: TestApp;
beforeAll(async () => { t = await createTestApp(); });
afterAll(async () => t.close());

const post = async (token: string, path: string, payload: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
  const r = await t.inject({ method: "POST", url: `/v1/eg/admin/dlq/${path}`, headers: { ...bearer(token), "idempotency-key": idemKey(t) }, payload: payload as object });
  return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, unknown> };
};
const dlqStatus = async (id: string): Promise<string | undefined> => (await t.raw.query<{ status: string }>("SELECT status FROM dlq_messages WHERE id = $1", [id])).rows[0]?.status;
const event = async (id: string): Promise<{ attempts: number; published_at: Date | null; dead_lettered_at: Date | null; last_error: string | null }> =>
  (await t.raw.query<{ attempts: number; published_at: Date | null; dead_lettered_at: Date | null; last_error: string | null }>("SELECT attempts, published_at, dead_lettered_at, last_error FROM outbox_events WHERE id = $1", [id])).rows[0] ?? { attempts: -1, published_at: null, dead_lettered_at: null, last_error: null };

describe("admin DLQ routes", () => {
  it("lists this market's open entries newest first with a keyset cursor, never the payload; other roles and shoppers are refused", async () => {
    await t.raw.query("DELETE FROM dlq_messages");
    const a = await seedDlq(t.raw, { at: "2029-12-31T10:00:00Z" });
    const b = await seedDlq(t.raw, { at: "2029-12-31T11:00:00Z", type: "refund.attention" });
    await seedDlq(t.raw, { marketId: "AE" });
    const ops = await t.admin(["ops"]);
    const p1raw = (await t.inject({ method: "GET", url: "/v1/eg/admin/dlq?limit=1", headers: bearer(ops.token) })).body;
    expect(p1raw).not.toContain("201000000000");
    const p1 = JSON.parse(p1raw) as { items: { id: string; event_id: string; event_type: string; attempts: number; last_error: string }[]; next_cursor: string | null };
    expect(p1.items).toHaveLength(1);
    expect(p1.next_cursor).not.toBeNull();
    const p2 = JSON.parse((await t.inject({ method: "GET", url: `/v1/eg/admin/dlq?limit=5&cursor=${p1.next_cursor ?? ""}`, headers: bearer(ops.token) })).body) as { items: { id: string }[]; next_cursor: string | null };
    expect([...p1.items, ...p2.items].map((i) => i.id).sort()).toEqual([a.id, b.id].sort());
    expect(p1.items[0]).toMatchObject({ attempts: 8, last_error: "Error:E_DOWN" });
    expect((await t.inject({ method: "GET", url: "/v1/eg/admin/dlq?cursor=bm90LWEtdXVpZA", headers: bearer(ops.token) })).statusCode).toBe(400);
    for (const role of ["support", "trust_safety", "finance", "marketing", "dpo"]) {
      expect((await t.inject({ method: "GET", url: "/v1/eg/admin/dlq", headers: bearer((await t.admin([role])).token) })).statusCode, role).toBe(403);
    }
    expect((await t.inject({ method: "GET", url: "/v1/eg/admin/dlq", headers: bearer((await t.shopper()).token) })).statusCode).toBe(403);
  });

  it("replay: resets the event, marks the row replayed, audits ids and counts, a second replay is not_in_dlq with no new audit entry", async () => {
    const d = await seedDlq(t.raw);
    const sec = await t.admin(["security"]);
    const before = t.adminAudit.entries.length;
    const r = await post(sec.token, "replay", { ids: [d.id] });
    expect(r).toMatchObject({ status: 200, body: { results: [{ id: d.id, outcome: "replayed" }], changed: 1 } });
    expect(await event(d.eventId)).toEqual({ attempts: 0, published_at: null, dead_lettered_at: null, last_error: null });
    expect(await dlqStatus(d.id)).toBe("replayed");
    const entries = t.adminAudit.entries.slice(before);
    expect(entries).toMatchObject([{ action: "dlq.replay_requested", actorId: sec.userId, diff: { after: { ids: [d.id], count: 1 } } }, { action: "dlq.replayed", actorId: sec.userId, diff: { after: { ids: [d.id], count: 1 } } }]);
    expect(JSON.stringify(entries)).not.toContain("201000000000");
    expect(await post(sec.token, "replay", { ids: [d.id] })).toMatchObject({ status: 200, body: { results: [{ id: d.id, outcome: "not_in_dlq" }], changed: 0 } });
    // The retry records only its intent (no after entry: nothing changed).
    expect(t.adminAudit.entries.slice(before + 2).map((e) => e.action)).toEqual(["dlq.replay_requested"]);
  });

  it("an id of another market is not_in_dlq and untouched (indistinguishable from unknown); bad bodies are 400; non-managing roles 403", async () => {
    const foreign = await seedDlq(t.raw, { marketId: "AE" });
    const ops = await t.admin(["ops"]);
    expect(await post(ops.token, "replay", { ids: [foreign.id, randomUUID()] })).toMatchObject({ status: 200, body: { changed: 0 } });
    expect(await post(ops.token, "discard", { ids: [foreign.id], reason_code: "duplicate" })).toMatchObject({ status: 200, body: { changed: 0 } });
    expect(await dlqStatus(foreign.id)).toBe("open");
    expect((await post(ops.token, "replay", { ids: [] })).status).toBe(400);
    expect((await post(ops.token, "replay", { ids: Array.from({ length: 51 }, () => randomUUID()) })).status).toBe(400);
    expect((await post(ops.token, "discard", { ids: [randomUUID()], reason_code: "because" })).status).toBe(400);
    expect((await post((await t.admin(["finance"])).token, "replay", { ids: [randomUUID()] })).status).toBe(403);
  });

  it("discard of a non-money event applies directly and is audited with the reason code", async () => {
    const d = await seedDlq(t.raw, { type: "order.placed" });
    const ops = await t.admin(["ops"]);
    const before = t.adminAudit.entries.length;
    expect(await post(ops.token, "discard", { ids: [d.id], reason_code: "obsolete" })).toMatchObject({ status: 200, body: { results: [{ id: d.id, outcome: "discarded" }], changed: 1 } });
    expect(await dlqStatus(d.id)).toBe("discarded");
    expect(await event(d.eventId)).toMatchObject({ last_error: "discarded:obsolete" });
    expect((await event(d.eventId)).published_at).not.toBeNull();
    expect(t.adminAudit.entries.slice(before)).toMatchObject([{ action: "dlq.discard_requested", diff: { after: { ids: [d.id], count: 1, reasonCode: "obsolete" } } }, { action: "dlq.discarded", diff: { after: { ids: [d.id], count: 1, reasonCode: "obsolete" } } }]);
  });

  it("discard of a money event type files a dual-approval request, changes nothing until the second approver votes, then applies once", async () => {
    const d = await seedDlq(t.raw, { type: "refund.attention" });
    const plain = await seedDlq(t.raw, { type: "order.placed" });
    const one = await t.admin(["ops"]);
    const asked = await post(one.token, "discard", { ids: [plain.id, d.id], reason_code: "handled_manually" });
    expect(asked.status).toBe(409);
    expect(asked.body.code).toBe("dual-approval-required");
    const url = `/v1/eg/admin/approval-requests/${String(asked.body.detail)}/decision`;
    expect(await dlqStatus(d.id)).toBe("open");
    expect(await dlqStatus(plain.id)).toBe("open");
    expect((await post(one.token, `../approval-requests/${String(asked.body.detail)}/decision`, { decision: "approve", reason: "mine" })).status).not.toBe(200);
    const vote = async (token: string): Promise<{ status: string }> => JSON.parse((await t.inject({ method: "POST", url, headers: { ...bearer(token), "idempotency-key": idemKey(t) }, payload: { decision: "approve", reason: "agreed with request" } })).body) as { status: string };
    expect((await vote((await t.admin(["security"])).token)).status).toBe("PENDING");
    expect(await dlqStatus(d.id)).toBe("open");
    const before = t.adminAudit.entries.length;
    expect((await vote((await t.admin(["ops"])).token)).status).toBe("EXECUTED");
    expect(await dlqStatus(d.id)).toBe("discarded");
    expect(await dlqStatus(plain.id)).toBe("discarded");
    expect(t.adminAudit.entries.slice(before).map((e) => e.action)).toContain("dlq.discarded");
  });

  it("intent first: a failing audit port stops the effect (nothing changes, so nothing is unaudited); a retry after the audit recovers works", async () => {
    const d = await seedDlq(t.raw);
    const staff = { kind: "admin" as const, userId: (await t.admin(["ops"])).userId, marketId: "EG", roles: ["ops"], scopes: [] };
    const down = new DlqAdmin(roleClient(t.raw, "outlet_worker"), roleClient(t.raw, "outlet_app"), { appendIn: () => Promise.reject(new Error("audit down")) });
    await expect(down.discard(staff, [d.id], "duplicate")).rejects.toThrow("audit down");
    await expect(down.replay(staff, [d.id])).rejects.toThrow("audit down");
    expect(await dlqStatus(d.id)).toBe("open");
    const seen: { action: string }[] = [];
    const ok = new DlqAdmin(roleClient(t.raw, "outlet_worker"), roleClient(t.raw, "outlet_app"), { appendIn: (_tx, e) => { seen.push({ action: e.action }); return Promise.resolve(); } });
    const applied = await ok.discard(staff, [d.id], "duplicate");
    expect(applied.changed).toBe(1);
    await ok.record(staff, applied, { reasonCode: "duplicate" });
    expect(seen.map((x) => x.action)).toEqual(["dlq.discard_requested", "dlq.discarded"]);
    await expect(ok.replay(staff, [randomUUID()])).resolves.toMatchObject({ changed: 0 });
  });

  it("replay writes the intent entry before the effect, then the after entry; an event dead-lettered over 45 days ago is expired and not audited as replayed", async () => {
    const d = await seedDlq(t.raw);
    const old = await seedDlq(t.raw);
    await t.raw.query("UPDATE outbox_events SET dead_lettered_at = now() - interval '46 days' WHERE id = $1", [old.eventId]);
    const sec = await t.admin(["security"]);
    const before = t.adminAudit.entries.length;
    const r = await post(sec.token, "replay", { ids: [d.id, old.id] });
    expect(r.body).toMatchObject({ changed: 1, results: [{ id: d.id, outcome: "replayed" }, { id: old.id, outcome: "expired" }] });
    expect(await dlqStatus(old.id)).toBe("open");
    expect(t.adminAudit.entries.slice(before).map((e) => e.action)).toEqual(["dlq.replay_requested", "dlq.replayed"]);
  });
});
