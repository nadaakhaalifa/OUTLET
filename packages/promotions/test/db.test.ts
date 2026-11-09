import { randomUUID } from "node:crypto";
import { brandClient, withDbContext } from "@outlet/db";
import type { ContextFor, Queryable, RoleSqlClient, SqlClient } from "@outlet/db";
import { createTestClient, roleClient } from "@outlet/db/testing";
import type { Principal } from "@outlet/policy";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PromotionError, PromotionEvaluator, PromotionService, VoucherService, autoBest, evaluate } from "../src/index.js";
import type { AppliedPromotion, PromotionInput } from "../src/index.js";
import { FakeAbuse, FakeAudit, FakeCodeBudget, FakeKill, FakeOrderFacts } from "../src/testing.js";
import fc from "fast-check";
import { A, B, bag, ctx } from "./fixtures.js";

const NOW = new Date("2030-06-01T12:00:00.000Z");
const KEY = new Uint8Array(32).fill(9);
let raw: SqlClient;
let close: () => Promise<void>;
let app: RoleSqlClient<"outlet_app">;
let storeA: string;
let storeB: string;
let u1: string;
let u2: string;
const kill = new FakeKill();
const abuse = new FakeAbuse();
const facts = new FakeOrderFacts();
const audit = new FakeAudit();
let clock = NOW.getTime();
const mk = (o: { velocity?: number; noAudit?: boolean; noKey?: boolean; noFacts?: boolean; budget?: FakeCodeBudget; client?: RoleSqlClient<"outlet_app"> } = {}) => {
  const deps = { client: o.client ?? app, ...(o.budget === undefined ? {} : { codeBudget: o.budget }), marketId: "EG", kill, abuse, ...(o.noFacts === true ? {} : { orderFacts: facts }), ...(o.noAudit === true ? {} : { audit }), ...(o.noKey === true ? {} : { hmacKey: KEY }), now: () => new Date(clock), ...(o.velocity === undefined ? {} : { velocityPerHour: o.velocity }) };
  return { promos: new PromotionService(deps), vouchers: new VoucherService(deps), evaluator: new PromotionEvaluator(deps) };
};
const svc = (): ReturnType<typeof mk> => mk({ velocity: 1000 });

const realBag = (stores: readonly string[] = [storeA, storeB]): ReturnType<typeof bag> => {
  const b = bag();
  const map = new Map([[A, storeA], [B, storeB]]);
  return { ...b, stores: b.stores.filter((s) => stores.includes(map.get(s.storeId) ?? "")).map((s) => ({ ...s, storeId: map.get(s.storeId) ?? s.storeId, lines: s.lines.map((l) => ({ ...l, storeId: map.get(l.storeId) ?? l.storeId })) })) };
};
const seller = (storeId: string, roles = ["manager"]): Principal => ({ kind: "seller_staff", userId: randomUUID(), marketId: "EG", storeIds: [storeId], roles, scopes: [] });
const admin = (roles = ["marketing"]): Principal => ({ kind: "admin", userId: randomUUID(), marketId: "EG", roles, scopes: [] });
const code = async (p: Promise<unknown>): Promise<string> => { try { await p; return "ok"; } catch (e) { return e instanceof PromotionError ? e.code : `other:${String(e)}`; } };

const input = (o: Partial<PromotionInput> = {}): PromotionInput => ({
  ownerType: "platform", storeId: null, type: "percent", nameAr: "عرض", rules: { level: "order", discount: { kind: "percent", bps: 1000 } }, stackingClass: "auto", fundingPlatformBp: 10_000, fundingSellerBp: 0,
  currency: "EGP", startsAt: new Date("2030-01-01T00:00:00Z"), endsAt: new Date("2031-01-01T00:00:00Z"), ...o,
});
const storeInput = (storeId: string, o: Partial<PromotionInput> = {}): PromotionInput =>
  input({ ownerType: "store", storeId, stackingClass: "store_voucher", rules: { level: "store", discount: { kind: "percent", bps: 1000 } }, fundingPlatformBp: 0, fundingSellerBp: 10_000, ...o });

const activate = async (s: ReturnType<typeof mk>, who: Principal, id: string, storeId: string | null): Promise<void> => { await s.promos.transition(who, id, storeId, "ACTIVE"); };
const rowsAs = <T extends object>(ctxArg: ContextFor<"outlet_app">, sql: string, params: unknown[] = []): Promise<T[]> =>
  withDbContext(app, ctxArg, async (tx: Queryable) => (await tx.query<T>(sql, params)).rows);

const applied = (promotionId: string, amount: bigint, voucherId: string | null = null, version = 1): AppliedPromotion => ({
  promotionId, version, voucherId, level: "order", stackingClass: "auto",
  total: { amountMinor: amount, currency: "EGP" }, platform: { amountMinor: amount, currency: "EGP" }, seller: { amountMinor: 0n, currency: "EGP" }, lines: [], shipping: [],
});

beforeAll(async () => {
  const t = await createTestClient();
  raw = t.client;
  close = t.close;
  const base = roleClient(raw, "outlet_app");
  app = brandClient<"outlet_app">({ query: (sql, params) => base.query(sql, params), transaction: (fn) => base.transaction((tx: Queryable) => fn(tx)) });
  const mkStore = async (slug: string): Promise<string> => {
    const sellerId = randomUUID();
    const storeId = randomUUID();
    await raw.query(
      `INSERT INTO sellers (id, home_market_id, market_id, legal_type, legal_name_ar, legal_name_en, commercial_register_no, tax_card_no, governorate_code, governorate_name_ar, status)
       VALUES ($1,'EG','EG','company','شركة','Company',$2,$3,'CAI','القاهرة','active')`, [sellerId, `CR-${slug}`, `TX-${slug}`]);
    await raw.query(`INSERT INTO stores (id, seller_id, market_id, slug, display_name_ar, kind, ships_from_country, status) VALUES ($1,$2,'EG',$3,$4,'local','EG','ACTIVE')`, [storeId, sellerId, slug, `متجر ${slug}`]);
    return storeId;
  };
  storeA = await mkStore("promo-a");
  storeB = await mkStore("promo-b");
  const mkUser = async (): Promise<string> => { const u = randomUUID(); await raw.query("INSERT INTO users (id, market_id, created_at, updated_at) VALUES ($1,'EG',$2,$2)", [u, NOW.toISOString()]); return u; };
  u1 = await mkUser();
  u2 = await mkUser();
});
afterAll(async () => { await close(); });

