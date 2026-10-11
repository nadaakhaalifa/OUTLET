import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DAY, EGP, U, createRuntime, type Runtime } from "./test/harness";

const buy = async (rt: Runtime, amount = EGP(1000), userId = U(1), key = `k-${Math.random()}`) => {
  rt.flags.sales = true;
  const r = await rt.purchase.execute({
    userId,
    idempotencyKey: key,
    amount,
    design: "eid",
    channel: "in_app",
    contact: null,
    message: null,
    scheduledAtMs: null,
    scopeStoreId: null,
    paymentMethod: "card",
    isNewCard: false,
  });
  if (r.kind !== "ok" || r.paymentIntentId === null) throw new Error(`purchase failed: ${r.kind}`);
  return { cardId: r.card.id, intent: r.paymentIntentId };
};

const issueOne = async (rt: Runtime, amount = EGP(1000), userId = U(1)) => {
  const { cardId, intent } = await buy(rt, amount, userId);
  const r = await rt.issue.execute({ cardId, paymentIntentId: intent });
  if (r.kind !== "issued") throw new Error(`issue failed: ${r.kind}`);
  return { cardId, code: r.code };
};

const redeemInput = (userId: string, rawCode: string, amount: bigint | null = null, device = "dev-1") => ({
  userId,
  rawCode,
  amount,
  deviceHash: device.padEnd(64, "0"),
  ipHash: "ip".padEnd(64, "0"),
});

describe("kill switches", () => {
  it("default OFF: purchases and redemptions are refused", async () => {
    const rt = createRuntime();
    const r = await rt.purchase.execute({
      userId: U(1), idempotencyKey: "k", amount: EGP(500), design: "eid", channel: "in_app", contact: null, message: null,
      scheduledAtMs: null, scopeStoreId: null, paymentMethod: "card", isNewCard: false,
    });
    expect(r.kind).toBe("disabled");
    expect((await rt.redeem.execute(redeemInput(U(2), "AAAA-BBBB-CCCC-DDDD"))).kind).toBe("disabled");
    expect(rt.store.attempts).toHaveLength(0);
  });
});

describe("purchase and issuing", () => {
  it("stores only HMAC hash + last4, never the code, and hands the code to delivery once", async () => {
    const rt = createRuntime();
    const { cardId, code } = await issueOne(rt);
    const c = await rt.store.getCard(cardId);
    expect(c?.status).toBe("DELIVERED");
    expect(c?.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(c?.codeKeyVersion).toBe(1);
    const canonical = code.replace(/-/g, "");
    expect(canonical.length).toBeGreaterThanOrEqual(16);
    expect(JSON.stringify(c, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v))).not.toContain(canonical);
    expect(c?.last4).toBe(canonical.slice(-4));
    expect(JSON.stringify(rt.store.outbox)).not.toContain(canonical);
    expect(rt.delivery.sent).toHaveLength(1);
  });

  it("is idempotent on the key and on the payment webhook", async () => {
    const rt = createRuntime();
    rt.flags.sales = true;
    const a = await buy(rt, EGP(500), U(1), "same");
    const b = await buy(rt, EGP(500), U(1), "same");
    expect(b.cardId).toBe(a.cardId);
    const first = await rt.issue.execute({ cardId: a.cardId, paymentIntentId: a.intent });
    const second = await rt.issue.execute({ cardId: a.cardId, paymentIntentId: a.intent });
    expect(first.kind).toBe("issued");
    expect(second.kind).toBe("replayed");
    expect(rt.delivery.sent).toHaveLength(1);
  });

  it("rejects an intent that does not belong to the card", async () => {
    const rt = createRuntime();
    const { cardId } = await buy(rt);
    expect((await rt.issue.execute({ cardId, paymentIntentId: "pi_other" })).kind).toBe("intent_mismatch");
  });

  it("enforces 100-10,000 EGP and 21+ above 5,000 EGP", async () => {
    const rt = createRuntime();
    rt.flags.sales = true;
    const base = { userId: U(1), design: "eid", channel: "in_app", contact: null, message: null, scheduledAtMs: null, scopeStoreId: null, paymentMethod: "card", isNewCard: false } as const;
    expect((await rt.purchase.execute({ ...base, idempotencyKey: "a", amount: EGP(99) })).kind).toBe("invalid_amount");
    expect((await rt.purchase.execute({ ...base, idempotencyKey: "b", amount: EGP(10_001) })).kind).toBe("invalid_amount");
    expect((await rt.purchase.execute({ ...base, idempotencyKey: "c", amount: EGP(5_001) })).kind).toBe("age_required");
    expect((await rt.purchase.execute({ ...base, idempotencyKey: "d", amount: EGP(5_000) })).kind).toBe("ok");
    rt.age.over21.add(U(1));
    expect((await rt.purchase.execute({ ...base, idempotencyKey: "e", amount: EGP(10_000) })).kind).toBe("ok");
  });

  it("refuses store credit and gift cards as the payment method (no laundering loop)", async () => {
    const rt = createRuntime();
    rt.flags.sales = true;
    for (const m of ["store_credit", "gift_card", "cod"]) {
      const r = await rt.purchase.execute({
        userId: U(1), idempotencyKey: `m-${m}`, amount: EGP(500), design: "eid", channel: "in_app", contact: null, message: null,
        scheduledAtMs: null, scopeStoreId: null, paymentMethod: m, isNewCard: false,
      });
      expect(r.kind).toBe("method_refused");
    }
  });

  it("refuses cash wording in the message", async () => {
    const rt = createRuntime();
    rt.flags.sales = true;
    const r = await rt.purchase.execute({
      userId: U(1), idempotencyKey: "w", amount: EGP(500), design: "eid", channel: "in_app", contact: null,
      message: "withdraw this cash anytime", scheduledAtMs: null, scopeStoreId: null, paymentMethod: "card", isNewCard: false,
    });
    expect(r.kind).toBe("invalid_message");
  });

  it("cancels an unpaid card and voids the intent", async () => {
    const rt = createRuntime();
    const { cardId, intent } = await buy(rt);
    expect(await rt.cancel.execute(cardId)).toBe("cancelled");
    expect(rt.payments.cancelled).toContain(intent);
    expect((await rt.store.getCard(cardId))?.status).toBe("CANCELLED");
  });
});

