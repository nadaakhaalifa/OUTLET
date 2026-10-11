import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LoggedIn } from "../../../test/harness";
import {
  ADMIN_SCOPES,
  EGP,
  SELLER_SCOPES,
  SERVICE_TOKEN,
  adminGrants,
  brandGrants,
  createPromotionsHarness,
  login,
  uid,
  type PromotionsHarness,
} from "./promotions-harness";

let h: PromotionsHarness;
let base: LoggedIn;
let admin: string;
let sellerA: string;
let sellerB: string;
let storeA: string;
let storeB: string;
let multi: string;

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const idem = () => ({ "Idempotency-Key": uid(7) });
const iso = (ms: number) => new Date(ms).toISOString();
const starts = () => iso(h.clock.nowMs() - 86_400_000);
const ends = () => iso(h.clock.nowMs() + 30 * 86_400_000);

const percentBody = (over: Record<string, unknown> = {}) => ({
  type: "percent",
  title: { ar: "خصم ١٠٪", en: "10% off" },
  code: "welcome10",
  funding: { platform_pct: 100, seller_pct: 0 },
  value: { percent_bp: 1000 },
  starts_at: starts(),
  ends_at: ends(),
  ...over,
});

const evalBody = (over: Record<string, unknown> = {}) => ({
  user_id: base.userId,
  lines: [
    { sku_id: uid(2), store_id: storeA, qty: 2, unit_price: EGP(500n) },
    { sku_id: uid(3), store_id: storeB, qty: 1, unit_price: EGP(1000n) },
  ],
  at: iso(h.clock.nowMs()),
  ...over,
});

const evaluate = (body: unknown, token: string = SERVICE_TOKEN) =>
  h.http().post("/v1/promotions/evaluate").set({ Authorization: `Bearer ${token}` }).send(body as object);

const adminCreate = (body: object) =>
  h.http().post("/v1/admin/promotions").set(bearer(admin)).set(idem()).send(body);
const activate = async (path: string, token: string, id: string, version: number, headers: Record<string, string> = {}) =>
  h
    .http()
    .patch(`${path}/${id}`)
    .set(bearer(token))
    .set(headers)
    .set("If-Match", `"${id}-v${version}"`)
    .send({ status: "active" });

beforeAll(async () => {
  h = await createPromotionsHarness();
  storeA = uid(1);
  storeB = uid(1);
  base = await login(h, "+201005599101");
  admin = await h.mint(base, { audience: "admin_api", grants: adminGrants(), scopes: ADMIN_SCOPES, passkey: true });
  sellerA = await h.mint(base, { audience: "seller_api", grants: brandGrants(storeA), scopes: SELLER_SCOPES });
  sellerB = await h.mint(base, { audience: "seller_api", grants: brandGrants(storeB, "manager"), scopes: SELLER_SCOPES });
  multi = await h.mint(base, {
    audience: "seller_api",
    grants: [...brandGrants(storeA), ...brandGrants(storeB)],
    scopes: SELLER_SCOPES,
  });
}, 30_000);
afterAll(async () => {
  await h.close();
});

