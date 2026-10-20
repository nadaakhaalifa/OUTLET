import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { PlaceCheckout } from "../application/commit";
import { HandlePaymentWebhook } from "../application/payment-events";
import { QuoteCheckout } from "../application/quote";
import { money, type CheckoutMethod } from "../domain/bridge";
import { ADDRESS, SHOPPER, STORE_A, STORE_B, U, bagLine, createWorld, defaultBag } from "./world";

const arbBag = fc.array(
  fc.record({
    store: fc.constantFrom(STORE_A, STORE_B),
    price: fc.bigInt({ min: 100n, max: 400_000n }),
    qty: fc.integer({ min: 1, max: 3 }),
  }),
  { minLength: 1, maxLength: 5 },
);

describe("checkout money invariants (property)", () => {
  it("quote parts sum to the total, ledger entry balances, PSP clearing equals the external amount, replay is identical", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbBag,
        fc.bigInt({ min: 0n, max: 600_000n }),
        fc.boolean(),
        fc.boolean(),
        fc.constantFrom<CheckoutMethod>("card", "mobile_wallet", "fawry", "bnpl", "cod"),
        async (rows, creditBalance, plus, useCredit, method) => {
          const w = createWorld({ plus });
          const bag = defaultBag(plus);
          w.cart.set(SHOPPER, {
            ...bag,
            lines: rows.map((r, i) => bagLine({ lineId: U(900 + i), skuId: U(950 + i), storeId: r.store, price: r.price, qty: r.qty })),
          });
          rows.forEach((r, i) => w.inventory.setStock(U(950 + i), r.qty));
          if (creditBalance > 0n) {
            w.credit.setBalances(SHOPPER, [{ sub: { kind: "goodwill" } as never, balance: money(creditBalance), expiresAt: null }]);
          }
          const q = await new QuoteCheckout(w.ctx).execute({ userId: SHOPPER, deviceId: null, method, addressId: ADDRESS, codes: [], useStoreCredit: useCredit, priceLock: null });
          if (q.kind !== "ok") return; // gates (e.g. COD) are covered elsewhere
          const again = await new QuoteCheckout(w.ctx).execute({ userId: SHOPPER, deviceId: null, method, addressId: ADDRESS, codes: [], useStoreCredit: useCredit, priceLock: null });
          if (again.kind !== "ok") throw new Error("replay differs");
          expect(again.quote.total.amount).toBe(q.quote.total.amount);
          expect(again.cartHash).toBe(q.cartHash);

          const { quote } = q;
          expect(quote.stores.reduce((a, s) => a + s.total.amount, 0n)).toBe(quote.total.amount);
          expect(quote.subtotal.amount - quote.discount.amount + quote.shipping.amount).toBe(quote.total.amount);
          expect(quote.tender.storeCreditTotal.amount + quote.tender.externalDue.amount).toBe(quote.total.amount);
          expect(quote.lines.reduce((a, l) => a + l.discount.amount, 0n)).toBe(quote.discount.amount);

          const commit = new PlaceCheckout(w.ctx);
          const r = await commit.execute({ userId: SHOPPER, deviceId: "d", idempotencyKey: "prop", method, addressId: ADDRESS, codes: [], useStoreCredit: useCredit, priceLock: null, expectedTotal: quote.total.amount, appAttestAssertion: null });
          if (r.kind !== "ok") return;
          const replay = await commit.execute({ userId: SHOPPER, deviceId: "d", idempotencyKey: "prop", method, addressId: ADDRESS, codes: [], useStoreCredit: useCredit, priceLock: null, expectedTotal: quote.total.amount, appAttestAssertion: null });
          expect(replay.kind === "ok" && replay.record.orderGroupId).toBe(r.record.orderGroupId);
          const g = r.record.orderGroupId;
          if (r.record.facts.status !== "PLACED") {
            w.provider.markSucceeded(`pi_${g}`);
            const e = w.provider.webhook({ eventId: "p1", intentId: `pi_${g}`, orderGroupId: g, kind: "succeeded", amount: quote.tender.externalDue.amount });
            await new HandlePaymentWebhook(w.ctx).execute({ provider: "fake-psp", rawBody: e.rawBody, headers: e.headers });
          }
          expect((await w.repo.get(g))?.facts.status).toBe("PLACED");
          expect(w.ledger.trialBalance()).toBe(0n);
          if (method !== "cod") {
            const clearing = method === "bnpl" ? "bnpl_clearing:fake-psp" : "psp_clearing:fake-psp";
            expect(w.ledger.balance(clearing)).toBe(quote.tender.externalDue.amount);
          }
        },
      ),
      { numRuns: 60 },
    );
  });
});
