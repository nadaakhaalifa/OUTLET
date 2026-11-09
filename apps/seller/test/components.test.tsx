import { act, fireEvent, render, screen } from "@testing-library/react";
import axe from "axe-core";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { createTranslator } from "@outlet/i18n";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

import { Sidebar } from "../src/components/Sidebar";
import { StoreSwitcher } from "../src/components/StoreSwitcher";
import { ProblemBanner } from "../src/components/ProblemBanner";
import { SaveIndicator, SaveStatusProvider, useSaveStatus, type SaveState } from "../src/components/SaveStatus";
import { DefectPhotoMarker } from "../src/components/wizard/DefectPhotoMarker";
import { DetailsStep } from "../src/components/wizard/DetailsStep";
import { ReviewStep } from "../src/components/wizard/ReviewStep";
import { PhotosStep } from "../src/components/wizard/PhotosStep";
import { readEnv, SESSION_COOKIE, STORE_COOKIE, STORES_COOKIE } from "../src/server/env";
import { EMPTY_STATE, stepForReason, type WizardState } from "../src/lib/wizard-model";
import { ATTRIBUTES, CATEGORY } from "./fake-api";

const ar = createTranslator("ar-EG");
const en = createTranslator("en-EG");
const clean = async (): Promise<string[]> => {
  const r = await axe.run(document.body, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } });
  return r.violations.map((v) => v.id);
};

describe("Sidebar", () => {
  it("links built sections, marks the current one, and shows unbuilt ones as disabled text", async () => {
    render(<Sidebar t={ar} base="/ar" current="products" />);
    const products = screen.getByRole("link", { name: ar("seller.nav.products") });
    expect(products.getAttribute("aria-current")).toBe("page");
    expect(products.getAttribute("href")).toBe("/ar/products");
    expect(screen.getByRole("link", { name: ar("seller.nav.overview") }).getAttribute("aria-current")).toBeNull();
    expect(screen.getByRole("link", { name: ar("seller.nav.overview") }).getAttribute("href")).toBe("/ar");
    expect(screen.getByRole("link", { name: ar("seller.nav.orders") }).getAttribute("href")).toBe("/ar/orders");
    expect(screen.getByRole("link", { name: ar("seller.nav.inventory") }).getAttribute("href")).toBe("/ar/inventory");
    expect(screen.getAllByRole("link")).toHaveLength(5);
    const soon = screen.getByText(ar("seller.nav.offers"), { exact: false });
    expect(soon.getAttribute("aria-disabled")).toBe("true");
    expect(soon.textContent).toContain(ar("seller.nav.soon"));
    expect(await clean()).toEqual([]);
  });
  it("renders in English too", () => {
    render(<Sidebar t={en} base="/en" current="overview" />);
    expect(screen.getByRole("link", { name: en("seller.nav.overview") }).getAttribute("aria-current")).toBe("page");
  });
});

describe("StoreSwitcher", () => {
  it("shows a message and no select when the user has no stores", () => {
    render(<StoreSwitcher locale="ar-EG" stores={[]} active="" />);
    expect(screen.getByText(ar("seller.store.none"))).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
  });
  it("lists stores, writes the store cookie and refreshes on change", async () => {
    render(<StoreSwitcher locale="en-EG" stores={["s-1", "s-2"]} active="s-1" />);
    const select = screen.getByLabelText<HTMLSelectElement>(en("seller.store.label"));
    expect(select.value).toBe("s-1");
    expect(select.options).toHaveLength(2);
    expect(select.options[1]?.textContent).toBe(en("seller.store.option", { n: 2 }));
    fireEvent.change(select, { target: { value: "s-2" } });
    expect(document.cookie).toContain("seller_store=s-2");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(await clean()).toEqual([]);
  });
});