describe("admin promotions", () => {
  let id = "";
  it("creates a draft with an ETag and the OpenAPI Promotion shape", async () => {
    const r = await adminCreate(percentBody());
    expect(r.status).toBe(201);
    id = r.body.id;
    expect(r.headers.etag).toBe(`"${id}-v1"`);
    expect(r.body).toEqual({
      id,
      type: "percent",
      title: { ar: "خصم ١٠٪", en: "10% off" },
      code: "WELCOME10",
      auto_apply: false,
      funding: { platform_pct: 100, seller_pct: 0 },
      starts_at: starts(),
      ends_at: ends(),
      status: "draft",
      version: 1,
    });
  });

  it("replays an idempotent create instead of creating a second promotion", async () => {
    const key = { "Idempotency-Key": uid(7) };
    const body = percentBody({ code: "ONCEONLY" });
    const a = await h.http().post("/v1/admin/promotions").set(bearer(admin)).set(key).send(body);
    const b = await h.http().post("/v1/admin/promotions").set(bearer(admin)).set(key).send(body);
    expect(a.status).toBe(201);
    expect(b.body.id).toBe(a.body.id);
  });

  it("requires an Idempotency-Key on create", async () => {
    const r = await h.http().post("/v1/admin/promotions").set(bearer(admin)).send(percentBody({ code: "NOKEY1" }));
    expect(r.status).toBe(400);
  });

  it("rejects a duplicate code, unsupported kinds, missing values and invalid terms", async () => {
    const dup = await adminCreate(percentBody({ code: "WELCOME10" }));
    expect(dup.status).toBe(422);
    expect(dup.body.code).toBe("code_taken");
    const bundle = await adminCreate(percentBody({ type: "bundle", code: "BUNDLE1" }));
    expect(bundle.body.code).toBe("promotion_type_not_supported");
    const noValue = await adminCreate(percentBody({ code: "NOVALUE", value: undefined }));
    expect(noValue.body.code).toBe("value_required");
    const funding = await adminCreate(percentBody({ code: "BADFUND", funding: { platform_pct: 70, seller_pct: 70 } }));
    expect(funding.status).toBe(422);
    expect(funding.body.detail).toContain("funding_must_sum_to_100");
    const xor = await adminCreate(percentBody({ code: undefined }));
    expect(xor.body.detail).toContain("code_xor_auto_apply");
    const window = await adminCreate(percentBody({ code: "BADWIN1", ends_at: starts() }));
    expect(window.body.detail).toContain("window_invalid");
  });

  it("rejects unknown fields and server-owned fields (mass assignment)", async () => {
    for (const extra of [{ status: "active" }, { version: 9 }, { created_by: uid(1) }, { id: uid(1) }]) {
      const r = await adminCreate(percentBody({ code: "MASS01", ...extra }));
      expect(r.status).toBe(400);
    }
  });

  it("creates bogo, tiered, fixed and free-shipping promotions", async () => {
    const bogo = await adminCreate({
      type: "bogo",
      title: { ar: "اشتري ١ واحصل على ١" },
      auto_apply: true,
      funding: { platform_pct: 50, seller_pct: 50 },
      bogo: { buy_qty: 1, get_qty: 1 },
      starts_at: starts(),
      ends_at: ends(),
    });
    expect(bogo.status).toBe(201);
    const tiered = await adminCreate({
      type: "tiered",
      title: { ar: "وفّر أكثر" },
      code: "TIERUP",
      funding: { platform_pct: 100, seller_pct: 0 },
      tiers: [{ min_subtotal: EGP(500n), percent_bp: 500 }, { min_subtotal: EGP(1000n), percent_bp: 1000 }],
      starts_at: starts(),
      ends_at: ends(),
    });
    expect(tiered.status).toBe(201);
    const fixed = await adminCreate({
      type: "fixed",
      title: { ar: "خصم ٥٠" },
      code: "FIXED50",
      funding: { platform_pct: 100, seller_pct: 0 },
      value: { fixed: EGP(50n) },
      min_order: EGP(300n),
      max_discount: EGP(50n),
      per_user_cap: 2,
      total_budget: EGP(10_000n),
      starts_at: starts(),
      ends_at: ends(),
    });
    expect(fixed.status).toBe(201);
    expect(fixed.body.min_order).toEqual(EGP(300n));
    expect(fixed.body.per_user_cap).toBe(2);
    const ship = await adminCreate({
      type: "free_shipping",
      title: { ar: "شحن مجاني" },
      code: "SHIPFREE",
      funding: { platform_pct: 100, seller_pct: 0 },
      starts_at: starts(),
      ends_at: ends(),
    });
    expect(ship.status).toBe(201);
  });

  it("reads, lists with a cursor, and honours If-None-Match", async () => {
    const r = await h.http().get(`/v1/admin/promotions/${id}`).set(bearer(admin));
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(id);
    const cached = await h.http().get(`/v1/admin/promotions/${id}`).set(bearer(admin)).set("If-None-Match", r.headers.etag as string);
    expect(cached.status).toBe(304);
    const page1 = await h.http().get("/v1/admin/promotions?limit=2").set(bearer(admin));
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.page.has_more).toBe(true);
    const page2 = await h
      .http()
      .get(`/v1/admin/promotions?limit=50&cursor=${page1.body.page.next_cursor}`)
      .set(bearer(admin));
    expect(page2.body.items.length).toBeGreaterThan(0);
    const seen = new Set([...page1.body.items, ...page2.body.items].map((x: { id: string }) => x.id));
    expect(seen.size).toBe(page1.body.items.length + page2.body.items.length);
    const bad = await h.http().get("/v1/admin/promotions?limit=0").set(bearer(admin));
    expect(bad.status).toBe(400);
  });

  it("patches under If-Match: 428 without, 412 when stale, 422 on a bad transition", async () => {
    const none = await h.http().patch(`/v1/admin/promotions/${id}`).set(bearer(admin)).send({ status: "active" });
    expect(none.status).toBe(428);
    const stale = await activate("/v1/admin/promotions", admin, id, 7);
    expect(stale.status).toBe(412);
    const foreignTag = await h
      .http()
      .patch(`/v1/admin/promotions/${id}`)
      .set(bearer(admin))
      .set("If-Match", `"${uid(1)}-v1"`)
      .send({ status: "active" });
    expect(foreignTag.status).toBe(412);
    const ok = await activate("/v1/admin/promotions", admin, id, 1);
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe("active");
    expect(ok.body.version).toBe(2);
    expect(ok.headers.etag).toBe(`"${id}-v2"`);
    const again = await activate("/v1/admin/promotions", admin, id, 2);
    expect(again.status).toBe(200);
    const badMove = await h
      .http()
      .patch(`/v1/admin/promotions/${id}`)
      .set(bearer(admin))
      .set("If-Match", `"${id}-v3"`)
      .send({ status: "ended" });
    expect(badMove.status).toBe(200);
    const revive = await h
      .http()
      .patch(`/v1/admin/promotions/${id}`)
      .set(bearer(admin))
      .set("If-Match", `"${id}-v4"`)
      .send({ status: "active" });
    expect(revive.status).toBe(422);
    expect(revive.body.detail).toContain("status_transition_not_allowed");
    const empty = await h.http().patch(`/v1/admin/promotions/${id}`).set(bearer(admin)).set("If-Match", `"${id}-v4"`).send({});
    expect(empty.status).toBe(400);
  });

  it("DELETE ends the promotion and is repeatable", async () => {
    const c = await adminCreate(percentBody({ code: "TOEND01" }));
    const r1 = await h.http().delete(`/v1/admin/promotions/${c.body.id}`).set(bearer(admin));
    expect(r1.status).toBe(204);
    const r2 = await h.http().delete(`/v1/admin/promotions/${c.body.id}`).set(bearer(admin));
    expect(r2.status).toBe(204);
    const got = await h.http().get(`/v1/admin/promotions/${c.body.id}`).set(bearer(admin));
    expect(got.body.status).toBe("ended");
    expect(h.promoEvents.events.map((e) => e.name)).toContain("promotion.ended");
  });
});

