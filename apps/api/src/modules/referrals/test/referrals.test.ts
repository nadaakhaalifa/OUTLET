import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryAppAttest, InMemoryReferralIdentity, InMemoryReferralStore } from "../adapters/in-memory";
import type { OrderClosedMessage, TokenEntropy } from "../domain/ports";
import { DEFAULT_REFERRAL_CONFIG } from "../domain/rules";
import {
  AttributeReferral,
  GetMyReferral,
  HandleOrderClosed,
  QuoteRefereeOffer,
  type ReferralRuntimeOptions,
} from "../application/referrals";

const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const T0 = 1_800_000_000_000;
const DAY = 86_400_000;

class Counter {
  private n = 0;
  uuidV7(): string {
    this.n += 1;
    return `00000000-0000-7000-8000-${String(this.n).padStart(12, "0")}`;
  }
}

class SeqEntropy implements TokenEntropy {
  private n = 0;
  randomBytes(length: number): Uint8Array {
    this.n += 1;
    return Uint8Array.from({ length }, (_, i) => (this.n * 7 + i * 3) & 255);
  }
}

const entropy = new SeqEntropy();
const REFERRER = U(1);
const FRIEND = U(2);

let store: InMemoryReferralStore;
let identity: InMemoryReferralIdentity;
let now: number;
let opts: ReferralRuntimeOptions;
const clock = { nowMs: () => now };
const ids = new Counter();

const attribute = () => new AttributeReferral(store, identity, new InMemoryAppAttest(), clock, ids, opts);
const closed = () => new HandleOrderClosed(store, identity, clock, opts);
const mine = () => new GetMyReferral(store, clock, ids, entropy, opts);

const msg = (over: Partial<OrderClosedMessage> = {}): OrderClosedMessage => ({
  messageId: U(500),
  orderId: U(600),
  userId: FRIEND,
  isFirstOrder: true,
  merchandiseSubtotal: 80_000n,
  refunded: false,
  paymentMethod: "prepaid",
  deliveredAtMs: T0,
  closedAtMs: T0 + 15 * DAY,
  paymentFingerprintHash: "f".repeat(64),
  ...over,
});

beforeEach(() => {
  store = new InMemoryReferralStore();
  identity = new InMemoryReferralIdentity();
  now = T0;
  opts = { config: DEFAULT_REFERRAL_CONFIG, requireAttest: true, deepLinkBase: "https://x.test/r" };
  identity.seed(REFERRER, { deviceHashes: ["d".repeat(64)], deliveredOrderCount: 2, paymentFingerprintHashes: ["e".repeat(64)] });
  identity.seed(FRIEND, { deviceHashes: ["c".repeat(64)] });
});

const refCode = async (): Promise<string> => (await mine().execute(REFERRER)).code;

describe("GetMyReferral", () => {
  it("is stable per user and builds a deep link", async () => {
    const a = await mine().execute(REFERRER);
    const b = await mine().execute(REFERRER);
    expect(a.code).toBe(b.code);
    expect(a.deepLink).toBe(`https://x.test/r/${a.code}`);
    expect(a).toMatchObject({ pending: 0, rewarded: 0, remainingInWindow: 50, offer: null });
    expect(a.milestone).toEqual({ every: 10, progress: 0, plusMonths: 1 });
  });
  it("different users get different codes", async () => {
    expect((await mine().execute(REFERRER)).code).not.toBe((await mine().execute(FRIEND)).code);
  });
});

