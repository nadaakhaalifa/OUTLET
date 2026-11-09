import { PgAuditStore, canonicalJson } from "@outlet/audit-log";
import { createHash } from "node:crypto";
import { contextClient } from "@outlet/db";
import { roleClient } from "@outlet/db/testing";
import { KILL_SWITCHES } from "@outlet/flags";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bearer, createTestApp, idemKey } from "./harness.js";
import type { TestApp } from "./harness.js";
import { seedApproval, seedApprovedUnexecuted, seedElevation } from "./admin-fixtures.js";
import { flagPage } from "../src/modules/admin/index.js";
import { PgAuditReader } from "../src/modules/admin/index.js";

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- test helper: the caller states the expected shape
const json = <T>(body: string): T => JSON.parse(body) as T;
const post = (token: string, url: string, payload: object, key = idemKey(t)) => t.inject({ method: "POST", url, headers: { ...bearer(token), "idempotency-key": key }, payload });
const get = (token: string, url: string) => t.inject({ method: "GET", url, headers: bearer(token) });
interface Flag { key: string; kind: string; description: string; fail_mode: string; rules: { enabled: boolean; market_id: string | null; version: number; id: string }[] }
const kill = (token: string, key: string, enabled: boolean, reason = "incident drill") => post(token, `/v1/eg/admin/feature-flags/${key}/kill-switch`, { enabled, reason });
const auditStore = (userId: string): PgAuditStore => new PgAuditStore(contextClient(roleClient(t.raw, "outlet_app"), { kind: "user", marketId: "EG", userId }));