describe("PromotionService: authorization, tenancy, versioning", () => {
  it("seller creates for own store; foreign store is 404; platform and co-funded are admin-only", async () => {
    const s = svc();
    const a = seller(storeA);
    const created = await s.promos.create(a, storeInput(storeA));
    expect(created.version).toBe(1);
    expect(await code(s.promos.create(a, storeInput(storeB)))).toBe("NOT_FOUND");
    expect(await code(s.promos.create(a, input()))).toBe("FORBIDDEN");
    expect(await code(s.promos.create(admin(), storeInput(storeA)))).toBe("FORBIDDEN");
    expect(await code(s.promos.create(seller(storeA, ["finance"]), storeInput(storeA)))).toBe("FORBIDDEN");
    expect(await code(s.promos.create(admin(["support"]), input()))).toBe("FORBIDDEN");
    expect(await code(s.promos.create(admin(), input({ ownerType: "co_funded", storeId: storeA, fundingPlatformBp: 4000, fundingSellerBp: 6000, stackingClass: "store_voucher", rules: { level: "store", discount: { kind: "percent", bps: 500 } } })))).toBe("ok");
    expect(await code(s.promos.create(a, storeInput(storeA, { rules: { level: "store", discount: { kind: "percent", bps: 0 } } })))).toBe("INVALID_RULES");
    expect(await code(s.promos.create(a, storeInput(storeA, { endsAt: new Date("2029-01-01T00:00:00Z") })))).toBe("INVALID_PROMOTION");
    expect(await code(s.promos.create(a, storeInput(storeA, { type: "fixed" })))).toBe("INVALID_PROMOTION");
  });

  it("admin writes are audited and fail closed without an audit port", async () => {
    const before = audit.entries.length;
    const { id } = await svc().promos.create(admin(), input());
    expect(audit.entries.slice(before).map((e) => e.action)).toEqual(["promotion.create"]);
    expect(await code(mk({ noAudit: true }).promos.create(admin(), input()))).toBe("NO_AUDIT");
    const sellerNoAudit = mk({ noAudit: true });
    expect(await code(sellerNoAudit.promos.create(seller(storeA), storeInput(storeA)))).toBe("ok");
    expect(id).toBeTruthy();
  });

  it("store RLS: store B sees nothing of store A; seller B reading A's promotion is 404", async () => {
    const s = svc();
    const { id } = await s.promos.create(seller(storeA), storeInput(storeA));
    const asB = await rowsAs<{ id: string }>({ kind: "store", marketId: "EG", storeId: storeB }, "SELECT id FROM promotions WHERE id = $1", [id]);
    expect(asB).toEqual([]);
    expect(await code(s.promos.get(seller(storeB), id, storeB))).toBe("NOT_FOUND");
    expect(await code(s.promos.get(seller(storeB), id, storeA))).toBe("NOT_FOUND");
    expect((await s.promos.get(seller(storeA), id, storeA)).id).toBe(id);
    const asUser = await rowsAs<{ id: string }>({ kind: "user", marketId: "EG", userId: u1 }, "SELECT id FROM promotions WHERE id = $1", [id]);
    expect(asUser).toHaveLength(1);
    const otherMarket = await rowsAs<{ id: string }>({ kind: "user", marketId: "SA", userId: u1 }, "SELECT id FROM promotions WHERE id = $1", [id]);
    expect(otherMarket).toEqual([]);
    expect(await code(s.promos.get(admin(), randomUUID(), null))).toBe("NOT_FOUND");
  });

  it("a shopper context cannot insert a promotion for a store, and store B cannot write into store A", async () => {
    const attempt = (c: ContextFor<"outlet_app">, store: string) => withDbContext(app, c, (tx) =>
      tx.query(`INSERT INTO promotions (id, market_id, owner_type, store_id, type, name_ar, rules, stacking_class, funding_platform_bp, funding_seller_bp, currency, starts_at, ends_at)
                VALUES ($1,'EG','store',$2,'percent','x','{}'::jsonb,'auto',0,10000,'EGP',now(),now() + interval '1 day')`, [randomUUID(), store]));
    await expect(attempt({ kind: "user", marketId: "EG", userId: u1 }, storeA)).rejects.toThrow(/row-level security/);
    await expect(attempt({ kind: "store", marketId: "EG", storeId: storeB }, storeA)).rejects.toThrow(/row-level security/);
  });

  it("update bumps the version, snapshots it, and refuses stale or running promotions", async () => {
    const s = svc();
    const a = seller(storeA);
    const { id } = await s.promos.create(a, storeInput(storeA));
    expect(await code(s.promos.update(a, id, storeA, 7, {}))).toBe("VERSION_CONFLICT");
    const r = await s.promos.update(a, id, storeA, 1, { nameAr: "جديد", maxDiscountMinor: 5000n, rules: { level: "store", discount: { kind: "percent", bps: 1500 } } });
    expect(r.version).toBe(2);
    expect(await code(s.promos.update(a, id, storeA, 1, {}))).toBe("VERSION_CONFLICT");
    expect(await code(s.promos.update(a, id, storeA, 2, { fundingPlatformBp: 1, fundingSellerBp: 1 }))).toBe("INVALID_PROMOTION");
    expect(await code(s.promos.update(a, id, storeA, 2, { startsAt: new Date("2032-01-01T00:00:00Z") }))).toBe("INVALID_PROMOTION");
    const versions = await rowsAs<{ version: number }>({ kind: "store", marketId: "EG", storeId: storeA }, "SELECT version FROM promotion_versions WHERE promotion_id = $1 ORDER BY version", [id]);
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
    await s.promos.transition(a, id, storeA, "SCHEDULED");
    await s.promos.transition(a, id, storeA, "ACTIVE");
    expect(await code(s.promos.update(a, id, storeA, 2, { nameAr: "x" }))).toBe("NOT_EDITABLE");
    await s.promos.transition(a, id, storeA, "PAUSED");
    expect(await code(s.promos.update(a, id, storeA, 2, { nameAr: "x" }))).toBe("ok");
    expect(await code(s.promos.transition(a, id, storeA, "DRAFT"))).toBe("INVALID_TRANSITION");
    expect((await s.promos.get(a, id, storeA)).status).toBe("PAUSED");
  });

  it("transition race: a concurrent status change is reported", async () => {
    const s = svc();
    const a = seller(storeA);
    const { id } = await s.promos.create(a, storeInput(storeA));
    const loaded = s.promos.transition(a, id, storeA, "SCHEDULED");
    await loaded;
    await raw.query("UPDATE promotions SET status = 'ENDED' WHERE id = $1", [id]);
    expect(await code(s.promos.transition(a, id, storeA, "ACTIVE"))).toBe("INVALID_TRANSITION");
  });
});