describe("redemption", () => {
  it("converts to store credit, partial then full, and conserves value", async () => {
    const rt = createRuntime();
    rt.flags.redemption = true;
    const { cardId, code } = await issueOne(rt, EGP(1000));
    const r1 = await rt.redeem.execute(redeemInput(U(2), code, EGP(300)));
    expect(r1.kind).toBe("ok");
    const r2 = await rt.redeem.execute(redeemInput(U(2), code.toLowerCase(), null));
    expect(r2.kind).toBe("ok");
    expect(rt.storeCredit.total(cardId)).toBe(EGP(1000));
    const c = await rt.store.getCard(cardId);
    expect(c?.status).toBe("REDEEMED");
    expect((await rt.redeem.execute(redeemInput(U(2), code))).kind).toBe("already_redeemed");
  });

  it("exceeding the balance is refused and leaves the card untouched", async () => {
    const rt = createRuntime();
    rt.flags.redemption = true;
    const { cardId, code } = await issueOne(rt, EGP(200));
    const r = await rt.redeem.execute(redeemInput(U(2), code, EGP(300)));
    expect(r).toMatchObject({ kind: "exceeds_balance", remaining: EGP(200) });
    expect((await rt.store.getCard(cardId))?.remaining).toBe(EGP(200));
  });

  it("a definite typed rejection restores the balance exactly once", async () => {
    const rt = createRuntime();
    rt.flags.redemption = true;
    const { cardId, code } = await issueOne(rt, EGP(200));
    rt.storeCredit.rejecting = true;
    expect((await rt.redeem.execute(redeemInput(U(2), code))).kind).toBe("credit_unavailable");
    expect((await rt.store.getCard(cardId))?.remaining).toBe(EGP(200));
    expect((await rt.store.listRedemptions(cardId)).map((r) => r.status)).toEqual(["reversed"]);
    expect(await rt.resume.execute({ minAgeMs: 0 })).toMatchObject({ reversed: 0, completed: 0 });
    expect((await rt.store.getCard(cardId))?.remaining).toBe(EGP(200));
    rt.storeCredit.rejecting = false;
    expect((await rt.redeem.execute(redeemInput(U(2), code))).kind).toBe("ok");
    expect(rt.storeCredit.total(cardId)).toBe(EGP(200));
  });

  it("an unknown failure before commit keeps the redemption pending and resume converges to one credit", async () => {
    const rt = createRuntime();
    rt.flags.redemption = true;
    const { cardId, code } = await issueOne(rt, EGP(200));
    rt.storeCredit.failing = true;
    expect((await rt.redeem.execute(redeemInput(U(2), code))).kind).toBe("processing");
    expect((await rt.store.getCard(cardId))?.remaining).toBe(0n);
    expect(rt.storeCredit.total(cardId)).toBe(0n);
    expect(await rt.resume.execute({ minAgeMs: 0 })).toMatchObject({ stillPending: 1 });
    rt.storeCredit.failing = false;
    expect(await rt.resume.execute({ minAgeMs: 0 })).toMatchObject({ completed: 1, stillPending: 0 });
    expect(rt.storeCredit.total(cardId)).toBe(EGP(200));
    expect(rt.storeCredit.postings).toHaveLength(1);
  });

  it("credit committed then timeout: card stays debited, retries never double credit (B-1)", async () => {
    const rt = createRuntime();
    rt.flags.redemption = true;
    const { cardId, code } = await issueOne(rt, EGP(1000));
    rt.storeCredit.failAfterCommit = true;
    const r = await rt.redeem.execute(redeemInput(U(2), code));
    expect(r.kind).toBe("processing");
    expect(rt.storeCredit.total(cardId)).toBe(EGP(1000));
    expect((await rt.store.getCard(cardId))?.remaining).toBe(0n);
    // repeated attempts cannot mint more value
    expect((await rt.redeem.execute(redeemInput(U(2), code))).kind).toBe("already_redeemed");
    await rt.resume.execute({ minAgeMs: 0 });
    expect(rt.storeCredit.total(cardId)).toBe(EGP(1000));
    rt.storeCredit.failAfterCommit = false;
    expect(await rt.resume.execute({ minAgeMs: 0 })).toMatchObject({ completed: 1 });
    expect(rt.storeCredit.total(cardId)).toBe(EGP(1000));
    expect((await rt.store.listRedemptions(cardId)).map((x) => x.status)).toEqual(["completed"]);
  });

  it("concurrent double redeem of the same code yields exactly one credit", async () => {
    const rt = createRuntime();
    rt.flags.redemption = true;
    const { cardId, code } = await issueOne(rt, EGP(500));
    const rs = await Promise.all([1, 2, 3, 4].map(() => rt.redeem.execute(redeemInput(U(2), code))));
    expect(rs.filter((r) => r.kind === "ok")).toHaveLength(1);
    expect(rt.storeCredit.total(cardId)).toBe(EGP(500));
    expect(rt.storeCredit.postings).toHaveLength(1);
  });

  it("property: credits + remaining == face under any timeout/retry interleaving", async () => {
    const op = fc.oneof(
      fc.record({ t: fc.constant("redeem" as const), amt: fc.option(fc.integer({ min: 1, max: 6 }), { nil: null }) }),
      fc.constant({ t: "resume" as const }),
      fc.record({ t: fc.constant("mode" as const), m: fc.constantFrom("ok", "fail", "after", "reject") }),
    );
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 25 }), async (ops) => {
        const rt = createRuntime();
        rt.flags.redemption = true;
        const face = EGP(1000);
        const { cardId, code } = await issueOne(rt, face);
        for (const o of ops) {
          if (o.t === "mode") {
            rt.storeCredit.failing = o.m === "fail";
            rt.storeCredit.failAfterCommit = o.m === "after";
            rt.storeCredit.rejecting = o.m === "reject";
          } else if (o.t === "resume") {
            await rt.resume.execute({ minAgeMs: 0 });
          } else {
            rt.clock.advance(1);
            await rt.redeem.execute(redeemInput(U(2), code, o.amt === null ? null : EGP(o.amt * 50), `d-${Math.random()}`));
          }
          const c = await rt.store.getCard(cardId);
          const live = (await rt.store.listRedemptions(cardId)).filter((r) => r.status !== "reversed").reduce((s, r) => s + r.amount, 0n);
          expect(live + (c?.remaining ?? 0n)).toBe(face);
          expect(rt.storeCredit.total(cardId)).toBeLessThanOrEqual(live);
        }
        rt.storeCredit.failing = false;
        rt.storeCredit.failAfterCommit = false;
        rt.storeCredit.rejecting = false;
        await rt.resume.execute({ minAgeMs: 0 });
        const c = await rt.store.getCard(cardId);
        const reds = await rt.store.listRedemptions(cardId);
        expect(reds.some((r) => r.status === "pending")).toBe(false);
        expect(rt.storeCredit.total(cardId) + (c?.remaining ?? 0n)).toBe(face);
        expect(rt.storeCredit.postings.length).toBe(reds.filter((r) => r.status === "completed").length);
      }),
      { numRuns: 60 },
    );
  });

  it("throttles after 5 wrong codes per hour per account, still lets the right code work after the window", async () => {
    const rt = createRuntime();
    rt.flags.redemption = true;
    const { code } = await issueOne(rt, EGP(200));
    for (let i = 0; i < 5; i += 1) {
      expect((await rt.redeem.execute(redeemInput(U(2), "ZZZZ-ZZZZ-ZZZZ-ZZZZ", null, `dev-${i}`))).kind).toBe("invalid_code");
    }
    const sixth = await rt.redeem.execute(redeemInput(U(2), code, null, "dev-x"));
    expect(sixth.kind).toBe("throttled");
    expect(rt.audit.entries.filter((e) => e.outcome === "throttled")).toHaveLength(1);
    rt.clock.advance(3_600_000 + 1_000);
    expect((await rt.redeem.execute(redeemInput(U(2), code, null, "dev-x"))).kind).toBe("ok");
  });

  it("throttles one device at 20 wrong codes a day across accounts", async () => {
    const rt = createRuntime();
    rt.flags.redemption = true;
    for (let i = 0; i < 20; i += 1) {
      rt.clock.advance(3 * 60_000);
      await rt.redeem.execute(redeemInput(U(100 + i), "ZZZZ-ZZZZ-ZZZZ-ZZZZ", null, "shared-dev"));
    }
    const r = await rt.redeem.execute(redeemInput(U(500), "ZZZZ-ZZZZ-ZZZZ-ZZZZ", null, "shared-dev"));
    expect(r).toMatchObject({ kind: "throttled", scope: "device" });
  });

  it("audits every attempt without a code or hash", async () => {
    const rt = createRuntime();
    rt.flags.redemption = true;
    const { code } = await issueOne(rt, EGP(200));
    await rt.redeem.execute(redeemInput(U(2), "ZZZZ-ZZZZ-ZZZZ-ZZZZ"));
    await rt.redeem.execute(redeemInput(U(2), code));
    const attempts = rt.audit.entries.filter((e) => e.action === "gift_card.redeem_attempt");
    expect(attempts.map((a) => a.outcome)).toEqual(["wrong", "ok"]);
    expect(JSON.stringify(rt.audit.entries)).not.toContain(code.replace(/-/g, ""));
    expect(rt.store.attempts).toHaveLength(2);
  });

  it("works for cards issued under a rotated-out HMAC key version", async () => {
    const rt = createRuntime();
    rt.flags.redemption = true;
    const { code } = await issueOne(rt, EGP(200));
    rt.secret.rotate();
    expect((await rt.redeem.execute(redeemInput(U(2), code))).kind).toBe("ok");
  });

  it("PROPERTY: redemptions + remaining == face value for any sequence of requests", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.integer({ min: 1, max: 600 }), { minLength: 1, maxLength: 8 }), async (requests) => {
        const rt = createRuntime();
        rt.flags.redemption = true;
        const { cardId, code } = await issueOne(rt, EGP(1000));
        for (const n of requests) await rt.redeem.execute(redeemInput(U(2), code, EGP(n)));
        const c = await rt.store.getCard(cardId);
        const redeemed = [...rt.store.redemptions.values()].filter((r) => r.status !== "reversed").reduce((s, r) => s + r.amount, 0n);
        expect(redeemed + (c?.remaining ?? -1n)).toBe(EGP(1000));
        expect(rt.storeCredit.total(cardId)).toBe(redeemed);
        expect(c?.remaining ?? -1n).toBeGreaterThanOrEqual(0n);
      }),
      { numRuns: 40 },
    );
  });
});

