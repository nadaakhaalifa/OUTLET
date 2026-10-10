import { beforeEach, describe, expect, it } from "vitest";
import type { Referral, ReferralEvent, ReferralStore } from "../domain/ports";

export interface ReferralStoreContext {
  readonly store: ReferralStore;
  /** Makes the user exist where the store enforces the FK (Postgres); no-op in memory. */
  ensureUser(userId: string): Promise<void>;
  /** Event types in emission order, with their payload where the adapter exposes it. */
  eventTypes(): Promise<readonly string[]>;
  rewardEventAmounts(): Promise<readonly string[]>;
}

export const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const T0 = 1_800_000_000_000;
const DAY = 86_400_000;
const HASH = (c: string): string => c.repeat(64);

export const referral = (n: number, referrerId: string, refereeId: string, codeId: string, over: Partial<Referral> = {}): Referral => ({
  id: U(900 + n),
  codeId,
  referrerId,
  refereeId,
  status: "attributed",
  rejectReason: null,
  refereeDeviceHashes: [HASH("a")],
  orderId: null,
  paymentFingerprintHash: null,
  rewardAmount: null,
  attributedAtMs: T0 + n * 1000,
  settledAtMs: null,
  ...over,
});

const attributedEvent = (r: Referral): ReferralEvent => ({
  type: "referral.attributed",
  referralId: r.id,
  referrerId: r.referrerId,
  refereeId: r.refereeId,
});

const rewardEvents = (r: Referral, amount: bigint): ReferralEvent[] => [
  {
    type: "referral.reward_earned",
    referralId: r.id,
    beneficiaryUserId: r.referrerId,
    amount,
    currency: "EGP",
    kind: "referral_credit",
    idempotencyKey: `referral:${r.id}:reward`,
  },
];

