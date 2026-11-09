import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bearer, createTestApp, idemKey } from "./harness.js";
import type { TestApp } from "./harness.js";
import { seedPiiAccess, seedStore } from "./admin-fixtures.js";

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- test helper: the caller states the expected shape
const json = <T>(body: string): T => JSON.parse(body) as T;
const post = (token: string, url: string, payload: object) => t.inject({ method: "POST", url, headers: { ...bearer(token), "idempotency-key": idemKey(t) }, payload });
const get = (token: string, url: string) => t.inject({ method: "GET", url, headers: bearer(token) });
const decide = (token: string, id: string) => post(token, `/v1/eg/admin/approval-requests/${id}/decision`, { decision: "approve", reason: "second pair of eyes ok" });
const status = async (storeId: string): Promise<string> => (await t.raw.query<{ status: string }>("SELECT status FROM stores WHERE id = $1", [storeId])).rows[0]?.status ?? "";
const sellerStatus = async (sellerId: string): Promise<string> => (await t.raw.query<{ status: string }>("SELECT status FROM sellers WHERE id = $1", [sellerId])).rows[0]?.status ?? "";

describe("store suspend and reinstate (always dual approval)", () => {
  it("suspend files a request, nothing changes until the second approver votes, then the seller and its stores are hidden once", async () => {
    const s = await seedStore(t.raw);
    const other = randomUUID();
    await t.raw.query("INSERT INTO stores (id, seller_id, market_id, slug, display_name_ar, kind, ships_from_country, status) VALUES ($1,$2,'EG',$3,'م','local','EG','ACTIVE')", [other, s.sellerId, `o-${other.slice(0, 8)}`]);
    const one = await t.admin(["trust_safety"]);
    const asked = await post(one.token, `/v1/eg/admin/stores/${s.storeId}/suspend`, { reason_code: "price_fraud", note: "repeated inflated reference prices" });
    expect(asked.statusCode).toBe(409);
    const problem = json<{ code: string; detail: string }>(asked.body);
    expect(problem.code).toBe("dual-approval-required");
    expect(await status(s.storeId)).toBe("ACTIVE");
    const url = problem.detail;
    expect((await decide(one.token, url)).statusCode).toBe(403);
    const two = await t.admin(["ops"]);
    expect(json<{ status: string }>((await decide(two.token, url)).body).status).toBe("PENDING");
    const three = await t.admin(["trust_safety"]);
    const done = await decide(three.token, url);
    expect(done.statusCode).toBe(200);
    expect(json<{ status: string }>(done.body).status).toBe("EXECUTED");
    expect(await status(s.storeId)).toBe("SUSPENDED");
    expect(await status(other)).toBe("SUSPENDED");
    expect(await sellerStatus(s.sellerId)).toBe("suspended");
    expect((await t.raw.query<{ state: string }>("SELECT state FROM kyc_cases WHERE id = $1", [s.caseId])).rows[0]?.state).toBe("SUSPENDED");
    const entry = t.adminAudit.entries.filter((e) => e.action === "store.suspended").at(-1);
    expect(entry).toMatchObject({ targetType: "store", targetId: s.storeId, diff: { before: { status: "ACTIVE" }, after: { status: "SUSPENDED", reasonCode: "price_fraud", sellerId: s.sellerId } } });
    expect(JSON.stringify(entry)).not.toContain("inflated");
    // Suspended already: a new request is refused before any approval is filed.
    expect((await post(one.token, `/v1/eg/admin/stores/${s.storeId}/suspend`, { reason_code: "price_fraud", note: "again please" })).statusCode).toBe(409);
    expect(json<{ code: string }>((await post(one.token, `/v1/eg/admin/stores/${s.storeId}/suspend`, { reason_code: "price_fraud", note: "again please" })).body).code).toBe("invalid-transition");
    // Replaying the execute is a conflict (claimed once).
    expect((await post(two.token, `/v1/eg/admin/approval-requests/${url}/execute`, {})).statusCode).toBe(409);
  });

  it("reinstate brings the seller and the stores back after two approvals; only a suspended store can be reinstated", async () => {
    const s = await seedStore(t.raw, "SUSPENDED", "suspended");
    const active = await seedStore(t.raw);
    const one = await t.admin(["ops"]);
    const nope = await post(one.token, `/v1/eg/admin/stores/${active.storeId}/reinstate`, { reason_code: "appeal_upheld", note: "not suspended at all" });
    expect(json<{ code: string }>(nope.body).code).toBe("invalid-transition");
    const asked = await post(one.token, `/v1/eg/admin/stores/${s.storeId}/reinstate`, { reason_code: "appeal_upheld", note: "evidence re-scored, no violation" });
    expect(asked.statusCode).toBe(409);
    const id = json<{ detail: string }>(asked.body).detail;
    await decide((await t.admin(["trust_safety"])).token, id);
    expect(json<{ status: string }>((await decide((await t.admin(["ops"])).token, id)).body).status).toBe("EXECUTED");
    expect(await status(s.storeId)).toBe("ACTIVE");
    expect(await sellerStatus(s.sellerId)).toBe("active");
    expect(t.adminAudit.entries.filter((e) => e.action === "store.reinstated").at(-1)).toMatchObject({ targetId: s.storeId, diff: { after: { status: "ACTIVE", reasonCode: "appeal_upheld" } } });
  });

  it("validation: a free-text reason code, a short note and unknown fields are 400; finance and support are 403; an unknown store is 404", async () => {
    const s = await seedStore(t.raw);
    const ts = await t.admin(["trust_safety"]);
    const url = `/v1/eg/admin/stores/${s.storeId}/suspend`;
    expect((await post(ts.token, url, { reason_code: "because", note: "long enough note" })).statusCode).toBe(400);
    expect((await post(ts.token, url, { reason_code: "price_fraud", note: "no" })).statusCode).toBe(400);
    expect((await post(ts.token, url, { reason_code: "price_fraud", note: "long enough note", extra: 1 })).statusCode).toBe(400);
    expect((await post(ts.token, `/v1/eg/admin/stores/${s.storeId}/reinstate`, { reason_code: "price_fraud", note: "long enough note" })).statusCode).toBe(400);
    for (const role of ["finance", "support", "dpo"]) expect((await post((await t.admin([role])).token, url, { reason_code: "price_fraud", note: "long enough note" })).statusCode).toBe(403);
    expect((await post(ts.token, `/v1/eg/admin/stores/${randomUUID()}/suspend`, { reason_code: "price_fraud", note: "long enough note" })).statusCode).toBe(404);
    expect(await status(s.storeId)).toBe("ACTIVE");
  });
});

