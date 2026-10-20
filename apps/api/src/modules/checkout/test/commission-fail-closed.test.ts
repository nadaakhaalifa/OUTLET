import { describe, expect, it } from "vitest";
import { QuoteCheckout } from "../application/quote";
import { InvalidCheckoutError } from "../domain/bridge";
import { StoredSchema } from "../adapters/serde";
import { ADDRESS, SHOPPER, STORE_A, createWorld, defaultBag } from "./world";

describe("F-4 commission fails closed", () => {
  it("a store with no commission terms stops the quote with InvalidCheckoutError", async () => {
    const w = createWorld();
    const bag = defaultBag();
    const stores = new Map(bag.stores);
    const a = stores.get(STORE_A);
    if (a === undefined) throw new Error("fixture");
    stores.set(STORE_A, { ...a, commissionBps: undefined as unknown as number });
    w.cart.set(SHOPPER, { ...bag, stores });
    await expect(
      new QuoteCheckout(w.ctx).execute({ userId: SHOPPER, deviceId: null, method: "card", addressId: ADDRESS, codes: [], useStoreCredit: false, priceLock: null }),
    ).rejects.toBeInstanceOf(InvalidCheckoutError);
  });

  it("a persisted commission outside 0..10000 is refused by the stored-quote schema", () => {
    const base = {
      quote: {},
      lines: [],
      buyer: { firstName: null, phoneRelay: null, governorateCode: "C" },
      addressId: null,
    };
    for (const bps of [-1, 10_001]) {
      expect(StoredSchema.safeParse({ ...base, commissionBps: { s: bps } }).success).toBe(false);
    }
  });
});