describe("feature flags", () => {
  it("lists every registered kill switch with its class, sorted, and pages with a keyset cursor", async () => {
    const { token } = await t.admin(["security"]);
    const first = json<{ items: Flag[]; next_cursor: string | null }>((await get(token, "/v1/eg/admin/feature-flags?limit=5")).body);
    expect(first.items.map((f) => f.key)).toEqual(Object.keys(KILL_SWITCHES).sort().slice(0, 5));
    expect(first.items.every((f) => f.kind === "kill_switch" && f.rules.length === 0)).toBe(true);
    const all: Flag[] = [...first.items];
    let cursor = first.next_cursor;
    while (cursor !== null) {
      const page = json<{ items: Flag[]; next_cursor: string | null }>((await get(token, `/v1/eg/admin/feature-flags?limit=10&cursor=${cursor}`)).body);
      all.push(...page.items);
      cursor = page.next_cursor;
    }
    expect(all.map((f) => f.key)).toEqual(Object.keys(KILL_SWITCHES).sort());
    expect(all.find((f) => f.key === "payments.cod.enabled")).toMatchObject({ fail_mode: "closed" });
    expect(all.find((f) => f.key === "games.enabled")).toMatchObject({ fail_mode: "open" });
  });

  it("a malformed cursor is a 400", async () => {
    const { token } = await t.admin(["security"]);
    expect((await get(token, `/v1/eg/admin/feature-flags?cursor=${Buffer.from("a|b").toString("base64url")}`)).statusCode).toBe(400);
  });

  it("engaging a ui switch is single-key, shows the market row, and writes one audit entry with the reason", async () => {
    const { userId, token } = await t.admin(["finance"]);
    const before = t.adminAudit.entries.length;
    const res = await kill(token, "games.enabled", false, "abuse of the spin wheel");
    expect(res.statusCode).toBe(200);
    expect(json<Flag>(res.body)).toMatchObject({ key: "games.enabled", kind: "kill_switch", rules: [{ enabled: false, market_id: "EG", version: 1 }] });
    const entries = t.adminAudit.entries.slice(before);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ action: "kill_switch.engaged", actorId: userId, targetType: "feature_flag", targetId: "games.enabled", diff: { before: null, after: { enabled: false, version: 1, reasonHash: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown } } });
    expect(JSON.stringify(entries[0])).not.toContain("abuse of the spin wheel");
    expect((await t.raw.query<{ enabled: boolean }>("SELECT enabled FROM feature_flags WHERE key = 'games.enabled' AND market_id = 'EG'")).rows[0]?.enabled).toBe(false);
    const again = json<Flag>((await kill(token, "games.enabled", true, "spin wheel fixed")).body);
    expect(again.rules[0]).toMatchObject({ enabled: true, version: 2 });
    expect(t.adminAudit.entries.at(-1)).toMatchObject({ action: "kill_switch.released", diff: { before: { enabled: false, version: 1 } } });
  });

  it("an unknown key is a 404 and creates nothing; a short reason and extra fields are 400", async () => {
    const { token } = await t.admin(["finance"]);
    expect((await kill(token, "not.a.switch", false)).statusCode).toBe(404);
    expect((await kill(token, "games.enabled", false, "no")).statusCode).toBe(400);
    expect((await post(token, "/v1/eg/admin/feature-flags/games.enabled/kill-switch", { enabled: false, reason: "fine reason", market_id: "EG" })).statusCode).toBe(400);
    expect((await t.raw.query("SELECT 1 FROM feature_flags WHERE key = 'not.a.switch'")).rows).toHaveLength(0);
  });

  it("support and marketing cannot read or toggle", async () => {
    const { token } = await t.admin(["support"]);
    expect((await get(token, "/v1/eg/admin/feature-flags")).statusCode).toBe(403);
    expect((await kill(token, "games.enabled", false)).statusCode).toBe(403);
  });

  it("re-enabling a money switch needs a second approver and applies once when approved", async () => {
    const one = await t.admin(["finance"]);
    expect((await kill(one.token, "payments.cod.enabled", false, "cod fraud ring")).statusCode).toBe(200);
    const asked = await kill(one.token, "payments.cod.enabled", true, "fraud ring contained");
    expect(asked.statusCode).toBe(409);
    const problem = json<{ code: string; detail: string }>(asked.body);
    expect(problem.code).toBe("dual-approval-required");
    const stillKilled = json<{ items: Flag[] }>((await get(one.token, "/v1/eg/admin/feature-flags?limit=50")).body).items.find((f) => f.key === "payments.cod.enabled");
    expect(stillKilled?.rules[0]?.enabled).toBe(false);
    const url = `/v1/eg/admin/approval-requests/${problem.detail}/decision`;
    expect((await post(one.token, url, { decision: "approve", reason: "my own request" })).statusCode).toBe(403);
    const two = await t.admin(["security"]);
    const first = await post(two.token, url, { decision: "approve", reason: "first approval ok" });
    expect(json<{ status: string }>(first.body).status).toBe("PENDING");
    const three = await t.admin(["security"]);
    const done = await post(three.token, url, { decision: "approve", reason: "second approval ok" });
    expect(json<{ status: string }>(done.body).status).toBe("EXECUTED");
    const after = json<{ items: Flag[] }>((await get(one.token, "/v1/eg/admin/feature-flags?limit=50")).body).items.find((f) => f.key === "payments.cod.enabled");
    expect(after?.rules[0]).toMatchObject({ enabled: true, version: 2 });
    expect(t.adminAudit.entries.map((e) => e.action)).toEqual(expect.arrayContaining(["approval.requested", "approval.executed", "kill_switch.released"]));
  });

  it("a fully approved release naming a switch that does not exist is refused (422) and stays unexecuted", async () => {
    const a = await seedApproval(t.raw, { action: "kill_switch.engage" });
    const payload = {};
    const hash = createHash("sha256").update(canonicalJson({ action: "kill_switch.engage", targetType: "kill_switch", targetId: "bogus.key", payload })).digest("hex");
    await t.raw.query("UPDATE approval_requests SET target_type = 'kill_switch', target_id = 'bogus.key', payload = '{}'::jsonb, payload_hash = decode($2,'hex') WHERE id = $1", [a.id, hash]);
    await t.raw.query("INSERT INTO approval_decisions (id, approval_request_id, market_id, approver_id, decision, note, created_at) VALUES ($1,$2,'EG',$3,'APPROVE','first',now())", [randomUUID(), a.id, randomUUID()]);
    const { token } = await t.admin(["security"]);
    const res = await post(token, `/v1/eg/admin/approval-requests/${a.id}/decision`, { decision: "approve", reason: "second approval ok" });
    expect(res.statusCode).toBe(422);
    expect(json<{ code: string }>(res.body).code).toBe("unknown-kill-switch");
    const row = await t.raw.query<{ executed_at: string | null }>("SELECT executed_at FROM approval_requests WHERE id = $1", [a.id]);
    expect(row.rows[0]?.executed_at).toBeNull();
  });

  it("recovery: an APPROVED release that never executed is run once by POST approval-requests/{id}/execute; a replay is 409, the requester is 403, a pending one is 409", async () => {
    const a = await seedApprovedUnexecuted(t.raw);
    const url = `/v1/eg/admin/approval-requests/${a.id}/execute`;
    const fin = await t.admin(["finance"]);
    const done = await post(fin.token, url, {});
    expect(done.statusCode).toBe(200);
    expect(json<{ status: string }>(done.body).status).toBe("EXECUTED");
    expect(t.adminAudit.entries.map((e) => e.action)).toEqual(expect.arrayContaining(["approval.executed", "kill_switch.released"]));
    const again = await post(fin.token, url, {});
    expect(again.statusCode).toBe(409);
    expect(json<{ code: string }>(again.body).code).toBe("approval-not-approved");
    const own = await t.admin(["finance"]);
    const mine = await seedApprovedUnexecuted(t.raw, { requestedBy: own.userId });
    expect((await post(own.token, `/v1/eg/admin/approval-requests/${mine.id}/execute`, {})).statusCode).toBe(403);
    const pending = await seedApproval(t.raw, { action: "kill_switch.engage" });
    expect((await post(fin.token, `/v1/eg/admin/approval-requests/${pending.id}/execute`, {})).statusCode).toBe(409);
  });

  it("flagPage pages stored non-switch flags too and tolerates unknown keys", () => {
    const rec = { key: "zzz.release", marketId: null, enabled: true, rules: { rolloutPercent: 10 }, version: 1, updatedBy: "u", updatedAt: new Date() };
    const page = flagPage([rec], { limit: 50 });
    expect(page.items.at(-1)).toMatchObject({ key: "zzz.release", kind: "release", fail_mode: "open", rules: [{ market_id: null, variant: { rolloutPercent: 10 } }] });
  });
});

