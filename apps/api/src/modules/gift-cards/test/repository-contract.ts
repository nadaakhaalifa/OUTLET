import { describe, expect, it } from "vitest";
import type { CardRecord, ContributionRecord, GiftCardStore, OutboxDraft, PotRecord } from "../domain/ports";

export const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const T0 = 1_800_000_000_000;
export const HASH = (c: string): string => c.repeat(64).slice(0, 64);

export const issuedCard = (id: string, over: Partial<CardRecord> = {}): CardRecord => ({
  id,
  purchaserId: U(1),
  codeHash: HASH("a"),
  codeKeyVersion: 1,
  last4: "AB12",
  amount: 100_000n,
  remaining: 100_000n,
  status: "ISSUED",
  scopeStoreId: null,
  expiresAtMs: T0 + 86_400_000 * 365,
  design: "eid",
  recipientChannel: "in_app",
  recipientContactEnc: null,
  messageEnc: null,
  scheduledAtMs: null,
  potId: null,
  paymentIntentId: "pi_1",
  idempotencyKey: `idem-${id}`,
  version: 1,
  createdAtMs: T0,
  issuedAtMs: T0,
  deliveredAtMs: null,
  ...over,
});

export const pendingCard = (id: string, over: Partial<CardRecord> = {}): CardRecord =>
  issuedCard(id, {
    status: "PENDING_PAYMENT",
    codeHash: null,
    codeKeyVersion: null,
    last4: null,
    expiresAtMs: null,
    issuedAtMs: null,
    paymentIntentId: null,
    ...over,
  });

export const evt = (id: string, type: OutboxDraft["type"] = "gift_card.issued"): OutboxDraft => ({
  type,
  aggregateType: "gift_card",
  aggregateId: id,
  payload: { card_id: id, amount: 1000 },
});

export interface ContractContext {
  readonly store: GiftCardStore;
  ensureUser(id: string): Promise<void>;
  outboxCount(): Promise<number>;
}

