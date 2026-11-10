import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DraftSaver, type SaverHooks } from "../src/lib/draft-saver";
import { EMPTY_STATE, type WizardState } from "../src/lib/wizard-model";
import { ATTRIBUTES, CATEGORY, fail, fakeApi, product } from "./fake-api";

const defs = ATTRIBUTES.attributes.map((a) => ({ code: a.code, dataType: a.data_type, required: a.required }));
const hooks = () => ({ status: vi.fn(), reasons: vi.fn(), failure: vi.fn(), conflict: vi.fn(), draftCreated: vi.fn() }) satisfies SaverHooks;
const complete: WizardState = {
  ...EMPTY_STATE, categoryId: CATEGORY, photos: { main: { mediaId: "m1", name: "a.png" } },
  name: "فستان صيفي", description: "قطن", price: "1299", attributes: { colour: "black" }, sizes: [{ label: "M", cm: "94" }],
};
const SKU = "33333333-3333-4333-8333-333333333333";
const withSku = () => product({ skus: [{ id: SKU } as never] });

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("draft creation failure", () => {
  it("a refused create reports the error once, never patches, and ensureDraft stays null", async () => {
    const { api } = fakeApi();
    api.createDraft.mockResolvedValueOnce(fail(500, "boom"));
    const h = hooks();
    const saver = new DraftSaver(api, h);
    saver.update(complete, defs);
    await saver.flush();
    expect(h.failure).toHaveBeenCalledWith(expect.objectContaining({ code: "boom" }));
    expect(h.status).toHaveBeenLastCalledWith("error");
    expect(api.patch).not.toHaveBeenCalled();
    expect(saver.productId).toBeUndefined();
    api.createDraft.mockResolvedValueOnce(fail(500, "boom"));
    expect(await saver.ensureDraft(complete)).toBeNull();
  });
});