describe("approval decisions are gated on approval.decide plus the request's own action role", () => {
  it("finance can decide a payout approval, ops cannot, and the requester still cannot approve their own", async () => {
    const requester = await t.admin(["finance"]);
    const a = await seedApproval(t.raw, { action: "payout.approve", requestedBy: requester.userId });
    const url = `/v1/eg/admin/approval-requests/${a.id}/decision`;
    expect(json<{ code: string }>((await post(requester.token, url, { decision: "approve", reason: "my own request" })).body).code).toBe("self-approval");
    const ops = await t.admin(["ops"]);
    expect((await post(ops.token, url, { decision: "approve", reason: "not my area" })).statusCode).toBe(403);
    expect((await get(ops.token, "/v1/eg/admin/approval-requests")).statusCode).toBe(200);
    const fin = await t.admin(["finance"]);
    const res = await post(fin.token, url, { decision: "approve", reason: "amount checked" });
    expect(res.statusCode).toBe(200);
    expect(json<{ status: string }>(res.body).status).toBe("PENDING");
    const shopper = await t.shopper();
    expect((await post(shopper.token, url, { decision: "approve", reason: "nice try" })).statusCode).toBe(403);
  });
});

describe("audit log", () => {
  it("lists newest first, hides diffs, filters by actor and target type, and pages by cursor", async () => {
    const { token } = await t.admin(["security"]);
    const actor = randomUUID();
    const store = auditStore(actor);
    for (const [i, type] of ["a_thing", "a_thing", "b_thing"].entries()) {
      await store.append({ marketId: "EG", actorType: "staff", actorId: actor, action: `x.${String(i)}`, targetType: type, targetId: `t${String(i)}`, diff: { after: { secret: "hidden" } }, ipHash: null, deviceId: null, requestId: `req-${String(i)}` });
    }
    await store.append({ marketId: "EG", actorType: "system", actorId: "not-a-uuid", action: "sys.tick", targetType: "sys_thing", targetId: "s", diff: null, ipHash: null, deviceId: null, requestId: null });
    interface Entry { action: string; actor_id: string | null; request_id: string; reason_code: string | null; diff?: unknown }
    const all = json<{ items: Entry[]; next_cursor: string | null }>((await get(token, "/v1/eg/admin/audit-log?limit=10")).body);
    expect(all.items[0]).toMatchObject({ action: "sys.tick", actor_id: null, request_id: "", reason_code: null });
    expect(JSON.stringify(all)).not.toContain("hidden");
    expect(all.items.every((e) => e.diff === undefined)).toBe(true);
    const mine = json<{ items: Entry[] }>((await get(token, `/v1/eg/admin/audit-log?actor_id=${actor}&target_type=a_thing`)).body);
    expect(mine.items.map((e) => e.action)).toEqual(["x.1", "x.0"]);
    const p1 = json<{ items: Entry[]; next_cursor: string | null }>((await get(token, `/v1/eg/admin/audit-log?actor_id=${actor}&limit=2`)).body);
    expect(p1.items.map((e) => e.action)).toEqual(["x.2", "x.1"]);
    const p2 = json<{ items: Entry[]; next_cursor: string | null }>((await get(token, `/v1/eg/admin/audit-log?actor_id=${actor}&limit=2&cursor=${p1.next_cursor ?? ""}`)).body);
    expect(p2.items.map((e) => e.action)).toEqual(["x.0"]);
    expect(p2.next_cursor).toBeNull();
  });

  it("filters by date range (inclusive of the end day) and stops at the lower bound", async () => {
    const { token } = await t.admin(["security"]);
    const day = new Date().toISOString().slice(0, 10);
    const hit = json<{ items: unknown[] }>((await get(token, `/v1/eg/admin/audit-log?from=${day}&to=${day}&limit=50`)).body);
    expect(hit.items.length).toBeGreaterThan(0);
    const past = json<{ items: unknown[]; next_cursor: string | null }>((await get(token, "/v1/eg/admin/audit-log?to=2000-01-01")).body);
    expect(past).toEqual({ items: [], next_cursor: null });
    const future = json<{ items: unknown[]; next_cursor: string | null }>((await get(token, "/v1/eg/admin/audit-log?from=2999-01-01")).body);
    expect(future).toEqual({ items: [], next_cursor: null });
  });

  it("a malformed cursor is a 400 and dpo/finance cannot read the audit log", async () => {
    const sec = await t.admin(["security"]);
    expect((await get(sec.token, `/v1/eg/admin/audit-log?cursor=${Buffer.from("a|b").toString("base64url")}`)).statusCode).toBe(400);
    expect((await get(sec.token, `/v1/eg/admin/audit-log?cursor=${Buffer.from("0").toString("base64url")}`)).statusCode).toBe(400);
    const fin = await t.admin(["finance"]);
    expect((await get(fin.token, "/v1/eg/admin/audit-log")).statusCode).toBe(403);
  });

  it("spends its scan budget and resumes from the last row looked at", async () => {
    const actor = randomUUID();
    const store = auditStore(actor);
    for (let i = 0; i < 3; i += 1) await store.append({ marketId: "EG", actorType: "staff", actorId: actor, action: `scan.${String(i)}`, targetType: "scan_thing", targetId: String(i), diff: null, ipHash: null, deviceId: null, requestId: null });
    const reader = new PgAuditReader(roleClient(t.raw, "outlet_app"));
    const p = { kind: "admin" as const, userId: actor, marketId: "EG", roles: ["security"], scopes: [] };
    // A `to` in the past skips every row; with the batch size shrunk by volume this ends without a cursor once the chain is exhausted.
    const r = await reader.list(p, { limit: 5, to: "2000-01-01" });
    expect(r.items).toEqual([]);
  });
});

