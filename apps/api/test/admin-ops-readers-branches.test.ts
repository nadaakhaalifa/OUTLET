import { randomUUID } from "node:crypto";
import type { Principal } from "@outlet/policy";
import { describe, expect, it } from "vitest";
import { PgApprovalReader, PgKycAdmin } from "../src/modules/admin/pg-readers.js";
import { PgElevationReader } from "../src/modules/admin/ops-services.js";
import { M1, S1, U1, fakeClient } from "./fake-sql.js";

const T = "2030-01-01T00:00:00.000Z";
const NOW = () => new Date(T);
const staff = (roles: string[]): Principal => ({ kind: "admin", userId: U1, marketId: "EG", roles, scopes: [] });
const anon = (roles: string[]): Principal => ({ kind: "admin", marketId: "EG", roles, scopes: [] });

describe("PgApprovalReader.countPending", () => {
  const rowsFor = (rows: object[]) => fakeClient((s) => (s.includes("FROM approval_requests r") ? rows : []));

  it("a principal without a user id sees nothing and issues no statement", async () => {
    const { client, log } = rowsFor([{ action: "role.grant", n: 5, soonest: T }]);
    expect(await new PgApprovalReader(client, NOW).countPending(anon(["security"]))).toEqual({ forMe: 0, soonestExpiresAt: null });
    expect(log.stmts).toEqual([]);
  });

  it("counts only the actions the caller's roles may decide, maps elevation.approve to role.grant, and reports the earliest expiry", async () => {
    const { client } = rowsFor([
      { action: "payout.approve", n: 2, soonest: "2030-01-03T00:00:00.000Z" },
      { action: "role.grant", n: 1, soonest: new Date("2030-01-02T00:00:00.000Z") },
      { action: "elevation.approve", n: 4, soonest: "2030-01-05T00:00:00.000Z" },
    ]);
    // security holds role.grant but not payout.approve
    expect(await new PgApprovalReader(client, NOW).countPending(staff(["security"]))).toEqual({ forMe: 5, soonestExpiresAt: "2030-01-02T00:00:00.000Z" });
    // finance holds payout.approve but not role.grant
    expect(await new PgApprovalReader(client, NOW).countPending(staff(["finance"]))).toEqual({ forMe: 2, soonestExpiresAt: "2030-01-03T00:00:00.000Z" });
    // a role that decides nothing here counts nothing and has no soonest
    expect(await new PgApprovalReader(client, NOW).countPending(staff(["support"]))).toEqual({ forMe: 0, soonestExpiresAt: null });
  });

  it("store.suspend requests expose their approved store ids (strings only, capped); other actions never do", async () => {
    const many = Array.from({ length: 250 }, (_, i) => `s${String(i)}`);
    const base = { target_type: "store", target_id: "i", requested_by: "r", status: "PENDING", created_at: T, expires_at: T, decided_by: null, decided_at: null, reason: null, executed_at: null };
    const { client } = fakeClient((s) => (s.includes("FROM approval_requests") ? [
      { ...base, id: "a", action: "store.suspend", payload: { storeIds: [...many, 7, null] } },
      { ...base, id: "b", action: "store.reinstate", payload: { storeIds: "nope" } },
      { ...base, id: "c", action: "store.suspend", payload: null },
      { ...base, id: "d", action: "payout.approve", payload: { storeIds: ["x"] } },
    ] : []));
    const page = await new PgApprovalReader(client).list(staff(["trust_safety"]), { limit: 10 });
    const byId = Object.fromEntries(page.items.map((i) => [i.id, i.store_ids]));
    expect(byId.a).toHaveLength(200);
    expect(byId.a?.every((x) => typeof x === "string")).toBe(true);
    expect(byId.b).toBeNull();
    expect(byId.c).toBeNull();
    expect(byId.d).toBeNull();
  });
});

describe("PgKycAdmin.count and detail edge data", () => {
  const worker = (script: (s: string) => object[]) => fakeClient<"outlet_worker">((s) => script(s)).client;
  const never = { decide: () => Promise.reject(new Error("unused")) } as never;

  it("count is zero for a missing row; a null oldest stays null; a Date oldest is ISO", async () => {
    expect(await new PgKycAdmin(worker(() => []), never).count("EG")).toEqual({ submitted: 0, needsInfo: 0, oldestAt: null });
    expect(await new PgKycAdmin(worker(() => [{ submitted: 2, needs_info: 1, oldest: null }]), never).count("EG")).toEqual({ submitted: 2, needsInfo: 1, oldestAt: null });
    expect(await new PgKycAdmin(worker(() => [{ submitted: 2, needs_info: 1, oldest: new Date(T) }]), never).count("EG")).toEqual({ submitted: 2, needsInfo: 1, oldestAt: T });
  });

  it("detail: an unknown case is null; missing legal names read as empty strings; bad stored checks read as none; a long note is cut", async () => {
    expect(await new PgKycAdmin(worker(() => []), never).detail("EG", S1)).toBeNull();
    const caseRow = { id: S1, seller_id: U1, kind: "onboarding", state: "SUBMITTED", submitted_at: null, decided_at: new Date(T), reason_note: "n".repeat(900), version: 3, provider: null, check_results: [{ nope: true }],
      legal_name_ar: null, legal_name_en: null, commercial_register_no: null, tax_card_no: null, governorate_name_ar: null };
    const docs = [
      { id: "d1", kind: "tax_card", media_asset_id: "m1", status: "verified", expires_on: new Date("2031-05-06T00:00:00Z"), created_at: new Date(T) },
      { id: "d2", kind: "commercial_register", media_asset_id: "m2", status: "pending", expires_on: "2031-07-08T00:00:00Z", created_at: T },
      { id: "d3", kind: "tax_card", media_asset_id: "m3", status: "pending", expires_on: null, created_at: T },
    ];
    const d = await new PgKycAdmin(worker((s) => (s.includes("FROM kyc_documents") ? docs : s.includes("FROM kyc_cases") ? [caseRow] : [])), never).detail("EG", S1);
    expect(d?.seller_legal).toEqual({ legal_name_ar: "", legal_name_en: null, commercial_register_no: "", tax_card_no: "", governorate_name_ar: "" });
    expect(d?.checks).toEqual([]);
    expect(d?.case.decision_reason).toHaveLength(500);
    expect(d?.case.submitted_at).toBeNull();
    expect(d?.case.decided_at).toBe(T);
    expect(d?.case.documents.map((x) => [x.verified, x.expires_on])).toEqual([[true, "2031-05-06"], [false, "2031-07-08"], [false, null]]);
  });

  it("detail: valid stored checks are listed with the case provider and an optional score", async () => {
    const caseRow = { id: S1, seller_id: U1, kind: "onboarding", state: "AUTO_CHECKS", submitted_at: T, decided_at: null, reason_note: null, version: 1, provider: "fake", check_results: [{ type: "register_lookup", result: "pass", scoreBp: 9000, checkedAt: T }, { type: "sanctions", result: "pass", checkedAt: T }],
      legal_name_ar: "م", legal_name_en: "S", commercial_register_no: "1", tax_card_no: "2", governorate_name_ar: "ق" };
    const d = await new PgKycAdmin(worker((s) => (s.includes("FROM kyc_cases") ? [caseRow] : [])), never).detail("EG", S1);
    expect(d?.checks).toEqual([
      { check_type: "register_lookup", result: "pass", score_bp: 9000, provider: "fake", checked_at: T },
      { check_type: "sanctions", result: "pass", score_bp: null, provider: "fake", checked_at: T },
    ]);
    expect(d?.case.decision_reason).toBeNull();
  });
});