describe("seller promotions", () => {
  let aPromo = "";
  it("creates a store-scoped promotion with the actor's only store and seller-only funding", async () => {
    const r = await h
      .http()
      .post("/v1/seller/promotions")
      .set(bearer(sellerA))
      .set(idem())
      .send(percentBody({ code: "STOREA10", funding: { platform_pct: 0, seller_pct: 100 } }));
    expect(r.status).toBe(201);
    aPromo = r.body.id;
    const stored = await h.repo.get(aPromo);
    expect(stored?.owner).toEqual({ kind: "store", storeId: storeA });
    expect(stored?.targeting.storeIds).toEqual([storeA]);
    expect(stored?.createdBy).toBe(base.userId);
  });

  it("refuses platform funding and targeting another store", async () => {
    const plat = await h
      .http()
      .post("/v1/seller/promotions")
      .set(bearer(sellerA))
      .set(idem())
      .send(percentBody({ code: "PLATFUND", funding: { platform_pct: 50, seller_pct: 50 } }));
    expect(plat.status).toBe(422);
    expect(plat.body.detail).toContain("seller_promotion_cannot_be_platform_funded");
    const other = await h
      .http()
      .post("/v1/seller/promotions")
      .set(bearer(sellerA))
      .set(idem())
      .send(
        percentBody({
          code: "OTHERSTORE",
          funding: { platform_pct: 0, seller_pct: 100 },
          targeting: { store_ids: [storeB] },
        }),
      );
    expect(other.status).toBe(422);
    expect(other.body.detail).toContain("seller_promotion_store_scope");
  });

  it("lists only the acting store's promotions", async () => {
    const mine = await h.http().get("/v1/seller/promotions").set(bearer(sellerA));
    expect(mine.status).toBe(200);
    expect(mine.body.items.map((x: { id: string }) => x.id)).toEqual([aPromo]);
    const theirs = await h.http().get("/v1/seller/promotions").set(bearer(sellerB));
    expect(theirs.body.items).toEqual([]);
  });

  it("a multi-store actor must pick a store with X-Store-Id", async () => {
    const none = await h.http().get("/v1/seller/promotions").set(bearer(multi));
    expect(none.status).toBe(400);
    const a = await h.http().get("/v1/seller/promotions").set(bearer(multi)).set("X-Store-Id", storeA);
    expect(a.body.items.map((x: { id: string }) => x.id)).toEqual([aPromo]);
    const notMine = await h.http().get("/v1/seller/promotions").set(bearer(multi)).set("X-Store-Id", uid(1));
    expect(notMine.status).toBe(404);
    const garbage = await h.http().get("/v1/seller/promotions").set(bearer(multi)).set("X-Store-Id", "nope");
    expect(garbage.status).toBe(400);
  });

  it("activates, edits caps and ends their own promotion; a manager of another store cannot", async () => {
    const act = await activate("/v1/seller/promotions", sellerA, aPromo, 1);
    expect(act.status).toBe(200);
    const edit = await h
      .http()
      .patch(`/v1/seller/promotions/${aPromo}`)
      .set(bearer(sellerA))
      .set("If-Match", `"${aPromo}-v2"`)
      .send({ max_discount: EGP(100n), title: { ar: "عنوان جديد" } });
    expect(edit.status).toBe(200);
    expect(edit.body.max_discount).toEqual(EGP(100n));
    expect(edit.body.title).toEqual({ ar: "عنوان جديد" });
    const foreign = await activate("/v1/seller/promotions", sellerB, aPromo, 3);
    expect(foreign.status).toBe(404);
    const del = await h.http().delete(`/v1/seller/promotions/${aPromo}`).set(bearer(sellerA));
    expect(del.status).toBe(204);
  });
});

