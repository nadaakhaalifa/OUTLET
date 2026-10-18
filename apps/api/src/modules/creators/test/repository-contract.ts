import { describe, expect, it } from "vitest";
import type {
  AffiliateLink,
  Attribution,
  CreatorAccount,
  CreatorLook,
  CreatorPayout,
  CreatorStore,
  NewCommission,
  SealedKyc,
} from "../domain/ports";

export interface CreatorStoreContext {
  readonly store: CreatorStore;
  /** Makes the user exist where the store enforces the FK (Postgres); no-op in memory. */
  ensureUser(userId: string): Promise<void>;
  eventTypes(): Promise<readonly string[]>;
}

export const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const T0 = Date.UTC(2026, 9, 12, 8, 0, 0);
const DAY = 86_400_000;
const H = (c: string): string => c.repeat(64);

export const kyc = (n: number): SealedKyc => ({
  keyId: "k1",
  legalNameEnc: new Uint8Array([1, 2, 3]),
  nationalIdEnc: new Uint8Array([4, 5, 6]),
  nationalIdHash: new Uint8Array(32).fill(n),
  payoutIbanEnc: null,
  payoutNameEnc: null,
  taxIdEnc: null,
  taxFormEnc: null,
});

export const account = (n: number, userId: string, over: Partial<CreatorAccount> = {}): CreatorAccount => ({
  id: U(100 + n),
  userId,
  handle: `creator_${n}`,
  displayName: `Creator ${n}`,
  status: "ACTIVE",
  kycState: "APPROVED",
  termsVersion: 1,
  termsAcceptedAtMs: T0,
  payoutPref: "cash",
  statusReason: null,
  appliedAtMs: T0,
  decidedAtMs: T0,
  ...over,
});

export const link = (n: number, creatorId: string, over: Partial<AffiliateLink> = {}): AffiliateLink => ({
  id: U(200 + n),
  creatorId,
  targetType: "product",
  targetId: U(300 + n),
  slug: `slug${String(n).padStart(8, "0")}abcd`,
  status: "ACTIVE",
  createdAtMs: T0 + n,
  ...over,
});

export const attribution = (n: number, creatorId: string, linkId: string, buyer: string, over: Partial<Attribution> = {}): Attribution => ({
  orderGroupId: U(400 + n),
  creatorId,
  linkId,
  clickId: U(500 + n),
  clickAtMs: T0 - DAY,
  buyerUserId: buyer,
  rateSnapshot: { defaultBps: 300, categoryBps: {} },
  windowEndMs: T0 + 6 * DAY,
  status: "ACTIVE",
  voidReason: null,
  createdAtMs: T0,
  ...over,
});

export const newCommission = (n: number, creatorId: string, orderGroupId: string, over: Partial<NewCommission> = {}): NewCommission => ({
  id: U(600 + n),
  creatorId,
  orderGroupId,
  orderLineId: U(700 + n),
  base: 100_000n,
  rateBps: 300n,
  amount: 3_000n,
  refundedBase: 0n,
  monthKey: "2026-10",
  closedAtMs: T0 + 15 * DAY,
  creatorActive: true,
  monthlyCap: 2_000_000n,
  ...over,
});

const look = (n: number, creatorId: string, over: Partial<CreatorLook> = {}): CreatorLook => ({
  id: U(800 + n),
  creatorId,
  title: `Look ${n}`,
  status: "DRAFT",
  takedownReason: null,
  productIds: [U(300), U(301)],
  createdAtMs: T0,
  updatedAtMs: T0,
  ...over,
});

const payout = (n: number, creatorId: string, amount: bigint, over: Partial<CreatorPayout> = {}): CreatorPayout => ({
  id: U(900 + n),
  creatorId,
  amount,
  state: "SCHEDULED",
  holdReason: null,
  attempt: 0,
  providerRef: null,
  failureReason: null,
  createdBy: U(9),
  createdAtMs: T0,
  updatedAtMs: T0,
  ...over,
});

