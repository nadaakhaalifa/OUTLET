import { randomUUID } from "node:crypto";
import { roleClient } from "@outlet/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AttentionAdmin } from "../src/modules/admin/index.js";
import { seedAttention } from "./admin-fixtures.js";
import { bearer, createTestApp, idemKey } from "./harness.js";
import type { TestApp } from "./harness.js";

let t: TestApp;
beforeAll(async () => { t = await createTestApp(); });
afterAll(async () => t.close());

const post = async (token: string, id: string, action: "ack" | "resolve", payload: unknown = {}): Promise<{ status: number; body: Record<string, unknown> }> => {
  const r = await t.inject({ method: "POST", url: `/v1/eg/admin/attention/${id}/${action}`, headers: { ...bearer(token), "idempotency-key": idemKey(t) }, payload: payload as object });
  return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, unknown> };
};
const status = async (id: string): Promise<string | undefined> => (await t.raw.query<{ status: string }>("SELECT status FROM attention_items WHERE id = $1", [id])).rows[0]?.status;

describe("ops attention routes", () => {
  it("lists non-resolved items newest first with a keyset cursor; shoppers and non-ops/finance roles are refused", async () => {
    await t.raw.query("DELETE FROM attention_items");
    const a = await seedAttention(t.raw, { at: "2029-12-31T10:00:00Z" });
    const b = await seedAttention(t.raw, { at: "2029-12-31T11:00:00Z", kind: "shipment.cancel_attention" });
    await seedAttention(t.raw, { status: "RESOLVED" });
    const ops = await t.admin(["ops"]);
    const p1 = JSON.parse((await t.inject({ method: "GET", url: "/v1/eg/admin/attention?limit=1", headers: bearer(ops.token) })).body) as { items: { id: string; payload: Record<string, string> }[]; next_cursor: string | null };
    expect(p1.items.map((i) => i.id)).toEqual([b.id]);
    expect(p1.items[0]?.payload).toEqual({ error: "REFUND_NOT_ALLOWED" });
    expect(p1.next_cursor).not.toBeNull();
    const p2 = JSON.parse((await t.inject({ method: "GET", url: `/v1/eg/admin/attention?limit=5&cursor=${p1.next_cursor ?? ""}`, headers: bearer(ops.token) })).body) as { items: { id: string }[]; next_cursor: string | null };
    expect(p2.items.map((i) => i.id)).toEqual([a.id]);
    expect(p2.next_cursor).toBeNull();
    for (const role of ["support", "trust_safety", "marketing", "security"]) {
      expect((await t.inject({ method: "GET", url: "/v1/eg/admin/attention", headers: bearer((await t.admin([role])).token) })).statusCode, role).toBe(403);
    }
    expect((await t.inject({ method: "GET", url: "/v1/eg/admin/attention", headers: bearer((await t.shopper()).token) })).statusCode).toBe(403);
  });

  it("ack: audited with the actor, idempotent in effect (second ack unchanged), a resolved item is 409, an unknown id 404, a wrong role 403", async () => {
    const { id } = await seedAttention(t.raw);
    const ops = await t.admin(["ops"]);
    const before = t.adminAudit.entries.length;
    const r = await post(ops.token, id, "ack");
    expect(r).toMatchObject({ status: 200, body: { id, status: "ACKED", acked_by: ops.userId } });
    expect(t.adminAudit.entries.slice(before)).toMatchObject([{ action: "attention.acked", targetType: "attention_item", targetId: id, actorId: ops.userId, diff: { before: { status: "OPEN" }, after: { status: "ACKED" } } }]);
    expect((await post(ops.token, id, "ack")).status).toBe(200);
    expect(t.adminAudit.entries).toHaveLength(before + 1); // unchanged success writes no second audit entry
    const done = await seedAttention(t.raw, { status: "RESOLVED" });
    expect(await post(ops.token, done.id, "ack")).toMatchObject({ status: 409, body: { code: "attention-conflict" } });
    expect((await post(ops.token, randomUUID(), "ack")).status).toBe(404);
    expect((await post((await t.admin(["trust_safety"])).token, id, "ack")).status).toBe(403);
    expect((await post(ops.token, "not-a-uuid", "ack")).status).toBe(400);
  });

  it("resolve: fixed codes only, audited with the code, same code again unchanged, another code 409; an OPEN item resolves directly (finance may too)", async () => {
    const { id } = await seedAttention(t.raw);
    const fin = await t.admin(["finance"]);
    const before = t.adminAudit.entries.length;
    expect(await post(fin.token, id, "resolve", { resolution_code: "REFUNDED_OFFLINE" })).toMatchObject({ status: 200, body: { status: "RESOLVED", resolution_code: "REFUNDED_OFFLINE", acked_by: fin.userId } });
    expect(t.adminAudit.entries.slice(before)).toMatchObject([{ action: "attention.resolved", diff: { before: { status: "OPEN" }, after: { status: "RESOLVED", resolutionCode: "REFUNDED_OFFLINE" } } }]);
    expect((await post(fin.token, id, "resolve", { resolution_code: "REFUNDED_OFFLINE" })).status).toBe(200);
    expect(await post(fin.token, id, "resolve", { resolution_code: "DUPLICATE" })).toMatchObject({ status: 409, body: { code: "attention-conflict" } });
    expect((await post(fin.token, id, "resolve", { resolution_code: "WHATEVER" })).status).toBe(400);
    expect((await post(fin.token, id, "resolve", {})).status).toBe(400);
    expect((await post(fin.token, randomUUID(), "resolve", { resolution_code: "NOT_AN_ISSUE" })).status).toBe(404);
  });

  it("an item of another market is a 404 (market pinned in the reader)", async () => {
    const id = randomUUID();
    await t.raw.query("INSERT INTO attention_items (id, market_id, kind, ref_type, ref_id) VALUES ($1,'AE','refund.attention','refund',$2)", [id, randomUUID()]);
    expect((await post((await t.admin(["ops"])).token, id, "ack")).status).toBe(404);
    expect(await status(id)).toBe("OPEN");
  });

  it("no audit, no change: an audit port that fails rolls the status update back in the same transaction", async () => {
    const { id } = await seedAttention(t.raw);
    const staff = { kind: "admin" as const, userId: (await t.admin(["ops"])).userId, marketId: "EG", roles: ["ops"], scopes: [] };
    const svc = new AttentionAdmin(roleClient(t.raw, "outlet_app"), { appendIn: () => Promise.reject(new Error("audit down")) });
    await expect(svc.ack(staff, id)).rejects.toThrow("audit down");
    expect(await status(id)).toBe("OPEN");
    await expect(svc.resolve(staff, id, "NOT_AN_ISSUE")).rejects.toThrow("audit down");
    expect(await status(id)).toBe("OPEN");
  });
});