describe("VoucherService: issue and resolve", () => {
  it("stores only an HMAC hash and last4 of a unique code; plaintext is returned once", async () => {
    const s = svc();
    const a = seller(storeA);
    const { id } = await s.promos.create(a, storeInput(storeA));
    const v = await s.vouchers.issue(a, { promotionId: id, storeId: storeA, kind: "unique_code", maxUses: 1 });
    expect(v.code).toHaveLength(20);
    const row = (await raw.query<{ code_hash: Uint8Array; last4: string; code_display: string | null }>("SELECT code_hash, last4, code_display FROM vouchers WHERE id = $1", [v.voucherId])).rows[0];
    expect(row?.code_display).toBeNull();
    expect(row?.last4).toBe(v.code.slice(-4));
    expect(Buffer.from(row?.code_hash ?? []).toString("hex")).not.toContain(v.code);
    const dump = JSON.stringify((await raw.query("SELECT * FROM vouchers WHERE id = $1", [v.voucherId])).rows);
    expect(dump).not.toContain(v.code);
  });

  it("public codes, kind restrictions and authorization", async () => {
    const s = svc();
    const a = seller(storeA);
    const { id } = await s.promos.create(a, storeInput(storeA));
    const { id: autoId } = await s.promos.create(a, storeInput(storeA, { stackingClass: "auto", rules: { level: "order", discount: { kind: "percent", bps: 100 } } }));
    expect(await code(s.vouchers.issue(a, { promotionId: id, storeId: storeA, kind: "public_code", codeDisplay: "bad code" }))).toBe("CODE_INVALID");
    expect(await code(s.vouchers.issue(a, { promotionId: id, storeId: storeA, kind: "public_code", codeDisplay: "SHORT7X" }))).toBe("CODE_INVALID"); // 7 chars: below the 8-char floor
    expect(await code(s.vouchers.issue(a, { promotionId: id, storeId: storeA, kind: "public_code", codeDisplay: "eid50sale" }))).toBe("ok");
    expect(await code(s.vouchers.issue(a, { promotionId: autoId, storeId: storeA, kind: "public_code", codeDisplay: "AUTOCODE1" }))).toBe("CODE_INVALID");
    expect(await code(s.vouchers.issue(seller(storeB), { promotionId: id, storeId: storeA, kind: "public_code", codeDisplay: "XYZ00099" }))).toBe("NOT_FOUND");
    expect(await code(s.vouchers.issue(seller(storeB), { promotionId: id, storeId: storeB, kind: "public_code", codeDisplay: "XYZ00098" }))).toBe("NOT_FOUND");
    expect(await code(s.vouchers.issue(a, { promotionId: randomUUID(), storeId: storeA, kind: "public_code", codeDisplay: "XYZ00097" }))).toBe("NOT_FOUND");
    expect(await code(mk({ noKey: true }).vouchers.issue(a, { promotionId: id, storeId: storeA, kind: "unique_code" }))).toBe("CODE_INVALID");
    expect(await code(s.vouchers.issue(a, { promotionId: id, storeId: null, kind: "public_code", codeDisplay: "NOSTORE01" }))).toBe("NOT_FOUND");
    const plat = await s.promos.create(admin(), input({ stackingClass: "platform_code" }));
    expect(await code(s.vouchers.issue(seller(storeA), { promotionId: plat.id, storeId: storeA, kind: "public_code", codeDisplay: "PLATFORM1" }))).toBe("NOT_FOUND");
    expect(await code(s.vouchers.issue(admin(), { promotionId: plat.id, storeId: null, kind: "public_code", codeDisplay: "PLATFORM2" }))).toBe("ok");
    const co = await s.promos.create(admin(), input({ ownerType: "co_funded", storeId: storeA, fundingPlatformBp: 5000, fundingSellerBp: 5000, stackingClass: "store_voucher", rules: { level: "store", discount: { kind: "percent", bps: 500 } } }));
    expect(await code(s.vouchers.issue(a, { promotionId: co.id, storeId: storeA, kind: "public_code", codeDisplay: "COFUND001" }))).toBe("FORBIDDEN");
    expect(await code(s.vouchers.issue(admin(), { promotionId: co.id, storeId: storeA, kind: "public_code", codeDisplay: "COFUND002" }))).toBe("ok");
    const dupe = await code(s.vouchers.issue(admin(), { promotionId: plat.id, storeId: null, kind: "public_code", codeDisplay: "PLATFORM2" }));
    expect(dupe).toMatch(/other/);
  });

  it("a personal voucher is invisible to other shoppers (RLS) and unusable by them", async () => {
    const s = svc();
    const a = seller(storeA);
    const { id } = await s.promos.create(a, storeInput(storeA));
    await activate(s, a, id, storeA);
    const v = await s.vouchers.issue(a, { promotionId: id, storeId: storeA, kind: "unique_code", assignedUserId: u1 });
    const mine = await rowsAs<{ id: string }>({ kind: "user", marketId: "EG", userId: u1 }, "SELECT id FROM vouchers WHERE id = $1", [v.voucherId]);
    const theirs = await rowsAs<{ id: string }>({ kind: "user", marketId: "EG", userId: u2 }, "SELECT id FROM vouchers WHERE id = $1", [v.voucherId]);
    expect(mine).toHaveLength(1);
    expect(theirs).toEqual([]);
    const b1 = realBag([storeA]);
    const ok = await s.evaluator.evaluateForQuote(b1, ctx({ userId: u1 }), { codes: [v.code] });
    expect(ok.invalidCodes).toEqual([]);
    expect(ok.result.applied).toHaveLength(1);
    const no = await s.evaluator.evaluateForQuote(b1, ctx({ userId: u2 }), { codes: [v.code] });
    expect(no.invalidCodes).toEqual([v.code]);
  });
});

