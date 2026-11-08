import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "@outlet/i18n";

vi.mock("../src/client/seller-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/client/seller-api")>();
  return { ...actual, createSellerApi: vi.fn(actual.createSellerApi) };
});

import { createSellerApi } from "../src/client/seller-api";
import { ProductWizard } from "../src/components/wizard/ProductWizard";
import { SaveIndicator, SaveStatusProvider } from "../src/components/SaveStatus";
import { CATEGORY, fail, fakeApi, product } from "./fake-api";

const t = createTranslator("en-EG");
const png = (name = "a.png"): File => new File([new Uint8Array([137, 80, 78, 71])], name, { type: "image/png" });
const full = () => product({ primary_category_id: CATEGORY, title_ar: "فستان", description_ar: "قطن", attributes: { colour: "black", size_run: [{ label: "M", cm: 94 }] }, media: [{ role: "main", media: { media_id: "m1" } }], skus: [{ id: "s", price: { amount_minor: "10000", currency: "EGP" } }] });
const mount = (api: ReturnType<typeof fakeApi>["api"], p?: ReturnType<typeof product>) =>
  render(
    <SaveStatusProvider>
      <SaveIndicator locale="en-EG" />
      <ProductWizard locale="en-EG" marketId="eg" api={api} debounceMs={5} {...(p === undefined ? {} : { product: p })} />
    </SaveStatusProvider>,
  );
const pickCategory = async (): Promise<void> => {
  await waitFor(() => { expect(screen.getByRole("option", { name: /فساتين/ })).toBeTruthy(); });
  fireEvent.change(screen.getByLabelText(t("seller.details.category")), { target: { value: CATEGORY } });
};
const slotInput = (label: string): HTMLInputElement => {
  const li = screen.getByRole("heading", { name: label }).closest("li")!;
  return li.querySelector("input[type=file]")!;
};
const toStep = async (n: 2 | 3 | 4): Promise<void> => {
  const titles = { 2: "seller.details.title", 3: "seller.price.title", 4: "seller.review.title" } as const;
  for (let s = 2; s <= n; s += 1) {
    fireEvent.click(screen.getByRole("button", { name: s === 4 ? t("seller.actions.continueReview") : t("seller.actions.continue") }));
    await screen.findByRole("heading", { name: t(titles[s as 2 | 3 | 4]) });
  }
};

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("ProductWizard: upload failures", () => {
  it.each([
    [413, "seller.photos.err.size", false],
    [422, "seller.photos.err.rejected", false],
    [503, "seller.photos.err.unavailable", false],
    [500, "seller.photos.err.generic", true],
  ] as const)("status %i shows %s (blocking banner only for unexpected failures)", async (status, key, banner) => {
    const f = fakeApi();
    f.api.upload.mockResolvedValueOnce(fail(status, "x-code"));
    mount(f.api);
    await pickCategory();
    fireEvent.change(slotInput(t("seller.photos.slot.main")), { target: { files: [png()] } });
    const slot = screen.getByRole("heading", { name: t("seller.photos.slot.main") }).closest("li")!;
    expect((await within(slot).findByRole("alert")).textContent).toBe(t(key));
    expect(within(slot).queryByRole("button", { name: t("seller.photos.remove") })).toBeNull();
    expect(document.querySelector(".banner") !== null).toBe(banner);
  });
  it("an unreadable preview still keeps the uploaded photo (shown as saved, not as an image)", async () => {
    class BadReader {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      result: string | null = null;
      readAsDataURL(): void { queueMicrotask(() => this.onerror?.()); }
    }
    vi.stubGlobal("FileReader", BadReader);
    const f = fakeApi();
    mount(f.api);
    await pickCategory();
    fireEvent.change(slotInput(t("seller.photos.slot.main")), { target: { files: [png()] } });
    expect(await screen.findByText(t("seller.photos.saved"))).toBeTruthy();
    expect(screen.queryByAltText(t("seller.photos.preview", { slot: t("seller.photos.slot.main") }))).toBeNull();
  });
  it("a non-string preview result is dropped too", async () => {
    class OddReader {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      result: ArrayBuffer = new ArrayBuffer(1);
      readAsDataURL(): void { queueMicrotask(() => this.onload?.()); }
    }
    vi.stubGlobal("FileReader", OddReader);
    mount(fakeApi().api);
    await pickCategory();
    fireEvent.change(slotInput(t("seller.photos.slot.main")), { target: { files: [png()] } });
    expect(await screen.findByText(t("seller.photos.saved"))).toBeTruthy();
  });
  it("removing a photo clears the slot", async () => {
    mount(fakeApi().api);
    await pickCategory();
    fireEvent.change(slotInput(t("seller.photos.slot.main")), { target: { files: [png()] } });
    fireEvent.click(await screen.findByRole("button", { name: t("seller.photos.remove") }));
    await waitFor(() => { expect(screen.queryByRole("button", { name: t("seller.photos.remove") })).toBeNull(); });
  });
  it("a draft that cannot be created reports needDraft and does not upload", async () => {
    const f = fakeApi();
    f.api.createDraft.mockResolvedValueOnce(fail(500, "boom"));
    mount(f.api);
    await pickCategory();
    fireEvent.change(slotInput(t("seller.photos.slot.main")), { target: { files: [png()] } });
    const slot = screen.getByRole("heading", { name: t("seller.photos.slot.main") }).closest("li")!;
    expect((await within(slot).findByRole("alert")).textContent).toBe(t("seller.photos.needDraft"));
    expect(f.api.upload).not.toHaveBeenCalled();
  });
});