/** Behaviour every ReferralStore must have. Run against in-memory and Kysely/PGlite. */
export function describeReferralStoreContract(name: string, make: () => Promise<ReferralStoreContext>): void {
  describe(`ReferralStore contract: ${name}`, () => {
    let c: ReferralStoreContext;
    beforeEach(async () => {
      c = await make();
      for (const n of [1, 2, 3, 4]) await c.ensureUser(U(n));
    });

    const code = async (owner: number, text: string, id = 100 + owner) =>
      c.store.ensureCode({ id: U(id), ownerUserId: U(owner), code: text, nowMs: T0 });

    it("creates one code per owner and returns the existing one afterwards", async () => {
      const a = await code(1, "ABCDEFGH");
      expect(a).toMatchObject({ kind: "created", record: { code: "ABCDEFGH", ownerUserId: U(1) } });
      const again = await c.store.ensureCode({ id: U(150), ownerUserId: U(1), code: "ZZZZZZZZ", nowMs: T0 + 5 });
      expect(again).toMatchObject({ kind: "existing", record: { code: "ABCDEFGH", id: U(101) } });
    });

    it("reports a code collision across owners", async () => {
      await code(1, "ABCDEFGH");
      expect(await code(2, "ABCDEFGH")).toEqual({ kind: "code_taken" });
      expect(await code(2, "JKMNPQRS")).toMatchObject({ kind: "created" });
    });

    it("finds codes by value only", async () => {
      await code(1, "ABCDEFGH");
      expect(await c.store.findCode("ABCDEFGH")).toMatchObject({ ownerUserId: U(1) });
      expect(await c.store.findCode("ZZZZZZZZ")).toBeNull();
    });

    it("inserts an attribution once per friend and emits events once", async () => {
      await code(1, "ABCDEFGH");
      const r = referral(1, U(1), U(2), U(101));
      expect(await c.store.insertAttribution(r, [attributedEvent(r)])).toBe("inserted");
      const dup = referral(2, U(3), U(2), U(101));
      expect(await c.store.insertAttribution(dup, [attributedEvent(dup)])).toBe("exists");
      expect(await c.store.getByReferee(U(2))).toEqual(r);
      expect(await c.eventTypes()).toEqual(["referral.attributed"]);
    });

    it("stores a rejected self referral (silent to callers, visible to operators)", async () => {
      await code(1, "ABCDEFGH");
      const self = referral(1, U(1), U(1), U(101), {
        status: "rejected",
        rejectReason: "self_referral",
        settledAtMs: T0,
      });
      expect(await c.store.insertAttribution(self, [])).toBe("inserted");
      expect(await c.store.getByReferee(U(1))).toMatchObject({ status: "rejected", rejectReason: "self_referral" });
    });

    it("lists by referrer in attribution order", async () => {
      await code(1, "ABCDEFGH");
      await c.store.insertAttribution(referral(2, U(1), U(3), U(101)), []);
      await c.store.insertAttribution(referral(1, U(1), U(2), U(101)), []);
      await c.store.insertAttribution(referral(3, U(4), U(1), U(101)), []);
      const list = await c.store.listByReferrer(U(1));
      expect(list.map((r) => r.refereeId)).toEqual([U(2), U(3)]);
    });

    it("settle applies once: inbox dedupes a replay and events are not duplicated", async () => {
      await code(1, "ABCDEFGH");
      const r = referral(1, U(1), U(2), U(101));
      await c.store.insertAttribution(r, []);
      const input = {
        consumer: "referrals.order_closed",
        messageId: U(700),
        change: {
          referralId: r.id,
          status: "rewarded" as const,
          rejectReason: null,
          orderId: U(800),
          paymentFingerprintHash: HASH("b"),
          rewardAmount: 10_000n,
          settledAtMs: T0 + DAY,
        },
        events: rewardEvents(r, 10_000n),
      };
      expect(await c.store.settle(input)).toMatchObject({ kind: "applied", outcome: "rewarded" });
      expect(await c.store.settle(input)).toEqual({ kind: "duplicate" });
      const after = await c.store.getByReferee(U(2));
      expect(after).toMatchObject({ status: "rewarded", rewardAmount: 10_000n, orderId: U(800), settledAtMs: T0 + DAY });
      expect(await c.eventTypes()).toEqual(["referral.reward_earned"]);
      expect(await c.rewardEventAmounts()).toEqual(["10000"]);
    });

    it("a second message for an already settled referral changes nothing and emits nothing", async () => {
      await code(1, "ABCDEFGH");
      const r = referral(1, U(1), U(2), U(101));
      await c.store.insertAttribution(r, []);
      const change = (amount: bigint) => ({
        referralId: r.id,
        status: "rewarded" as const,
        rejectReason: null,
        orderId: U(800),
        paymentFingerprintHash: null,
        rewardAmount: amount,
        settledAtMs: T0 + DAY,
      });
      await c.store.settle({ consumer: "k", messageId: U(701), change: change(10_000n), events: rewardEvents(r, 10_000n) });
      await c.store.settle({ consumer: "k", messageId: U(702), change: change(99n), events: rewardEvents(r, 99n) });
      expect(await c.rewardEventAmounts()).toEqual(["10000"]);
      expect((await c.store.getByReferee(U(2)))?.rewardAmount).toBe(10_000n);
    });

    it("records a null-change message so it is not reprocessed", async () => {
      const input = { consumer: "k", messageId: U(703), change: null, events: [] };
      expect(await c.store.settle(input)).toMatchObject({ kind: "applied", outcome: "recorded" });
      expect(await c.store.settle(input)).toEqual({ kind: "duplicate" });
    });

    it("counts rewarded referrals inside a window", async () => {
      await code(1, "ABCDEFGH");
      const mk = async (n: number, referee: number, settled: number) => {
        const r = referral(n, U(1), U(referee), U(101));
        await c.store.insertAttribution(r, []);
        await c.store.settle({
          consumer: "k",
          messageId: U(710 + n),
          change: {
            referralId: r.id,
            status: "rewarded",
            rejectReason: null,
            orderId: U(810 + n),
            paymentFingerprintHash: null,
            rewardAmount: 10_000n,
            settledAtMs: settled,
          },
          events: [],
        });
      };
      await mk(1, 2, T0 - 400 * DAY);
      await mk(2, 3, T0 - 10 * DAY);
      expect(await c.store.countRewarded(U(1), null)).toBe(2);
      expect(await c.store.countRewarded(U(1), T0 - 365 * DAY)).toBe(1);
      expect(await c.store.countRewarded(U(4), null)).toBe(0);
    });

    describe("concurrent settle (per-referrer serialisation)", () => {
      const guard = (max: number, every: number) => ({
        referrerId: U(1),
        windowStartMs: T0 - 365 * DAY,
        maxInWindow: max,
        milestoneEvery: every,
        milestonePlusMonths: 1,
      });
      const run = async (n: number, max: number, every: number) => {
        await code(1, "ABCDEFGH");
        const refs = Array.from({ length: n }, (_, i) => referral(i + 1, U(1), U(20 + i), U(101)));
        for (const r of refs) {
          await c.ensureUser(r.refereeId);
          await c.store.insertAttribution(r, []);
        }
        return Promise.all(
          refs.map((r, i) =>
            c.store.settle({
              consumer: "k",
              messageId: U(1000 + i),
              change: {
                referralId: r.id,
                status: "rewarded",
                rejectReason: null,
                orderId: U(1100 + i),
                paymentFingerprintHash: null,
                rewardAmount: 10_000n,
                settledAtMs: T0,
                guard: guard(max, every),
              },
              events: rewardEvents(r, 10_000n),
            }),
          ),
        );
      };

      it("never rewards more than the cap", async () => {
        const res = await run(6, 2, 10);
        expect(res.filter((r) => r.kind === "applied" && r.outcome === "rewarded")).toHaveLength(2);
        expect(res.filter((r) => r.kind === "applied" && r.outcome === "capped")).toHaveLength(4);
        expect(await c.store.countRewarded(U(1), null)).toBe(2);
      });

      it("grants the milestone exactly once", async () => {
        const res = await run(6, 50, 3);
        const plus = res.filter((r) => r.kind === "applied" && r.plusMonths > 0);
        expect(plus).toHaveLength(2);
        expect((await c.eventTypes()).filter((t) => t === "referral.plus_month_earned")).toHaveLength(2);
      });
    });
  });
}
