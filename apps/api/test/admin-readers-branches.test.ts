import { randomUUID } from "node:crypto";
import { CatalogError } from "@outlet/catalog";
import type { SqlClient } from "@outlet/db";
import { createTestClient, roleClient } from "@outlet/db/testing";
import type { Principal } from "@outlet/policy";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AttentionAdmin, PgDashboardReader, StoreModeration } from "../src/modules/admin/index.js";
import type { AuditAppendPort, StoreModerationInput } from "../src/modules/admin/index.js";
import { ProblemError } from "../src/platform/problem.js";

const staff = (userId?: string): Principal => ({ kind: "admin", ...(userId === undefined ? {} : { userId }), marketId: "EG", roles: ["ops"], scopes: [] });

describe("AttentionAdmin without a user id", () => {
  it("refuses to write on behalf of nobody: ack and resolve are 403 and never reach the database", async () => {
    let touched = false;
    const db = new Proxy({}, { get: () => { touched = true; throw new Error("db used"); } });
    const svc = new AttentionAdmin(db as never, { appendIn: () => Promise.resolve(undefined) });
    for (const run of [() => svc.ack(staff(), randomUUID()), () => svc.resolve(staff(), randomUUID(), "NOT_AN_ISSUE")]) {
      await expect(run()).rejects.toMatchObject({ status: 403 });
    }
    expect(touched).toBe(false);
  });
});

describe("StoreModeration.apply guards (stubbed ports)", () => {
  const S = randomUUID();
  const O = randomUUID();
  const input = (ids: string[]): StoreModerationInput => ({ reasonCode: "counterfeit", note: "a note", approvalRequestId: randomUUID(), storeIds: ids });
  const make = (opts: { status?: string; failOn?: Map<string, Error>; audit?: AuditAppendPort } = {}) => {
    const moved: string[] = [];
    const sellerCalls: string[] = [];
    const store = (id: string) => ({ id, status: opts.status ?? "ACTIVE" }) as never;
    const mod = new StoreModeration({
      stores: { getForAdmin: (_p, id) => Promise.resolve(store(id)), setModerationStatus: (_p, id) => { const f = opts.failOn?.get(id); if (f !== undefined) return Promise.reject(f); moved.push(id); return Promise.resolve(store(id)); } },
      sellers: {
        suspendStore: () => { sellerCalls.push("suspend"); return Promise.resolve({ sellerId: "sel" } as never); },
        reinstateStore: () => { sellerCalls.push("reinstate"); return Promise.resolve({ sellerId: "sel" } as never); },
        storeSet: () => Promise.resolve({ stores: [{ id: S, status: "ACTIVE" }, { id: O, status: "VACATION" }, { id: randomUUID(), status: "DRAFT" }] } as never),
      },
      audit: opts.audit ?? { appendIn: () => Promise.resolve(undefined) },
    });
    return { mod, moved, sellerCalls };
  };

  it("a request whose approved set omits the target store is 422 and nothing is written", async () => {
    const m = make();
    const err = await m.mod.apply(staff("u"), S, "SUSPENDED", input([O])).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProblemError);
    expect(err).toMatchObject({ status: 422 });
    expect(m.sellerCalls).toEqual([]);
    expect(m.moved).toEqual([]);
  });

  it("a reinstatement approved for more than one store is 422 (it may only touch the target)", async () => {
    const m = make({ status: "SUSPENDED" });
    await expect(m.mod.apply(staff("u"), S, "ACTIVE", input([S, O]))).rejects.toMatchObject({ status: 422 });
    expect(m.sellerCalls).toEqual([]);
  });

  it("a store that is neither movable nor already at the target is 409 before any write", async () => {
    const m = make({ status: "CLOSED" });
    await expect(m.mod.apply(staff("u"), S, "SUSPENDED", input([S]))).rejects.toMatchObject({ status: 409 });
    expect(m.sellerCalls).toEqual([]);
  });

  it("a sibling store closed meanwhile is skipped; the target's own conflict, or any other failure, is not swallowed", async () => {
    const conflict = new CatalogError("conflict", "closed");
    const skip = make({ failOn: new Map([[O, conflict]]) });
    const res = await skip.mod.apply(staff("u"), S, "SUSPENDED", input([S, O]));
    expect(res.changedStoreIds).toEqual([S]);
    expect(skip.sellerCalls).toEqual(["suspend"]);
    await expect(make({ failOn: new Map([[S, conflict]]) }).mod.apply(staff("u"), S, "SUSPENDED", input([S, O]))).rejects.toBe(conflict);
    const boom = new Error("db down");
    await expect(make({ failOn: new Map([[O, boom]]) }).mod.apply(staff("u"), S, "SUSPENDED", input([S, O]))).rejects.toBe(boom);
  });

  it("an idempotent re-apply on a store already at the target still converges (seller effect repeated, store reported)", async () => {
    const m = make({ status: "SUSPENDED" });
    const res = await m.mod.apply(staff("u"), S, "SUSPENDED", input([S]));
    expect(res).toMatchObject({ to: "SUSPENDED", beforeStatus: "SUSPENDED", changedStoreIds: [S], sellerId: "sel" });
  });

  it("records the audit entry with a hashed note, the action per direction, and an empty actor for a principal without an id", async () => {
    const entries: { action: string; actorId: string; diff: { after: { noteHash: string } } }[] = [];
    const m = make({ audit: { appendIn: (_tx, e) => { entries.push(e as never); return Promise.resolve(undefined); } } });
    const res = await m.mod.apply(staff("u"), S, "SUSPENDED", input([S]));
    await m.mod.record(staff(), {} as never, res);
    await m.mod.record(staff("u"), {} as never, { ...res, to: "ACTIVE" });
    expect(entries.map((e) => [e.action, e.actorId])).toEqual([["store.suspended", ""], ["store.reinstated", "u"]]);
    expect(entries[0]?.diff.after.noteHash).toMatch(/^[0-9a-f]{64}$/);
    expect(entries[0]?.diff.after.noteHash).not.toContain("note");
  });

  it("targets: a reinstatement files against the target only; a suspension against the seller's live stores only", async () => {
    const m = make();
    expect(await m.mod.targets(staff("u"), S, "ACTIVE")).toEqual([S]);
    expect(await m.mod.targets(staff("u"), S, "SUSPENDED")).toEqual([S, O]);
  });
});