describe("PII access log", () => {
  it("lists newest first with keyset paging and filters by staff, target type and date range", async () => {
    const actor = randomUUID();
    await seedPiiAccess(t.raw, { actorId: actor, at: "2031-03-01T10:00:00Z" });
    await seedPiiAccess(t.raw, { actorId: actor, at: "2031-03-02T10:00:00Z", targetType: "reconciliation_run" });
    await seedPiiAccess(t.raw, { actorId: actor, at: "2031-03-03T10:00:00Z" });
    await seedPiiAccess(t.raw, { at: "2031-03-04T10:00:00Z" });
    const { token } = await t.admin(["dpo"]);
    interface Page { items: { id: string; staff_id: string; target_type: string; reason_code: string; occurred_at: string }[]; next_cursor: string | null }
    const first = json<Page>((await get(token, `/v1/eg/admin/privacy/pii-access-log?staff_id=${actor}&limit=2`)).body);
    expect(first.items.map((i) => i.occurred_at)).toEqual(["2031-03-03T10:00:00.000Z", "2031-03-02T10:00:00.000Z"]);
    expect(first.items[0]).toMatchObject({ staff_id: actor, reason_code: "fraud_review", target_type: "kyc_case" });
    expect(first.next_cursor).not.toBeNull();
    const second = json<Page>((await get(token, `/v1/eg/admin/privacy/pii-access-log?staff_id=${actor}&limit=2&cursor=${first.next_cursor ?? ""}`)).body);
    expect(second.items.map((i) => i.occurred_at)).toEqual(["2031-03-01T10:00:00.000Z"]);
    expect(second.next_cursor).toBeNull();
    const typed = json<Page>((await get(token, `/v1/eg/admin/privacy/pii-access-log?staff_id=${actor}&target_type=reconciliation_run`)).body);
    expect(typed.items).toHaveLength(1);
    const ranged = json<Page>((await get(token, `/v1/eg/admin/privacy/pii-access-log?from=2031-03-02&to=2031-03-03&limit=10`)).body);
    expect(ranged.items.map((i) => i.occurred_at)).toEqual(["2031-03-03T10:00:00.000Z", "2031-03-02T10:00:00.000Z"]);
  });

  it("never returns another market's rows, rejects a bad cursor, allows security, refuses everyone else, and does not log itself", async () => {
    const id = randomUUID();
    await t.raw.query("INSERT INTO pii_access_log (id, market_id, actor_id, target_type, target_id, action, reason_code, occurred_at) VALUES ($1,'ZZ',$2,'kyc_case',$3,'seller_kyc.read','fraud_review','2032-01-01')", [id, randomUUID(), randomUUID()]);
    const sec = await t.admin(["security"]);
    const all = json<{ items: { id: string }[] }>((await get(sec.token, "/v1/eg/admin/privacy/pii-access-log?limit=50")).body);
    expect(all.items.some((i) => i.id === id)).toBe(false);
    expect((await get(sec.token, `/v1/eg/admin/privacy/pii-access-log?cursor=${Buffer.from("a|b").toString("base64url")}`)).statusCode).toBe(400);
    for (const role of ["ops", "finance", "trust_safety", "support", "marketing"]) expect((await get((await t.admin([role])).token, "/v1/eg/admin/privacy/pii-access-log")).statusCode).toBe(403);
    const before = (await t.raw.query<{ n: string }>("SELECT count(*)::text AS n FROM pii_access_log WHERE market_id = 'EG'")).rows[0]?.n;
    await get(sec.token, "/v1/eg/admin/privacy/pii-access-log");
    expect((await t.raw.query<{ n: string }>("SELECT count(*)::text AS n FROM pii_access_log WHERE market_id = 'EG'")).rows[0]?.n).toBe(before);
  });

  it("outlet_app still cannot read the table directly (only the market-pinned function)", async () => {
    const { roleClient } = await import("@outlet/db/testing");
    await expect(roleClient(t.raw, "outlet_app").query("SELECT * FROM pii_access_log")).rejects.toThrow();
  });
});