describe("SaveIndicator", () => {
  const Drive = ({ to }: { to: SaveState }) => {
    const { set } = useSaveStatus();
    useEffect(() => { set(to); }, [set, to]);
    return null;
  };
  it.each([
    ["idle", ""],
    ["saving", ar("seller.topbar.saving")],
    ["saved", ar("seller.topbar.saved")],
    ["error", ar("seller.topbar.saveFailed")],
  ] as const)("announces %s", async (state, text) => {
    render(
      <SaveStatusProvider>
        <Drive to={state} />
        <SaveIndicator locale="ar-EG" />
      </SaveStatusProvider>,
    );
    await act(async () => { await Promise.resolve(); });
    const el = screen.getByRole("status");
    expect(el.textContent).toBe(text);
    expect(el.getAttribute("data-state")).toBe(state);
    expect(el.getAttribute("aria-live")).toBe("polite");
  });
  it("is idle without a provider and the default setter is harmless", () => {
    const Probe = () => { useSaveStatus().set("saved"); return <SaveIndicator locale="en-EG" />; };
    render(<Probe />);
    expect(screen.getByRole("status").getAttribute("data-state")).toBe("idle");
  });
});

describe("ProblemBanner", () => {
  it.each([
    ["passkey-required", 403, "seller.error.passkey"],
    ["invalid-token", 401, "seller.error.unauthenticated"],
    ["rate-limited", 429, "seller.error.rate"],
    ["version-conflict", 409, "seller.error.conflict"],
    ["something-new", 404, "seller.error.notFound"],
    ["something-new", 403, "seller.error.forbidden"],
    ["something-new", 401, "seller.error.unauthenticated"],
    ["something-new", 500, "error.generic"],
  ] as const)("maps %s/%i", async (code, status, key) => {
    render(<ProblemBanner t={ar} code={code} status={status} />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe(ar(key));
    expect(alert.getAttribute("data-code")).toBe(code);
    expect(await clean()).toEqual([]);
  });
});

describe("seller env", () => {
  it("defaults trusted types off and API_URL unset", () => {
    expect(readEnv({})).toEqual({ CSP_TRUSTED_TYPES: "off" });
  });
  it("reads set values and treats an empty API_URL as unset", () => {
    expect(readEnv({ CSP_TRUSTED_TYPES: "on", API_URL: "https://api.example.test" })).toEqual({ CSP_TRUSTED_TYPES: "on", API_URL: "https://api.example.test" });
    expect(readEnv({ API_URL: "" }).API_URL).toBeUndefined();
  });
  it("rejects invalid values and exposes cookie names", () => {
    expect(() => readEnv({ API_URL: "not a url" })).toThrow();
    expect(() => readEnv({ CSP_TRUSTED_TYPES: "maybe" })).toThrow();
    expect([SESSION_COOKIE, STORE_COOKIE, STORES_COOKIE]).toEqual(["seller_session", "seller_store", "seller_stores"]);
  });
  it("defaults to process.env", () => {
    expect(readEnv().CSP_TRUSTED_TYPES).toMatch(/^(on|off)$/);
  });
});

describe("DefectPhotoMarker", () => {
  const setup = (over: Partial<Parameters<typeof DefectPhotoMarker>[0]> = {}) => {
    const onChange = vi.fn();
    const utils = render(<DefectPhotoMarker locale="en-EG" src="blob:x" x={null} y={null} onChange={onChange} {...over} />);
    return { onChange, ...utils };
  };
  it("hides the photo when there is no src and shows no dot or status without a point", () => {
    setup({ src: undefined });
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });
  it("shows the dot and the status when both coordinates are set", () => {
    const { container } = setup({ x: 10, y: 20 });
    expect(container.querySelector("circle")).not.toBeNull();
    expect(screen.getByRole("status").textContent).toBe(en("seller.condition.markSet", { x: 10, y: 20 }));
  });
  it("does not show a dot when only one coordinate is set", () => {
    const { container } = setup({ x: 10, y: null });
    expect(container.querySelector("circle")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });
  it("converts a click into clamped percentages, and ignores a zero-size box", () => {
    const { onChange } = setup();
    const hit = screen.getByRole("button");
    fireEvent.click(hit, { clientX: 50, clientY: 20 });
    expect(onChange).not.toHaveBeenCalled(); // jsdom rect is 0x0
    hit.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.click(hit, { clientX: 50, clientY: 20 });
    expect(onChange).toHaveBeenLastCalledWith(25, 20);
    fireEvent.click(hit, { clientX: 999, clientY: -50 });
    expect(onChange).toHaveBeenLastCalledWith(100, 0);
  });
  it("typing X or Y: defaults the other axis to 50, clamps, and clears on empty or NaN", () => {
    const { onChange } = setup();
    const [xIn, yIn] = screen.getAllByRole("spinbutton");
    fireEvent.change(xIn!, { target: { value: "150" } });
    expect(onChange).toHaveBeenLastCalledWith(100, 50);
    fireEvent.change(yIn!, { target: { value: "30" } });
    expect(onChange).toHaveBeenLastCalledWith(50, 30);
    fireEvent.change(xIn!, { target: { value: "abc" } });
    expect(onChange).toHaveBeenCalledTimes(2); // non-numeric input is not a change in a number field
  });
  it("typing with existing coordinates keeps the other axis and null-clears", () => {
    const { onChange } = setup({ x: 40, y: 60 });
    const [xIn, yIn] = screen.getAllByRole("spinbutton");
    fireEvent.change(xIn!, { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith(null, 60);
    fireEvent.change(yIn!, { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith(40, null);
    fireEvent.change(yIn!, { target: { value: "70" } });
    expect(onChange).toHaveBeenLastCalledWith(40, 70);
  });
  it("has no axe violations", async () => {
    setup({ x: 1, y: 2 });
    expect(await clean()).toEqual([]);
  });
});

describe("ReviewStep", () => {
  const base = { locale: "ar-EG" as const, hasDraft: true, reasons: [] as string[] | null, published: false, listHref: "/ar/products", onFix: vi.fn() };
  it("published shows a link to the list (wins over reasons)", () => {
    render(<ReviewStep {...base} published reasons={["MAIN_PHOTO_REQUIRED"]} />);
    expect(screen.getByRole("link", { name: ar("seller.review.viewList") }).getAttribute("href")).toBe("/ar/products");
  });
  it("asks for a draft when none exists, or readiness is unknown", () => {
    const { unmount } = render(<ReviewStep {...base} hasDraft={false} />);
    expect(screen.getByText(ar("seller.review.needDraft"))).toBeTruthy();
    unmount();
    render(<ReviewStep {...base} reasons={null} />);
    expect(screen.getByText(ar("seller.review.needDraft"))).toBeTruthy();
  });
  it("says ok when there are no blocking reasons", () => {
    render(<ReviewStep {...base} />);
    expect(screen.getByRole("status").textContent).toBe(ar("seller.review.ok"));
  });
  it("lists blocking reasons and routes Fix to the owning step", async () => {
    const onFix = vi.fn();
    render(<ReviewStep {...base} reasons={["MAIN_PHOTO_REQUIRED", "CATEGORY_REQUIRED"]} onFix={onFix} />);
    expect(screen.getByRole("alert")).toBeTruthy();
    const fixes = screen.getAllByRole("button", { name: ar("seller.review.fix") });
    expect(fixes).toHaveLength(2);
    fireEvent.click(fixes[0]!);
    expect(onFix).toHaveBeenCalledTimes(1);
    expect(onFix).toHaveBeenCalledWith(stepForReason("MAIN_PHOTO_REQUIRED"));
    fireEvent.click(fixes[1]!);
    expect(onFix).toHaveBeenLastCalledWith(stepForReason("CATEGORY_REQUIRED"));
    expect(await clean()).toEqual([]);
  });
});

describe("DetailsStep", () => {
  const attrs = {
    ...ATTRIBUTES,
    attributes: [
      { code: "colour", data_type: "enum", required: true, options: [{ code: "black", label_ar: "أسود", label_en: "Black" }, { code: "red", label_ar: "أحمر", label_en: null }] },
      { code: "size_run", data_type: "size_run", required: true, options: [] },
      { code: "drawstring_free", data_type: "boolean", required: false, options: [] },
      { code: "care_notes_ar", data_type: "text", required: false, options: [] },
      { code: "unknown_code", data_type: "text", required: true, options: [] },
    ],
  } as unknown as Parameters<typeof DetailsStep>[0]["attributeSet"];
  const state = (over: Partial<WizardState> = {}): WizardState => ({ ...EMPTY_STATE, categoryId: CATEGORY, ...over });

  it("shows loading when the attribute set has not arrived", async () => {
    render(<DetailsStep locale="ar-EG" state={state()} attributeSet={null} onChange={vi.fn()} />);
    expect(screen.getByText(ar("seller.details.attributesLoading"))).toBeTruthy();
    expect(await clean()).toEqual([]);
  });
  it("reports edits for each plain field and the warranty-kind mapping", () => {
    const onChange = vi.fn();
    render(<DetailsStep locale="ar-EG" state={state()} attributeSet={null} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText(ar("seller.details.name")), { target: { value: "N" } });
    expect(onChange).toHaveBeenLastCalledWith({ name: "N" });
    fireEvent.change(screen.getByLabelText(ar("seller.details.description")), { target: { value: "D" } });
    expect(onChange).toHaveBeenLastCalledWith({ description: "D" });
    fireEvent.change(screen.getByLabelText(new RegExp(ar("seller.details.warranty"))), { target: { value: "12" } });
    expect(onChange).toHaveBeenLastCalledWith({ warrantyMonths: "12" });
    fireEvent.change(screen.getByLabelText(new RegExp(ar("seller.details.accessories"))), { target: { value: "box" } });
    expect(onChange).toHaveBeenLastCalledWith({ accessories: "box" });
    const kind = screen.getByLabelText(ar("seller.details.warrantyKind"));
    fireEvent.change(kind, { target: { value: "brand" } });
    expect(onChange).toHaveBeenLastCalledWith({ warrantyKind: "brand" });
    fireEvent.change(kind, { target: { value: "none" } });
    expect(onChange).toHaveBeenLastCalledWith({ warrantyKind: "none" });
    fireEvent.change(kind, { target: { value: "seller" } });
    expect(onChange).toHaveBeenLastCalledWith({ warrantyKind: "seller" });
    expect((screen.getAllByRole("button", { name: /./ }).filter((b) => (b as HTMLButtonElement).disabled))).toHaveLength(2);
  });
  it("renders enum (locale labels, fallback to Arabic), boolean and text attributes and writes them", () => {
    const onChange = vi.fn();
    render(<DetailsStep locale="en-EG" state={state({ attributes: { colour: "black" } })} attributeSet={attrs} onChange={onChange} />);
    const colour = screen.getByLabelText<HTMLSelectElement>(en("seller.attr.colour"));
    expect(colour.value).toBe("black");
    expect(colour.required).toBe(true);
    expect(Array.from(colour.options).map((o) => o.textContent)).toEqual([en("seller.details.choose"), "Black", "أحمر"]);
    fireEvent.change(colour, { target: { value: "red" } });
    expect(onChange).toHaveBeenLastCalledWith({ attributes: { colour: "red" } });
    const bool = screen.getByLabelText<HTMLSelectElement>(new RegExp(en("seller.attr.drawstring_free")));
    expect(bool.required).toBe(false);
    expect(bool.value).toBe("");
    fireEvent.change(bool, { target: { value: "true" } });
    expect(onChange).toHaveBeenLastCalledWith({ attributes: { colour: "black", drawstring_free: "true" } });
    const text = screen.getByLabelText(new RegExp(en("seller.attr.care_notes_ar")));
    fireEvent.change(text, { target: { value: "wash" } });
    expect(onChange).toHaveBeenLastCalledWith({ attributes: { colour: "black", care_notes_ar: "wash" } });
    const unknown = document.getElementById("attr-unknown_code") as HTMLInputElement;
    expect(unknown.required).toBe(true);
    expect(screen.getAllByText(new RegExp(en("seller.details.attributes"))).length).toBeGreaterThan(0);
  });
  it("Arabic locale uses Arabic enum labels", () => {
    render(<DetailsStep locale="ar-EG" state={state()} attributeSet={attrs} onChange={vi.fn()} />);
    expect(screen.getByRole("option", { name: "أسود" })).toBeTruthy();
  });
  it("size run: add, edit label/cm, and remove only when more than one row", () => {
    const onChange = vi.fn();
    const { rerender } = render(<DetailsStep locale="en-EG" state={state()} attributeSet={attrs} onChange={onChange} />);
    expect(screen.queryByRole("button", { name: en("seller.size.remove") })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: en("seller.size.add") }));
    expect(onChange).toHaveBeenLastCalledWith({ sizes: [{ label: "", cm: "" }, { label: "", cm: "" }] });
    const two = state({ sizes: [{ label: "S", cm: "50" }, { label: "M", cm: "52" }] });
    rerender(<DetailsStep locale="en-EG" state={two} attributeSet={attrs} onChange={onChange} />);
    const inputs = screen.getAllByRole("textbox").filter((i) => (i as HTMLInputElement).maxLength === 8 || (i as HTMLInputElement).maxLength === 5);
    fireEvent.change(inputs[3]!, { target: { value: "55" } });
    expect(onChange).toHaveBeenLastCalledWith({ sizes: [{ label: "S", cm: "50" }, { label: "M", cm: "55" }] });
    fireEvent.change(inputs[2]!, { target: { value: "L" } });
    expect(onChange).toHaveBeenLastCalledWith({ sizes: [{ label: "S", cm: "50" }, { label: "L", cm: "52" }] });
    const removes = screen.getAllByRole("button", { name: en("seller.size.remove") });
    expect(removes).toHaveLength(2);
    fireEvent.click(removes[0]!);
    expect(onChange).toHaveBeenLastCalledWith({ sizes: [{ label: "M", cm: "52" }] });
  });
});

describe("PhotosStep", () => {
  const mk = (over: Partial<Parameters<typeof PhotosStep>[0]> = {}) => {
    const props = { locale: "en-EG" as const, state: { ...EMPTY_STATE, categoryId: CATEGORY }, categories: [{ id: CATEGORY, name: "Dresses", depth: 2, path: "a/b/c" }], attributeSet: ATTRIBUTES, progress: {}, photoError: {}, onChange: vi.fn(), onFile: vi.fn(), onRemove: vi.fn(), ...over };
    return { props, ...render(<PhotosStep {...props} />) };
  };
  it("new-clearance shows main and packaging only; choose label, no remove; file selection calls onFile and resets the input", async () => {
    const { props } = mk();
    expect(screen.queryByRole("heading", { name: en("seller.photos.slot.defect") })).toBeNull();
    expect(screen.queryByRole("button", { name: en("seller.photos.remove") })).toBeNull();
    const input = document.querySelector("input[type=file]")!;
    const file = new File([new Uint8Array([1])], "a.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [file] } });
    expect(props.onFile).toHaveBeenCalledWith("main", file);
    fireEvent.change(input, { target: { files: [] } });
    expect(props.onFile).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText(en("seller.details.category")), { target: { value: "" } });
    expect(props.onChange).toHaveBeenCalledWith({ categoryId: "", attributes: {} });
    expect(await clean()).toEqual([]);
  });
  it("a present photo shows Replace and Remove, and Remove calls onRemove", () => {
    const { props } = mk({ state: { ...EMPTY_STATE, categoryId: CATEGORY, photos: { main: { mediaId: "m1", previewUrl: "blob:m" } as never } } });
    expect(screen.getByText(en("seller.photos.replace"))).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: en("seller.photos.remove") })[0]!);
    expect(props.onRemove).toHaveBeenCalledWith("main");
  });
});

describe("PhotosStep: defect card and slot states", () => {
  const defectState = (over: Partial<WizardState> = {}): WizardState => ({ ...EMPTY_STATE, categoryId: CATEGORY, condition: "cosmeticDefect", ...over });
  const mk = (state: WizardState, locale: "ar-EG" | "en-EG" = "en-EG", extra: Partial<Parameters<typeof PhotosStep>[0]> = {}) => {
    const props = { locale, state, categories: [], attributeSet: ATTRIBUTES, progress: {}, photoError: {}, onChange: vi.fn(), onFile: vi.fn(), onRemove: vi.fn(), ...extra };
    return { props, ...render(<PhotosStep {...props} />) };
  };
  it("a perfect condition shows the none hint, no defect form and no defect slot", () => {
    mk({ ...EMPTY_STATE, categoryId: CATEGORY });
    expect(screen.getByText(en("seller.condition.none"))).toBeTruthy();
    expect(screen.queryByLabelText(en("seller.condition.type"))).toBeNull();
  });
  it("a defect condition shows the defect slot and form; each control writes into state.defect", async () => {
    const { props } = mk(defectState());
    expect(screen.getByRole("heading", { name: en("seller.photos.slot.defect") })).toBeTruthy();
    const type = screen.getByLabelText<HTMLSelectElement>(en("seller.condition.type"));
    expect(Array.from(type.options).map((o) => o.textContent)).toEqual([en("seller.condition.typePlaceholder"), "Stain"]);
    fireEvent.change(type, { target: { value: "stain" } });
    expect(props.onChange).toHaveBeenLastCalledWith({ defect: { ...EMPTY_STATE.defect, typeCode: "stain" } });
    fireEvent.change(screen.getByLabelText(en("seller.condition.location")), { target: { value: "cuff" } });
    expect(props.onChange).toHaveBeenLastCalledWith({ defect: { ...EMPTY_STATE.defect, location: "cuff" } });
    const sev = screen.getByLabelText(en("seller.condition.severity"));
    fireEvent.change(sev, { target: { value: "major" } });
    expect(props.onChange).toHaveBeenLastCalledWith({ defect: { ...EMPTY_STATE.defect, severity: "major" } });
    fireEvent.change(sev, { target: { value: "minor" } });
    expect(props.onChange).toHaveBeenLastCalledWith({ defect: { ...EMPTY_STATE.defect, severity: "minor" } });
    const affects = screen.getByRole<HTMLInputElement>("checkbox");
    expect(affects.checked).toBe(false); // affectsFunction defaults to true
    fireEvent.click(affects);
    expect(props.onChange).toHaveBeenLastCalledWith({ defect: { ...EMPTY_STATE.defect, affectsFunction: false } });
    fireEvent.change(screen.getByLabelText(en("seller.condition.notes")), { target: { value: "n" } });
    expect(props.onChange).toHaveBeenLastCalledWith({ notes: "n" });
    expect(screen.getByText(en("seller.condition.notesCount", { count: 0, max: 500 }))).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: en("condition.openBox") }));
    expect(props.onChange).toHaveBeenLastCalledWith({ condition: "openBox" });
    expect(await clean()).toEqual([]);
  });
  it("Arabic locale shows Arabic defect type labels; a missing attribute set yields only the placeholder", () => {
    const { unmount } = mk(defectState(), "ar-EG");
    expect(screen.getByRole("option", { name: "بقعة" })).toBeTruthy();
    unmount();
    mk(defectState(), "en-EG", { attributeSet: null });
    expect((screen.getByLabelText<HTMLSelectElement>(en("seller.condition.type"))).options).toHaveLength(1);
  });
  it("marker clicks write percentages into state.defect, and x/y from state show the status", () => {
    const state = defectState({ defect: { ...EMPTY_STATE.defect, xPct: 10, yPct: 20 }, photos: { defect: { mediaId: "d", name: "d.png", previewUrl: "blob:d" } } });
    const { props } = mk(state);
    expect(screen.getByText(en("seller.condition.markSet", { x: 10, y: 20 }))).toBeTruthy();
    const [x] = screen.getAllByRole("spinbutton");
    fireEvent.change(x!, { target: { value: "30" } });
    expect(props.onChange).toHaveBeenLastCalledWith({ defect: { ...state.defect, xPct: 30, yPct: 20 } });
  });
  it("slot states: upload progress, error alert, and a restored photo without a preview", () => {
    mk({ ...EMPTY_STATE, categoryId: CATEGORY, photos: { main: { mediaId: "m", name: "m.png" }, packaging: { mediaId: "p", name: "p.png", previewUrl: "blob:p" } } }, "en-EG", { progress: { main: 0.5 }, photoError: { packaging: "seller.photos.needDraft" } });
    expect((screen.getByRole<HTMLProgressElement>("progressbar")).value).toBe(50);
    expect(screen.getByText(en("seller.photos.saved"))).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe(en("seller.photos.needDraft"));
    expect(screen.getAllByRole("img").length).toBeGreaterThan(0);
  });
});