describe("evaluateForQuote", () => {
  it("loads active promotions and entered codes, keeps stores apart, labels the result, honours the kill switch", async () => {
    const s = svc();
    const adm = admin();
    const plat = await s.promos.create(adm, input({ rules: { level: "item", discount: { kind: "percent", bps: 500 } } }));
    await activate(s, adm, plat.id, null);
    const sa = seller(storeA);
    const sv = await s.promos.create(sa, storeInput(storeA));
    await activate(s, sa, sv.id, storeA);
    const v = await s.vouchers.issue(sa, { promotionId: sv.id, storeId: storeA, kind: "public_code", codeDisplay: "STOREA10" });
    const other = await s.promos.create(seller(storeB), storeInput(storeB));
    await activate(s, seller(storeB), other.id, storeB);
    await s.vouchers.issue(seller(storeB), { promotionId: other.id, storeId: storeB, kind: "public_code", codeDisplay: "STOREB10" });
    const onlyA = realBag([storeA]);
    const none = await s.evaluator.evaluateForQuote(onlyA, ctx({ userId: u1 }));
    expect(none.selectedIds).toContain(plat.id);
    expect(none.selectedIds).not.toContain(sv.id);
    const withCode = await s.evaluator.evaluateForQuote(onlyA, ctx({ userId: u1 }), { codes: ["storea10", "storea10", "NOPE", "STOREB10"] });
    expect(withCode.selectedIds).toContain(sv.id);
    expect(withCode.invalidCodes).toEqual(["NOPE", "STOREB10"]);
    expect(withCode.labels.some((l) => l.kind === "voucher")).toBe(true);
    expect(withCode.labels.every((l) => !l.textEn.includes('%'))).toBe(true);
    expect(v.voucherId).toBeTruthy();
    kill.enabled = false;
    const off = await s.evaluator.evaluateForQuote(onlyA, ctx({ userId: u1 }), { codes: ["STOREA10"] });
    kill.enabled = true;
    expect(off.disabled).toBe(true);
    expect(off.result.totals.goodsDiscount.amountMinor).toBe(0n);
    expect(off.labels).toEqual([]);
  });

  it("prunes beyond 5 candidates and reflects per-user usage", async () => {
    const s = svc();
    const adm = admin();
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const p = await s.promos.create(adm, input({ type: "fixed", rules: { level: "order", discount: { kind: "fixed", amountMinor: String(100 + i) } }, perUserLimit: 1, nameAr: `p${String(i)}` }));
      await activate(s, adm, p.id, null);
      ids.push(p.id);
    }
    const u = await (async () => { const x = randomUUID(); await raw.query("INSERT INTO users (id, market_id, created_at, updated_at) VALUES ($1,'EG',$2,$2)", [x, NOW.toISOString()]); return x; })();
    const q = await s.evaluator.evaluateForQuote(realBag(), ctx({ userId: u }));
    expect(q.prunedIds.length).toBeGreaterThanOrEqual(2);
    expect(ids.length).toBe(7);
    const big = await s.promos.create(adm, input({ type: "fixed", rules: { level: "order", discount: { kind: "fixed", amountMinor: "900000" } }, perUserLimit: 1, nameAr: "كبير" }));
    await activate(s, adm, big.id, null);
    const before = await s.evaluator.evaluateForQuote(realBag(), ctx({ userId: u }));
    const hit = before.result.applied.find((x) => x.promotionId === big.id);
    expect(hit).toBeDefined();
    if (hit !== undefined) await s.vouchers.reserve(u, randomUUID(), [hit]);
    const again = await s.evaluator.evaluateForQuote(realBag(), ctx({ userId: u }));
    expect(again.selectedIds).not.toContain(big.id);
    expect(again.result.rejected).toEqual([]);
  });
});