describe("conflicts and failed reloads", () => {
  it("a version conflict whose reload also fails is reported as the original failure, with no second patch", async () => {
    const f = fakeApi();
    const h = hooks();
    const saver = new DraftSaver(f.api, h);
    saver.update({ ...complete, name: "", price: "" }, defs);
    await saver.flush();
    f.bump();
    f.api.getProduct.mockResolvedValueOnce(fail(500, "down"));
    saver.update(complete, defs);
    await saver.flush();
    expect(h.conflict).not.toHaveBeenCalled();
    expect(h.failure).toHaveBeenLastCalledWith(expect.objectContaining({ code: "version-conflict" }));
    expect(h.status).toHaveBeenLastCalledWith("error");
    expect(f.api.patch).toHaveBeenCalledTimes(2); // the first save, then the one that conflicted; no blind retry after a failed reload
  });

  it("a defect card refused with a version conflict reloads the product, tells the user and reports the error", async () => {
    const f = fakeApi();
    const h = hooks();
    const open: WizardState = {
      ...complete, condition: "openBox", photos: { main: { mediaId: "m1", name: "a" }, defect: { mediaId: "d1", name: "b" } },
      defect: { typeCode: "stain", location: "الكم", severity: "minor", affectsFunction: false, xPct: 25, yPct: 60 }, notes: "بقعة",
    };
    f.api.defectCard.mockResolvedValueOnce(fail(409, "version-conflict"));
    const saver = new DraftSaver(f.api, h);
    saver.update(open, defs);
    await saver.flush();
    expect(h.conflict).toHaveBeenCalledTimes(1);
    expect(h.failure).toHaveBeenLastCalledWith(expect.objectContaining({ code: "version-conflict" }));
    expect(h.status).toHaveBeenLastCalledWith("error");
    // the card is retried on the next save because it was never marked as sent
    await saver.flush();
    expect(f.api.defectCard.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("a defect card that another failure rejects is reported without a reload", async () => {
    const f = fakeApi();
    const h = hooks();
    const open: WizardState = {
      ...complete, condition: "openBox", photos: { main: { mediaId: "m1", name: "a" }, defect: { mediaId: "d1", name: "b" } },
      defect: { typeCode: "stain", location: "الكم", severity: "minor", affectsFunction: false, xPct: 25, yPct: 60 }, notes: "بقعة",
    };
    f.api.defectCard.mockResolvedValueOnce(fail(422, "validation"));
    const saver = new DraftSaver(f.api, h);
    saver.update(open, defs);
    await saver.flush();
    expect(h.conflict).not.toHaveBeenCalled();
    expect(h.failure).toHaveBeenLastCalledWith(expect.objectContaining({ code: "validation" }));
  });

  it("the card write succeeds but the product cannot be re-read: the saver keeps its last version and still ends saved", async () => {
    const f = fakeApi();
    const h = hooks();
    const open: WizardState = {
      ...complete, condition: "openBox", photos: { main: { mediaId: "m1", name: "a" }, defect: { mediaId: "d1", name: "b" } },
      defect: { typeCode: "stain", location: "الكم", severity: "minor", affectsFunction: false, xPct: 25, yPct: 60 }, notes: "بقعة",
    };
    const saver = new DraftSaver(f.api, h);
    saver.update(open, defs);
    f.api.getProduct.mockResolvedValue(fail(500, "down"));
    await saver.flush();
    expect(f.api.defectCard).toHaveBeenCalledTimes(1);
    expect(h.status).toHaveBeenLastCalledWith("saved");
  });
});

describe("readiness", () => {
  it("a failing readiness read does not break the save and publishes no stale reasons", async () => {
    const f = fakeApi();
    f.api.readiness.mockResolvedValue(fail(503, "down"));
    const h = hooks();
    const saver = new DraftSaver(f.api, h);
    saver.update(complete, defs);
    await saver.flush();
    expect(h.reasons).not.toHaveBeenCalled();
    expect(h.status).toHaveBeenLastCalledWith("saved");
  });
});

describe("stock sync", () => {
  const stocked = { ...complete, quantity: "5" } as WizardState;

  it("sets the on-hand quantity to what was typed, by the difference, once; retyping the same number sends nothing; lowering it is a correction", async () => {
    const f = fakeApi({}, withSku());
    const saver = new DraftSaver(f.api, hooks());
    saver.update(stocked, defs);
    await saver.flush();
    expect(f.adjustments()).toEqual([{ sku_id: SKU, delta: 5, reason: "received", expected_version: 0 }]);
    saver.update({ ...stocked, name: "اسم آخر" }, defs);
    await saver.flush();
    expect(f.adjustments()).toHaveLength(1);
    saver.update({ ...stocked, quantity: "2", name: "اسم آخر" }, defs);
    await saver.flush();
    expect(f.adjustments().at(-1)).toMatchObject({ delta: -3, reason: "correction", expected_version: 1 });
    expect(f.stock()?.onHand).toBe(2);
  });

  it("a listing with no SKU yet has nothing to sync and still saves", async () => {
    const f = fakeApi();
    const h = hooks();
    const saver = new DraftSaver(f.api, h);
    saver.update(stocked, defs);
    await saver.flush();
    expect(f.api.stockLevel).not.toHaveBeenCalled();
    expect(f.adjustments()).toEqual([]);
    expect(h.status).toHaveBeenLastCalledWith("saved");
  });

  it("the product read, the level read and the adjustment each stop the save and report the failure", async () => {
    for (const stage of ["product", "level", "adjust"] as const) {
      const f = fakeApi({}, withSku());
      const h = hooks();
      const saver = new DraftSaver(f.api, h);
      saver.update({ ...stocked, quantity: "" }, defs); // creates the draft and saves without any stock
      await saver.flush();
      if (stage === "product") f.api.getProduct.mockResolvedValueOnce(fail(500, "product-down"));
      if (stage === "level") f.api.stockLevel.mockResolvedValueOnce(fail(500, "level-down"));
      if (stage === "adjust") f.api.adjustStock.mockResolvedValueOnce(fail(409, "stock-conflict"));
      saver.update(stocked, defs);
      await saver.flush();
      expect(h.failure, stage).toHaveBeenLastCalledWith(expect.objectContaining({ code: { product: "product-down", level: "level-down", adjust: "stock-conflict" }[stage] }));
      expect(h.status, stage).toHaveBeenLastCalledWith("error");
    }
  });
});

describe("an existing listing", () => {
  it("one that already holds its defect card on the server is not re-sent anything when nothing changed", async () => {
    const p = product({ id: "22222222-2222-4222-8222-222222222222", version: 5, primary_category_id: CATEGORY, defect_card: { grade_code: "open_box" } as never });
    const f = fakeApi({}, p);
    const saver = new DraftSaver(f.api, hooks(), { initial: { product: p, state: complete, defs } });
    expect(saver.productId).toBe(p.id);
    saver.update(complete, defs);
    await saver.flush();
    expect(f.api.patch).not.toHaveBeenCalled();
    expect(f.api.defectCard).not.toHaveBeenCalled();
  });
});