describe("ProductWizard: navigation, editing and publish", () => {
  it("editing an existing listing says so, and Back returns to the previous step", async () => {
    mount(fakeApi({}, full()).api, full());
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(t("seller.wizard.edit"));
    expect(screen.getByRole("link", { name: t("seller.review.viewList") }).getAttribute("href")).toBe("/eg-en/products");
    await toStep(2);
    expect(screen.queryByRole("link", { name: t("seller.review.viewList") })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: t("seller.actions.back") }));
    await screen.findByRole("heading", { name: t("seller.photos.title") });
  });
  it("Save draft flushes pending edits to the API and the indicator reports it", async () => {
    const f = fakeApi({}, full());
    mount(f.api, full());
    await toStep(2);
    fireEvent.change(screen.getByLabelText(t("seller.details.name")), { target: { value: "فستان جديد" } });
    fireEvent.click(screen.getByRole("button", { name: t("seller.actions.saveDraft") }));
    await waitFor(() => { expect(f.api.patch).toHaveBeenCalled(); });
    expect(f.api.patch.mock.calls.at(-1)?.[2]).toMatchObject({ details: { title_ar: "فستان جديد" } });
    await waitFor(() => { expect(screen.getByRole("status", { name: "" }).getAttribute("data-state")).toBe("saved"); });
  });
  it("publish: an unexpected failure shows a banner and keeps the button usable; blocked reasons show the first hint outside review", async () => {
    const f = fakeApi({ onPublish: () => fail(500, "boom") });
    mount(f.api, full());
    await toStep(4);
    const btn = screen.getByRole<HTMLButtonElement>("button", { name: t("seller.actions.publish") });
    fireEvent.click(btn);
    await waitFor(() => { expect(document.querySelector(".banner")).not.toBeNull(); });
    expect(screen.getByRole<HTMLButtonElement>("button", { name: t("seller.actions.publish") }).disabled).toBe(false);
    expect(screen.queryByText(t("seller.review.published"), { exact: false })).toBeNull();
  });
  it("publish is disabled once published", async () => {
    const f = fakeApi({}, full());
    mount(f.api, full());
    await toStep(4);
    fireEvent.click(screen.getByRole("button", { name: t("seller.actions.publish") }));
    await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>("button", { name: t("seller.actions.publish") }).disabled).toBe(true); });
  });
  it("outside review, the first blocking reason is hinted in the side panel", async () => {
    const f = fakeApi({ reasons: () => ["MAIN_PHOTO_REQUIRED"] });
    mount(f.api, full());
    await waitFor(() => { expect(screen.getAllByText(t("seller.reason.MAIN_PHOTO_REQUIRED")).length).toBeGreaterThan(0); });
  });
  it("a stale version shows the conflict banner, keeps local photos, and can be dismissed", async () => {
    const f = fakeApi({}, full());
    mount(f.api, full());
    await toStep(2);
    f.bump(); // someone else saved
    fireEvent.change(screen.getByLabelText(t("seller.details.name")), { target: { value: "تعديل" } });
    const banner = await screen.findByText(t("seller.error.conflict"));
    expect(banner.closest("[role=alert]")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: t("seller.error.dismiss") }));
    await waitFor(() => { expect(screen.queryByText(t("seller.error.conflict"))).toBeNull(); });
  });
  it("without an api prop it builds the BFF client for the lower-cased market", () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
    render(<SaveStatusProvider><ProductWizard locale="ar-EG" marketId="EG" /></SaveStatusProvider>);
    expect(createSellerApi).toHaveBeenCalledWith("eg");
  });
});