describe("VoucherService: reserve, confirm, release, reinstate", () => {
  const fresh = async (o: { perUser?: number; total?: number; budget?: bigint; maxUses?: number } = {}) => {
    const s = svc();
    const a = seller(storeA);
    const { id } = await s.promos.create(a, storeInput(storeA, { ...(o.perUser === undefined ? {} : { perUserLimit: o.perUser }), ...(o.total === undefined ? {} : { totalLimit: o.total }), ...(o.budget === undefined ? {} : { budgetMinor: o.budget }) }));
    await activate(s, a, id, storeA);
    const v = await s.vouchers.issue(a, { promotionId: id, storeId: storeA, kind: "unique_code", ...(o.maxUses === undefined ? {} : { maxUses: o.maxUses }) });
    return { s, id, v };
  };
  const usage = async (id: string): Promise<{ used_minor: number; used_count: number }> => (await raw.query<{ used_minor: number; used_count: number }>("SELECT used_minor, used_count FROM promotion_usage WHERE promotion_id = $1", [id])).rows[0]!;

  it("replaying the same order group counts once (uniqueness under replay, also concurrent)", async () => {
    const { s, id, v } = await fresh();
    const g = randomUUID();
    const r1 = await s.vouchers.reserve(u1, g, [applied(id, 1000n, v.voucherId)]);
    const r2 = await s.vouchers.reserve(u1, g, [applied(id, 1000n, v.voucherId)]);
    expect([r1, r2]).toEqual([{ reserved: 1, replayed: 0 }, { reserved: 0, replayed: 1 }]);
    expect((await usage(id)).used_count).toBe(1);
    const g2 = randomUUID();
    const both = await Promise.all([s.vouchers.reserve(u1, g2, [applied(id, 50n)]), s.vouchers.reserve(u1, g2, [applied(id, 50n)])]);
    expect(both.reduce((a, r) => a + r.reserved, 0)).toBe(1);
    const n = (await raw.query<{ n: string }>("SELECT count(*) AS n FROM voucher_redemptions WHERE order_group_id = $1 AND kind = 'reserved'", [g2])).rows[0]?.n;
    expect(Number(n)).toBe(1);
    await expect(raw.query(`INSERT INTO voucher_redemptions (id, promotion_id, promotion_version, user_id, market_id, order_group_id, kind, amount_minor, platform_funded_minor, seller_funded_minor, currency)
      VALUES ($1,$2,1,$3,'EG',$4,'reserved',1,1,0,'EGP')`, [randomUUID(), id, u1, g])).rejects.toThrow(/duplicate key|unique/);
  });

  it("enforces per-user, total and budget caps and rolls the whole group back", async () => {
    const pu = await fresh({ perUser: 1 });
    await pu.s.vouchers.reserve(u1, randomUUID(), [applied(pu.id, 100n)]);
    expect(await code(pu.s.vouchers.reserve(u1, randomUUID(), [applied(pu.id, 100n)]))).toBe("CAP_EXCEEDED");
    expect(await code(pu.s.vouchers.reserve(u2, randomUUID(), [applied(pu.id, 100n)]))).toBe("ok");
    const tot = await fresh({ total: 1 });
    await tot.s.vouchers.reserve(u1, randomUUID(), [applied(tot.id, 10n)]);
    expect(await code(tot.s.vouchers.reserve(u2, randomUUID(), [applied(tot.id, 10n)]))).toBe("CAP_EXCEEDED");
    const bud = await fresh({ budget: 1000n });
    const grp = randomUUID();
    await bud.s.vouchers.reserve(u1, randomUUID(), [applied(bud.id, 700n)]);
    expect(await code(bud.s.vouchers.reserve(u2, grp, [applied(pu.id, 5n), applied(bud.id, 400n)]))).toBe("CAP_EXCEEDED");
    expect((await raw.query("SELECT 1 FROM voucher_redemptions WHERE order_group_id = $1", [grp])).rows).toEqual([]);
    expect((await usage(bud.id)).used_minor).toBe(700);
    expect(await code(bud.s.vouchers.reserve(u2, randomUUID(), [applied(bud.id, 300n)]))).toBe("ok");
    const wrongVersion = await fresh();
    expect(await code(wrongVersion.s.vouchers.reserve(u1, randomUUID(), [applied(wrongVersion.id, 1n, null, 9)]))).toBe("CAP_EXCEEDED");
    expect(await code(wrongVersion.s.vouchers.reserve(u1, randomUUID(), [applied(randomUUID(), 1n)]))).toBe("CAP_EXCEEDED");
  });

  it("velocity counts only active reservations: released ones do not block the shopper", async () => {
    const x = await fresh();
    const quick = mk({ velocity: 2 });
    const user = randomUUID();
    await raw.query("INSERT INTO users (id, market_id, created_at, updated_at) VALUES ($1,'EG',$2,$2)", [user, NOW.toISOString()]);
    const g1 = randomUUID();
    await quick.vouchers.reserve(user, g1, [applied(x.id, 1n)]);
    await quick.vouchers.reserve(user, randomUUID(), [applied(x.id, 1n)]);
    expect(await code(quick.vouchers.reserve(user, randomUUID(), [applied(x.id, 1n)]))).toBe("ABUSE_BLOCKED");
    await quick.vouchers.release(user, g1);
    expect(await code(quick.vouchers.reserve(user, randomUUID(), [applied(x.id, 1n)]))).toBe("ok");
  });

  it("voucher max uses, void vouchers, velocity, abuse port and kill switch", async () => {
    const one = await fresh({ maxUses: 1 });
    await one.s.vouchers.reserve(u1, randomUUID(), [applied(one.id, 1n, one.v.voucherId)]);
    expect(await code(one.s.vouchers.reserve(u2, randomUUID(), [applied(one.id, 1n, one.v.voucherId)]))).toBe("CAP_EXCEEDED");
    const gone = await fresh();
    await raw.query("UPDATE vouchers SET status = 'void' WHERE id = $1", [gone.v.voucherId]);
    expect(await code(gone.s.vouchers.reserve(u1, randomUUID(), [applied(gone.id, 1n, gone.v.voucherId)]))).toBe("CODE_INVALID");
    expect(await code(gone.s.vouchers.reserve(u1, randomUUID(), [applied(gone.id, 1n, randomUUID())]))).toBe("CODE_INVALID");
    const x = await fresh();
    const quick = mk({ velocity: 2 });
    const user = await (async () => { const y = randomUUID(); await raw.query("INSERT INTO users (id, market_id, created_at, updated_at) VALUES ($1,'EG',$2,$2)", [y, NOW.toISOString()]); return y; })();
    await quick.vouchers.reserve(user, randomUUID(), [applied(x.id, 1n)]);
    await quick.vouchers.reserve(user, randomUUID(), [applied(x.id, 1n)]);
    expect(await code(quick.vouchers.reserve(user, randomUUID(), [applied(x.id, 1n)]))).toBe("ABUSE_BLOCKED");
    clock += 2 * 3_600_000;
    expect(await code(quick.vouchers.reserve(user, randomUUID(), [applied(x.id, 1n)]))).toBe("ok");
    clock = NOW.getTime();
    abuse.verdict = { allow: false, reason: "multi_account" };
    expect(await code(x.s.vouchers.reserve(u2, randomUUID(), [applied(x.id, 1n)], { deviceId: "dev-1" }))).toBe("ABUSE_BLOCKED");
    expect(abuse.calls.at(-1)).toMatchObject({ deviceId: "dev-1", userId: u2 });
    abuse.verdict = { allow: true };
    kill.enabled = false;
    expect(await code(x.s.vouchers.reserve(u2, randomUUID(), [applied(x.id, 1n)]))).toBe("DISABLED");
    kill.enabled = true;
    const noAbuse = new VoucherService({ client: app, marketId: "EG", kill, now: () => new Date(clock) });
    expect(await code(noAbuse.reserve(u2, randomUUID(), [applied(x.id, 1n)]))).toBe("ok");
  });

  it("confirm is idempotent; release returns the caps; confirmed cannot be released", async () => {
    const { s, id } = await fresh({ total: 1 });
    const g = randomUUID();
    await s.vouchers.reserve(u1, g, [applied(id, 300n)]);
    expect(await s.vouchers.release(u1, g)).toBe(1);
    expect(await s.vouchers.release(u1, g)).toBe(0);
    expect(await s.vouchers.confirm(u1, g)).toBe(0);
    expect(await usage(id)).toEqual({ used_minor: 0, used_count: 0 });
    const g2 = randomUUID();
    await s.vouchers.reserve(u2, g2, [applied(id, 300n)]);
    expect(await s.vouchers.confirm(u2, g2)).toBe(1);
    expect(await s.vouchers.confirm(u2, g2)).toBe(0);
    expect(await s.vouchers.release(u2, g2)).toBe(0);
    expect(await usage(id)).toEqual({ used_minor: 300, used_count: 1 });
  });

  it("reinstates only for a whole order cancelled before shipping", async () => {
    const { s, id } = await fresh({ perUser: 1 });
    const g = randomUUID();
    await s.vouchers.reserve(u1, g, [applied(id, 400n)]);
    await s.vouchers.confirm(u1, g);
    facts.cancelledBeforeShipping = false;
    expect(await code(s.vouchers.reinstate(u1, g))).toBe("REINSTATE_NOT_ALLOWED");
    expect(await code(mk({ noFacts: true }).vouchers.reinstate(u1, g))).toBe("REINSTATE_NOT_ALLOWED");
    expect(await code(s.vouchers.reserve(u1, randomUUID(), [applied(id, 400n)]))).toBe("CAP_EXCEEDED");
    facts.cancelledBeforeShipping = true;
    expect(await s.vouchers.reinstate(u1, g)).toBe(1);
    expect(await s.vouchers.reinstate(u1, g)).toBe(0);
    expect(await usage(id)).toEqual({ used_minor: 0, used_count: 0 });
    expect(await code(s.vouchers.reserve(u1, randomUUID(), [applied(id, 400n)]))).toBe("ok");
    facts.cancelledBeforeShipping = false;
  });

  it("finding 2: a whole-cancelled group whose reservation was never confirmed is released by reinstate, once", async () => {
    const { s, id } = await fresh({ perUser: 1 });
    const g3 = randomUUID();
    await s.vouchers.reserve(u2, g3, [applied(id, 400n)]);
    expect(await usage(id)).toEqual({ used_minor: 400, used_count: 1 });
    facts.cancelledBeforeShipping = true;
    expect(await s.vouchers.reinstate(u2, g3)).toBe(1); // cancelled before the settle consumer confirmed: released, caps given back
    expect(await s.vouchers.reinstate(u2, g3)).toBe(0);
    facts.cancelledBeforeShipping = false;
    expect(await usage(id)).toEqual({ used_minor: 0, used_count: 0 });
    const kinds = (await raw.query<{ kind: string }>("SELECT kind FROM voucher_redemptions WHERE order_group_id = $1 ORDER BY kind", [g3])).rows.map((r) => r.kind);
    expect(kinds).toEqual(["released", "reserved"]);
    expect(await s.vouchers.confirm(u2, g3)).toBe(0); // a late settle event finds nothing to confirm
    expect(await code(s.vouchers.reserve(u2, randomUUID(), [applied(id, 400n)]))).toBe("ok"); // per-user limit free again
  });

  it("finding 2: confirm skips a group that is already CANCELLED (settle event consumed after the cancel); reinstate then releases it", async () => {
    const { s, id } = await fresh();
    const g = randomUUID();
    await s.vouchers.reserve(u1, g, [applied(id, 250n)]);
    await raw.query("SET session_replication_role = replica");
    await raw.query(
      `INSERT INTO order_groups (id, user_id, market_id, currency, status, funds_flow, checkout_session_id, idempotency_key, payment_method, items_subtotal_minor, discount_minor, shipping_minor, shipping_vat_minor, vat_minor, total_minor, placed_at, created_at)
       VALUES ($1,$2,'EG','EGP','CANCELLED','collect_payout',$3,$4,'card',1000,250,0,0,0,750,$5,$5)`,
      [g, u1, randomUUID(), randomUUID(), NOW.toISOString()],
    );
    await raw.query("SET session_replication_role = origin");
    expect(await s.vouchers.confirm(u1, g)).toBe(0);
    expect((await raw.query("SELECT 1 FROM voucher_redemptions WHERE order_group_id = $1 AND kind = 'confirmed'", [g])).rows).toEqual([]);
    expect(await usage(id)).toEqual({ used_minor: 250, used_count: 1 });
    facts.cancelledBeforeShipping = true;
    expect(await s.vouchers.reinstate(u1, g)).toBe(1);
    facts.cancelledBeforeShipping = false;
    expect(await usage(id)).toEqual({ used_minor: 0, used_count: 0 });
  });

  it("finding 2: concurrent confirm and reinstate on one group give the caps back exactly once", async () => {
    const { s, id } = await fresh();
    const g = randomUUID();
    await s.vouchers.reserve(u1, g, [applied(id, 120n)]);
    facts.cancelledBeforeShipping = true;
    await Promise.all([s.vouchers.confirm(u1, g), s.vouchers.reinstate(u1, g)]);
    await s.vouchers.reinstate(u1, g); // whichever ran second, a replay settles what is left
    facts.cancelledBeforeShipping = false;
    expect(await usage(id)).toEqual({ used_minor: 0, used_count: 0 });
  });

  it("voucher_redemptions is append-only and shoppers see only their own rows", async () => {
    const { s, id } = await fresh();
    const g = randomUUID();
    await s.vouchers.reserve(u1, g, [applied(id, 10n)]);
    await expect(withDbContext(app, { kind: "user", marketId: "EG", userId: u1 }, (tx) => tx.query("UPDATE voucher_redemptions SET amount_minor = 0 WHERE order_group_id = $1", [g]))).rejects.toThrow(/permission denied|append-only/);
    await expect(withDbContext(app, { kind: "user", marketId: "EG", userId: u1 }, (tx) => tx.query("DELETE FROM voucher_redemptions WHERE order_group_id = $1", [g]))).rejects.toThrow(/permission denied|append-only/);
    await expect(raw.query("UPDATE voucher_redemptions SET amount_minor = 0 WHERE order_group_id = $1", [g])).rejects.toThrow(/append-only/);
    await expect(raw.query("DELETE FROM voucher_redemptions WHERE order_group_id = $1", [g])).rejects.toThrow(/append-only/);
    expect(await rowsAs({ kind: "user", marketId: "EG", userId: u2 }, "SELECT 1 FROM voucher_redemptions WHERE order_group_id = $1", [g])).toEqual([]);
    expect(await rowsAs({ kind: "user", marketId: "EG", userId: u1 }, "SELECT 1 FROM voucher_redemptions WHERE order_group_id = $1", [g])).toHaveLength(1);
    expect(await rowsAs({ kind: "store", marketId: "EG", storeId: storeA, userId: u1 }, "SELECT 1 FROM voucher_redemptions WHERE order_group_id = $1", [g])).toEqual([]);
  });

  it("evaluate output feeds reserve end to end", async () => {
    const { s, id } = await fresh();
    const b = realBag([storeA]);
    const cands = [(await s.promos.get(seller(storeA), id, storeA))];
    const r = autoBest(b, ctx({ userId: u1 }), cands.map((c) => ({ ...c, stackingClass: "auto" as const })));
    expect(evaluate(b, ctx(), []).applied).toEqual([]);
    expect(r.result.applied).toHaveLength(1);
    const applied1 = r.result.applied[0];
    expect(applied1).toBeDefined();
    if (applied1 !== undefined) expect(await code(s.vouchers.reserve(u1, randomUUID(), [applied1]))).toBe("ok");
  });
});