describe("PgDashboardReader.storeSalesTop", () => {
  let admin: SqlClient;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ client: admin, close } = await createTestClient());
    await admin.query("SET session_replication_role = replica");
  });
  afterAll(async () => close());
  beforeEach(async () => { await admin.query("DELETE FROM store_sales_daily"); });
  const seed = (store: string, day: string, orders: number, gmv: string, refreshed: string, name = "متجر"): Promise<unknown> =>
    admin.query("INSERT INTO store_sales_daily (market_id, store_id, day, currency, orders_paid, gmv_minor, store_name_ar, store_name_en, refreshed_at) VALUES ('EG',$1,$2::date,'EGP',$3,$4,$5,NULL,$6::timestamptz)", [store, day, orders, gmv, name, refreshed]);

  it("ranks by GMV, folds the rest into 'other', and reports the newest refresh among all rows", async () => {
    const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
    await seed(a, "2030-01-01", 1, "100", "2030-01-01T10:00:00Z", "أ");
    await seed(b, "2030-01-01", 5, "900", "2030-01-01T12:00:00Z", "ب");
    await seed(c, "2030-01-01", 2, "300", "2030-01-01T11:00:00Z", "ج");
    await seed(c, "2030-01-02", 1, "50", "2030-01-01T09:00:00Z", "ج جديد");
    await seed(a, "2029-12-01", 9, "9999", "2030-01-01T23:00:00Z", "outside window");
    const r = await new PgDashboardReader(roleClient(admin, "outlet_worker")).storeSalesTop("EG", "EGP", "2030-01-01", "2030-01-02", 2);
    expect(r.items.map((i) => [i.storeId, i.orders, i.gmvMinor, i.nameEn])).toEqual([[b, 5, 900n, null], [c, 3, 350n, null]]);
    expect(r.items[1]?.nameAr).toBe("ج جديد"); // latest day's name wins
    expect(r.other).toEqual({ stores: 1, orders: 1, gmvMinor: 100n });
    expect(r.asOf).toBe("2030-01-01T12:00:00.000Z");
  });

  it("an empty window is an empty list, zero other, and no as-of (never invented)", async () => {
    const r = await new PgDashboardReader(roleClient(admin, "outlet_worker")).storeSalesTop("EG", "EGP", "2030-01-01", "2030-01-02", 5);
    expect(r).toEqual({ items: [], other: { stores: 0, orders: 0, gmvMinor: 0n }, asOf: null });
  });

  it("another market's rows never appear", async () => {
    await admin.query("INSERT INTO store_sales_daily (market_id, store_id, day, currency, orders_paid, gmv_minor, store_name_ar, refreshed_at) VALUES ('AE',$1,'2030-01-01','EGP',1,10,'x','2030-01-01T10:00:00Z')", [randomUUID()]);
    const r = await new PgDashboardReader(roleClient(admin, "outlet_worker")).storeSalesTop("EG", "EGP", "2030-01-01", "2030-01-02", 5);
    expect(r.items).toEqual([]);
  });
});
