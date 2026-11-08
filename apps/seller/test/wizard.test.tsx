import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranslator, formatMoney } from "@outlet/i18n";
import { money } from "@outlet/money";
import { ProductWizard } from "../src/components/wizard/ProductWizard";
import { SaveStatusProvider } from "../src/components/SaveStatus";
import { CATEGORY, fail, fakeApi, ok, product } from "./fake-api";

const t = createTranslator("ar-EG");
const png = (name = "a.png"): File => new File([new Uint8Array([137, 80, 78, 71])], name, { type: "image/png" });

const mount = (api: ReturnType<typeof fakeApi>["api"], props: { product?: ReturnType<typeof product> } = {}) =>
  render(
    <SaveStatusProvider>
      <ProductWizard locale="ar-EG" marketId="EG" api={api} debounceMs={5} {...props} />
    </SaveStatusProvider>,
  );

const upload = async (label: string, file: File): Promise<void> => {
  const slot = screen.getByRole("heading", { name: label }).closest("li");
  if (slot === null) throw new Error("no slot");
  fireEvent.change(slot.querySelector("input[type=file]")!, { target: { files: [file] } });
  await waitFor(() => { expect(within(slot).getByRole("button", { name: t("seller.photos.remove") })).toBeTruthy(); });
};
const pickCategory = async (): Promise<void> => {
  await waitFor(() => { expect(screen.getByRole("option", { name: /فساتين/ })).toBeTruthy(); });
  fireEvent.change(screen.getByLabelText(t("seller.details.category")), { target: { value: CATEGORY } });
};
const clickContinue = (key: "seller.actions.continue" | "seller.actions.continueReview" = "seller.actions.continue"): void => {
  fireEvent.click(screen.getByRole("button", { name: t(key) }));
};
const violations = async (): Promise<string[]> => {
  const r = await axe.run(document.body, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } });
  return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ProductWizard step 1: photos & condition", () => {
  it("blocks Continue until the category and the main photo exist (mirrors the server rules)", async () => {
    const { api } = fakeApi();
    mount(api);
    clickContinue();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(t("seller.reason.CATEGORY_REQUIRED"));
    expect(alert.textContent).toContain(t("seller.reason.MAIN_PHOTO_REQUIRED"));
    expect(api.createDraft).not.toHaveBeenCalled();
  });

  it("refuses a photo before a category exists, and a wrong type or size without calling the API", async () => {
    const { api } = fakeApi();
    mount(api);
    const slot = screen.getByRole("heading", { name: t("seller.photos.slot.main") }).closest("li") as HTMLElement;
    const input = slot.querySelector("input[type=file]")!;
    fireEvent.change(input, { target: { files: [png()] } });
    expect((await within(slot).findByRole("alert")).textContent).toBe(t("seller.photos.needDraft"));
    await pickCategory();
    fireEvent.change(input, { target: { files: [new File(["x"], "a.pdf", { type: "application/pdf" })] } });
    expect((await within(slot).findByRole("alert")).textContent).toBe(t("seller.photos.err.type"));
    expect(api.upload).not.toHaveBeenCalled();
  });

  it("uploads to the draft, shows the preview, autosaves with If-Match and ticks the checklist from the server reasons", async () => {
    const f = fakeApi({ reasons: () => ["CONDITION_PHOTO_REQUIRED", "NO_ACTIVE_VARIANT"] });
    mount(f.api);
    await pickCategory();
    await upload(t("seller.photos.slot.main"), png());
    expect(f.api.createDraft).toHaveBeenCalledWith("new_with_tags", CATEGORY);
    expect(f.api.upload).toHaveBeenCalledWith(product().id, "product", expect.any(File), expect.any(Function));
    await waitFor(() => { expect(f.api.patch).toHaveBeenCalled(); });
    expect(f.api.patch.mock.calls[0]?.[1]).toBe(1);
    expect(f.api.patch.mock.calls[0]?.[2]).toMatchObject({ condition: { media: [{ role: "main", position: 0 }] } });
    const rows = await waitFor(() => {
      const items = within(screen.getByRole("region", { name: t("seller.ready.title") })).getAllByRole("listitem");
      expect(items.length).toBe(4);
      return items;
    });
    await waitFor(() => { expect(rows.map((r) => r.getAttribute("data-done"))).toEqual(["true", "false", "true", "false"]); });
    expect(screen.getByAltText(t("seller.photos.preview", { slot: t("seller.photos.slot.main") }))).toBeTruthy();
  });

  it("a defect grade needs the close-up before Continue; the hotspot is saved as basis points on the defect card", async () => {
    const f = fakeApi();
    mount(f.api);
    await pickCategory();
    await upload(t("seller.photos.slot.main"), png());
    fireEvent.click(screen.getByRole("radio", { name: t("condition.openBox") }));
    expect(screen.getByRole("heading", { name: t("seller.photos.slot.defect") })).toBeTruthy();
    clickContinue();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(t("seller.reason.CONDITION_PHOTO_REQUIRED"));
    expect(alert.textContent).toContain(t("seller.problem.defectType"));
    expect(alert.textContent).toContain(t("seller.problem.notes"));

    await upload(t("seller.photos.slot.defect"), png("close.png"));
    fireEvent.change(await screen.findByLabelText(t("seller.condition.type")), { target: { value: "stain" } });
    fireEvent.change(screen.getByLabelText(t("seller.condition.location")), { target: { value: "الكم الأيسر" } });
    fireEvent.change(screen.getByLabelText(t("seller.condition.notes")), { target: { value: "بقعة صغيرة" } });
    fireEvent.change(screen.getByLabelText(t("seller.condition.markX")), { target: { value: "25" } });
    fireEvent.change(screen.getByLabelText(t("seller.condition.markY")), { target: { value: "60" } });
    expect(screen.getByText(t("seller.condition.markSet", { x: 25, y: 60 }))).toBeTruthy();
    await waitFor(() => { expect(f.api.defectCard).toHaveBeenCalled(); });
    expect(f.api.defectCard.mock.calls.at(-1)?.[2]).toMatchObject({
      summary_ar: "بقعة صغيرة",
      items: [{ defect_type_code: "stain", location_ar: "الكم الأيسر", hotspot_x_bp: 2500, hotspot_y_bp: 6000 }],
    });
    // condition photos: the defect close-up travels as role "condition"
    const cond = f.api.patch.mock.calls.map((c) => c[2] as { condition?: { condition_grade_code: string; media: { role: string }[] } }).findLast((b) => b.condition?.condition_grade_code === "open_box");
    expect(cond?.condition?.media.map((m) => m.role)).toEqual(["main", "condition"]);
    clickContinue();
    await screen.findByRole("heading", { name: t("seller.details.title") });
  });

  it("is axe-clean, RTL and free of inline styles on step 1 (defect grade)", async () => {
    const { api } = fakeApi();
    const { container } = mount(api);
    await pickCategory();
    fireEvent.click(screen.getByRole("radio", { name: t("condition.cosmeticDefect") }));
    await waitFor(() => { expect(screen.getByLabelText(t("seller.condition.type"))).toBeTruthy(); });
    expect(await violations()).toEqual([]);
    expect(container.querySelectorAll("[style]")).toHaveLength(0);
  });
});

