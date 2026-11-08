import { SellerAccountsError } from "@outlet/seller-accounts";
import { describe, expect, it } from "vitest";
import { PgApprovalReader, PgKycAdmin, PgReconciliationReader } from "../src/modules/admin/pg-readers.js";
import { M1, S1, U1, fakeClient } from "./fake-sql.js";

const cur = (...p: string[]) => Buffer.from(p.join("|")).toString("base64url");
const T = "2026-01-01T00:00:00.000Z";
const principal = { marketId: M1, userId: U1 } as never;
const noUser = { marketId: M1 } as never;
const arow = (o: object = {}) => ({ id: "a", action: "x", target_type: "t", target_id: "i", requested_by: "r", status: "PENDING", created_at: T, expires_at: T, decided_by: null, decided_at: null, reason: null, executed_at: null, ...o });

describe("PgApprovalReader", () => {
  const mk = (rows: object[]) => fakeClient((s) => (s.includes("FROM approval_requests") ? rows : []));
  it("maps executed vs approved and truncates reasons; decided fields", async () => {
    const { client } = mk([arow({ status: "APPROVED", executed_at: T, reason: "r".repeat(600), decided_at: new Date(T), decided_by: "d" }), arow({ id: "b", status: "APPROVED" })]);
    const page = await new PgApprovalReader(client).list(principal, { limit: 5 });
    expect(page.items.map((i) => i.status)).toEqual(["EXECUTED", "APPROVED"]);
    expect(page.items[0]?.reason).toHaveLength(500);
    expect(page.items[0]?.decided_at).toBe(T);
    expect(page.next_cursor).toBeNull();
  });
  it("builds a filter per status and action and pages with a cursor", async () => {
    const { client, log } = mk([arow(), arow({ id: "b" })]);
    const r = new PgApprovalReader(client);
    const page = await r.list(noUser, { limit: 1, status: "PENDING", action: "payout", cursor: cur(T, S1) } as never);
    expect(page.next_cursor).not.toBeNull();
    const s = log.stmts.filter((x) => x.sql.includes("approval_requests")).at(-1);
    expect(s?.sql).toContain("status = $2");
    expect(s?.params).toEqual([M1, "PENDING", "payout", T, S1]);
    await r.list(noUser, { limit: 1, status: "EXECUTED" } as never);
    await r.list(noUser, { limit: 1, status: "APPROVED" } as never);
    expect(log.stmts.some((x) => x.sql.includes("executed_at IS NULL"))).toBe(true);
    expect(log.stmts.some((x) => x.sql.includes("executed_at IS NOT NULL"))).toBe(true);
  });
  it("rejects malformed cursors with 400", async () => {
    const r = new PgApprovalReader(mk([]).client);
    for (const c of ["%%", cur("a"), cur("not-a-date", S1)]) await expect(r.list(principal, { limit: 1, cursor: c })).rejects.toMatchObject({ status: 400 });
  });
  it("get: 404 when absent, mapped row otherwise", async () => {
    await expect(new PgApprovalReader(mk([]).client).get(principal, S1)).rejects.toMatchObject({ status: 404 });
    expect((await new PgApprovalReader(mk([arow()]).client).get(noUser, S1)).id).toBe("a");
  });
});

describe("PgKycAdmin", () => {
  const crow = { id: "c1", seller_id: S1, legal_name_ar: null, state: "SUBMITTED", submitted_at: T };
  const list = (rows: object[], q: object) => new PgKycAdmin(fakeClient<"outlet_worker">((s) => (s.includes("kyc_cases") ? rows : [])).client, { decide: () => Promise.reject(new Error("x")) }).list(M1, q as never);
  it("lists, defaulting a null legal name and paging by submitted_at", async () => {
    const p = await list([crow, { ...crow, id: "c2", submitted_at: null }], { limit: 1, status: "SUBMITTED", cursor: cur(T, S1) });
    expect(p.items[0]).toMatchObject({ legal_name_ar: "", submitted_at: T });
    expect(p.next_cursor).not.toBeNull();
    expect((await list([crow, { ...crow, submitted_at: null }], { limit: 1 })).items).toHaveLength(1);
    expect((await list([{ ...crow, submitted_at: null }, crow], { limit: 1 })).next_cursor).toBeNull();
    expect((await list([crow], { limit: 5 })).next_cursor).toBeNull();
  });
  it("rejects bad cursors", async () => {
    await expect(list([], { limit: 1, cursor: cur("x") })).rejects.toMatchObject({ status: 400 });
    await expect(list([], { limit: 1, cursor: cur("bad", S1) })).rejects.toMatchObject({ status: 400 });
  });
  const view = { caseId: "c1", sellerId: S1, state: "APPROVED", submittedAt: T, decidedAt: T, version: 2 };
  const decide = (impl: (p: unknown, id: string, i: Record<string, unknown>) => unknown, input: object) =>
    new PgKycAdmin(fakeClient<"outlet_worker">(() => []).client, { decide: ((p: unknown, id: string, i: Record<string, unknown>) => Promise.resolve(impl(p, id, i))) as never }).decide(principal, "c1", input as never);
  it("translates decisions to service verbs and reason codes", async () => {
    const seen: Record<string, unknown>[] = [];
    const impl = (_: unknown, __: string, i: Record<string, unknown>) => { seen.push(i); return view; };
    const a = await decide(impl, { decision: "APPROVED", decision_reason: "ok" });
    expect(a).toMatchObject({ id: "c1", status: "APPROVED", version: 2, decision_reason: "ok" });
    await decide(impl, { decision: "REJECTED", decision_reason: "no" });
    await decide(impl, { decision: "NEEDS_INFO", decision_reason: "more", requested_documents: ["id", "tax"] });
    await decide(impl, { decision: "NEEDS_INFO", decision_reason: "more", requested_documents: [] });
    expect(seen.map((s) => [s.decision, s.reasonCode])).toEqual([["approve", undefined], ["reject", "rejected_by_admin"], ["request_info", "needs_info"], ["request_info", "needs_info"]]);
    expect(seen[2]?.note).toBe("more | requested: id,tax");
    expect(seen[3]?.note).toBe("more");
  });
  it("maps domain errors to problems and rethrows foreign errors", async () => {
    const fail = (e: unknown) => decide(() => { throw e; }, { decision: "APPROVED", decision_reason: "x" });
    await expect(fail(new SellerAccountsError("not_found", "m"))).rejects.toMatchObject({ status: 404 });
    await expect(fail(new SellerAccountsError("forbidden", "m"))).rejects.toMatchObject({ status: 403 });
    await expect(fail(new SellerAccountsError("conflict", "m"))).rejects.toMatchObject({ status: 409, code: "invalid-transition" });
    await expect(fail(new SellerAccountsError("invalid_transition", "m"))).rejects.toMatchObject({ status: 409 });
    await expect(fail(new SellerAccountsError("validation", "m", ["a"]))).rejects.toMatchObject({ status: 422 });
    const boom = new Error("boom");
    await expect(fail(boom)).rejects.toBe(boom);
  });
});