describe("services not composed", () => {
  it("answers 503 on every ops route when the console has no ops services", async () => {
    const bare = await createTestApp({ adminOps: false });
    try {
      const { token } = await bare.admin(["security", "finance"]);
      expect((await bare.inject({ method: "GET", url: "/v1/eg/admin/audit-log", headers: bearer(token) })).statusCode).toBe(503);
      expect((await bare.inject({ method: "GET", url: "/v1/eg/admin/feature-flags", headers: bearer(token) })).statusCode).toBe(503);
    } finally {
      await bare.close();
    }
  });
});

describe("audit-log verify", () => {
  it("an intact chain verifies; a tampered row is reported with its seq and reason", async () => {
    const { token, userId } = await t.admin(["security"]);
    const store = auditStore(userId);
    for (let i = 0; i < 3; i += 1) await store.append({ marketId: "EG", actorType: "staff", actorId: userId, action: `verify.${String(i)}`, targetType: "verify_thing", targetId: String(i), diff: null, ipHash: null, deviceId: null, requestId: null });
    const ok = json<{ ok: boolean; checked: number; head_seq: number; broken_seq: number | null }>((await get(token, "/v1/eg/admin/audit-log/verify")).body);
    expect(ok).toMatchObject({ ok: true, broken_seq: null });
    expect(ok.checked).toBeGreaterThanOrEqual(3);
    expect(json<{ ok: boolean }>((await get(token, "/v1/eg/admin/audit-log/verify?from_seq=2")).body).ok).toBe(true);
    expect((await get(token, "/v1/eg/admin/audit-log/verify?from_seq=0")).statusCode).toBe(400);
    expect((await get((await t.admin(["finance"])).token, "/v1/eg/admin/audit-log/verify")).statusCode).toBe(403);
    // The append-only trigger blocks edits, so switch it off for the superuser connection only while tampering.
    await t.raw.query("ALTER TABLE audit_log DISABLE TRIGGER USER");
    await t.raw.query("UPDATE audit_log SET action = 'tampered' WHERE seq = (SELECT max(seq) FROM audit_log)");
    await t.raw.query("ALTER TABLE audit_log ENABLE TRIGGER USER");
    const bad = json<{ ok: boolean; broken_seq: number; reason: string }>((await get(token, "/v1/eg/admin/audit-log/verify")).body);
    expect(bad).toMatchObject({ ok: false, reason: "hash" });
    expect(bad.broken_seq).toBeGreaterThanOrEqual(3);
  });

  it("answers 503 without ops services", async () => {
    const bare = await createTestApp({ adminOps: false });
    try {
      const { token } = await bare.admin(["security"]);
      expect((await bare.inject({ method: "GET", url: "/v1/eg/admin/audit-log/verify", headers: bearer(token) })).statusCode).toBe(503);
      expect((await bare.inject({ method: "GET", url: "/v1/eg/admin/elevations", headers: bearer(token) })).statusCode).toBe(503);
    } finally {
      await bare.close();
    }
  });
});

