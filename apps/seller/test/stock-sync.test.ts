import { describe, expect, it } from "vitest";
import { DraftSaver } from "../src/lib/draft-saver";
import { EMPTY_STATE, quantityOf } from "../src/lib/wizard-model";
import { fakeApi, product } from "./fake-api";

const SKU = "33333333-3333-4333-8333-333333333333";
const withPrice = (quantity: string) => ({ ...EMPTY_STATE, categoryId: "00000000-0000-4000-8000-0000000c0011", price: "100", quantity });
const listed = product({ skus: [{ id: SKU, price: { amount_minor: "10000", currency: "EGP" } }] });
const hooks = () => ({ status: () => undefined, reasons: () => undefined, failure: () => undefined, conflict: () => undefined, draftCreated: () => undefined });

describe("wizard quantity reaches the inventory", () => {
  it("quantityOf accepts whole units only", () => {
    expect([quantityOf({ quantity: "12" }), quantityOf({ quantity: " 7 " }), quantityOf({ quantity: "" }), quantityOf({ quantity: "1.5" }), quantityOf({ quantity: "-3" }), quantityOf({ quantity: "1234567" })]).toEqual([12, 7, null, null, null, null]);
  });

  it("sends the difference once, then nothing while the number is unchanged, then the next difference", async () => {
    const f = fakeApi({}, listed);
    const saver = new DraftSaver(f.api, hooks(), { debounceMs: 0 });
    saver.update(withPrice("10"), []);
    await saver.flush();
    expect(f.api.adjustStock).toHaveBeenCalledTimes(1);
    expect(f.adjustments()[0]).toMatchObject({ sku_id: SKU, delta: 10, reason: "received", expected_version: 0 });
    saver.update({ ...withPrice("10"), price: "101" }, []);
    await saver.flush();
    expect(f.api.adjustStock).toHaveBeenCalledTimes(1);
    saver.update(withPrice("4"), []);
    await saver.flush();
    expect(f.adjustments()[1]).toMatchObject({ delta: -6, reason: "correction", expected_version: 1 });
    expect(f.stock()?.onHand).toBe(4);
  });

  it("a blank or invalid quantity sends nothing, and an existing level only gets the difference", async () => {
    const f = fakeApi({}, listed);
    const saver = new DraftSaver(f.api, hooks(), { debounceMs: 0 });
    saver.update(withPrice(""), []);
    await saver.flush();
    saver.update(withPrice("abc"), []);
    await saver.flush();
    expect(f.api.adjustStock).not.toHaveBeenCalled();
    await f.api.adjustStock({ sku_id: SKU, delta: 8, reason: "received" });
    f.api.adjustStock.mockClear();
    saver.update(withPrice("8"), []);
    await saver.flush();
    expect(f.api.adjustStock).not.toHaveBeenCalled();
  });
});