describe("AttributeReferral", () => {
  it("requires attestation when configured", async () => {
    const code = await refCode();
    expect(await attribute().execute(FRIEND, code, null)).toEqual({ kind: "attestation_failed" });
    expect(await store.getByReferee(FRIEND)).toBeNull();
  });
  it("attributes a clean friend and exposes the offer", async () => {
    const code = await refCode();
    expect(await attribute().execute(FRIEND, code.toLowerCase(), "ok:1")).toEqual({ kind: "accepted" });
    expect(await store.getByReferee(FRIEND)).toMatchObject({ status: "attributed", referrerId: REFERRER });
    const view = await mine().execute(FRIEND);
    expect(view.offer).toEqual({ discount: 15_000n, minOrder: 60_000n });
    expect((await mine().execute(REFERRER)).pending).toBe(1);
  });
  it("unknown code is a 404-class result", async () => {
    expect(await attribute().execute(FRIEND, "ZZZZZZZZ", "ok:1")).toEqual({ kind: "unknown_code" });
    expect(await attribute().execute(FRIEND, "bad", "ok:1")).toEqual({ kind: "unknown_code" });
  });
  it("self referral is accepted silently, recorded as rejected, never rewarded, and logged", async () => {
    const code = await refCode();
    expect(await attribute().execute(REFERRER, code, "ok:1")).toEqual({ kind: "accepted" });
    expect(await store.getByReferee(REFERRER)).toMatchObject({ status: "rejected", rejectReason: "self_referral" });
    expect(store.events).toContainEqual(expect.objectContaining({ type: "referral.attribution_rejected", reason: "self_referral" }));
    expect((await mine().execute(REFERRER)).offer).toBeNull();
  });
  it("same device is silent and rejected", async () => {
    identity.seed(FRIEND, { deviceHashes: ["d".repeat(64)] });
    const code = await refCode();
    expect(await attribute().execute(FRIEND, code, "ok:1")).toEqual({ kind: "accepted" });
    expect(await store.getByReferee(FRIEND)).toMatchObject({ status: "rejected", rejectReason: "same_device" });
  });
  it.each([
    ["underage", { ageYears: 17 }],
    ["not_new_user", { phoneIsNew: false }],
    ["not_new_user", { priorOrderCount: 2 }],
  ] as const)("rejects silently: %s", async (reason, over) => {
    identity.seed(FRIEND, { deviceHashes: ["c".repeat(64)], ...over });
    const code = await refCode();
    expect(await attribute().execute(FRIEND, code, "ok:1")).toEqual({ kind: "accepted" });
    expect(await store.getByReferee(FRIEND)).toMatchObject({ status: "rejected", rejectReason: reason });
  });
  it("first attribution wins; a replay is accepted and changes nothing", async () => {
    const code = await refCode();
    await attribute().execute(FRIEND, code, "ok:1");
    const before = await store.getByReferee(FRIEND);
    identity.seed(U(3), { deviceHashes: ["9".repeat(64)] });
    const other = (await mine().execute(U(3))).code;
    expect(await attribute().execute(FRIEND, other, "ok:1")).toEqual({ kind: "accepted" });
    expect(await store.getByReferee(FRIEND)).toEqual(before);
  });
});

describe("QuoteRefereeOffer", () => {
  it("discounts only attributed friends with no prior order and subtotal >= 600 EGP", async () => {
    const q = new QuoteRefereeOffer(store, identity, opts);
    expect(await q.execute(FRIEND, 80_000n)).toBe(0n);
    await attribute().execute(FRIEND, await refCode(), "ok:1");
    expect(await q.execute(FRIEND, 80_000n)).toBe(15_000n);
    expect(await q.execute(FRIEND, 59_999n)).toBe(0n);
    identity.seed(FRIEND, { deviceHashes: ["c".repeat(64)], priorOrderCount: 1 });
    expect(await q.execute(FRIEND, 80_000n)).toBe(0n);
  });
});