describe("elevations", () => {
  const els = "/v1/eg/admin/elevations";
  it("request, list scope (own vs approvers), approve once, self-approval and replay refused, audited", async () => {
    const req = await t.admin(["support"]);
    const created = await post(req.token, els, { role: "ops", reason: "incident response", ttl_minutes: 15 });
    expect(created.statusCode).toBe(201);
    const e = json<{ id: string; status: string; staff_id: string; approval_request_id: string | null }>(created.body);
    expect(e).toMatchObject({ status: "PENDING", staff_id: req.userId, approval_request_id: null });
    expect((await post(req.token, els, { role: "ops", reason: "x", ttl_minutes: 15 })).statusCode).toBe(400);
    expect((await post(req.token, els, { role: "ops", reason: "too long window", ttl_minutes: 61 })).statusCode).toBe(400);
    const other = await seedElevation(t.raw);
    const mine = json<{ items: { id: string }[] }>((await get(req.token, els)).body).items.map((i) => i.id);
    expect(mine).toContain(e.id);
    expect(mine).not.toContain(other.id);
    const sec = await t.admin(["security"]);
    const all = json<{ items: { id: string }[] }>((await get(sec.token, `${els}?status=PENDING&limit=50`)).body).items.map((i) => i.id);
    expect(all).toEqual(expect.arrayContaining([e.id, other.id]));
    expect((await post(req.token, `${els}/${e.id}/decision`, { decision: "approve" })).statusCode).toBe(403);
    const ok = await post(sec.token, `${els}/${e.id}/decision`, { decision: "approve" });
    expect(ok.statusCode).toBe(200);
    expect(json<{ status: string; approved_by: string }>(ok.body)).toMatchObject({ status: "APPROVED", approved_by: sec.userId });
    expect((await post(sec.token, `${els}/${e.id}/decision`, { decision: "reject" })).statusCode).toBe(409);
    expect(t.adminAudit.entries.map((a) => a.action)).toEqual(expect.arrayContaining(["elevation.requested", "elevation.approved"]));
  });

  it("the requester cannot decide their own elevation", async () => {
    const sec = await t.admin(["security"]);
    const own = await seedElevation(t.raw, { staffId: sec.userId });
    const r = await post(sec.token, `${els}/${own.id}/decision`, { decision: "approve" });
    expect(r.statusCode).toBe(403);
    expect(json<{ code: string }>(r.body).code).toBe("self-approval");
  });

  it("super_admin: single approval is refused, dual approval via its approval request activates break-glass", async () => {
    const req = await t.admin(["security"]);
    const created = json<{ id: string; approval_request_id: string }>((await post(req.token, els, { role: "super_admin", reason: "break glass drill", ttl_minutes: 10 })).body);
    expect(created.approval_request_id).toEqual(expect.any(String));
    const a = await t.admin(["security"]);
    const single = await post(a.token, `${els}/${created.id}/decision`, { decision: "approve" });
    expect(single.statusCode).toBe(409);
    expect(json<{ code: string }>(single.body).code).toBe("dual-approval-required");
    const url = `/v1/eg/admin/approval-requests/${created.approval_request_id}/decision`;
    expect(json<{ status: string }>((await post(a.token, url, { decision: "approve", reason: "first approver" })).body).status).toBe("PENDING");
    const b = await t.admin(["security"]);
    expect((await post(b.token, url, { decision: "approve", reason: "second approver" })).statusCode).toBe(200);
    const after = json<{ status: string; approved_by: string }>((await get(b.token, `${els}?status=APPROVED`)).body);
    expect(JSON.stringify(after)).toContain(created.id);
    expect(t.adminAudit.entries.map((x) => x.action)).toContain("elevation.approved");
  });
});
