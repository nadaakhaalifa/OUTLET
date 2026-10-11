import { describe, expect, it } from "vitest";
import { initialFacts, money } from "../domain/bridge";
import type { OutboxDraft, SagaRecord, SagaRepository } from "../domain/ports";
import { T0, U } from "./world";

export interface RepoKit {
  readonly repo: SagaRepository;
  ensureUser(id: string): Promise<void>;
  outboxTypes(): Promise<readonly string[]>;
}

const USER_A = U(1);
const USER_B = U(2);

export function sagaRecord(over: Partial<SagaRecord> & { orderGroupId: string }): SagaRecord {
  const total = money(100_000n);
  return {
    orderGroupId: over.orderGroupId,
    userId: over.userId ?? USER_A,
    idempotencyKey: over.idempotencyKey ?? `key-${over.orderGroupId}`,
    requestHash: over.requestHash ?? "h1",
    cartHash: over.cartHash ?? `cart-${over.orderGroupId}`,
    facts: over.facts ?? initialFacts({ method: "card", creditAmount: 0n, externalDue: 100_000n, codNeedsConfirmation: false }),
    stored: over.stored ?? {
      quote: {
        method: "card",
        lines: [
          {
            lineId: U(601),
            skuId: U(501),
            productId: U(800),
            storeId: U(300),
            qty: 1,
            unitPrice: total,
            discount: money(0n),
            vat: money(12_281n),
          },
        ],
        stores: [
          {
            storeId: U(300),
            merchandise: total,
            platformFundedDiscount: money(0n),
            sellerFundedDiscount: money(0n),
            deliveryFee: money(0n),
            shipping: money(0n),
            freeDeliveryReason: "none",
            vat: money(12_281n),
            total,
          },
        ],
        subtotal: total,
        discount: money(0n),
        shipping: money(0n),
        vat: money(12_281n),
        total,
        tender: { storeCredit: [], storeCreditTotal: money(0n), externalDue: total },
        vatBps: 1_400n,
      },
      lines: [
        {
          lineId: U(601),
          skuId: U(501),
          productId: U(800),
          storeId: U(300),
          qty: 1,
          unitPrice: total,
          discount: money(0n),
          vat: money(12_281n),
          title: { ar: "فستان", en: "Dress" },
        },
      ],
      commissionBps: { [U(300)]: 1_500 },
      buyer: { firstName: "Mona", phoneRelay: null, governorateCode: "EG-C" },
      addressId: null,
    },
    provider: over.provider ?? null,
    clientAction: over.clientAction ?? null,
    version: over.version ?? 0,
    attempts: over.attempts ?? 0,
    nextWakeAtMs: over.nextWakeAtMs === undefined ? T0 : over.nextWakeAtMs,
    lastError: over.lastError ?? null,
    stuck: over.stuck ?? false,
    createdAtMs: over.createdAtMs ?? T0,
    updatedAtMs: over.updatedAtMs ?? T0,
  };
}

const event = (n: number, aggregateId: string, type = "order_group.paid"): OutboxDraft => ({
  id: U(7000 + n),
  type,
  aggregateId,
  occurredAtMs: T0,
  payload: { user_id: USER_A, total: "100000" },
});