describe("optional fields and row mapping", () => {
  it("create and update with every optional field, principals without a user id", async () => {
    const s = svc();
    const a: Principal = { kind: "seller_staff", marketId: "EG", storeIds: [storeA], roles: ["owner"], scopes: [] };
    const { id } = await s.promos.create(a, storeInput(storeA, { nameEn: "Offer", perUserLimit: 2, totalLimit: 50, minOrderMinor: 1000n, maxDiscountMinor: 9000n, budgetMinor: 100_000n }));
    const c = await s.promos.get(a, id, storeA);
    expect([c.perUserLimit, c.totalLimit, c.minOrderMinor, c.maxDiscountMinor, c.budgetMinor]).toEqual([2, 50, 1000n, 9000n, 100_000n]);
    await s.promos.update(a, id, storeA, 1, {
      type: "percent", nameAr: "ع", nameEn: "E", stackingClass: "store_voucher", fundingPlatformBp: 0, fundingSellerBp: 10_000, perUserLimit: 3, totalLimit: 60, minOrderMinor: 2000n, maxDiscountMinor: 8000n, budgetMinor: 90_000n,
      startsAt: new Date("2030-02-01T00:00:00Z"), endsAt: new Date("2030-12-01T00:00:00Z"),
    });
    const u = await s.promos.get(a, id, storeA);
    expect([u.perUserLimit, u.totalLimit, u.minOrderMinor, u.maxDiscountMinor, u.budgetMinor, u.version]).toEqual([3, 60, 2000n, 8000n, 90_000n, 2]);
    await s.promos.transition(a, id, storeA, "ACTIVE");
    const v = await s.vouchers.issue(a, { promotionId: id, storeId: storeA, kind: "public_code", codeDisplay: "NOUSER001" });
    expect(v.code).toBe("NOUSER001");
    const adm: Principal = { kind: "admin", marketId: "EG", roles: ["marketing"], scopes: [] };
    const plat = await s.promos.create(adm, input());
    expect(plat.id).toBeTruthy();
    expect(await code(s.promos.update(adm, plat.id, null, 1, {}))).toBe("ok");
  });

  it("toCandidate accepts string timestamps and bigint strings", async () => {
    const { toCandidate } = await import("../src/application/rows.js");
    const c = toCandidate({
      id: "x", market_id: "EG", owner_type: "platform", store_id: null, type: "percent", name_ar: "a", name_en: null, rules: { level: "order", discount: { kind: "percent", bps: 100 } }, stacking_class: "auto",
      funding_platform_bp: 10_000, funding_seller_bp: 0, per_user_limit: null, total_limit: null, min_order_minor: "5", max_discount_minor: 6n, budget_minor: null, currency: "EGP",
      starts_at: "2030-01-01T00:00:00Z", ends_at: new Date("2031-01-01T00:00:00Z"), status: "ACTIVE", version: 1,
    });
    expect([c.minOrderMinor, c.maxDiscountMinor, c.startsAt.getUTCFullYear()]).toEqual([5n, 6n, 2030]);
  });
});