describe("PgReconciliationReader", () => {
  const run = (o: object = {}) => ({ id: "r1", source: "eta_submission", counterparty: "eta", business_date: "2026-01-01", mode: "nightly", status: "running", matched_count: null, unmatched_count: null, started_at: T, finished_at: null, ...o });
  const rr = (rows: object[]) => { const f = fakeClient<"outlet_worker">((s) => (s.includes("FROM reconciliation_runs WHERE") ? rows : [])); return { r: new PgReconciliationReader(f.client), log: f.log }; };
  it("maps sources and statuses, defaults counts, and filters", async () => {
    const { r, log } = rr([run(), run({ id: "r2", source: "psp", status: "completed", matched_count: 3, unmatched_count: 1, finished_at: T }), run({ id: "r3", status: "failed" })]);
    const p = await r.listRuns(M1, { limit: 10, source: "store_credit", business_date: "2026-01-01", cursor: cur(T, S1) });
    expect(p.items.map((i) => [i.source, i.status, i.matched_count, i.unmatched_count])).toEqual([["eta", "RUNNING", 0, 0], ["psp", "COMPLETED", 3, 1], ["eta", "FAILED", 0, 0]]);
    expect(p.items[1]?.finished_at).toBe(T);
    expect(log.stmts.at(-1)?.params).toEqual([M1, "store_credit_projection", "2026-01-01", T, S1]);
    await r.listRuns(M1, { limit: 10, source: "psp" });
    expect(log.stmts.at(-1)?.params).toEqual([M1, "psp"]);
  });
  it("pages and rejects bad cursors", async () => {
    expect((await rr([run(), run({ id: "r2" })]).r.listRuns(M1, { limit: 1 })).next_cursor).not.toBeNull();
    for (const c of [cur("x"), cur("bad", S1)]) await expect(rr([]).r.listRuns(M1, { limit: 1, cursor: c })).rejects.toMatchObject({ status: 400 });
  });
  const item = (o: object = {}) => ({ id: "i1", run_id: "r1", ref_type: "t", ref_id: "x", entry_id: null, expected_minor: null, actual_minor: null, currency: "EGP ", status: "OPEN", ticket_ref: null, first_seen_at: "2026-01-01T00:00:00Z", resolved_at: null, ...o });
  const items = (rows: object[], runExists = true) => new PgReconciliationReader(fakeClient<"outlet_worker">((s) => (s.includes("reconciliation_exceptions") ? rows : s.includes("SELECT 1 FROM reconciliation_runs") ? (runExists ? [{}] : []) : [])).client);
  const NOW = new Date("2026-01-04T12:00:00Z");
  it("null for an unknown run", async () => {
    expect(await items([], false).listItems(M1, S1, { limit: 5 }, NOW)).toBeNull();
  });
  it("derives statuses, trims currency and computes age", async () => {
    const page = await items([
      item({ id: "1", expected_minor: "100", actual_minor: "90" }), item({ id: "2", expected_minor: "100" }), item({ id: "3", actual_minor: "5" }), item({ id: "4" }),
      item({ id: "5", status: "RESOLVED", expected_minor: "1", resolved_at: "2026-01-02T00:00:00Z" }), item({ id: "6", status: "ESCALATED", resolved_at: new Date("2025-12-01T00:00:00Z") }),
    ]).listItems(M1, S1, { limit: 10 }, NOW);
    expect(page?.items.map((i) => i.status)).toEqual(["AMOUNT_MISMATCH", "MISSING_SOURCE", "MISSING_LEDGER", "UNMATCHED", "RESOLVED", "UNMATCHED"]);
    expect(page?.items[0]?.expected).toEqual({ amount_minor: "100", currency: "EGP" });
    expect(page?.items[3]?.expected).toBeNull();
    expect(page?.items.map((i) => i.age_days)).toEqual([3, 3, 3, 3, 1, 0]);
    expect(page?.next_cursor).toBeNull();
  });
  it("pages, and rejects bad cursors inside the transaction", async () => {
    const p = await items([item(), item({ id: "2" })]).listItems(M1, S1, { limit: 1, cursor: cur(T, S1) }, NOW);
    expect(p?.next_cursor).not.toBeNull();
    for (const c of [cur("x"), cur("bad", S1)]) await expect(items([]).listItems(M1, S1, { limit: 1, cursor: c }, NOW)).rejects.toMatchObject({ status: 400 });
  });
});
