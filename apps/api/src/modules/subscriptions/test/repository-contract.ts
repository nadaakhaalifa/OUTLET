import { describe, expect, it } from "vitest";
import {
  DAY_MS,
  cancel,
  renewFailed,
  startPaid,
  startTrial,
  type PlusPlan,
  type PlusSubscription,
} from "../domain/bridge";
import type { EntitlementRow, InvoiceRecord, SubscriptionStore } from "../domain/ports";

export const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const T0 = 1_800_000_000_000;

export interface StoreFixture {
  readonly store: SubscriptionStore;
  ensureUser(id: string): Promise<void>;
  eventTypes(): Promise<readonly string[]>;
}

export const plan = (n: number, over: Partial<PlusPlan> = {}): PlusPlan => ({
  id: U(100 + n),
  code: "plus_monthly",
  interval: "month",
  priceMinor: 20_000n,
  version: 1,
  active: true,
  trialDays: 14,
  effectiveFromMs: 0,
  notifiedAtMs: null,
  ...over,
});

export const invoice = (n: number, subId: string, userId: string, over: Partial<InvoiceRecord> = {}): InvoiceRecord => ({
  id: U(300 + n),
  subscriptionId: subId,
  userId,
  cycle: 1,
  attempt: 0,
  kind: "first",
  amountMinor: 20_000n,
  vatMinor: 2_456n,
  creditAppliedMinor: 0n,
  netRecognitionMinor: 17_544n,
  periodsTotal: 1,
  periodsRecognised: 0,
  periodStartMs: T0,
  status: "PAID",
  provider: "fake_psp",
  pspRef: "psp_1",
  issuedAtMs: T0,
  chargedAtMs: T0,
  refundedAtMs: null,
  ...over,
});

const ent = (sub: PlusSubscription, n: number): EntitlementRow => ({
  userId: sub.userId,
  subscriptionId: sub.id,
  group: "commerce_benefits",
  key: `k${n}`,
  validFromMs: T0,
  validToMs: T0 + DAY_MS,
});