describe("void and expiry", () => {
  it("purchaser voids before redemption and the unredeemed amount goes back to the original method", async () => {
    const rt = createRuntime();
    rt.delivery.failing = true; // issued but not yet DELIVERED
    const { cardId } = await issueOne(rt, EGP(500));
    const r = await rt.voidCard.execute({ userId: U(1), cardId });
    expect(r).toMatchObject({ kind: "ok", refundedAmount: EGP(500), refund: "completed" });
    expect(rt.payments.refunds).toHaveLength(1);
    expect((await rt.voidCard.execute({ userId: U(2), cardId })).kind).toBe("not_found");
  });

  it("expires after the expiry date and forfeits only the remainder", async () => {
    const rt = createRuntime();
    const { cardId } = await issueOne(rt, EGP(500));
    expect(await rt.expire.execute()).toBe(0);
    rt.clock.advance(DAY * 366 * 3 + DAY);
    expect(await rt.expire.execute()).toBe(1);
    expect((await rt.store.getCard(cardId))?.status).toBe("EXPIRED");
    expect(await rt.expire.execute()).toBe(0);
  });
});

describe("group gift pots", () => {
  const open = async (rt: Runtime, target = EGP(1000)) => {
    rt.flags.sales = true;
    const r = await rt.createPot.execute({
      userId: U(1), idempotencyKey: `pot-${Math.random()}`, target, closesAtMs: rt.clock.nowMs() + 10 * DAY,
      nickname: "Sara", design: "wedding", channel: "in_app", contact: null, message: null,
    });
    if (r.kind !== "ok" || r.shareToken === null) throw new Error(`pot failed: ${r.kind}`);
    return { potId: r.pot.id, token: r.shareToken };
  };
  const give = async (rt: Runtime, potId: string, token: string, userId: string, amount: bigint) => {
    const r = await rt.contribute.execute({ userId, potId, shareToken: token, amount, paymentMethod: "card", isNewCard: false, idempotencyKey: `c-${Math.random()}` });
    if (r.kind !== "ok" || r.paymentIntentId === null) throw new Error(`contribute failed: ${r.kind}`);
    return { contributionId: r.contributionId, paymentIntentId: r.paymentIntentId };
  };

  it("funds, issues the card exactly at target and is replay safe", async () => {
    const rt = createRuntime();
    const { potId, token } = await open(rt);
    const a = await give(rt, potId, token, U(2), EGP(600));
    const b = await give(rt, potId, token, U(3), EGP(400));
    expect(await rt.confirm.execute({ contributionId: a.contributionId, paymentIntentId: a.paymentIntentId })).toMatchObject({ kind: "paid", closed: "open" });
    expect(await rt.confirm.execute({ contributionId: b.contributionId, paymentIntentId: b.paymentIntentId })).toMatchObject({ kind: "paid", closed: "funded" });
    expect((await rt.confirm.execute({ contributionId: b.contributionId, paymentIntentId: b.paymentIntentId })).kind).toBe("replayed");
    const pot = await rt.store.getPot(potId);
    expect(pot?.status).toBe("CLOSED_FUNDED");
    const card = await rt.store.getCard(pot?.cardId ?? "");
    expect(["ISSUED", "DELIVERED"]).toContain(card?.status);
    expect(card?.amount).toBe(EGP(1000));
  });

  it("refuses a contribution that overshoots the target", async () => {
    const rt = createRuntime();
    const { potId, token } = await open(rt);
    const r = await rt.contribute.execute({ userId: U(2), potId, shareToken: token, amount: EGP(1100), paymentMethod: "card", isNewCard: false, idempotencyKey: "x" });
    expect(r.kind).toBe("invalid_amount");
  });

  it("refuses a wrong share token with not_found", async () => {
    const rt = createRuntime();
    const { potId } = await open(rt);
    const r = await rt.contribute.execute({ userId: U(2), potId, shareToken: "0".repeat(32), amount: EGP(100), paymentMethod: "card", isNewCard: false, idempotencyKey: "y" });
    expect(r.kind).toBe("not_found");
  });

  it("refunds every paid contribution when the pot closes unfunded, and cancels pending intents", async () => {
    const rt = createRuntime();
    const { potId, token } = await open(rt);
    const a = await give(rt, potId, token, U(2), EGP(300));
    const b = await give(rt, potId, token, U(3), EGP(200));
    await give(rt, potId, token, U(4), EGP(100));
    await rt.confirm.execute({ contributionId: a.contributionId, paymentIntentId: a.paymentIntentId });
    await rt.confirm.execute({ contributionId: b.contributionId, paymentIntentId: b.paymentIntentId });
    rt.clock.advance(11 * DAY);
    expect(await rt.close.execute(potId)).toBe("unfunded");
    const r = await rt.refund.execute(potId);
    expect(r).toMatchObject({ refunded: EGP(500), done: true });
    expect(rt.payments.refunds.reduce((s, x) => s + x.amount, 0n)).toBe(EGP(500));
    expect(rt.payments.cancelled).toHaveLength(1);
    expect((await rt.store.getPot(potId))?.status).toBe("REFUNDED");
    const card = await rt.store.getCard((await rt.store.getPot(potId))?.cardId ?? "");
    expect(card?.status).toBe("CANCELLED");
    // replay changes nothing
    await rt.refund.execute(potId);
    expect(rt.payments.refunds).toHaveLength(2);
  });

  it("keeps the pot in REFUNDING and retries when a PSP refund fails", async () => {
    const rt = createRuntime();
    const { potId, token } = await open(rt);
    const a = await give(rt, potId, token, U(2), EGP(300));
    await rt.confirm.execute({ contributionId: a.contributionId, paymentIntentId: a.paymentIntentId });
    rt.clock.advance(11 * DAY);
    await rt.close.execute(potId);
    rt.payments.failRefundFor.add(a.paymentIntentId);
    expect((await rt.refund.execute(potId))?.done).toBe(false);
    expect((await rt.store.getPot(potId))?.status).toBe("REFUNDING");
    rt.payments.failRefundFor.clear();
    expect((await rt.due.execute()).refundedPots).toBe(1);
    expect((await rt.store.getPot(potId))?.status).toBe("REFUNDED");
  });

  it("PROPERTY: refunds of an unfunded pot sum to exactly the paid contributions", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.integer({ min: 1, max: 8 }), { minLength: 1, maxLength: 6 }), async (parts) => {
        const rt = createRuntime();
        const { potId, token } = await open(rt, EGP(5_000));
        let paid = 0n;
        for (const [i, p] of parts.entries()) {
          const amt = EGP(p * 100);
          const r = await give(rt, potId, token, U(10 + i), amt);
          await rt.confirm.execute({ contributionId: r.contributionId, paymentIntentId: r.paymentIntentId });
          paid += amt;
        }
        rt.clock.advance(11 * DAY);
        await rt.close.execute(potId);
        await rt.refund.execute(potId);
        expect(rt.payments.refunds.reduce((s, x) => s + x.amount, 0n)).toBe(paid);
      }),
      { numRuns: 25 },
    );
  });

  it("organiser view does not leak to others and the shared view shows only nickname and totals", async () => {
    const rt = createRuntime();
    const { potId, token } = await open(rt);
    expect(await rt.myPot.execute(U(2), potId)).toBeNull();
    const v = await rt.shared.execute(token);
    expect(Object.keys(v ?? {}).sort()).toEqual(["closesAtMs", "contributions", "id", "organiserNickname", "raised", "status", "target"]);
  });
});

