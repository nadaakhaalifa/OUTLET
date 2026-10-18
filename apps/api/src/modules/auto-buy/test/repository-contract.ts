import { beforeEach, describe, expect, it } from "vitest";
import type { AttemptRecord, AutoBuyStore, MandateRecord } from "../domain/ports";

export const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const SKU = (n: number): string => `00000000-0000-4000-8000-${String(9000 + n).padStart(12, "0")}`;
export const ID = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;
export const T0 = 1_800_000_000_000;
export const DAY = 86_400_000;
export const SHA = "a".repeat(64);

export const mandateRec = (n: number, over: Partial<MandateRecord> = {}): MandateRecord => ({
  id: ID(n),
  userId: U(1),
  skuId: SKU(1),
  sizeLabel: "M",
  targetPrice: 64_900n,
  maxPrice: 70_000n,
  mode: "notify_confirm",
  pspTokenRef: null,
  status: "ARMED",
  closedReason: null,
  expiresAtMs: T0 + 30 * DAY,
  mandateVersion: 1,
  mandateLocale: "en",
  termsSha256: SHA,
  acceptedAtMs: T0,
  acceptedDeviceId: "device-1",
  createdAtMs: T0,
  updatedAtMs: T0,
  ...over,
});

export const attemptRec = (n: number, mandateId: string, over: Partial<AttemptRecord> = {}): AttemptRecord => ({
  id: ID(500 + n),
  mandateId,
  userId: U(1),
  priceEventId: `pe-${n}`,
  mode: "notify_confirm",
  state: "TRIGGERED",
  triggerPrice: 64_000n,
  chargePrice: null,
  noticeSentAtMs: null,
  cancelDeadlineMs: null,
  chargeStartedAtMs: null,
  reservationRef: null,
  orderGroupId: null,
  failureReason: null,
  createdAtMs: T0,
  updatedAtMs: T0,
  ...over,
});

export interface StoreWorld {
  readonly store: AutoBuyStore;
  readonly ensureUser: (id: string) => Promise<void>;
  /** Event types emitted since the world was created. */
  readonly eventTypes: () => Promise<readonly string[]>;
}

const TEXT = { version: 1, locale: "en" as const, body: "I authorise the purchase of {{item}} for {{target}}.", bodySha256: SHA };

