import { describe, expect, it } from "vitest";
import { money, promotions } from "../domain/bridge";
import {
  CreatePromotion,
  EvaluatePromotions,
  GetPromotion,
  ListPromotions,
  RecordRedemptions,
  ReinstateRedemptions,
  UpdatePromotion,
  type PromotionDeps,
} from "../application/promotions";
import { InMemoryPromotionEventPublisher, InMemoryPromotionRepository } from "../adapters/in-memory";
import { PromotionsUnavailableError } from "../domain/ports";
import { STORE_A, STORE_B, U, record } from "./repository-contract";

const NOW = Date.UTC(2026, 9, 10, 9, 0, 0);

function setup() {
  const repo = new InMemoryPromotionRepository();
  const events = new InMemoryPromotionEventPublisher();
  let n = 0;
  const clock = { now: NOW, nowMs() { return this.now; } };
  const deps: PromotionDeps = {
    repo,
    events,
    clock,
    ids: { uuidV7: () => U(60000 + (n += 1)) },
  };
  return { repo, events, clock, deps };
}

const line = (storeId: string, pounds: bigint, qty = 1) => ({ skuId: U(777), storeId, qty, unitPrice: money(pounds * 100n) });

describe("EvaluatePromotions", () => {
  it("loads candidates, applies per-user caps from stored redemptions and stays pure", async () => {
    const { repo, deps } = setup();
    const p = record({ code: "ONCE", perUserCap: 1, startsAtMs: NOW - 1000, endsAtMs: NOW + 1000 });
    await repo.insert(p);
    const uc = new EvaluatePromotions(deps);
    const input = { userId: U(1), lines: [line(STORE_A, 100n)], shippingFees: [], codes: [" once "], paymentMethod: null, isPlus: false, atMs: NOW };
    const first = await uc.execute(input);
    expect(first.totalDiscount).toBe(1000n);
    expect(await uc.execute(input)).toEqual(first);
    await new RecordRedemptions(deps).execute({ userId: U(1), orderGroupId: U(2), applied: first.applied });
    const second = await uc.execute(input);
    expect(second.applied).toEqual([]);
    expect(second.rejected).toEqual([{ code: "ONCE", promotionId: p.id, reason: "per_user_cap_reached" }]);
    // another shopper is unaffected
    expect((await uc.execute({ ...input, userId: U(2) })).totalDiscount).toBe(1000n);
  });

  it("caps entered codes at five and ignores a promotion outside its window", async () => {
    const { repo, deps } = setup();
    await repo.insert(record({ code: "LATE", startsAtMs: NOW + 1, endsAtMs: NOW + 1000 }));
    const uc = new EvaluatePromotions(deps);
    const r = await uc.execute({
      userId: U(1),
      lines: [line(STORE_A, 100n)],
      shippingFees: [],
      codes: ["LATE", "A1A", "A2A", "A3A", "A4A", "A5A", "A6A"],
      paymentMethod: null,
      isPlus: false,
      atMs: NOW,
    });
    expect(r.applied).toEqual([]);
    // LATE was not live so it never reached the engine as a candidate: unknown to the shopper
    expect(r.rejected.map((x) => x.reason)).toEqual(expect.arrayContaining(["unknown_code"]));
    expect(r.rejected.filter((x) => x.code !== null)).toHaveLength(5);
  });

  it("raises PromotionsUnavailableError when the store fails, never a partial result", async () => {
    const { repo, deps } = setup();
    repo.failing = true;
    await expect(
      new EvaluatePromotions(deps).execute({ userId: U(1), lines: [line(STORE_A, 1n)], shippingFees: [], codes: [], paymentMethod: null, isPlus: false, atMs: NOW }),
    ).rejects.toBeInstanceOf(PromotionsUnavailableError);
  });
});