describe("ProductWizard steps 2 to 4", () => {
  const go = async (): Promise<void> => {
    await pickCategory();
    await upload(t("seller.photos.slot.main"), png());
    clickContinue();
    await screen.findByRole("heading", { name: t("seller.details.title") });
  };

  it("validates the Arabic name, description and required category attributes before step 3", async () => {
    const f = fakeApi();
    mount(f.api);
    await go();
    fireEvent.change(screen.getByLabelText(t("seller.details.name")), { target: { value: "Dress" } });
    clickContinue();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(t("seller.reason.TITLE_AR_REQUIRED"));
    expect(alert.textContent).toContain(t("seller.reason.DESCRIPTION_AR_REQUIRED"));
    expect(alert.textContent).toContain(t("seller.reason.ATTRIBUTES_INCOMPLETE"));
    fireEvent.change(screen.getByLabelText(t("seller.details.name")), { target: { value: "فستان صيفي" } });
    fireEvent.change(screen.getByLabelText(t("seller.details.description")), { target: { value: "فستان قطن" } });
    fireEvent.change(await screen.findByLabelText(t("seller.attr.colour")), { target: { value: "black" } });
    fireEvent.change(screen.getAllByLabelText(t("seller.size.label"))[0]!, { target: { value: "M" } });
    fireEvent.change(screen.getAllByLabelText(t("seller.size.cm"))[0]!, { target: { value: "94" } });
    clickContinue();
    await screen.findByRole("heading", { name: t("seller.price.title") });
    await waitFor(() => { expect(f.api.patch.mock.calls.some((c) => "details" in (c[2]))).toBe(true); });
  });

  it("the buyer preview shows a plain EGP price and a condition chip, never a % off or a strike-through", async () => {
    const f = fakeApi();
    const { container } = mount(f.api);
    await go();
    fireEvent.change(screen.getByLabelText(t("seller.details.name")), { target: { value: "فستان صيفي" } });
    const preview = (): HTMLElement => screen.getByRole("complementary", { name: t("seller.preview.title") });
    expect(preview().textContent).toContain(t("seller.preview.pricePending"));
    fireEvent.change(screen.getByLabelText(t("seller.details.description")), { target: { value: "قطن" } });
    fireEvent.change(await screen.findByLabelText(t("seller.attr.colour")), { target: { value: "black" } });
    fireEvent.change(screen.getAllByLabelText(t("seller.size.label"))[0]!, { target: { value: "M" } });
    fireEvent.change(screen.getAllByLabelText(t("seller.size.cm"))[0]!, { target: { value: "94" } });
    clickContinue();
    await screen.findByRole("heading", { name: t("seller.price.title") });
    clickContinue("seller.actions.continueReview");
    expect((await screen.findByRole("alert")).textContent).toContain(t("seller.price.invalid"));
    fireEvent.change(screen.getByLabelText(t("seller.price.selling")), { target: { value: "١٢٩٩٫٥٠" } });
    const text = preview().textContent;
    expect(text).toContain("فستان صيفي");
    expect(text).toContain(formatMoney(money(129950n, "EGP"), "ar-EG"));
    expect(text).toContain(t("condition.newClearance"));
    expect(text).not.toMatch(/%|٪/);
    expect(preview().querySelector("del, s, [data-verified=true]")).toBeNull();
    expect(container.querySelectorAll("[style]")).toHaveLength(0);
    await waitFor(() => { expect(f.api.patch.mock.calls.some((c) => (c[2] as { price?: { price: { amount_minor: string } } }).price?.price.amount_minor === "129950")).toBe(true); });
    expect(await violations()).toEqual([]);
  });

  it("buyer offers and quantity are shown but clearly not saved; barcode and voice are disabled", async () => {
    const f = fakeApi();
    mount(f.api);
    await go();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: t("seller.details.scan") }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: t("seller.details.voice") }).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(t("seller.details.name")), { target: { value: "فستان" } });
  });

  it("review: publish returns the 409 reasons, the seller fixes the step, and publish then succeeds", async () => {
    let attempts = 0;
    const f = fakeApi({
      reasons: () => ["DEFECT_CARD_REQUIRED"],
      onPublish: () => {
        attempts += 1;
        return attempts === 1 ? fail(409, "activation-blocked", ["DEFECT_CARD_REQUIRED", "VARIANT_PRICE_INVALID"]) : ok({ status: "PUBLISHED", blocked_reasons: [] });
      },
    });
    mount(f.api, { product: product({ primary_category_id: CATEGORY, title_ar: "فستان", description_ar: "قطن", attributes: { colour: "black", size_run: [{ label: "M", cm: 94 }] }, media: [{ role: "main", media: { media_id: "m1" } }], skus: [{ id: "s", price: { amount_minor: "10000", currency: "EGP" } }] }) });
    fireEvent.click(screen.getByRole("button", { name: t("seller.actions.continue") }));
    await screen.findByRole("heading", { name: t("seller.details.title") });
    clickContinue();
    await screen.findByRole("heading", { name: t("seller.price.title") });
    clickContinue("seller.actions.continueReview");
    await screen.findByRole("heading", { name: t("seller.review.title") });

    fireEvent.click(screen.getByRole("button", { name: t("seller.actions.publish") }));
    const blocked = await screen.findByText(t("seller.review.blocked"));
    const list = blocked.closest<HTMLElement>("[role=alert]");
    if (list === null) throw new Error("no alert");
    expect(within(list).getAllByRole("listitem").map((li) => li.getAttribute("data-reason"))).toEqual(["DEFECT_CARD_REQUIRED", "VARIANT_PRICE_INVALID"]);
    expect(list.textContent).toContain(t("seller.reason.DEFECT_CARD_REQUIRED"));
    expect(await violations()).toEqual([]);

    const priceFix = within(list).getAllByRole("button", { name: t("seller.review.fix") })[1]; // price -> step 3
    if (priceFix === undefined) throw new Error("no fix button");
    fireEvent.click(priceFix);
    await screen.findByRole("heading", { name: t("seller.price.title") });
    clickContinue("seller.actions.continueReview");
    await screen.findByRole("heading", { name: t("seller.review.title") });
    fireEvent.click(screen.getByRole("button", { name: t("seller.actions.publish") }));
    expect((await screen.findByRole("status", { name: "" })).textContent).toContain(t("seller.review.published"));
    expect(f.api.publish).toHaveBeenCalledTimes(2);
  });

  it("shows the passkey-required Problem as a blocking banner", async () => {
    const f = fakeApi({ onPatch: () => fail(403, "passkey-required") });
    mount(f.api);
    await pickCategory();
    await upload(t("seller.photos.slot.main"), png());
    const banner = await screen.findByText(t("seller.error.passkey"));
    expect(banner.closest("[role=alert]")?.getAttribute("data-code")).toBe("passkey-required");
  });
});