/** Repository contract: the in-memory and Postgres stores must be indistinguishable to the use cases. */
export function describeAutoBuyStoreContract(name: string, fresh: () => Promise<StoreWorld>): void {
  describe(`AutoBuyStore contract: ${name}`, () => {
    let w: StoreWorld;
    beforeEach(async () => {
      w = await fresh();
      await w.ensureUser(U(1));
      await w.ensureUser(U(2));
      await w.store.run(async (tx) => {
        await tx.putText(TEXT);
      });
    });

    it("inserts a mandate, and refuses a second ARMED rule for the same user and sku", async () => {
      const r = await w.store.run(async (tx) => [await tx.insertMandate(mandateRec(1)), await tx.insertMandate(mandateRec(2))]);
      expect(r).toEqual(["inserted", "duplicate_active"]);
      // another user may arm the same sku
      expect(await w.store.run((tx) => tx.insertMandate(mandateRec(3, { userId: U(2) })))).toBe("inserted");
    });

    it("allows a new rule once the previous one is closed", async () => {
      await w.store.run(async (tx) => {
        await tx.insertMandate(mandateRec(1));
        await tx.closeMandate(ID(1), "DISARMED", "user_cancelled", T0 + 1);
      });
      expect(await w.store.run((tx) => tx.insertMandate(mandateRec(2)))).toBe("inserted");
    });

    it("a closed mandate cannot be reopened or closed twice", async () => {
      await w.store.run(async (tx) => {
        await tx.insertMandate(mandateRec(1));
        await tx.closeMandate(ID(1), "EXPIRED", "expired", T0 + 1);
      });
      await expect(w.store.run((tx) => tx.closeMandate(ID(1), "DISARMED", "again", T0 + 2))).rejects.toThrow();
    });

    it("owner scoped lookups: a foreign id is null, exactly like a missing one", async () => {
      await w.store.run((tx) => tx.insertMandate(mandateRec(1)));
      await w.store.run(async (tx) => {
        expect((await tx.getOwnedMandateForUpdate(U(1), ID(1)))?.id).toBe(ID(1));
        expect(await tx.getOwnedMandateForUpdate(U(2), ID(1))).toBeNull();
        expect(await tx.getOwnedMandateForUpdate(U(1), ID(99))).toBeNull();
      });
    });

    it("the unique (mandate, price event) key makes a redelivery a no-op", async () => {
      await w.store.run((tx) => tx.insertMandate(mandateRec(1)));
      const r = await w.store.run(async (tx) => [
        await tx.insertAttempt(attemptRec(1, ID(1))),
        await tx.insertAttempt({ ...attemptRec(1, ID(1)), id: ID(777) }),
        await tx.insertAttempt(attemptRec(2, ID(1))),
      ]);
      expect(r).toEqual(["inserted", "exists", "inserted"]);
    });

    it("a failed transaction leaves nothing behind, including outbox events", async () => {
      await expect(
        w.store.run(async (tx) => {
          await tx.insertMandate(mandateRec(1));
          await tx.emit([{ type: "auto_buy.armed", userId: U(1), mandateId: ID(1), mode: "notify_confirm" }]);
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(await w.store.listForUser(U(1), 10)).toHaveLength(0);
      expect(await w.eventTypes()).toEqual([]);
    });

    it("emits events in the same transaction as the state change", async () => {
      await w.store.run(async (tx) => {
        await tx.insertMandate(mandateRec(1));
        await tx.emit([{ type: "auto_buy.armed", userId: U(1), mandateId: ID(1), mode: "notify_confirm" }]);
      });
      expect(await w.eventTypes()).toEqual(["auto_buy.armed"]);
    });

    it("armedForSku returns rules whose target the price has reached, and only ARMED ones", async () => {
      await w.store.run(async (tx) => {
        await tx.insertMandate(mandateRec(1, { targetPrice: 64_900n }));
        await tx.insertMandate(mandateRec(2, { userId: U(2), targetPrice: 50_000n, maxPrice: 60_000n }));
        await tx.insertMandate(mandateRec(3, { skuId: SKU(2), targetPrice: 99_000n, maxPrice: 99_000n }));
      });
      expect((await w.store.armedForSku(SKU(1), 64_000n, 10)).map((m) => m.id)).toEqual([ID(1)]);
      expect((await w.store.armedForSku(SKU(1), 64_900n, 10)).map((m) => m.id)).toEqual([ID(1)]);
      expect(await w.store.armedForSku(SKU(1), 64_901n, 10)).toHaveLength(0);
      expect((await w.store.armedForSku(SKU(1), 40_000n, 10)).map((m) => m.id).sort()).toEqual([ID(1), ID(2)]);
      await w.store.run((tx) => tx.closeMandate(ID(1), "DISARMED", "user_cancelled", T0 + 1));
      expect((await w.store.armedForSku(SKU(1), 40_000n, 10)).map((m) => m.id)).toEqual([ID(2)]);
    });

    it("filters armed rules by user and by PSP token reference", async () => {
      await w.store.run(async (tx) => {
        await tx.insertMandate(mandateRec(1, { mode: "unattended", pspTokenRef: "tok_card_aaaaaaaa" }));
        await tx.insertMandate(mandateRec(2, { skuId: SKU(2), mode: "unattended", pspTokenRef: "tok_card_bbbbbbbb" }));
      });
      expect((await w.store.armedForUser(U(1), "tok_card_aaaaaaaa")).map((m) => m.id)).toEqual([ID(1)]);
      expect(await w.store.armedForUser(U(1), null)).toHaveLength(2);
      expect(await w.store.armedForUser(U(2), null)).toHaveLength(0);
    });

    it("lists a user's rules newest first with the latest attempt, and never another user's", async () => {
      await w.store.run(async (tx) => {
        await tx.insertMandate(mandateRec(1, { createdAtMs: T0 }));
        await tx.insertMandate(mandateRec(2, { skuId: SKU(2), createdAtMs: T0 + 10 }));
        await tx.insertMandate(mandateRec(3, { userId: U(2), createdAtMs: T0 + 20 }));
        await tx.insertAttempt(attemptRec(1, ID(2), { createdAtMs: T0 + 100 }));
        await tx.insertAttempt(attemptRec(2, ID(2), { createdAtMs: T0 + 200 }));
      });
      const l = await w.store.listForUser(U(1), 10);
      expect(l.map((x) => x.mandate.id)).toEqual([ID(2), ID(1)]);
      expect(l[0]?.latest?.priceEventId).toBe("pe-2");
      expect(l[1]?.latest).toBeNull();
      expect(await w.store.listForUser(U(1), 1)).toHaveLength(1);
    });

    it("worker queries: due, stale, stuck, unresolved, abandoned and expired", async () => {
      const now = T0 + 10 * 60_000;
      await w.store.run(async (tx) => {
        await tx.insertMandate(mandateRec(1, { mode: "unattended", pspTokenRef: "tok_card_aaaaaaaa", expiresAtMs: T0 + 1000 }));
        await tx.insertMandate(mandateRec(2, { skuId: SKU(2) }));
        const m = ID(1);
        await tx.insertAttempt(attemptRec(1, m, { mode: "unattended", state: "NOTIFIED", noticeSentAtMs: T0, cancelDeadlineMs: T0 + 15 * 60_000 }));
        await tx.insertAttempt(attemptRec(2, m, { mode: "unattended", state: "NOTIFIED", noticeSentAtMs: T0 - DAY, cancelDeadlineMs: T0 - DAY + 15 * 60_000 }));
        await tx.insertAttempt(attemptRec(3, m, { state: "TRIGGERED", createdAtMs: T0 - 1000 }));
        await tx.insertAttempt(attemptRec(4, m, { mode: "unattended", state: "CHARGING", noticeSentAtMs: T0 - DAY, cancelDeadlineMs: T0 - DAY + 15 * 60_000, chargeStartedAtMs: T0 - 60_000 }));
        await tx.insertAttempt(attemptRec(5, m, { mode: "unattended", state: "REQUIRES_USER_ACTION", noticeSentAtMs: T0 - DAY, cancelDeadlineMs: T0 - DAY + 15 * 60_000, updatedAtMs: T0 - 60_000 }));
      });
      const ids = (xs: readonly { id: string }[]) => xs.map((x) => x.id).sort();
      expect(ids(await w.store.dueAttempts(T0 + 16 * 60_000, 10))).toEqual([ID(501), ID(502)]);
      expect(ids(await w.store.dueAttempts(T0 + 14 * 60_000, 10))).toEqual([ID(502)]);
      expect(ids(await w.store.staleNotices(T0 - DAY + 16 * 60_000, 10))).toEqual([ID(502)]);
      expect(ids(await w.store.stuckTriggered(now, 10))).toEqual([ID(503)]);
      expect(ids(await w.store.unresolvedCharges(now, 10))).toEqual([ID(504)]);
      expect(ids(await w.store.abandonedSca(now, 10))).toEqual([ID(505)]);
      expect(ids(await w.store.expiredMandates(now, 10))).toEqual([ID(1)]);
    });

    it("tracks the last attempt time and the open attempts of a rule", async () => {
      await w.store.run(async (tx) => {
        await tx.insertMandate(mandateRec(1));
        expect(await tx.lastAttemptAt(ID(1))).toBeNull();
        await tx.insertAttempt(attemptRec(1, ID(1), { createdAtMs: T0 + 5 }));
        await tx.insertAttempt(attemptRec(2, ID(1), { createdAtMs: T0 + 9, state: "SKIPPED", failureReason: "out_of_stock" }));
        // B-6: a skipped or never-notified attempt does not start the cooldown.
        expect(await tx.lastAttemptAt(ID(1))).toBeNull();
        await tx.insertAttempt(
          attemptRec(3, ID(1), {
            createdAtMs: T0 + 7,
            state: "NOTIFIED",
            mode: "unattended",
            noticeSentAtMs: T0 + 7,
            cancelDeadlineMs: T0 + 7 + 15 * 60_000,
          }),
        );
        expect(await tx.lastAttemptAt(ID(1))).toBe(T0 + 7);
        expect((await tx.openAttemptsOfMandate(ID(1))).map((a) => a.state).sort()).toEqual(["NOTIFIED", "TRIGGERED"]);
      });
    });

    it("B-1: MANUAL_REVIEW attempts are open, listed for re-lookup, and the per-user lock is callable", async () => {
      await w.store.run(async (tx) => {
        await tx.lockUser(U(1));
        await tx.insertMandate(mandateRec(1));
        await tx.insertAttempt(
          attemptRec(1, ID(1), {
            state: "MANUAL_REVIEW",
            mode: "unattended",
            noticeSentAtMs: T0,
            cancelDeadlineMs: T0 + 15 * 60_000,
            chargeStartedAtMs: T0 + 16 * 60_000,
            chargePrice: 64_000n,
            failureReason: "unresolved_not_found",
          }),
        );
        expect((await tx.openAttemptsOfMandate(ID(1))).map((a) => a.state)).toEqual(["MANUAL_REVIEW"]);
      });
      expect((await w.store.manualReview(10)).map((a) => a.id)).toEqual([ID(501)]);
    });

    it("updates an attempt and round trips every field", async () => {
      await w.store.run((tx) => tx.insertMandate(mandateRec(1)));
      const a = attemptRec(1, ID(1));
      await w.store.run((tx) => tx.insertAttempt(a));
      const next: AttemptRecord = {
        ...a,
        mode: "unattended",
        state: "PURCHASED",
        chargePrice: 64_000n,
        noticeSentAtMs: T0 + 1000,
        cancelDeadlineMs: T0 + 1000 + 15 * 60_000,
        chargeStartedAtMs: T0 + 2_000_000,
        reservationRef: a.id,
        orderGroupId: ID(4242),
        updatedAtMs: T0 + 3_000_000,
      };
      // mode is fixed at insert; only mutable columns are written by updateAttempt
      await w.store.run((tx) => tx.updateAttempt(next));
      const got = await w.store.run((tx) => tx.getAttemptForUpdate(a.id));
      expect(got).toEqual({ ...next, mode: "notify_confirm" });
    });
  });
}