describe("CreatePromotion", () => {
  const base = {
    createdBy: U(9),
    title: { ar: "عرض" },
    kind: "percent" as const,
    scope: "order" as const,
    value: { kind: "percent" as const, percentBps: 1000 },
    code: "new10",
    autoApply: false,
    funding: { platformPct: 100, sellerPct: 0 },
    targeting: { storeIds: [], skuIds: [], paymentMethods: [], plusOnly: false },
    minOrder: null,
    maxDiscount: null,
    perUserCap: null,
    perDayCap: null,
    totalBudget: null,
    startsAtMs: NOW,
    endsAtMs: NOW + 1000,
  };

  it("creates drafts, normalises the code and pins store promotions to their store", async () => {
    const { deps, repo } = setup();
    const uc = new CreatePromotion(deps);
    const r = await uc.execute({ ...base, owner: { kind: "platform" } });
    expect(r).toMatchObject({ kind: "ok", record: { code: "NEW10", status: "draft", version: 1 } });
    const s = await uc.execute({
      ...base,
      code: "store10",
      owner: { kind: "store", storeId: STORE_A },
      funding: { platformPct: 0, sellerPct: 100 },
    });
    expect(s.kind).toBe("ok");
    if (s.kind === "ok") {
      expect(s.record.targeting.storeIds).toEqual([STORE_A]);
      expect((await repo.get(s.record.id))?.owner).toEqual({ kind: "store", storeId: STORE_A });
    }
  });

  it("returns every validation issue and a code clash", async () => {
    const { deps } = setup();
    const uc = new CreatePromotion(deps);
    const bad = await uc.execute({ ...base, owner: { kind: "store", storeId: STORE_A }, funding: { platformPct: 50, sellerPct: 50 }, code: null });
    expect(bad).toEqual({
      kind: "invalid",
      issues: expect.arrayContaining(["seller_promotion_cannot_be_platform_funded", "code_xor_auto_apply"]),
    });
    await uc.execute({ ...base, owner: { kind: "platform" } });
    expect(await uc.execute({ ...base, owner: { kind: "platform" }, code: "NEW10" })).toEqual({ kind: "code_taken" });
  });
});

describe("Get, List and Update", () => {
  it("get hides promotions of another owner", async () => {
    const { deps, repo } = setup();
    const p = record({ owner: { kind: "store", storeId: STORE_A }, funding: { platformPct: 0, sellerPct: 100 } });
    await repo.insert(p);
    const get = new GetPromotion(deps);
    expect((await get.execute(p.id, { kind: "store", storeId: STORE_A }))?.id).toBe(p.id);
    expect(await get.execute(p.id, { kind: "store", storeId: STORE_B })).toBeNull();
    expect(await get.execute(p.id, { kind: "platform" })).toBeNull();
  });

  it("list reports hasMore without leaking the extra row", async () => {
    const { deps, repo } = setup();
    for (let i = 0; i < 3; i += 1) await repo.insert(record());
    const out = await new ListPromotions(deps).execute({ owner: { kind: "platform" }, afterId: null, limit: 2 });
    expect(out.items).toHaveLength(2);
    expect(out.hasMore).toBe(true);
    const all = await new ListPromotions(deps).execute({ owner: { kind: "platform" }, afterId: null, limit: 3 });
    expect(all.hasMore).toBe(false);
  });

  it("update enforces transitions, windows and money, bumps the version and publishes events", async () => {
    const { deps, repo, events } = setup();
    const p = record({ status: "draft" });
    await repo.insert(p);
    const up = new UpdatePromotion(deps);
    const owner = { kind: "platform" as const };
    const act = await up.execute({ id: p.id, owner, expectedVersion: 1, patch: { status: "active" } });
    expect(act).toMatchObject({ kind: "ok", record: { status: "active", version: 2 } });
    expect(events.events.map((e) => e.name)).toEqual(["promotion.activated"]);
    expect(await up.execute({ id: p.id, owner, expectedVersion: 1, patch: { status: "paused" } })).toEqual({ kind: "stale" });
    expect(await up.execute({ id: p.id, owner, expectedVersion: 2, patch: { endsAtMs: p.startsAtMs } })).toEqual({
      kind: "invalid",
      issues: ["window_invalid"],
    });
    expect(
      await up.execute({ id: p.id, owner, expectedVersion: 2, patch: { totalBudget: money(0n), maxDiscount: money(-5n) } }),
    ).toEqual({ kind: "invalid", issues: ["max_discount_invalid", "total_budget_invalid"] });
    await up.execute({ id: p.id, owner, expectedVersion: 2, patch: { status: "ended" } });
    expect(events.events.map((e) => e.name)).toEqual(["promotion.activated", "promotion.ended"]);
    const revived = await up.execute({ id: p.id, owner, expectedVersion: 3, patch: { status: "active" } });
    expect(revived).toEqual({ kind: "invalid", issues: ["status_transition_not_allowed"] });
    const edit = await up.execute({ id: p.id, owner, expectedVersion: 3, patch: { title: { ar: "x" } } });
    expect(edit).toEqual({ kind: "invalid", issues: ["promotion_ended"] });
    expect(await up.execute({ id: U(1), owner, expectedVersion: 1, patch: { status: "paused" } })).toEqual({ kind: "not_found" });
    expect(
      await up.execute({ id: p.id, owner: { kind: "store", storeId: STORE_A }, expectedVersion: 3, patch: { status: "paused" } }),
    ).toEqual({ kind: "not_found" });
  });
});