/** One behavioural contract that the in-memory and the Kysely stores must both honour. */
export function describeGiftCardStoreContract(name: string, fresh: () => Promise<ContractContext>): void {
  describe(`GiftCardStore contract: ${name}`, () => {
    const setup = async () => {
      const c = await fresh();
      await c.ensureUser(U(1));
      await c.ensureUser(U(2));
      return c;
    };

    it("inserts a card once per (purchaser, idempotency key) and writes its events in the same call", async () => {
      const c = await setup();
      const a = await c.store.insertCard(pendingCard(U(100)), [evt(U(100))]);
      const b = await c.store.insertCard(pendingCard(U(101), { idempotencyKey: `idem-${U(100)}` }), [evt(U(101))]);
      expect(a.kind).toBe("created");
      expect(b.kind).toBe("duplicate");
      expect(b.card.id).toBe(U(100));
      expect(await c.outboxCount()).toBe(1);
    });

    it("finds a card by code hash and never by a different hash", async () => {
      const c = await setup();
      await c.store.insertCard(issuedCard(U(100)), []);
      expect((await c.store.findByCodeHash(HASH("a")))?.id).toBe(U(100));
      expect(await c.store.findByCodeHash(HASH("b"))).toBeNull();
    });

    it("updates with optimistic concurrency", async () => {
      const c = await setup();
      await c.store.insertCard(pendingCard(U(100)), []);
      const ok = await c.store.updateCard(U(100), 1, { paymentIntentId: "pi_9" }, []);
      expect(ok.kind).toBe("ok");
      const stale = await c.store.updateCard(U(100), 1, { paymentIntentId: "pi_10" }, []);
      expect(stale.kind).toBe("conflict");
      expect((await c.store.getCard(U(100)))?.paymentIntentId).toBe("pi_9");
    });

    it("partial then full redemption conserves value: redeemed + remaining == face", async () => {
      const c = await setup();
      await c.store.insertCard(issuedCard(U(100)), []);
      const r1 = await c.store.beginRedemption({ cardId: U(100), userId: U(2), requested: 30_000n, redemptionId: U(201), nowMs: T0 });
      expect(r1.kind).toBe("ok");
      await c.store.completeRedemption(U(201), U(301), T0, [evt(U(100), "gift_card.redeemed")]);
      const r2 = await c.store.beginRedemption({ cardId: U(100), userId: U(2), requested: null, redemptionId: U(202), nowMs: T0 });
      expect(r2.kind === "ok" && r2.full).toBe(true);
      await c.store.completeRedemption(U(202), U(302), T0, []);
      const card = await c.store.getCard(U(100));
      const reds = await c.store.listRedemptions(U(100));
      const sum = reds.filter((r) => r.status !== "reversed").reduce((s, r) => s + r.amount, 0n);
      expect(card?.status).toBe("REDEEMED");
      expect(card?.remaining).toBe(0n);
      expect(sum + (card?.remaining ?? -1n)).toBe(100_000n);
      const again = await c.store.beginRedemption({ cardId: U(100), userId: U(2), requested: null, redemptionId: U(203), nowMs: T0 });
      expect(["unavailable", "empty"]).toContain(again.kind);
    });

    it("refuses to redeem more than remains and reverses a failed posting back to the prior state", async () => {
      const c = await setup();
      await c.store.insertCard(issuedCard(U(100)), []);
      const over = await c.store.beginRedemption({ cardId: U(100), userId: U(2), requested: 200_000n, redemptionId: U(201), nowMs: T0 });
      expect(over).toMatchObject({ kind: "exceeds_balance", remaining: 100_000n });
      const r = await c.store.beginRedemption({ cardId: U(100), userId: U(2), requested: 40_000n, redemptionId: U(202), nowMs: T0 });
      expect(r.kind).toBe("ok");
      expect((await c.store.getCard(U(100)))?.remaining).toBe(60_000n);
      await c.store.reverseRedemption(U(202));
      const card = await c.store.getCard(U(100));
      expect(card?.remaining).toBe(100_000n);
      expect(card?.status).toBe("ISSUED");
    });

    it("never redeems a card that is VOIDED or still pending payment", async () => {
      const c = await setup();
      await c.store.insertCard(pendingCard(U(100)), []);
      await c.store.insertCard(issuedCard(U(101), { status: "VOIDED", codeHash: HASH("c") }), []);
      const pending = await c.store.beginRedemption({ cardId: U(100), userId: U(2), requested: null, redemptionId: U(201), nowMs: T0 });
      const voided = await c.store.beginRedemption({ cardId: U(101), userId: U(2), requested: null, redemptionId: U(202), nowMs: T0 });
      expect(["not_found", "unavailable"]).toContain(pending.kind);
      expect(voided.kind).toBe("unavailable");
    });

    it("counts only wrong attempts inside the window, per account and per device, and purges old rows", async () => {
      const c = await setup();
      const dev = HASH("d");
      const rec = async (id: number, acc: string, outcome: "ok" | "wrong" | "throttled", atMs: number) =>
        c.store.recordAttempt({ id: U(id), accountId: acc, deviceHash: dev, ipHash: HASH("i"), outcome, atMs });
      await rec(1, U(1), "wrong", T0 - 7_200_000);
      await rec(2, U(1), "wrong", T0 - 60_000);
      await rec(3, U(1), "ok", T0 - 30_000);
      await rec(4, U(2), "wrong", T0 - 10_000);
      await rec(5, U(1), "throttled", T0 - 5_000);
      expect(await c.store.failureTimes({ accountId: U(1) }, T0 - 3_600_000)).toEqual([T0 - 60_000]);
      expect((await c.store.failureTimes({ deviceHash: dev }, T0 - 3_600_000)).length).toBe(2);
      expect(await c.store.purgeAttemptsBefore(T0 - 3_600_000)).toBe(1);
    });

    it("lists expirable cards only when ISSUED or DELIVERED and past expiry", async () => {
      const c = await setup();
      await c.store.insertCard(issuedCard(U(100), { expiresAtMs: T0 - 1 }), []);
      await c.store.insertCard(issuedCard(U(101), { expiresAtMs: T0 + 1_000, codeHash: HASH("b") }), []);
      expect(await c.store.listExpirable(T0, 10)).toEqual([U(100)]);
    });

    it("creates a pot with its POT_OPEN card atomically and closes it with the card change", async () => {
      const c = await setup();
      const card = pendingCard(U(100), { status: "POT_OPEN", potId: null });
      const pot: PotRecord = {
        id: U(400),
        organiserId: U(1),
        organiserNickname: "Sara",
        target: 100_000n,
        closesAtMs: T0 + 86_400_000,
        status: "OPEN",
        cardId: U(100),
        shareTokenHash: HASH("e"),
        version: 1,
        createdAtMs: T0,
        closedAtMs: null,
      };
      const ins = await c.store.insertPot(pot, { ...card, potId: pot.id }, []);
      expect(ins.kind).toBe("created");
      expect((await c.store.getPotByTokenHash(HASH("e")))?.id).toBe(U(400));
      expect(await c.store.listDuePots(T0, 10)).toEqual([]);
      expect(await c.store.listDuePots(T0 + 86_400_001, 10)).toEqual([U(400)]);
      const co: ContributionRecord = {
        id: U(500),
        potId: U(400),
        userId: U(2),
        amount: 50_000n,
        paymentIntentId: null,
        status: "pending",
        idempotencyKey: "k1",
        createdAtMs: T0,
      };
      expect((await c.store.insertContribution(co)).kind).toBe("created");
      expect((await c.store.insertContribution({ ...co, id: U(501) })).kind).toBe("duplicate");
      await c.store.updateContribution(U(500), { status: "paid", paymentIntentId: "pi_5" });
      expect((await c.store.listContributions(U(400))).map((x) => x.status)).toEqual(["paid"]);
      const r = await c.store.updatePot(U(400), 1, { status: "CLOSED_UNFUNDED", closedAtMs: T0 }, { patch: { status: "CANCELLED" }, events: [] }, []);
      expect(r.kind).toBe("ok");
      expect((await c.store.getCard(U(100)))?.status).toBe("CANCELLED");
      expect((await c.store.updatePot(U(400), 1, { status: "REFUNDING" }, null, [])).kind).toBe("conflict");
      expect(await c.store.listPotsInState("CLOSED_UNFUNDED", 10)).toEqual([U(400)]);
    });

    it("admitAttempt is check-and-record: 5 failures per account then throttled, pending counts, ip window applies", async () => {
      const c = await setup();
      const adm = (id: number, acc: string, dev: string, ip: string, atMs: number) =>
        c.store.admitAttempt({ id: U(id), accountId: acc, deviceHash: HASH(dev), ipHash: HASH(ip), atMs });
      const rs = await Promise.all([1, 2, 3, 4, 5, 6, 7].map((n) => adm(n, U(1), `d${n}`, `i${n}`, T0)));
      expect(rs.filter((r) => r.allowed)).toHaveLength(5);
      const blocked = rs.find((r) => !r.allowed);
      expect(blocked).toMatchObject({ allowed: false, scope: "account" });
      await c.store.finalizeAttempt(U(1), "ok");
      expect((await c.store.failureTimes({ accountId: U(1) }, T0 - 1)).length).toBe(4);
    });

    it("lists pending redemptions oldest first and reverse is idempotent", async () => {
      const c = await setup();
      await c.store.insertCard(issuedCard(U(100)), []);
      await c.store.beginRedemption({ cardId: U(100), userId: U(2), requested: 10_000n, redemptionId: U(210), nowMs: T0 });
      expect((await c.store.listPendingRedemptions(T0 - 1, 10)).length).toBe(0);
      expect((await c.store.listPendingRedemptions(T0, 10)).map((r) => r.id)).toEqual([U(210)]);
      await c.store.reverseRedemption(U(210));
      await c.store.reverseRedemption(U(210));
      expect((await c.store.getCard(U(100)))?.remaining).toBe(100_000n);
      expect(await c.store.listPendingRedemptions(T0 + 1, 10)).toEqual([]);
    });

    it("confirmContribution locks the pot: only what fits is applied, the rest is excess", async () => {
      const c = await setup();
      const card = pendingCard(U(100), { status: "POT_OPEN", potId: null });
      const pot: PotRecord = {
        id: U(400), organiserId: U(1), organiserNickname: "Sara", target: 100_000n, closesAtMs: T0 + 86_400_000,
        status: "OPEN", cardId: U(100), shareTokenHash: HASH("e"), version: 1, createdAtMs: T0, closedAtMs: null,
      };
      await c.store.insertPot(pot, { ...card, potId: pot.id }, []);
      for (const n of [1, 2, 3]) {
        await c.store.insertContribution({
          id: U(500 + n), potId: U(400), userId: U(2), amount: 50_000n, paymentIntentId: null,
          status: n === 3 ? "pending_void" : "pending", idempotencyKey: `k${n}`, createdAtMs: T0,
        });
      }
      const rs = await Promise.all([1, 2, 3].map((n) => c.store.confirmContribution(U(500 + n), `pi_${n}`)));
      expect(rs.filter((r) => r.kind === "applied")).toHaveLength(2);
      expect(rs.filter((r) => r.kind === "excess")).toHaveLength(1);
      expect((await c.store.confirmContribution(U(501), "pi_1")).kind).toBe("replayed");
      expect(await c.store.updateContribution(U(501), { status: "cancelled" }, ["pending"])).toBeNull();
      expect((await c.store.listContributionsInStatus("paid", 10)).length).toBe(2);
    });

    it("pages throttled attempts and pots newest first with a keyset position", async () => {
      const c = await setup();
      for (const n of [1, 2, 3]) {
        await c.store.recordAttempt({ id: U(600 + n), accountId: U(1), deviceHash: HASH("d"), ipHash: HASH("i"), outcome: n === 2 ? "wrong" : "throttled", atMs: T0 + n });
      }
      const p1 = await c.store.listThrottledAttempts(null, 1);
      expect(p1.map((a) => a.id)).toEqual([U(603)]);
      const p2 = await c.store.listThrottledAttempts({ ms: T0 + 3, id: U(603) }, 5);
      expect(p2.map((a) => a.id)).toEqual([U(601)]);
      for (const n of [1, 2]) {
        const card = pendingCard(U(700 + n), { status: "POT_OPEN", potId: null });
        const pot: PotRecord = {
          id: U(710 + n), organiserId: U(1), organiserNickname: "S", target: 100_000n, closesAtMs: T0 + 86_400_000,
          status: "OPEN", cardId: card.id, shareTokenHash: HASH(String(n)), version: 1, createdAtMs: T0 + n, closedAtMs: null,
        };
        await c.store.insertPot(pot, { ...card, potId: pot.id, idempotencyKey: `pk${n}` }, []);
      }
      const first = await c.store.listPotsPage(null, 1);
      expect(first.map((p) => p.id)).toEqual([U(712)]);
      expect((await c.store.listPotsPage({ ms: T0 + 2, id: U(712) }, 5)).map((p) => p.id)).toEqual([U(711)]);
    });
  });
}