describe("HandleOrderClosed", () => {
  beforeEach(async () => {
    await attribute().execute(FRIEND, await refCode(), "ok:1");
  });

  it("rewards the referrer with an intent only after close, once (idempotent)", async () => {
    expect(await closed().execute(msg())).toMatchObject({ kind: "rewarded", plusMonths: 0 });
    expect(await closed().execute(msg())).toEqual({ kind: "duplicate" });
    const rewards = store.events.filter((e) => e.type === "referral.reward_earned");
    expect(rewards).toHaveLength(1);
    expect(rewards[0]).toMatchObject({ beneficiaryUserId: REFERRER, amount: 10_000n, kind: "referral_credit" });
    expect(await store.getByReferee(FRIEND)).toMatchObject({ status: "rewarded", rewardAmount: 10_000n });
  });

  it("a different message id for the same settled referral does not reward twice", async () => {
    await closed().execute(msg());
    expect(await closed().execute(msg({ messageId: U(501) }))).toEqual({ kind: "ignored" });
    expect(store.events.filter((e) => e.type === "referral.reward_earned")).toHaveLength(1);
  });

  it("refunded order rejects", async () => {
    expect(await closed().execute(msg({ refunded: true }))).toMatchObject({ kind: "rejected" });
    expect(await store.getByReferee(FRIEND)).toMatchObject({ status: "rejected", rejectReason: "order_refunded" });
    expect(store.events.some((e) => e.type === "referral.reward_earned")).toBe(false);
  });

  it("COD needs delivery and close", async () => {
    expect(await closed().execute(msg({ paymentMethod: "cod", deliveredAtMs: null }))).toMatchObject({ kind: "rejected" });
    expect(await store.getByReferee(FRIEND)).toMatchObject({ rejectReason: "cod_not_delivered" });
  });

  it("order below 600 EGP rejects", async () => {
    await closed().execute(msg({ merchandiseSubtotal: 59_999n }));
    expect(await store.getByReferee(FRIEND)).toMatchObject({ rejectReason: "order_below_minimum" });
  });

  it("payment fingerprint shared with the referrer rejects", async () => {
    await closed().execute(msg({ paymentFingerprintHash: "e".repeat(64) }));
    expect(await store.getByReferee(FRIEND)).toMatchObject({ rejectReason: "payment_fingerprint_reuse" });
  });

  it("referrer without a delivered order rejects", async () => {
    identity.seed(REFERRER, { deviceHashes: ["d".repeat(64)], deliveredOrderCount: 0 });
    await closed().execute(msg());
    expect(await store.getByReferee(FRIEND)).toMatchObject({ rejectReason: "referrer_no_delivered_order" });
  });

  it("unrelated orders are recorded in the inbox and ignored", async () => {
    expect(await closed().execute(msg({ userId: U(77) }))).toEqual({ kind: "ignored" });
    expect(await closed().execute(msg({ userId: U(77) }))).toEqual({ kind: "duplicate" });
    expect(await closed().execute(msg({ messageId: U(502), isFirstOrder: false }))).toEqual({ kind: "ignored" });
    expect(await store.getByReferee(FRIEND)).toMatchObject({ status: "attributed" });
  });

  it("cluster of friends sharing one device withholds the reward", async () => {
    const shared = "7".repeat(64);
    const friends = [U(10), U(11), U(12), U(13)];
    const code = await refCode();
    for (const f of friends) {
      identity.seed(f, { deviceHashes: [shared] });
      await attribute().execute(f, code, "ok:1");
    }
    await closed().execute(msg({ userId: U(13), messageId: U(510), paymentFingerprintHash: "1".repeat(64) }));
    expect(await store.getByReferee(U(13))).toMatchObject({ status: "rejected", rejectReason: "cluster_suspected" });
    // an unlinked friend is still rewarded
    await closed().execute(msg());
    expect(await store.getByReferee(FRIEND)).toMatchObject({ status: "rewarded" });
  });

  it("caps rewards at 50 per window and grants a Plus month on the 10th reward", async () => {
    const code = await refCode();
    const results: string[] = [];
    for (let i = 0; i < 52; i += 1) {
      const f = U(1000 + i);
      identity.seed(f, { deviceHashes: [`${(i + 16).toString(16).padStart(2, "0")}`.repeat(32)] });
      await attribute().execute(f, code, "ok:1");
      const r = await closed().execute(msg({ userId: f, messageId: U(2000 + i), paymentFingerprintHash: `${(i + 16).toString(16).padStart(2, "0")}`.repeat(32) }));
      results.push(r.kind);
    }
    // the friend from beforeEach is an extra attributed row but not closed
    expect(results.filter((k) => k === "rewarded")).toHaveLength(50);
    expect(results.filter((k) => k === "rejected")).toHaveLength(2);
    const plus = store.events.filter((e) => e.type === "referral.plus_month_earned");
    expect(plus).toHaveLength(5);
    expect(plus[0]).toMatchObject({ months: 1, beneficiaryUserId: REFERRER });
    const view = await mine().execute(REFERRER);
    expect(view).toMatchObject({ rewarded: 50, remainingInWindow: 0 });
  });

  it("the window slides: old rewards stop counting after a year", async () => {
    const code = await refCode();
    // 50 rewards a year ago
    now = T0 - 400 * DAY;
    for (let i = 0; i < 50; i += 1) {
      const f = U(3000 + i);
      identity.seed(f, { deviceHashes: [`${(i + 16).toString(16).padStart(2, "0")}`.repeat(32)] });
      await attribute().execute(f, code, "ok:1");
      await closed().execute(msg({ userId: f, messageId: U(4000 + i), paymentFingerprintHash: `${(i + 16).toString(16).padStart(2, "0")}`.repeat(32) }));
    }
    now = T0;
    expect(await closed().execute(msg())).toMatchObject({ kind: "rewarded" });
  });
});