describe("Redemptions", () => {
  it("records once per order group, rejects over budget, and reinstates", async () => {
    const { deps, repo, events } = setup();
    const p = record({ code: "BUDGET", totalBudget: money(1500n), startsAtMs: NOW - 1, endsAtMs: NOW + 1000 });
    await repo.insert(p);
    const ev = new EvaluatePromotions(deps);
    const rec = new RecordRedemptions(deps);
    const input = { userId: U(1), lines: [line(STORE_A, 100n)], shippingFees: [], codes: ["BUDGET"], paymentMethod: null, isPlus: false, atMs: NOW };
    const r1 = await ev.execute(input);
    expect(await rec.execute({ userId: U(1), orderGroupId: U(11), applied: r1.applied })).toEqual({ kind: "recorded", recorded: 1, existing: 0 });
    expect(await rec.execute({ userId: U(1), orderGroupId: U(11), applied: r1.applied })).toEqual({ kind: "recorded", recorded: 0, existing: 1 });
    expect(events.events.filter((e) => e.name === "voucher.redeemed")).toHaveLength(1);
    // 500 left: evaluation caps the next discount at 500 and commit accepts it
    const r2 = await ev.execute({ ...input, userId: U(2) });
    expect(r2.totalDiscount).toBe(500n);
    expect((await rec.execute({ userId: U(2), orderGroupId: U(12), applied: r2.applied })).kind).toBe("recorded");
    // a stale evaluation can no longer commit
    expect(await rec.execute({ userId: U(3), orderGroupId: U(13), applied: r1.applied })).toMatchObject({
      kind: "rejected",
      reason: "budget_exhausted",
    });
    const re = new ReinstateRedemptions(deps);
    expect(await re.execute(U(12))).toBe(1);
    expect(await re.execute(U(12))).toBe(0);
    expect(events.events.filter((e) => e.name === "voucher.reinstated")).toHaveLength(1);
    expect((await ev.execute({ ...input, userId: U(4) })).totalDiscount).toBe(500n);
  });

  it("surfaces the cairo day key for per-day caps", async () => {
    const { deps, repo, clock } = setup();
    const p = record({ code: "DAYCAP", perDayCap: 1, startsAtMs: NOW - 1, endsAtMs: NOW + 90_000_000 });
    await repo.insert(p);
    const ev = new EvaluatePromotions(deps);
    const rec = new RecordRedemptions(deps);
    const input = { userId: U(1), lines: [line(STORE_A, 100n)], shippingFees: [], codes: ["DAYCAP"], paymentMethod: null, isPlus: false, atMs: NOW };
    const r = await ev.execute(input);
    await rec.execute({ userId: U(1), orderGroupId: U(21), applied: r.applied });
    expect((await ev.execute({ ...input, userId: U(2) })).applied).toEqual([]);
    // the next Cairo day the counter is fresh
    clock.now = NOW + 24 * 3_600_000;
    const next = { ...input, userId: U(2), atMs: NOW + 24 * 3_600_000 };
    expect((await ev.execute(next)).applied).toHaveLength(1);
    expect(promotions.cairoDayKey(NOW)).not.toBe(promotions.cairoDayKey(NOW + 24 * 3_600_000));
  });
});