/** One behavioural contract, run against every SagaRepository adapter. */
export function describeSagaRepositoryContract(name: string, fresh: () => Promise<RepoKit>): void {
  describe(`SagaRepository contract: ${name}`, () => {
    it("creates, reads back identically (bigint facts and money survive), and refuses duplicates", async () => {
      const k = await fresh();
      await k.ensureUser(USER_A);
      const rec = sagaRecord({ orderGroupId: U(100), clientAction: { type: "redirect", url: "https://pay.example.invalid/x" } });
      expect(await k.repo.create(rec, [])).toEqual({ kind: "created" });
      const got = await k.repo.get(U(100));
      expect(got?.facts).toEqual(rec.facts);
      expect(got?.stored).toEqual(rec.stored);
      expect(got?.clientAction).toEqual(rec.clientAction);
      expect(got?.nextWakeAtMs).toBe(T0);
      expect((await k.repo.findByKey(USER_A, rec.idempotencyKey))?.orderGroupId).toBe(U(100));

      const sameKey = await k.repo.create(sagaRecord({ orderGroupId: U(101), idempotencyKey: rec.idempotencyKey }), []);
      expect(sameKey.kind).toBe("duplicate_key");
      const sameCart = await k.repo.create(sagaRecord({ orderGroupId: U(102), cartHash: rec.cartHash }), []);
      expect(sameCart.kind).toBe("duplicate_cart");
      expect(await k.repo.get(U(101))).toBeNull();
      expect(await k.repo.get(U(102))).toBeNull();
    });

    it("a finished saga no longer blocks the same bag (live-cart uniqueness only)", async () => {
      const k = await fresh();
      await k.ensureUser(USER_A);
      const a = sagaRecord({ orderGroupId: U(110), cartHash: "same" });
      await k.repo.create(a, []);
      const done: SagaRecord = { ...a, facts: { ...a.facts, status: "PLACED" }, version: 1 };
      expect(await k.repo.save(done, 0, [])).toBe(true);
      expect((await k.repo.create(sagaRecord({ orderGroupId: U(111), cartHash: "same" }), [])).kind).toBe("created");
    });

    it("owner-scoped read: another user's saga is null (BOLA)", async () => {
      const k = await fresh();
      await k.ensureUser(USER_A);
      await k.ensureUser(USER_B);
      await k.repo.create(sagaRecord({ orderGroupId: U(120) }), []);
      expect((await k.repo.getForUser(U(120), USER_A))?.orderGroupId).toBe(U(120));
      expect(await k.repo.getForUser(U(120), USER_B)).toBeNull();
      expect(await k.repo.getForUser("not-a-uuid", USER_A)).toBeNull();
    });

    it("save is compare-and-swap on version; losers write nothing, winners write events in the same step", async () => {
      const k = await fresh();
      await k.ensureUser(USER_A);
      const rec = sagaRecord({ orderGroupId: U(130) });
      await k.repo.create(rec, []);
      const v1: SagaRecord = { ...rec, facts: { ...rec.facts, status: "RESERVE_INVENTORY" }, version: 1, attempts: 2, lastError: "x" };
      expect(await k.repo.save(v1, 0, [event(1, U(130))])).toBe(true);
      const stale: SagaRecord = { ...rec, facts: { ...rec.facts, status: "FAILED" }, version: 1 };
      expect(await k.repo.save(stale, 0, [event(2, U(130), "order_group.failed")])).toBe(false);
      const got = await k.repo.get(U(130));
      expect(got?.facts.status).toBe("RESERVE_INVENTORY");
      expect(got?.version).toBe(1);
      expect(got?.attempts).toBe(2);
      expect(await k.outboxTypes()).toEqual(["order_group.paid"]);
    });

    it("due returns only live, unparked sagas whose wake time has passed, oldest first", async () => {
      const k = await fresh();
      await k.ensureUser(USER_A);
      await k.repo.create(sagaRecord({ orderGroupId: U(140), nextWakeAtMs: T0 + 2_000 }), []);
      await k.repo.create(sagaRecord({ orderGroupId: U(141), nextWakeAtMs: T0 + 1_000 }), []);
      await k.repo.create(sagaRecord({ orderGroupId: U(142), nextWakeAtMs: T0 + 90_000 }), []);
      await k.repo.create(sagaRecord({ orderGroupId: U(143), nextWakeAtMs: null }), []);
      await k.repo.create(sagaRecord({ orderGroupId: U(144), nextWakeAtMs: T0, stuck: true }), []);
      const placed = sagaRecord({ orderGroupId: U(145), nextWakeAtMs: T0 });
      await k.repo.create({ ...placed, facts: { ...placed.facts, status: "PLACED" } }, []);
      const due = await k.repo.due(T0 + 5_000, 10);
      expect(due.map((d) => d.orderGroupId)).toEqual([U(141), U(140)]);
      expect((await k.repo.due(T0 + 5_000, 1)).length).toBe(1);
    });

    it("payment events dedupe on (provider, event id) and record applied", async () => {
      const k = await fresh();
      await k.ensureUser(USER_A);
      await k.repo.create(sagaRecord({ orderGroupId: U(150) }), []);
      const e = {
        id: U(8001),
        provider: "fake-psp",
        eventId: "evt-1",
        orderGroupId: U(150),
        intentId: "pi_1",
        kind: "succeeded" as const,
        amount: 100_000n,
        signatureOk: true,
        rejectReason: null,
        body: '{"raw":true}',
        receivedAtMs: T0,
      };
      expect(await k.repo.recordPaymentEvent(e)).toBe("new");
      expect(await k.repo.recordPaymentEvent({ ...e, id: U(8002) })).toBe("duplicate");
      expect(await k.repo.recordPaymentEvent({ ...e, id: U(8003), provider: "other-psp" })).toBe("new");
      await k.repo.markPaymentEventApplied("fake-psp", "evt-1", T0 + 1);
      await k.repo.markPaymentEventApplied("fake-psp", "evt-1", T0 + 2);
    });
  });
}