describe("pot void and overshoot safety (B-3)", () => {
  const open = async (rt: Runtime, target = EGP(1000)) => {
    rt.flags.sales = true;
    const r = await rt.createPot.execute({
      userId: U(1), idempotencyKey: `pot-${Math.random()}`, target, closesAtMs: rt.clock.nowMs() + 10 * DAY,
      nickname: "Sara", design: "wedding", channel: "in_app", contact: null, message: null,
    });
    if (r.kind !== "ok" || r.shareToken === null) throw new Error(`pot failed: ${r.kind}`);
    return { potId: r.pot.id, token: r.shareToken };
  };
  const give = async (rt: Runtime, potId: string, token: string, userId: string, amount: bigint) => {
    const r = await rt.contribute.execute({ userId, potId, shareToken: token, amount, paymentMethod: "card", isNewCard: false, idempotencyKey: `c-${Math.random()}` });
    if (r.kind !== "ok" || r.paymentIntentId === null) throw new Error(`contribute failed: ${r.kind}`);
    return { contributionId: r.contributionId, paymentIntentId: r.paymentIntentId };
  };

  it("an unconfirmed cancel keeps the contribution PENDING_VOID and a late success is refunded, never replayed", async () => {
    const rt2 = createRuntime();
    const p2 = await open(rt2, EGP(1000));
    const paid = await give(rt2, p2.potId, p2.token, U(2), EGP(600));
    const slow2 = await give(rt2, p2.potId, p2.token, U(3), EGP(400));
    rt2.payments.cancelResult.set(slow2.paymentIntentId, "unknown");
    await rt2.confirm.execute({ contributionId: paid.contributionId, paymentIntentId: paid.paymentIntentId });
    rt2.clock.advance(11 * DAY);
    expect(await rt2.close.execute(p2.potId)).toBe("unfunded");
    expect((await rt2.store.getContribution(slow2.contributionId))?.status).toBe("pending_void");
    // PSP success arrives after the void attempt
    const late = await rt2.confirm.execute({ contributionId: slow2.contributionId, paymentIntentId: slow2.paymentIntentId });
    expect(late.kind).toBe("refunded_late");
    expect((await rt2.store.getContribution(slow2.contributionId))?.status).toBe("refunded");
    expect(rt2.payments.refunds.map((r) => r.paymentIntentId)).toContain(slow2.paymentIntentId);
  });

  it("a captured cancel result refunds; a throw stays pending_void until the sweep confirms", async () => {
    const rt = createRuntime();
    const { potId, token } = await open(rt, EGP(1000));
    const paid = await give(rt, potId, token, U(2), EGP(600));
    const cap = await give(rt, potId, token, U(3), EGP(200));
    const thr = await give(rt, potId, token, U(4), EGP(200));
    rt.payments.cancelResult.set(cap.paymentIntentId, "captured");
    rt.payments.cancelResult.set(thr.paymentIntentId, "throw");
    await rt.confirm.execute({ contributionId: paid.contributionId, paymentIntentId: paid.paymentIntentId });
    rt.clock.advance(11 * DAY);
    await rt.close.execute(potId);
    expect((await rt.store.getContribution(cap.contributionId))?.status).toBe("refunded");
    expect((await rt.store.getContribution(thr.contributionId))?.status).toBe("pending_void");
    rt.payments.cancelResult.delete(thr.paymentIntentId);
    await rt.due.execute();
    expect((await rt.store.getContribution(thr.contributionId))?.status).toBe("cancelled");
  });

  it("concurrent success webhooks cannot over-fund a pot: the excess is refunded", async () => {
    const rt = createRuntime();
    const { potId, token } = await open(rt, EGP(1000));
    const a = await give(rt, potId, token, U(2), EGP(500));
    const b = await give(rt, potId, token, U(3), EGP(500));
    // force both into a state where each would overshoot on its own if unlocked
    const c = await rt.store.insertContribution({
      id: "00000000-0000-4000-8000-0000000000c1", potId, userId: U(4), amount: EGP(500), paymentIntentId: "pi_extra",
      status: "pending", idempotencyKey: "extra", createdAtMs: rt.clock.nowMs(),
    });
    await Promise.all([
      rt.confirm.execute({ contributionId: a.contributionId, paymentIntentId: a.paymentIntentId }),
      rt.confirm.execute({ contributionId: b.contributionId, paymentIntentId: b.paymentIntentId }),
      rt.confirm.execute({ contributionId: c.contribution.id, paymentIntentId: "pi_extra" }),
    ]);
    const cs = await rt.store.listContributions(potId);
    const paidSum = cs.filter((x) => x.status === "paid").reduce((s, x) => s + x.amount, 0n);
    expect(paidSum).toBe(EGP(1000));
    expect(cs.filter((x) => x.status === "refunded")).toHaveLength(1);
    const card = await rt.store.getCard((await rt.store.getPot(potId))?.cardId ?? "");
    expect(card?.amount).toBe(EGP(1000));
  });
});

describe("atomic throttle (B-2)", () => {
  it("parallel wrong attempts cannot all pass the 5/h account limit", async () => {
    const rt = createRuntime();
    rt.flags.redemption = true;
    const rs = await Promise.all(
      Array.from({ length: 12 }, (_, i) => rt.redeem.execute(redeemInput(U(2), "ZZZZ-ZZZZ-ZZZZ-ZZZZ", null, `dev-${i}`))),
    );
    expect(rs.filter((r) => r.kind === "invalid_code").length).toBeLessThanOrEqual(5);
    expect(rs.filter((r) => r.kind === "throttled").length).toBeGreaterThanOrEqual(7);
  });

  it("throttles by ip hash even when account and device rotate", async () => {
    const rt = createRuntime();
    rt.flags.redemption = true;
    let throttled: unknown = null;
    for (let i = 0; i < 51; i += 1) {
      rt.clock.advance(60_000);
      const r = await rt.redeem.execute({ ...redeemInput(U(100 + i), "ZZZZ-ZZZZ-ZZZZ-ZZZZ", null, `dev-${i}`), ipHash: "ip-shared" });
      if (r.kind === "throttled") throttled = r;
    }
    expect(throttled).toMatchObject({ scope: "ip" });
  });
});