describe("internal evaluate", () => {
  let platformId = "";
  let storeVoucherId = "";

  beforeAll(async () => {
    const p = await adminCreate(percentBody({ code: "PLAT10", value: { percent_bp: 1000 } }));
    platformId = p.body.id;
    await activate("/v1/admin/promotions", admin, platformId, 1);
    const s = await h
      .http()
      .post("/v1/seller/promotions")
      .set(bearer(sellerB))
      .set(idem())
      .send(
        percentBody({
          code: "STOREB20",
          scope: "store",
          value: { percent_bp: 2000 },
          funding: { platform_pct: 0, seller_pct: 100 },
        }),
      );
    storeVoucherId = s.body.id;
    await activate("/v1/seller/promotions", sellerB, storeVoucherId, 1);
    const ship = await adminCreate({
      type: "free_shipping",
      title: { ar: "شحن مجاني" },
      code: "FREESHIP2",
      funding: { platform_pct: 100, seller_pct: 0 },
      min_order: EGP(900n),
      starts_at: starts(),
      ends_at: ends(),
    });
    await activate("/v1/admin/promotions", admin, ship.body.id, 1);
  });

  it("returns the OpenAPI result shape for stacked platform and store vouchers", async () => {
    const r = await evaluate(evalBody({ voucher_codes: ["plat10", "storeb20"] }));
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(["applied", "rejected", "total_discount"]);
    // store voucher: 20% of store B (1000) = 200 first; platform order 10% of (2000 - 200) = 180
    expect(r.body.applied).toEqual([
      { promotion_id: storeVoucherId, scope: "store", amount: EGP(200n) },
      { promotion_id: platformId, scope: "order", amount: EGP(180n) },
    ]);
    expect(r.body.rejected).toEqual([]);
    expect(r.body.total_discount).toEqual(EGP(380n));
  });

  it("is deterministic: the same request twice gives the same body", async () => {
    const a = await evaluate(evalBody({ voucher_codes: ["PLAT10"] }));
    const b = await evaluate(evalBody({ voucher_codes: ["PLAT10"] }));
    expect(b.body).toEqual(a.body);
  });

  it("reports rejected codes by code and reason, never the auto promotions", async () => {
    const r = await evaluate(evalBody({ voucher_codes: ["NOPE", "STOREB20"], lines: [{ sku_id: uid(2), store_id: storeA, qty: 1, unit_price: EGP(100n) }] }));
    expect(r.status).toBe(200);
    expect(r.body.applied).toEqual([]);
    expect(r.body.rejected).toEqual(
      expect.arrayContaining([
        { code: "NOPE", reason: "unknown_code" },
        { code: "STOREB20", reason: "no_eligible_lines" },
      ]),
    );
  });

  it("applies free shipping from the shipping_fees extension, and not for Plus members", async () => {
    const fees = [
      { store_id: storeA, fee: EGP(60n) },
      { store_id: storeB, fee: EGP(60n) },
    ];
    const r = await evaluate(evalBody({ voucher_codes: ["FREESHIP2"], shipping_fees: fees }));
    // only store A (1000) and store B (1000) both reach 900
    expect(r.body.total_discount).toEqual(EGP(120n));
    const plus = await evaluate(evalBody({ voucher_codes: ["FREESHIP2"], shipping_fees: fees, is_plus_member: true }));
    expect(plus.body.applied).toEqual([]);
  });

  it("answers a budget-capped promotion once a redemption has consumed the budget", async () => {
    const c = await adminCreate(
      percentBody({ code: "ONEUSE01", value: { percent_bp: 5000 }, per_user_cap: 1 }),
    );
    await activate("/v1/admin/promotions", admin, c.body.id, 1);
    const first = await evaluate(evalBody({ voucher_codes: ["ONEUSE01"] }));
    expect(first.body.applied).toHaveLength(1);
    const stored = await h.repo.get(c.body.id);
    expect(stored).not.toBeNull();
    await h.repo.recordRedemptions([
      {
        promotionId: c.body.id,
        promotionVersion: 2,
        userId: base.userId,
        orderGroupId: uid(5),
        amount: 1n,
        platformFunded: 1n,
        sellerFunded: 0n,
        dayKey: "2027-01-01",
        atMs: h.clock.nowMs(),
      },
    ]);
    const second = await evaluate(evalBody({ voucher_codes: ["ONEUSE01"] }));
    expect(second.body.rejected).toEqual([{ code: "ONEUSE01", reason: "per_user_cap_reached" }]);
  });

  it("validates the body strictly and answers 503 when the promotion store is down", async () => {
    expect((await evaluate({ ...evalBody(), extra: 1 })).status).toBe(400);
    expect((await evaluate(evalBody({ lines: [] }))).status).toBe(400);
    expect((await evaluate(evalBody({ voucher_codes: ["a", "b", "c", "d", "e", "f"] }))).status).toBe(400);
    expect((await evaluate(evalBody({ at: "yesterday" }))).status).toBe(400);
    h.repo.failing = true;
    try {
      const r = await evaluate(evalBody());
      expect(r.status).toBe(503);
      expect(r.body.code).toBe("promotions_unavailable");
    } finally {
      h.repo.failing = false;
    }
  });
});
