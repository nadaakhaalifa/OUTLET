import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DraftSaver, type SaverHooks } from "../src/lib/draft-saver";
import { EMPTY_STATE, type WizardState } from "../src/lib/wizard-model";
import { ATTRIBUTES, CATEGORY, fail, fakeApi, product } from "./fake-api";

const defs = ATTRIBUTES.attributes.map((a) => ({ code: a.code, dataType: a.data_type, required: a.required }));
const hooks = () => ({ status: vi.fn(), reasons: vi.fn(), failure: vi.fn(), conflict: vi.fn(), draftCreated: vi.fn() }) satisfies SaverHooks;
const withPhoto: WizardState = { ...EMPTY_STATE, categoryId: CATEGORY, photos: { main: { mediaId: "m1", name: "a.png" } } };
const complete: WizardState = {
  ...withPhoto,
  name: "فستان صيفي",
  description: "قطن",
  price: "1299",
  attributes: { colour: "black" },
  sizes: [{ label: "M", cm: "94" }],
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("DraftSaver", () => {
  it("does nothing until a category exists, then creates the draft once and saves after the debounce", async () => {
    const { api } = fakeApi();
    const h = hooks();
    const saver = new DraftSaver(api, h);
    saver.update(EMPTY_STATE, defs);
    await vi.advanceTimersByTimeAsync(2000);
    expect(api.createDraft).not.toHaveBeenCalled();

    saver.update(withPhoto, defs);
    saver.update({ ...withPhoto, name: "فستان" }, defs);
    await vi.advanceTimersByTimeAsync(799);
    expect(api.createDraft).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(api.createDraft).toHaveBeenCalledTimes(1);
    expect(api.createDraft).toHaveBeenCalledWith("new_with_tags", CATEGORY);
    expect(api.patch).toHaveBeenCalledTimes(1);
    expect(api.patch.mock.calls[0]?.[1]).toBe(1);
    expect(Object.keys(api.patch.mock.calls[0]?.[2] ?? {})).toEqual(["condition"]);
    expect(h.draftCreated).toHaveBeenCalledWith(product().id);
    expect(h.status).toHaveBeenLastCalledWith("saved");
    expect(h.reasons).toHaveBeenCalledWith([]);
  });

  it("sends only complete, changed sections and chains If-Match through the returned version", async () => {
    const { api } = fakeApi();
    const saver = new DraftSaver(api, hooks());
    saver.update(withPhoto, defs);
    await saver.flush();
    saver.update(complete, defs);
    await saver.flush();
    expect(api.patch.mock.calls.map((c) => [c[1], Object.keys(c[2]).sort()])).toEqual([
      [1, ["condition"]],
      [2, ["details", "price"]],
    ]);
    // nothing changed -> nothing sent
    saver.update({ ...complete }, defs);
    await saver.flush();
    expect(api.patch).toHaveBeenCalledTimes(2);
    // an incomplete edit (price cleared) is not sent either
    saver.update({ ...complete, price: "" }, defs);
    await saver.flush();
    expect(api.patch).toHaveBeenCalledTimes(2);
  });

  it("posts the defect card after the grade was saved, with the refreshed version, and again when the grade changes", async () => {
    const { api } = fakeApi();
    const saver = new DraftSaver(api, hooks());
    const open: WizardState = {
      ...complete,
      condition: "openBox",
      photos: { main: { mediaId: "m1", name: "a" }, defect: { mediaId: "d1", name: "b" } },
      defect: { typeCode: "stain", location: "الكم", severity: "minor", affectsFunction: false, xPct: 25, yPct: 60 },
      notes: "بقعة",
    };
    saver.update(open, defs);
    await saver.flush();
    expect(api.defectCard).toHaveBeenCalledTimes(1);
    expect(api.defectCard.mock.calls[0]?.[1]).toBe(2); // after the PATCH bumped 1 -> 2
    expect(saver.version).toBe(3); // the card write bumped it again and the saver re-read it
    saver.update({ ...open, name: "فستان آخر" }, defs);
    await saver.flush();
    expect(api.defectCard).toHaveBeenCalledTimes(1);
    saver.update({ ...open, condition: "cosmeticDefect" }, defs);
    await saver.flush();
    expect(api.defectCard).toHaveBeenCalledTimes(2);
  });

  it("serializes overlapping saves: an edit made while saving triggers one more pass, never a parallel PATCH", async () => {
    let release: (() => void) | undefined;
    const { api } = fakeApi();
    const real = api.patch.getMockImplementation();
    api.patch.mockImplementationOnce(async (...a) => {
      await new Promise<void>((r) => {
        release = r;
      });
      return real === undefined ? fail(500, "x") : real(...a);
    });
    const saver = new DraftSaver(api, hooks());
    saver.update(withPhoto, defs);
    const first = saver.flush();
    await vi.advanceTimersByTimeAsync(0);
    saver.update(complete, defs);
    void saver.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.patch).toHaveBeenCalledTimes(1);
    release?.();
    await first;
    expect(api.patch).toHaveBeenCalledTimes(2);
    expect(api.patch.mock.calls[1]?.[1]).toBe(2);
  });

  it("on a version conflict reloads, tells the user and retries once", async () => {
    const f = fakeApi();
    const h = hooks();
    const saver = new DraftSaver(f.api, h);
    saver.update(withPhoto, defs);
    await saver.flush();
    f.bump(); // a colleague saved in between
    saver.update(complete, defs);
    await saver.flush();
    expect(h.conflict).toHaveBeenCalledTimes(1);
    expect(f.api.patch.mock.calls.map((c) => c[1])).toEqual([1, 2, 3]);
    expect(h.status).toHaveBeenLastCalledWith("saved");
  });

  it("surfaces a failure (passkey-required) and reports the error state without retrying forever", async () => {
    const { api } = fakeApi({ onPatch: () => fail(403, "passkey-required") });
    const h = hooks();
    const saver = new DraftSaver(api, h);
    saver.update(withPhoto, defs);
    await saver.flush();
    expect(api.patch).toHaveBeenCalledTimes(1);
    expect(h.failure).toHaveBeenCalledWith(expect.objectContaining({ code: "passkey-required", status: 403 }));
    expect(h.status).toHaveBeenLastCalledWith("error");
  });

  it("ensureDraft creates the draft for a photo upload only when a category exists", async () => {
    const { api } = fakeApi();
    const saver = new DraftSaver(api, hooks());
    expect(await saver.ensureDraft(EMPTY_STATE)).toBeNull();
    expect(await saver.ensureDraft(withPhoto)).toBe(product().id);
    expect(await saver.ensureDraft(withPhoto)).toBe(product().id);
    expect(api.createDraft).toHaveBeenCalledTimes(1);
  });

  it("an existing listing is not re-saved until the user edits it", async () => {
    const p = product({ id: "22222222-2222-4222-8222-222222222222", version: 5, primary_category_id: CATEGORY, title_ar: "فستان", description_ar: "قطن", media: [{ role: "main", media: { media_id: "m1" } }] });
    const { api } = fakeApi({}, p);
    const saver = new DraftSaver(api, hooks(), { initial: { product: p, state: { ...complete, price: "" }, defs } });
    expect(saver.productId).toBe(p.id);
    expect(saver.version).toBe(5);
    const same = { ...complete, price: "" };
    saver.update(same, defs);
    await saver.flush();
    expect(api.patch).not.toHaveBeenCalled();
    saver.update({ ...same, name: "فستان سهرة" }, defs);
    await saver.flush();
    expect(api.patch).toHaveBeenCalledTimes(1);
    expect(api.patch.mock.calls[0]?.[1]).toBe(5);
    expect(Object.keys(api.patch.mock.calls[0]?.[2] ?? {})).toEqual(["details"]);
  });
});