describe("PgElevationReader", () => {
  const erow = (o: object = {}) => ({ id: randomUUID(), staff_id: U1, role_code: "ops", reason: "r".repeat(700), ttl_minutes: 30, status: "PENDING", created_at: "2029-12-31T00:00:00.000Z", pending_until: "2030-01-02T00:00:00.000Z",
    decided_at: null, starts_at: null, expires_at: null, approved_by: null, approval_request_id: null, ...o });
  const mk = (rows: object[]) => fakeClient((s) => (s.includes("FROM elevation_requests") ? rows : []));

  it("a request nobody decided in time reads as EXPIRED, a live one stays PENDING, long reasons are cut", async () => {
    const { client } = mk([erow({ pending_until: "2029-12-31T12:00:00.000Z" }), erow()]);
    const page = await new PgElevationReader(client, NOW).list(staff(["ops"]), { limit: 10 }, true);
    expect(page.items.map((i) => i.status)).toEqual(["EXPIRED", "PENDING"]);
    expect(page.items[0]?.reason).toHaveLength(500);
    expect(page.next_cursor).toBeNull();
  });

  it("own scope filters by the caller (an empty id without a user), status filters, and a cursor is validated before any statement", async () => {
    const { client, log } = mk([erow(), erow()]);
    const r = new PgElevationReader(client, NOW);
    const page = await r.list(anon(["ops"]), { limit: 1, status: "APPROVED" } as never, false);
    expect(page.next_cursor).not.toBeNull();
    const s = log.stmts.filter((x) => x.sql.includes("FROM elevation_requests")).at(-1);
    expect(s?.sql).toContain("e.staff_id = $2::uuid");
    expect(s?.params).toEqual(["EG", "", "APPROVED"]);
    const bad = (c: string) => r.list(staff(["ops"]), { limit: 1, cursor: c }, true);
    for (const c of ["%%", Buffer.from("a").toString("base64url"), Buffer.from("not-a-date|" + S1).toString("base64url"), Buffer.from(`${T}|not-a-uuid`).toString("base64url")]) await expect(bad(c)).rejects.toMatchObject({ status: 400 });
    const before = log.stmts.length;
    await r.list(staff(["ops"]), { limit: 1, cursor: Buffer.from(`${T}|${S1}`).toString("base64url") }, true);
    expect(log.stmts.length).toBeGreaterThan(before);
  });

  it("countActive: zero without a user in own scope (no statement), counts from the row otherwise, zero for an empty result", async () => {
    const { client, log } = mk([{ active: 2, pending: 1 }]);
    const r = new PgElevationReader(client, NOW);
    expect(await r.countActive(anon(["ops"]), false)).toEqual({ active: 0, pending: 0 });
    expect(log.stmts).toEqual([]);
    expect(await r.countActive(staff(["ops"]), false)).toEqual({ active: 2, pending: 1 });
    expect(await r.countActive(anon(["ops"]), true)).toEqual({ active: 2, pending: 1 });
    expect(await new PgElevationReader(mk([]).client, NOW).countActive(staff(["ops"]), true)).toEqual({ active: 0, pending: 0 });
  });

  it("get: someone else's request is 404 in own scope and visible in market scope; an unknown id is 404", async () => {
    const other = erow({ staff_id: M1 });
    await expect(new PgElevationReader(mk([other]).client, NOW).get(staff(["ops"]), other.id, false)).rejects.toMatchObject({ status: 404 });
    expect((await new PgElevationReader(mk([other]).client, NOW).get(staff(["ops"]), other.id, true)).staff_id).toBe(M1);
    expect((await new PgElevationReader(mk([erow()]).client, NOW).get(staff(["ops"]), S1, false)).staff_id).toBe(U1);
    await expect(new PgElevationReader(mk([]).client, NOW).get(staff(["ops"]), S1, true)).rejects.toMatchObject({ status: 404 });
  });
});
