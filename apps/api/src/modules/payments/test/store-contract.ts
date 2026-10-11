import { describe, expect, it } from "vitest";
import type { PaymentStore } from "../domain/ports";
import { GROUP_1, GROUP_2, SHOPPER_A, SHOPPER_B, T0, cardRecord, intentRecord, rawRecord, refundRecord } from "./fixtures";

export interface StoreWorld {
  readonly store: PaymentStore;
  ensureUser(id: string): Promise<void>;
  outboxTypes(): Promise<string[]>;
}

/** One behavioural contract, run against the in-memory and the Kysely (PGlite) stores. */
export function describePaymentStoreContract(name: string, fresh: () => Promise<StoreWorld>): void {
  describe(`PaymentStore contract: ${name}`, () => {
    const setup = async () => {
      const w = await fresh();
      await w.ensureUser(SHOPPER_A);
      await w.ensureUser(SHOPPER_B);
      return w;
    };

    it("insertIntent is unique per order group and returns the existing row", async () => {
      const w = await setup();
      const a = intentRecord({ orderGroupId: GROUP_1 });
      const first = await w.store.insertIntent(a, []);
      expect(first.kind).toBe("inserted");
      const second = await w.store.insertIntent(intentRecord({ orderGroupId: GROUP_1, amount: 999n }), []);
      expect(second.kind).toBe("exists");
      expect(second.intent.id).toBe(a.id);
      expect(second.intent.amount).toBe(125_000n);
    });

    it("mutateIntent applies a legal transition, bumps version and writes the outbox in the same step", async () => {
      const w = await setup();
      const i = intentRecord({ providerRef: "pi_1", status: "REQUIRES_ACTION" });
      await w.store.insertIntent(i, []);
      const r = await w.store.mutateIntent({
        intentId: i.id,
        decide: (cur) => ({
          patch: { status: "SUCCEEDED" },
          events: [
            {
              type: "payment.succeeded",
              intentId: cur.id,
              orderGroupId: cur.orderGroupId,
              amount: cur.amount,
              currency: cur.currency,
              provider: cur.provider,
              method: cur.method,
              providerRef: cur.providerRef,
            },
          ],
          outcome: "transition:SUCCEEDED",
        }),
      });
      expect(r.kind).toBe("applied");
      const cur = await w.store.getIntent(i.id);
      expect(cur?.status).toBe("SUCCEEDED");
      expect(cur?.version).toBe(1);
      expect(await w.outboxTypes()).toEqual(["payment.succeeded"]);
    });

    it("refuses an illegal transition and leaves state and outbox untouched", async () => {
      const w = await setup();
      const i = intentRecord({ status: "FAILED", failureCode: "declined" });
      await w.store.insertIntent(i, []);
      await expect(
        w.store.mutateIntent({
          intentId: i.id,
          decide: () => ({
            patch: { status: "SUCCEEDED" },
            events: [{ type: "payment.voided", intentId: i.id, orderGroupId: i.orderGroupId }],
            outcome: "x",
          }),
        }),
      ).rejects.toThrow();
      expect((await w.store.getIntent(i.id))?.status).toBe("FAILED");
      expect(await w.outboxTypes()).toEqual([]);
    });

    it("inbox dedup: the same message id is applied once", async () => {
      const w = await setup();
      const i = intentRecord({ status: "REQUIRES_ACTION", providerRef: "pi_2" });
      await w.store.insertIntent(i, []);
      const inbox = { consumer: "payments.webhook_received", messageId: U9(1) };
      const decide = () => ({
        patch: { status: "AUTHORIZED" as const },
        events: [],
        outcome: "transition:AUTHORIZED",
      });
      expect((await w.store.mutateIntent({ intentId: i.id, decide, inbox })).kind).toBe("applied");
      expect((await w.store.mutateIntent({ intentId: i.id, decide, inbox })).kind).toBe("duplicate");
      expect((await w.store.getIntent(i.id))?.version).toBe(1);
    });

    it("unknown intent is not_found", async () => {
      const w = await setup();
      expect((await w.store.mutateIntent({ intentId: U9(5), decide: () => null })).kind).toBe("not_found");
    });

    it("listExpirable returns only overdue CREATED and REQUIRES_ACTION intents", async () => {
      const w = await setup();
      const due = intentRecord({ expiresAtMs: T0 - 1 });
      const later = intentRecord({ expiresAtMs: T0 + 1_000_000 });
      const paid = intentRecord({ expiresAtMs: T0 - 1, status: "SUCCEEDED", providerRef: "pi_3" });
      for (const i of [due, later, paid]) await w.store.insertIntent(i, []);
      const got = await w.store.listExpirable(T0, 10);
      expect(got.map((x) => x.id)).toEqual([due.id]);
    });

    it("raw events dedup by (provider, event id) and a verified event enqueues exactly one webhook_received", async () => {
      const w = await setup();
      const r = rawRecord();
      expect(await w.store.recordRawEvent(r)).toBe("stored");
      expect(await w.store.recordRawEvent({ ...r, id: U9(9) })).toBe("duplicate");
      expect(await w.outboxTypes()).toEqual(["payment.webhook_received"]);
    });

    it("unverified events are stored, deduplicate by content and never enqueue processing", async () => {
      const w = await setup();
      const bad = rawRecord({ signatureOk: false, body: { forged: true } });
      expect(await w.store.recordRawEvent(bad)).toBe("stored");
      expect(await w.store.recordRawEvent({ ...bad, id: U9(8) })).toBe("duplicate");
      expect(await w.outboxTypes()).toEqual([]);
      expect(await w.store.listUnprocessedEventIds(10)).toEqual([]);
    });

    it("a forged event id cannot block the genuine event", async () => {
      const w = await setup();
      const forged = rawRecord({ signatureOk: false, body: { event_id: "evt_1", forged: true } });
      expect(await w.store.recordRawEvent(forged)).toBe("stored");
      expect(await w.store.recordRawEvent(rawRecord({ eventId: "evt_1" }))).toBe("stored");
    });

    it("settleRawEvent marks processed once and appends its events", async () => {
      const w = await setup();
      const r = rawRecord();
      await w.store.recordRawEvent(r);
      const ev = [
        { type: "payment.anomaly" as const, intentId: null, orderGroupId: GROUP_1, anomaly: "unknown_intent" as const, detail: "x" },
      ];
      expect(await w.store.settleRawEvent({ rawEventId: r.id, outcome: "unknown_intent", events: ev })).toBe("settled");
      expect(await w.store.settleRawEvent({ rawEventId: r.id, outcome: "again", events: ev })).toBe("duplicate");
      expect((await w.store.getRawEvent(r.id))?.processedAtMs).not.toBeNull();
      expect(await w.store.listUnprocessedEventIds(10)).toEqual([]);
      expect((await w.outboxTypes()).filter((t) => t === "payment.anomaly")).toHaveLength(1);
    });

    it("refunds: idempotent per key, never above the captured amount, settle updates the intent", async () => {
      const w = await setup();
      const i = intentRecord({ status: "SUCCEEDED", providerRef: "pi_4", amount: 100_000n });
      await w.store.insertIntent(i, []);
      const r1 = refundRecord(i.id, { idempotencyKey: "k1", amount: 30_000n });
      expect((await w.store.insertRefund(r1)).kind).toBe("inserted");
      expect((await w.store.insertRefund({ ...r1, id: U9(7) })).kind).toBe("exists");
      expect((await w.store.insertRefund(refundRecord(i.id, { idempotencyKey: "k2", amount: 80_000n }))).kind).toBe("exceeds_captured");
      const s = await w.store.settleRefund({ refundId: r1.id, outcome: "succeeded", providerRefundRef: "rf_1", failureCode: null });
      expect(s.kind).toBe("applied");
      const cur = await w.store.getIntent(i.id);
      expect(cur?.status).toBe("PARTIALLY_REFUNDED");
      expect(cur?.refundedAmount).toBe(30_000n);
      const again = await w.store.settleRefund({ refundId: r1.id, outcome: "succeeded", providerRefundRef: "rf_1", failureCode: null });
      expect(again.kind).toBe("already_settled");
      const r2 = refundRecord(i.id, { idempotencyKey: "k3", amount: 70_000n });
      expect((await w.store.insertRefund(r2)).kind).toBe("inserted");
      await w.store.settleRefund({ refundId: r2.id, outcome: "succeeded", providerRefundRef: "rf_2", failureCode: null });
      const full = await w.store.getIntent(i.id);
      expect(full?.status).toBe("REFUNDED");
      expect(full?.refundedAmount).toBe(100_000n);
      expect(await w.outboxTypes()).toEqual(["payment.refunded", "payment.refunded"]);
    });

    it("a failed refund frees its amount and emits payment.refund_failed", async () => {
      const w = await setup();
      const i = intentRecord({ status: "SUCCEEDED", providerRef: "pi_5", amount: 50_000n });
      await w.store.insertIntent(i, []);
      const r = refundRecord(i.id, { idempotencyKey: "kf", amount: 50_000n });
      await w.store.insertRefund(r);
      await w.store.settleRefund({ refundId: r.id, outcome: "failed", providerRefundRef: null, failureCode: "declined" });
      expect((await w.store.insertRefund(refundRecord(i.id, { idempotencyKey: "kf2", amount: 50_000n }))).kind).toBe("inserted");
      expect(await w.outboxTypes()).toEqual(["payment.refund_failed"]);
    });

    it("a refund on an intent that was never captured is not_refundable", async () => {
      const w = await setup();
      const i = intentRecord({ status: "REQUIRES_ACTION", providerRef: "pi_6" });
      await w.store.insertIntent(i, []);
      expect((await w.store.insertRefund(refundRecord(i.id))).kind).toBe("not_refundable");
    });

    it("findPendingRefunds returns every unreferenced pending refund of the same amount", async () => {
      const w = await setup();
      const i = intentRecord({ status: "SUCCEEDED", providerRef: "pi_7", amount: 90_000n });
      await w.store.insertIntent(i, []);
      const r = refundRecord(i.id, { amount: 12_345n, idempotencyKey: "kp" });
      await w.store.insertRefund(r);
      expect((await w.store.findPendingRefunds(i.id, 12_345n)).map((x) => x.id)).toEqual([r.id]);
      expect(await w.store.findPendingRefunds(i.id, 1n)).toEqual([]);
      const r2 = refundRecord(i.id, { amount: 12_345n, idempotencyKey: "kp2", createdAtMs: r.createdAtMs + 1 });
      await w.store.insertRefund(r2);
      expect((await w.store.findPendingRefunds(i.id, 12_345n)).map((x) => x.id)).toEqual([r.id, r2.id]);
      expect((await w.store.listPendingRefundsWithoutRef(10)).map((x) => x.id)).toEqual([r.id, r2.id]);
    });

    it("saved cards: token unique per provider, owner scoped, soft delete", async () => {
      const w = await setup();
      const c = cardRecord({ pspToken: "tok_unique_aaaaaaaa" });
      expect((await w.store.upsertSavedCard(c)).kind).toBe("inserted");
      expect((await w.store.upsertSavedCard({ ...c, id: U9(6) })).kind).toBe("exists");
      expect(await w.store.listSavedCards(SHOPPER_A)).toHaveLength(1);
      expect(await w.store.listSavedCards(SHOPPER_B)).toHaveLength(0);
      expect(await w.store.getSavedCard(c.id, SHOPPER_B)).toBeNull();
      expect(await w.store.deleteSavedCard(c.id, SHOPPER_B, T0)).toBe(false);
      expect(await w.store.getSavedCard(c.id, SHOPPER_A)).not.toBeNull();
      expect(await w.store.deleteSavedCard(c.id, SHOPPER_A, T0)).toBe(true);
      expect(await w.store.listSavedCards(SHOPPER_A)).toHaveLength(0);
      expect(await w.store.deleteSavedCard(c.id, SHOPPER_A, T0)).toBe(false);
    });

    it("keeps unrelated order groups independent", async () => {
      const w = await setup();
      await w.store.insertIntent(intentRecord({ orderGroupId: GROUP_1 }), []);
      const b = await w.store.insertIntent(intentRecord({ orderGroupId: GROUP_2 }), []);
      expect(b.kind).toBe("inserted");
    });
  });
}

const U9 = (n: number): string => `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`;