describe("hardening: locks, voucher binding, code budget, definer functions, lifecycle", () => {
  const promo = async (s: ReturnType<typeof mk>, o: Partial<PromotionInput> = {}): Promise<{ id: string; a: Principal }> => {
    const a = seller(storeA);
    const { id } = await s.promos.create(a, storeInput(storeA, o));
    await activate(s, a, id, storeA);
    return { id, a };
  };
  const newUser = async (): Promise<string> => { const y = randomUUID(); await raw.query("INSERT INTO users (id, market_id, created_at, updated_at) VALUES ($1,'EG',$2,$2)", [y, NOW.toISOString()]); return y; };
  const userCtx = (u: string): ContextFor<"outlet_app"> => ({ kind: "user", marketId: "EG", userId: u });

  it("B1: reserve takes the per-user and per-(user,promotion) advisory locks, in a fixed order", async () => {
    const seen: string[] = [];
    const spy = brandClient<"outlet_app">({
      query: (sql, params) => app.query(sql, params),
      transaction: (fn) => app.transaction((tx: Queryable) => fn({ query: (sql: string, params?: unknown[]) => { if (sql.includes("pg_advisory_xact_lock")) seen.push(String(params?.[0])); return tx.query(sql, params); } })),
    });
    const s = mk({ velocity: 1000, client: spy });
    const { id } = await promo(s);
    const u = await newUser();
    await s.vouchers.reserve(u, randomUUID(), [applied(id, 5n)]);
    expect(seen).toEqual([`velocity:${u}`, `${u}${id}`]);
  });

  it("B1: concurrent order groups cannot exceed per_user_limit or the velocity rule (property)", async () => {
    const s = mk({ velocity: 1000 });
    await fc.assert(fc.asyncProperty(fc.integer({ min: 2, max: 5 }), fc.integer({ min: 1, max: 3 }), async (n, limit) => {
      const { id } = await promo(s, { perUserLimit: limit });
      const u = await newUser();
      const res = await Promise.all(Array.from({ length: n }, () => code(s.vouchers.reserve(u, randomUUID(), [applied(id, 1n)]))));
      expect(res.filter((r) => r === "ok").length).toBe(Math.min(n, limit));
      expect(res.filter((r) => r !== "ok").every((r) => r === "CAP_EXCEEDED")).toBe(true);
    }), { numRuns: 8 });
    const fast = mk({ velocity: 2 });
    const { id } = await promo(fast);
    const u = await newUser();
    const res = await Promise.all(Array.from({ length: 5 }, () => code(fast.vouchers.reserve(u, randomUUID(), [applied(id, 1n)]))));
    expect(res.filter((r) => r === "ok").length).toBe(2);
  });

  it("B2: reserve rejects a voucher of another promotion and a total above max_discount", async () => {
    const s = svc();
    const p1 = await promo(s, { maxDiscountMinor: 500n });
    const p2 = await promo(s);
    const v2 = await s.vouchers.issue(p2.a, { promotionId: p2.id, storeId: storeA, kind: "unique_code" });
    expect(await code(s.vouchers.reserve(u1, randomUUID(), [applied(p1.id, 10n, v2.voucherId)]))).toBe("CODE_INVALID");
    expect(await code(s.vouchers.reserve(u1, randomUUID(), [applied(p1.id, 501n)]))).toBe("CAP_EXCEEDED");
    expect(await code(s.vouchers.reserve(u1, randomUUID(), [applied(p1.id, 500n)]))).toBe("ok");
    expect((await raw.query("SELECT 1 FROM voucher_redemptions WHERE promotion_id = $1 AND amount_minor > 500", [p1.id])).rows).toEqual([]);
  });

  it("B3: public codes need 8+ chars (service and CHECK); the code budget is consulted by resolveCode", async () => {
    await expect(raw.query("INSERT INTO vouchers (id, market_id, promotion_id, kind, code_display) SELECT $1,'EG',id,'public_code','ABC1234' FROM promotions LIMIT 1", [randomUUID()])).rejects.toThrow(/check/i);
    const budget = new FakeCodeBudget(2);
    const s = mk({ budget, velocity: 1000 });
    const attempt = (dev: string) => withDbContext(app, userCtx(u1), (tx) => s.vouchers.resolveCode(tx, u1, "NOPE0000", { deviceId: dev }));
    expect(await code(attempt("d1"))).toBe("ok");
    expect(await code(attempt("d1"))).toBe("ok");
    expect(await code(attempt("d1"))).toBe("ABUSE_BLOCKED");
    expect(await code(attempt("d2"))).toBe("ok"); // budget is per (user, device)
    const noDev = withDbContext(app, userCtx(u1), (tx) => mk({ budget: new FakeCodeBudget(0) }).vouchers.resolveCode(tx, u1, "NOPE0000"));
    expect(await code(noDev)).toBe("ABUSE_BLOCKED");
  });

  it("B5: outlet_app cannot UPDATE the counters directly; the definer functions enforce the caps", async () => {
    const s = svc();
    const { id, a } = await promo(s, { totalLimit: 1, maxDiscountMinor: 100n });
    const v = await s.vouchers.issue(a, { promotionId: id, storeId: storeA, kind: "unique_code", maxUses: 1 });
    const usage0 = async (): Promise<{ used_count: number }> => (await raw.query<{ used_count: number }>("SELECT used_count FROM promotion_usage WHERE promotion_id = $1", [id])).rows[0]!;
    const ctxU = userCtx(u1);
    await expect(rowsAs(ctxU, "UPDATE promotion_usage SET used_count = 0 WHERE promotion_id = $1", [id])).rejects.toThrow(/permission denied/);
    await expect(rowsAs(ctxU, "UPDATE vouchers SET uses = 0 WHERE id = $1", [v.voucherId])).rejects.toThrow(/permission denied/);
    const bump = async (amount: number, voucher: string | null, ctxArg: ContextFor<"outlet_app"> = ctxU): Promise<string | undefined> =>
      (await rowsAs<{ r: string }>(ctxArg, "SELECT promotion_usage_bump($1, $2, $3) AS r", [id, amount, voucher]))[0]?.r;
    expect(await bump(101, null)).toBe("max_discount");
    expect(await bump(10, randomUUID())).toBe("voucher_cap");
    expect((await usage0()).used_count).toBe(0); // a refused bump (max_discount, voucher) writes nothing
    await expect(rowsAs({ kind: "store", marketId: "EG", storeId: storeA }, "SELECT promotion_usage_bump($1, 1, NULL)", [id])).rejects.toThrow(/requires ctx user/);
    await expect(rowsAs(ctxU, "SELECT promotion_usage_bump($1, -1, NULL)", [id])).rejects.toThrow(/invalid amount/);
    expect(await rowsAs<{ r: string }>(ctxU, "SELECT promotion_usage_bump($1, 1, NULL) AS r", [randomUUID()]).then((r) => r[0]?.r)).toBe("inactive");
    await expect(rowsAs({ kind: "store", marketId: "EG", storeId: storeA }, "SELECT promotion_usage_giveback($1, 1, NULL)", [id])).rejects.toThrow(/requires ctx user/);
    await expect(rowsAs(ctxU, "SELECT promotion_usage_giveback($1, -1, NULL)", [id])).rejects.toThrow(/invalid amount/);
    // a bump that fails after counting is rolled back by the service (no partial counters)
    expect(await code(s.vouchers.reserve(u1, randomUUID(), [applied(id, 10n, v.voucherId)]))).toBe("ok");
    expect(await code(s.vouchers.reserve(u2, randomUUID(), [applied(id, 10n)]))).toBe("CAP_EXCEEDED");
    expect(Number((await raw.query<{ n: number }>("SELECT used_count AS n FROM promotion_usage WHERE promotion_id = $1", [id])).rows[0]?.n)).toBe(1);
  });

  it("B6: ACTIVE respects starts_at/ends_at; EXHAUSTED is set automatically at the cap and a release re-opens it", async () => {
    const s = svc();
    const a = seller(storeA);
    const future = await s.promos.create(a, storeInput(storeA, { startsAt: new Date(NOW.getTime() + 86_400_000), endsAt: new Date(NOW.getTime() + 2 * 86_400_000) }));
    expect(await code(s.promos.transition(a, future.id, storeA, "ACTIVE"))).toBe("INVALID_TRANSITION");
    await s.promos.transition(a, future.id, storeA, "SCHEDULED");
    expect(await code(s.promos.transition(a, future.id, storeA, "ACTIVE"))).toBe("INVALID_TRANSITION");
    const past = await s.promos.create(a, storeInput(storeA, { startsAt: new Date(NOW.getTime() - 2 * 86_400_000), endsAt: new Date(NOW.getTime() - 86_400_000) }));
    expect(await code(s.promos.transition(a, past.id, storeA, "ACTIVE"))).toBe("INVALID_TRANSITION");

    const { id } = await promo(s, { totalLimit: 1 });
    const status = async (): Promise<string | undefined> => (await raw.query<{ status: string }>("SELECT status FROM promotions WHERE id = $1", [id])).rows[0]?.status;
    const g = randomUUID();
    await s.vouchers.reserve(u1, g, [applied(id, 10n)]);
    expect(await status()).toBe("EXHAUSTED");
    expect(await code(s.vouchers.reserve(u2, randomUUID(), [applied(id, 10n)]))).toBe("CAP_EXCEEDED");
    await s.vouchers.release(u1, g);
    expect(await status()).toBe("ACTIVE");
    const bud = await promo(s, { budgetMinor: 100n });
    await s.vouchers.reserve(u1, randomUUID(), [applied(bud.id, 100n)]);
    expect((await raw.query<{ status: string }>("SELECT status FROM promotions WHERE id = $1", [bud.id])).rows[0]?.status).toBe("EXHAUSTED");
  });
});