/** One shared behaviour suite for every CreatorStore implementation. */
export function describeCreatorStoreContract(name: string, make: () => Promise<CreatorStoreContext>): void {
  describe(`CreatorStore contract: ${name}`, () => {
    const seed = async (c: CreatorStoreContext, n = 1) => {
      const userId = U(n);
      await c.ensureUser(userId);
      const a = account(n, userId);
      expect((await c.store.createAccount(a, kyc(n), [{ type: "creator.applied", creatorId: a.id }])).kind).toBe("created");
      const l = link(n, a.id);
      await c.store.insertLink(l, []);
      return { a, l };
    };

    it("creates an account once and refuses a duplicate handle or identity document", async () => {
      const c = await make();
      await c.ensureUser(U(1));
      await c.ensureUser(U(2));
      await c.ensureUser(U(3));
      const a1 = account(1, U(1));
      expect((await c.store.createAccount(a1, kyc(1), [])).kind).toBe("created");
      expect((await c.store.createAccount({ ...a1, id: U(150) }, kyc(7), [])).kind).toBe("exists");
      expect((await c.store.createAccount(account(2, U(2), { handle: a1.handle }), kyc(2), [])).kind).toBe("handle_taken");
      expect((await c.store.createAccount(account(3, U(3)), kyc(1), [])).kind).toBe("identity_in_use");
      expect((await c.store.getByUser(U(1)))?.handle).toBe("creator_1");
      expect((await c.store.getByHandle("creator_1"))?.id).toBe(a1.id);
      expect(await c.store.getByUser(U(2))).toBeNull();
    });

    it("decides an application and lists by status", async () => {
      const c = await make();
      await c.ensureUser(U(1));
      const a = account(1, U(1), { status: "APPLIED", kycState: "SUBMITTED", decidedAtMs: null });
      await c.store.createAccount(a, kyc(1), []);
      expect((await c.store.listByStatus("APPLIED", 10)).map((x) => x.id)).toEqual([a.id]);
      const next = await c.store.decide({
        creatorId: a.id,
        status: "ACTIVE",
        kycState: "APPROVED",
        reason: null,
        reviewerId: U(9),
        nowMs: T0 + 1,
        events: [{ type: "creator.approved", creatorId: a.id }],
      });
      expect(next?.status).toBe("ACTIVE");
      expect(await c.store.listByStatus("APPLIED", 10)).toHaveLength(0);
      expect(await c.store.decide({ creatorId: U(999), status: "ACTIVE", kycState: "APPROVED", reason: null, reviewerId: U(9), nowMs: T0, events: [] })).toBeNull();
      expect(await c.eventTypes()).toContain("creator.approved");
    });

    it("links: one active per target, unique slug, owner-scoped disable", async () => {
      const c = await make();
      const { a, l } = await seed(c, 1);
      await c.ensureUser(U(2));
      const b = account(2, U(2));
      await c.store.createAccount(b, kyc(2), []);
      const dup = await c.store.insertLink({ ...l, id: U(250), slug: "otherslug00000000" }, []);
      expect(dup.kind).toBe("exists");
      const slugClash = await c.store.insertLink({ ...link(9, a.id), slug: l.slug }, []);
      expect(slugClash.kind).toBe("slug_taken");
      expect((await c.store.findLinkBySlug(l.slug))?.id).toBe(l.id);
      // another creator cannot disable it
      expect(await c.store.disableLink(b.id, l.id, T0)).toBe(false);
      expect(await c.store.disableLink(a.id, l.id, T0)).toBe(true);
      expect((await c.store.getLink(l.id))?.status).toBe("DISABLED");
      // after disabling, the same target can get a new active link
      expect((await c.store.insertLink({ ...link(8, a.id), targetId: l.targetId }, [])).kind).toBe("created");
    });

    it("looks keep item order and survive an update", async () => {
      const c = await make();
      const { a } = await seed(c, 1);
      const lk = look(1, a.id, { productIds: [U(302), U(300), U(301)] });
      await c.store.insertLook(lk);
      expect((await c.store.getLook(lk.id))?.productIds).toEqual([U(302), U(300), U(301)]);
      await c.store.updateLook({ ...lk, status: "PUBLISHED", productIds: [U(301)], updatedAtMs: T0 + 5 });
      const got = await c.store.getLook(lk.id);
      expect(got?.status).toBe("PUBLISHED");
      expect(got?.productIds).toEqual([U(301)]);
      expect((await c.store.listLooks(a.id)).map((x) => x.id)).toEqual([lk.id]);
    });

    it("clicks: counts per ip and hour, stats, device lookup inside a window", async () => {
      const c = await make();
      const { a, l } = await seed(c, 1);
      const mk = (n: number, atMs: number, over: object = {}) => ({
        id: U(1000 + n), linkId: l.id, creatorId: a.id, atMs, deviceHash: H("d"), ipHash: H("1"),
        counted: true, uaClass: "app" as const, ...over,
      });
      await c.store.insertClick(mk(1, T0), [{ type: "affiliate.click_recorded", creatorId: a.id, linkId: l.id, counted: true }]);
      await c.store.insertClick(mk(2, T0 + 1000), []);
      await c.store.insertClick(mk(3, T0 + 2000, { counted: false, uaClass: "bot" }), []);
      await c.store.insertClick(mk(4, T0 + 3000, { deviceHash: H("e"), ipHash: H("2") }), []);
      expect(await c.store.countedClicksSince(a.id, H("1"), T0 - 1)).toBe(2);
      expect(await c.store.countedClicksSince(a.id, H("1"), T0 + 1001)).toBe(0);
      expect(await c.store.clickStats(a.id, T0 - 1)).toEqual({ total: 4, counted: 3 });
      const found = await c.store.clicksForDevices([H("d")], T0 - 1, T0 + 10_000);
      expect(found.map((x) => x.id)).toEqual([U(1003), U(1002), U(1001)]);
      expect(await c.store.clicksForDevices([], 0, T0)).toEqual([]);
    });

    it("attribution is one per order group and can be voided", async () => {
      const c = await make();
      const { a, l } = await seed(c, 1);
      const at = attribution(1, a.id, l.id, U(50));
      expect(await c.store.insertAttribution(at, [{ type: "creator.order_attributed", creatorId: a.id, orderGroupId: at.orderGroupId }])).toBe("inserted");
      expect(await c.store.insertAttribution({ ...at, creatorId: a.id, buyerUserId: U(51) }, [])).toBe("exists");
      expect((await c.store.getAttribution(at.orderGroupId))?.buyerUserId).toBe(U(50));
      expect(await c.store.attributedBuyers(a.id, 10)).toEqual([U(50)]);
      await c.store.voidAttribution(at.orderGroupId, "same_device", [
        { type: "creator.attribution_voided", creatorId: a.id, orderGroupId: at.orderGroupId, reason: "same_device" },
      ]);
      expect((await c.store.getAttribution(at.orderGroupId))?.status).toBe("VOIDED");
      expect(await c.store.attributedBuyers(a.id, 10)).toEqual([]);
    });

    it("accrual: claimed once, duplicate message and duplicate line are inert, intent exists", async () => {
      const c = await make();
      const { a, l } = await seed(c, 1);
      const at = attribution(1, a.id, l.id, U(50));
      await c.store.insertAttribution(at, []);
      const nc = newCommission(1, a.id, at.orderGroupId);
      const r1 = await c.store.claimAccrual({ consumer: "t", messageId: U(2001), commission: nc });
      expect(r1.kind).toBe("claimed");
      if (r1.kind === "claimed") {
        expect(r1.commission.state).toBe("ACCRUED");
        expect(r1.commission.amount).toBe(3_000n);
      }
      expect((await c.store.claimAccrual({ consumer: "t", messageId: U(2001), commission: nc })).kind).toBe("duplicate");
      expect((await c.store.claimAccrual({ consumer: "t", messageId: U(2002), commission: { ...nc, id: U(650) } })).kind).toBe("exists");
      const intents = await c.store.intentsFor(nc.id);
      expect(intents).toHaveLength(1);
      expect(intents[0]).toMatchObject({ seq: 0, kind: "accrual", amount: 3_000n, creatorUserId: U(1) });
      expect(await c.store.markPosted(nc.id, 0, T0)).toBe(true);
      expect(await c.store.markPosted(nc.id, 0, T0)).toBe(false);
      expect(await c.store.intentsFor(nc.id)).toHaveLength(0);
      expect(await c.store.listUnpostedIntents(10)).toHaveLength(0);
      expect(await c.store.monthAccrued(a.id, "2026-10")).toBe(3_000n);
      expect(await c.eventTypes()).toContain("commission.accrued");
    });

    it("monthly cap holds the whole commission; a suspended creator holds too; release re-accrues", async () => {
      const c = await make();
      const { a, l } = await seed(c, 1);
      const at = attribution(1, a.id, l.id, U(50));
      await c.store.insertAttribution(at, []);
      const cap = 5_000n;
      const first = await c.store.claimAccrual({ consumer: "t", messageId: U(2001), commission: newCommission(1, a.id, at.orderGroupId, { monthlyCap: cap }) });
      const second = await c.store.claimAccrual({ consumer: "t", messageId: U(2002), commission: newCommission(2, a.id, at.orderGroupId, { monthlyCap: cap }) });
      const third = await c.store.claimAccrual({ consumer: "t", messageId: U(2003), commission: newCommission(3, a.id, at.orderGroupId, { creatorActive: false, monthlyCap: cap }) });
      expect(first.kind === "claimed" && first.commission.state).toBe("ACCRUED");
      expect(second.kind === "claimed" && second.commission.state).toBe("ACCRUING");
      expect(second.kind === "claimed" && second.commission.holdReason).toBe("monthly_cap");
      expect(third.kind === "claimed" && third.commission.holdReason).toBe("creator_not_active");
      expect(await c.store.monthAccrued(a.id, "2026-10")).toBe(3_000n);
      expect(await c.store.listHeld(10)).toHaveLength(2);
      expect(await c.store.intentsFor(U(602))).toHaveLength(0);

      const released = await c.store.releaseHeld(U(602), "2026-11", 1_000_000n);
      expect(released?.state).toBe("ACCRUED");
      expect(await c.store.releaseHeld(U(602), "2026-11", 1_000_000n)).toBeNull();
      expect(await c.store.monthAccrued(a.id, "2026-11")).toBe(3_000n);
      expect(await c.store.intentsFor(U(602))).toHaveLength(1);
    });

    it("refund: pro rata clawback, replay safe, full clawback closes the commission", async () => {
      const c = await make();
      const { a, l } = await seed(c, 1);
      const at = attribution(1, a.id, l.id, U(50));
      await c.store.insertAttribution(at, []);
      const nc = newCommission(1, a.id, at.orderGroupId);
      await c.store.claimAccrual({ consumer: "t", messageId: U(2001), commission: nc });
      await c.store.markPosted(nc.id, 0, T0);

      const part = await c.store.claimRefund({ consumer: "r", messageId: U(3001), orderLineId: nc.orderLineId, lineGross: 114_000n, refundedGross: 45_600n });
      expect(part.kind).toBe("applied");
      if (part.kind === "applied") {
        expect(part.plan).toMatchObject({ kind: "clawback", delta: 1_200n, full: false });
        expect(part.commission.clawedBack).toBe(1_200n);
        expect(part.commission.state).toBe("ACCRUED");
      }
      expect((await c.store.claimRefund({ consumer: "r", messageId: U(3001), orderLineId: nc.orderLineId, lineGross: 114_000n, refundedGross: 45_600n })).kind).toBe("duplicate");
      // same cumulative refund in a different message: nothing more to claw back
      const again = await c.store.claimRefund({ consumer: "r", messageId: U(3002), orderLineId: nc.orderLineId, lineGross: 114_000n, refundedGross: 45_600n });
      expect(again.kind === "applied" && again.plan.kind).toBe("none");
      const full = await c.store.claimRefund({ consumer: "r", messageId: U(3003), orderLineId: nc.orderLineId, lineGross: 114_000n, refundedGross: 114_000n });
      if (full.kind === "applied") {
        expect(full.plan).toMatchObject({ kind: "clawback", delta: 1_800n, full: true });
        expect(full.commission.state).toBe("CLAWED_BACK");
      } else throw new Error("expected applied");
      const intents = await c.store.intentsFor(nc.id);
      expect(intents.map((i) => [i.seq, i.kind, i.amount])).toEqual([[1, "clawback", 1_200n], [2, "clawback", 1_800n]]);
      expect((await c.store.getCommission(nc.id))?.clawedBack).toBe(3_000n);
      expect(await c.store.claimRefund({ consumer: "r", messageId: U(3004), orderLineId: U(799), lineGross: 1n, refundedGross: 1n })).toEqual({ kind: "no_commission" });
    });

    it("refund of a held commission shrinks it without a ledger intent and voids at zero", async () => {
      const c = await make();
      const { a, l } = await seed(c, 1);
      const at = attribution(1, a.id, l.id, U(50));
      await c.store.insertAttribution(at, []);
      const nc = newCommission(1, a.id, at.orderGroupId, { creatorActive: false });
      await c.store.claimAccrual({ consumer: "t", messageId: U(2001), commission: nc });
      const half = await c.store.claimRefund({ consumer: "r", messageId: U(3001), orderLineId: nc.orderLineId, lineGross: 100n, refundedGross: 50n });
      expect(half.kind === "applied" && half.commission.amount).toBe(1_500n);
      const all = await c.store.claimRefund({ consumer: "r", messageId: U(3002), orderLineId: nc.orderLineId, lineGross: 100n, refundedGross: 100n });
      expect(all.kind === "applied" && all.commission.state).toBe("VOIDED");
      expect(await c.store.intentsFor(nc.id)).toHaveLength(0);
      expect(await c.store.listCommissions(a.id, 10, null)).toHaveLength(0);
    });

    it("totals separate pending, paid, clawed back and held", async () => {
      const c = await make();
      const { a, l } = await seed(c, 1);
      const at = attribution(1, a.id, l.id, U(50));
      await c.store.insertAttribution(at, []);
      await c.store.claimAccrual({ consumer: "t", messageId: U(2001), commission: newCommission(1, a.id, at.orderGroupId) });
      await c.store.claimAccrual({ consumer: "t", messageId: U(2002), commission: newCommission(2, a.id, at.orderGroupId, { creatorActive: false }) });
      await c.store.claimRefund({ consumer: "r", messageId: U(3001), orderLineId: U(701), lineGross: 100n, refundedGross: 40n });
      expect(await c.store.commissionTotals(a.id)).toEqual({ pending: 1_800n, accrued: 3_000n, clawedBack: 1_200n, paid: 0n, held: 3_000n });
    });

    it("payouts: one open per creator, reserve then settle marks PAID, cancel releases", async () => {
      const c = await make();
      const { a, l } = await seed(c, 1);
      const at = attribution(1, a.id, l.id, U(50));
      await c.store.insertAttribution(at, []);
      await c.store.claimAccrual({ consumer: "t", messageId: U(2001), commission: newCommission(1, a.id, at.orderGroupId) });
      expect(await c.store.reservableTotal(a.id)).toBe(3_000n);
      const p = payout(1, a.id, 3_000n);
      expect(await c.store.createPayout({ payout: p, events: [{ type: "creator_payout.requested", creatorId: a.id, payoutId: p.id, amount: 3_000n }] })).toBe("created");
      expect(await c.store.reservableTotal(a.id)).toBe(0n);
      expect(await c.store.createPayout({ payout: payout(2, a.id, 1n), events: [] })).toBe("open_exists");
      expect((await c.store.getCommission(U(601)))?.payoutId).toBe(p.id);

      // compare-and-set: a stale `from` loses
      expect(await c.store.transitionPayout({ id: p.id, from: "APPROVED", to: "SENT", nowMs: T0, events: [] })).toBeNull();
      const approved = await c.store.transitionPayout({ id: p.id, from: "SCHEDULED", to: "APPROVED", nowMs: T0 + 1, events: [] });
      expect(approved?.state).toBe("APPROVED");
      const sent = await c.store.transitionPayout({ id: p.id, from: "APPROVED", to: "SENT", attempt: 1, nowMs: T0 + 2, events: [] });
      expect(sent?.attempt).toBe(1);
      const done = await c.store.transitionPayout({
        id: p.id, from: "SENT", to: "SETTLED", providerRef: "ref-1", nowMs: T0 + 3,
        events: [{ type: "creator_payout.settled", creatorId: a.id, payoutId: p.id, amount: 3_000n }],
      });
      expect(done).toMatchObject({ state: "SETTLED", providerRef: "ref-1" });
      expect((await c.store.getCommission(U(601)))?.state).toBe("PAID");
      expect((await c.store.commissionTotals(a.id)).paid).toBe(3_000n);

      // a new open payout is possible again; cancelling releases reserved commissions
      await c.store.claimAccrual({ consumer: "t", messageId: U(2002), commission: newCommission(2, a.id, at.orderGroupId) });
      const p2 = payout(3, a.id, 3_000n);
      expect(await c.store.createPayout({ payout: p2, events: [] })).toBe("created");
      expect(await c.store.transitionPayout({ id: p2.id, from: "SCHEDULED", to: "CANCELLED", nowMs: T0 + 9, events: [] })).not.toBeNull();
      expect(await c.store.reservableTotal(a.id)).toBe(3_000n);
      expect((await c.store.listPayouts({ creatorId: a.id, limit: 10 })).map((x) => x.state).sort()).toEqual(["CANCELLED", "SETTLED"]);
    });
  });
}