export function describeSubscriptionStoreContract(name: string, open: () => Promise<StoreFixture>): void {
  describe(`SubscriptionStore contract: ${name}`, () => {
    const setup = async (users: number[] = [1]) => {
      const f = await open();
      for (const u of users) await f.ensureUser(U(u));
      const p = plan(1);
      expect(await f.store.savePlan(p, [])).toBe("ok");
      return { ...f, p };
    };
    const sub = (p: PlusPlan, n: number, userN: number) =>
      startPaid({ id: U(200 + n), userId: U(userN), plan: p, pspTokenRef: "tok", nowMs: T0 });

    it("plans: versions are unique per code, activation is updatable", async () => {
      const { store, p } = await setup();
      expect(await store.savePlan(plan(2, { version: 1 }), [])).toBe("exists");
      expect(await store.savePlan(plan(3, { version: 2, priceMinor: 25_000n }), [])).toBe("ok");
      const all = await store.listPlanVersions("plus_monthly");
      expect(all.map((x) => x.version)).toEqual([1, 2]);
      expect(all[1]?.priceMinor).toBe(25_000n);
      await store.savePlan({ ...p, active: false, notifiedAtMs: T0 }, []);
      const again = await store.getPlan(p.id);
      expect(again?.active).toBe(false);
      expect(again?.notifiedAtMs).toBe(T0);
      expect(await store.getPlan(U(999))).toBeNull();
    });

    it("commits subscription, invoice, entitlements and events together", async () => {
      const { store, p, eventTypes } = await setup();
      const s = sub(p, 1, 1);
      const r = await store.commit({
        subscription: { value: s, expectedVersion: null },
        invoices: [invoice(1, s.id, s.userId)],
        entitlements: { subscriptionId: s.id, rows: [ent(s, 1), ent(s, 2)] },
        events: [{ type: "plus.subscribed", subscriptionId: s.id, userId: s.userId, planCode: s.planCode, trial: false }],
      });
      expect(r).toBe("ok");
      const got = await store.getSubscription(s.id);
      expect(got?.status).toBe("ACTIVE");
      expect(got?.version).toBe(1);
      expect(got?.periodEndMs).toBe(s.periodEndMs);
      expect((await store.getLiveByUser(U(1)))?.id).toBe(s.id);
      expect(await store.listInvoices(s.id)).toHaveLength(1);
      expect((await store.latestPaidInvoice(s.id))?.amountMinor).toBe(20_000n);
      expect((await store.entitlementRows(U(1))).map((e) => e.key).sort()).toEqual(["k1", "k2"]);
      expect(await eventTypes()).toEqual(["plus.subscribed"]);
    });

    it("one live subscription per user: the second insert is refused and nothing is applied", async () => {
      const { store, p, eventTypes } = await setup();
      const a = sub(p, 1, 1);
      expect(await store.commit({ subscription: { value: a, expectedVersion: null }, events: [] })).toBe("ok");
      const b = sub(p, 2, 1);
      const r = await store.commit({
        subscription: { value: b, expectedVersion: null },
        invoices: [invoice(2, b.id, b.userId)],
        events: [{ type: "plus.subscribed", subscriptionId: b.id, userId: b.userId, planCode: b.planCode, trial: false }],
      });
      expect(r).toBe("already_subscribed");
      expect(await store.getSubscription(b.id)).toBeNull();
      expect(await store.listInvoices(b.id)).toHaveLength(0);
      expect(await eventTypes()).toEqual([]);
    });

    it("optimistic concurrency: a stale version conflicts and applies nothing", async () => {
      const { store, p, eventTypes } = await setup();
      const s = sub(p, 1, 1);
      await store.commit({ subscription: { value: s, expectedVersion: null }, events: [] });
      const live = (await store.getSubscription(s.id)) as PlusSubscription;
      expect(await store.commit({ subscription: { value: cancel(live, T0), expectedVersion: live.version }, events: [] })).toBe("ok");
      const stale = await store.commit({
        subscription: { value: renewFailed(live, T0), expectedVersion: live.version },
        events: [{ type: "plus.payment_failed", subscriptionId: s.id, userId: s.userId, attempt: 0 }],
      });
      expect(stale).toBe("conflict");
      expect((await store.getSubscription(s.id))?.status).toBe("CANCELLED_AT_PERIOD_END");
      expect(await eventTypes()).toEqual([]);
    });

    it("an expired subscription frees the user for a new one", async () => {
      const { store, p } = await setup();
      const a = sub(p, 1, 1);
      await store.commit({ subscription: { value: a, expectedVersion: null }, events: [] });
      const live = (await store.getSubscription(a.id)) as PlusSubscription;
      await store.commit({ subscription: { value: { ...live, status: "EXPIRED", nextActionAtMs: null }, expectedVersion: live.version }, events: [] });
      expect(await store.getLiveByUser(U(1))).toBeNull();
      expect((await store.getLatestByUser(U(1)))?.status).toBe("EXPIRED");
      const b = sub(p, 2, 1);
      expect(await store.commit({ subscription: { value: b, expectedVersion: null }, events: [] })).toBe("ok");
      expect((await store.getLatestByUser(U(1)))?.id).toBe(b.id);
    });

    it("trial claims: a claimed key refuses the whole commit", async () => {
      const { store, p, eventTypes } = await setup([1, 2]);
      const hash = (c: string) => c.repeat(64).slice(0, 64);
      const a = startTrial({ id: U(201), userId: U(1), plan: p, pspTokenRef: "t", nowMs: T0 });
      expect(
        await store.commit({
          subscription: { value: a, expectedVersion: null },
          trialClaims: { keyHashes: [hash("a"), hash("b")], subscriptionId: a.id, atMs: T0 },
          events: [],
        }),
      ).toBe("ok");
      expect([...(await store.claimedTrialKeys([hash("a"), hash("c")]))]).toEqual([hash("a")]);
      expect((await store.claimedTrialKeys([])).size).toBe(0);
      const b = startTrial({ id: U(202), userId: U(2), plan: p, pspTokenRef: "t", nowMs: T0 });
      const r = await store.commit({
        subscription: { value: b, expectedVersion: null },
        trialClaims: { keyHashes: [hash("c"), hash("b")], subscriptionId: b.id, atMs: T0 },
        events: [{ type: "plus.subscribed", subscriptionId: b.id, userId: b.userId, planCode: b.planCode, trial: true }],
      });
      expect(r).toBe("trial_taken");
      expect(await store.getSubscription(b.id)).toBeNull();
      expect((await store.claimedTrialKeys([hash("c")])).size).toBe(0);
      expect(await eventTypes()).toEqual([]);
    });

    it("webhook events dedupe by (provider, event id)", async () => {
      const { store } = await setup();
      const w = { provider: "fake_psp", eventId: "evt_1" };
      expect(await store.commit({ webhookEvent: w, events: [] })).toBe("ok");
      expect(await store.commit({ webhookEvent: w, events: [] })).toBe("duplicate_event");
      expect(await store.commit({ webhookEvent: { provider: "other", eventId: "evt_1" }, events: [] })).toBe("ok");
    });

    it("invoices are unique per (subscription, cycle, attempt) and update in place by id", async () => {
      const { store, p } = await setup();
      const s = sub(p, 1, 1);
      await store.commit({ subscription: { value: s, expectedVersion: null }, invoices: [invoice(1, s.id, s.userId)], events: [] });
      expect(await store.commit({ invoices: [invoice(2, s.id, s.userId)], events: [] })).toBe("conflict");
      const recognised = { ...invoice(1, s.id, s.userId), periodsRecognised: 1 };
      expect(await store.commit({ invoices: [recognised], events: [] })).toBe("ok");
      expect((await store.getInvoice(U(301)))?.periodsRecognised).toBe(1);
      expect(await store.listForRecognition(10)).toHaveLength(0);
      expect(await store.commit({ invoices: [invoice(3, s.id, s.userId, { attempt: 1, status: "FAILED", chargedAtMs: null, pspRef: null })], events: [] })).toBe("ok");
      expect((await store.listInvoices(s.id)).map((i) => i.attempt)).toEqual([0, 1]);
      expect((await store.latestPaidInvoice(s.id))?.id).toBe(U(301));
    });

    it("entitlements are replaced as a set and can be revoked", async () => {
      const { store, p } = await setup();
      const s = sub(p, 1, 1);
      await store.commit({ subscription: { value: s, expectedVersion: null }, entitlements: { subscriptionId: s.id, rows: [ent(s, 1), ent(s, 2)] }, events: [] });
      await store.commit({ entitlements: { subscriptionId: s.id, rows: [ent(s, 3)] }, events: [] });
      expect((await store.entitlementRows(U(1))).map((e) => e.key)).toEqual(["k3"]);
      await store.commit({ entitlements: { subscriptionId: s.id, rows: [] }, events: [] });
      expect(await store.entitlementRows(U(1))).toEqual([]);
    });

    it("sweeper query: due, not expired, oldest first, limited", async () => {
      const { store, p } = await setup([1, 2, 3]);
      const mk = (n: number, userN: number, next: number | null, status: PlusSubscription["status"] = "ACTIVE") => ({
        ...sub(p, n, userN),
        status,
        nextActionAtMs: next,
      });
      await store.commit({ subscription: { value: mk(1, 1, T0 + 300), expectedVersion: null }, events: [] });
      await store.commit({ subscription: { value: mk(2, 2, T0 + 100), expectedVersion: null }, events: [] });
      await store.commit({ subscription: { value: mk(3, 3, null), expectedVersion: null }, events: [] });
      expect((await store.listDue(T0 + 50, 10)).length).toBe(0);
      expect((await store.listDue(T0 + 500, 10)).map((s) => s.id)).toEqual([U(202), U(201)]);
      expect((await store.listDue(T0 + 500, 1)).map((s) => s.id)).toEqual([U(202)]);
      expect((await store.listLiveByPlanCode("plus_monthly")).length).toBe(3);
    });

    it("signups round trip with client action and are unique by charge key", async () => {
      const { store, p } = await setup();
      const s = {
        id: U(401),
        userId: U(1),
        planId: p.id,
        chargeKey: "plus:signup:u1:k1",
        tokenRef: "tok",
        deviceId: "dev",
        amountMinor: 20_000n,
        status: "PENDING" as const,
        pspRef: null,
        clientAction: null,
        subscriptionId: null,
        createdAtMs: T0,
        updatedAtMs: T0,
      };
      await store.commit({ signup: s, events: [] });
      await store.commit({
        signup: { ...s, pspRef: "p1", clientAction: { type: "redirect", url: "https://psp.test/3ds" }, updatedAtMs: T0 + 1 },
        events: [],
      });
      const back = await store.getSignupByChargeKey("plus:signup:u1:k1");
      expect(back?.clientAction).toEqual({ type: "redirect", url: "https://psp.test/3ds" });
      expect(back?.amountMinor).toBe(20_000n);
      expect((await store.getSignup(U(401)))?.pspRef).toBe("p1");
      expect(await store.getSignupByChargeKey("nope")).toBeNull();
    });

    it("savings ledger: once per (order group, benefit), reversible, summed, ordered", async () => {
      const { store, eventTypes } = await setup();
      const row = (n: number, og: number, benefit: string, amount: bigint, at: number) => ({
        id: U(500 + n),
        userId: U(1),
        orderGroupId: U(600 + og),
        benefit,
        amountSavedMinor: amount,
        createdAtMs: at,
        reversedAtMs: null,
      });
      expect(await store.addSavings(row(1, 1, "free_delivery", 6_500n, T0 + 1), [])).toBe("added");
      expect(await store.addSavings(row(2, 1, "free_delivery", 6_500n, T0 + 2), [])).toBe("exists");
      expect(await store.addSavings(row(3, 2, "free_delivery", 4_000n, T0 + 3), [])).toBe("added");
      expect(await store.totalSavedMinor(U(1))).toBe(10_500n);
      expect((await store.listSavings(U(1), 10)).map((r) => r.id)).toEqual([U(503), U(501)]);
      expect(await store.benefitUsedSince(U(1), T0 + 3)).toBe(true);
      expect(await store.benefitUsedSince(U(1), T0 + 4)).toBe(false);
      const n = await store.reverseSavings(U(602), T0 + 10, (userId) => [
        { type: "plus.benefit_reversed", userId, orderGroupId: U(602) },
      ]);
      expect(n).toBe(1);
      expect(await store.reverseSavings(U(602), T0 + 11, () => [])).toBe(0);
      expect(await store.totalSavedMinor(U(1))).toBe(6_500n);
      expect(await store.benefitUsedSince(U(1), T0 + 3)).toBe(false);
      expect(await eventTypes()).toEqual(["plus.benefit_reversed"]);
      expect(await store.totalSavedMinor(U(2))).toBe(0n);
    });
  });
}
