import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "@outlet/i18n";
import type { OnboardingApi, OnboardingWire } from "../src/client/onboarding-api";
import type { ApiFailure, ApiResult } from "../src/client/seller-api";
import { OnboardingFlow } from "../src/components/onboarding/OnboardingFlow";

const t = createTranslator("ar-EG");
const wire = (over: Partial<OnboardingWire> = {}): OnboardingWire => ({
  seller_id: "s", kyc_case_id: "c", status: "DRAFT", submitted_at: null, decided_at: null, decision_reason: null, version: 1,
  gaps: ["document:commercial_register", "document:tax_card", "document:signatory_national_id", "bank_account"], required_documents: ["commercial_register", "tax_card", "signatory_national_id"], ...over,
});
const fail = (status: number, code = "x", reasons: string[] = []): ApiFailure => ({ ok: false, status, code, reasons });
const ok = <T,>(data: T): ApiResult<T> => ({ ok: true, data });

type Overrides = { [K in keyof OnboardingApi]?: OnboardingApi[K] };
const fakeApi = (over: Overrides = {}) => {
  const get = vi.fn<OnboardingApi["get"]>(() => Promise.resolve(ok(wire())));
  const start = vi.fn<OnboardingApi["start"]>(() => Promise.resolve(ok({ seller_id: "s", kyc_case_id: "c" })));
  const setBank = vi.fn<OnboardingApi["setBank"]>(() => Promise.resolve(ok({ iban_last4: "0002" })));
  const uploadDocument = vi.fn<OnboardingApi["uploadDocument"]>((_t, _f, p) => { p(0.5); return Promise.resolve(ok({ document_id: "d" })); });
  const submit = vi.fn<OnboardingApi["submit"]>(() => Promise.resolve(ok(wire({ status: "SUBMITTED", gaps: [] }))));
  const api: OnboardingApi = { get, start, setBank, uploadDocument, submit, ...over };
  return Object.assign(api, { mocks: { get, start, setBank, uploadDocument, submit } });
};
const mount = (api: OnboardingApi, locale: "ar-EG" | "en-EG" = "ar-EG") => render(<OnboardingFlow locale={locale} marketId="EG" api={api} />);
const pdf = (): File => new File(["%PDF-1.4"], "a.pdf", { type: "application/pdf" });
const violations = async (): Promise<string[]> => (await axe.run(document.body, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } })).violations.map((v) => v.id);
const label = (k: Parameters<typeof t>[0]) => t(k);
const IBAN = "EG380019000500000000263180002";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("loading, empty and error states", () => {
  it("shows a busy status while loading, then the empty create form on 404", async () => {
    const api = fakeApi({ get: vi.fn<OnboardingApi["get"]>(() => Promise.resolve(fail(404))) });
    mount(api);
    expect(screen.getByRole("status").getAttribute("aria-busy")).toBe("true");
    expect(await screen.findByText(label("seller.kyc.empty.title"))).toBeTruthy();
    expect(await violations()).toEqual([]);
  });
  it("shows the API problem with a retry, and retry reloads", async () => {
    const get = vi.fn<OnboardingApi["get"]>().mockResolvedValueOnce(fail(403, "passkey-required")).mockResolvedValueOnce(ok(wire()));
    mount(fakeApi({ get }));
    expect((await screen.findByRole("alert")).textContent).toContain(t("seller.error.passkey"));
    fireEvent.click(screen.getByRole("button", { name: label("seller.kyc.retry") }));
    expect(await screen.findByText(label("seller.kyc.status.title"))).toBeTruthy();
  });
  it("shows an offline banner and clears it when the connection returns", async () => {
    mount(fakeApi());
    await screen.findByText(label("seller.kyc.status.title"));
    window.dispatchEvent(new Event("offline"));
    expect((await screen.findAllByRole("alert")).some((a) => a.textContent === t("seller.kyc.offline"))).toBe(true);
    window.dispatchEvent(new Event("online"));
    await waitFor(() => { expect(screen.queryByText(label("seller.kyc.offline"))).toBeNull(); });
  });
});

describe("create the application", () => {
  const fill = (): void => {
    fireEvent.change(screen.getByLabelText(label("seller.kyc.nameAr")), { target: { value: "شركة النور" } });
    fireEvent.change(screen.getByLabelText(label("seller.kyc.nameEn")), { target: { value: "Al Nour" } });
    fireEvent.change(screen.getByLabelText(label("seller.kyc.register")), { target: { value: "12345" } });
    fireEvent.change(screen.getByLabelText(label("seller.kyc.tax")), { target: { value: "678" } });
    fireEvent.change(screen.getByLabelText(label("seller.kyc.governorate")), { target: { value: "cairo" } });
    fireEvent.click(screen.getByRole("checkbox"));
  };
  const empty = async (over: Overrides = {}) => {
    const api = fakeApi({ get: vi.fn<OnboardingApi["get"]>().mockResolvedValueOnce(fail(404)).mockResolvedValue(ok(wire())), ...over });
    mount(api);
    await screen.findByText(label("seller.kyc.empty.title"));
    return api;
  };

  it("validates locally, then sends the legal identity with the Arabic governorate name and previews it", async () => {
    const api = await empty();
    fireEvent.click(screen.getByRole("button", { name: label("seller.kyc.create") }));
    for (const k of ["nameAr", "register", "tax", "governorate", "signatory"] as const) expect(screen.getByText(label(`seller.kyc.err.${k}`))).toBeTruthy();
    expect(screen.getByLabelText(label("seller.kyc.nameAr")).getAttribute("aria-invalid")).toBe("true");
    expect(api.mocks.start).not.toHaveBeenCalled();
    fill();
    const preview = screen.getByRole("complementary");
    expect(within(preview).getByText("شركة النور")).toBeTruthy();
    expect(within(preview).getByText(t("seller.kyc.gov.cairo"))).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: label("seller.kyc.legalType.sole_trader") }));
    fireEvent.click(screen.getByRole("button", { name: label("seller.kyc.create") }));
    await waitFor(() => { expect(api.mocks.start).toHaveBeenCalledTimes(1); });
    expect(api.mocks.start).toHaveBeenCalledWith({ legal_type: "sole_trader", legal_name_ar: "شركة النور", legal_name_en: "Al Nour", commercial_register_no: "12345", tax_card_no: "678", governorate_code: "cairo", governorate_name_ar: t("seller.kyc.gov.cairo") });
    expect(await screen.findByText(label("seller.kyc.status.title"))).toBeTruthy();
    expect(within(screen.getByRole("complementary")).getByText("12345")).toBeTruthy();
  });
  it("omits an empty English name and explains a duplicate register number", async () => {
    const start = vi.fn<OnboardingApi["start"]>(() => Promise.resolve(fail(409, "conflict")));
    await empty({ start });
    fill();
    fireEvent.change(screen.getByLabelText(label("seller.kyc.nameEn")), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: label("seller.kyc.create") }));
    expect((await screen.findByRole("alert")).textContent).toContain(t("seller.kyc.error.conflict"));
    expect(start.mock.calls[0]?.[0]).not.toHaveProperty("legal_name_en");
  });
  it("shows the preview placeholder before anything is typed", async () => {
    await empty();
    expect(within(screen.getByRole("complementary")).getAllByText(label("seller.kyc.preview.pending"))).toHaveLength(4);
  });
});

describe("existing application", () => {
  it("renders the track, required documents from gaps, and the legal-identity notice when the server values cannot be read back", async () => {
    mount(fakeApi());
    await screen.findByText(label("seller.kyc.status.title"));
    expect(screen.getByRole("listitem", { current: "step" }).textContent).toContain(t("seller.kyc.state.DRAFT"));
    expect(screen.getAllByText(label("seller.kyc.docs.missing"))).toHaveLength(3);
    expect(screen.getAllByText(label("seller.kyc.docs.notRequired"))).toHaveLength(3);
    expect(screen.getByText(label("seller.kyc.preview.unavailable"))).toBeTruthy();
    expect(screen.getByRole("button", { name: label("seller.kyc.submit") }).hasAttribute("disabled")).toBe(true);
    expect(await violations()).toEqual([]);
  });
  it("renders in English too", async () => {
    mount(fakeApi(), "en-EG");
    expect(await screen.findByText(createTranslator("en-EG")("seller.kyc.status.title"))).toBeTruthy();
  });

  it("uploads a PDF with progress then refreshes; refuses wrong type and size without calling the API", async () => {
    const get = vi.fn<OnboardingApi["get"]>().mockResolvedValueOnce(ok(wire())).mockResolvedValue(ok(wire({ gaps: ["document:tax_card", "document:signatory_national_id", "bank_account"] })));
    const api = fakeApi({ get });
    mount(api);
    await screen.findByText(label("seller.kyc.status.title"));
    const input = screen.getByLabelText(t("seller.kyc.docs.chooseFor", { doc: t("seller.kyc.doc.commercial_register") }));
    fireEvent.change(input, { target: { files: [new File(["x"], "a.png", { type: "image/png" })] } });
    expect(await screen.findByText(label("seller.kyc.docs.err.type"))).toBeTruthy();
    fireEvent.change(input, { target: { files: [new File([], "e.pdf", { type: "application/pdf" })] } });
    expect(await screen.findByText(label("seller.kyc.docs.err.size"))).toBeTruthy();
    expect(api.mocks.uploadDocument).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { files: [pdf()] } });
    await waitFor(() => { expect(api.mocks.uploadDocument).toHaveBeenCalledWith("commercial_register", expect.any(File), expect.any(Function)); });
    expect(await screen.findAllByText(label("seller.kyc.docs.onFile"))).toHaveLength(1);
    expect(screen.queryByText(label("seller.kyc.docs.err.size"))).toBeNull();
  });
  it.each([[413, "seller.kyc.docs.err.size"], [415, "seller.kyc.docs.err.type"], [503, "seller.kyc.docs.err.unavailable"], [422, "seller.kyc.docs.err.rejected"], [0, "seller.kyc.docs.err.network"], [500, "seller.kyc.docs.err.generic"]] as const)("maps upload status %s to its message", async (status, key) => {
    mount(fakeApi({ uploadDocument: vi.fn<OnboardingApi["uploadDocument"]>(() => Promise.resolve(fail(status))) }));
    await screen.findByText(label("seller.kyc.status.title"));
    fireEvent.change(screen.getByLabelText(t("seller.kyc.docs.chooseFor", { doc: t("seller.kyc.doc.tax_card") })), { target: { files: [pdf()] } });
    expect(await screen.findByText(t(key))).toBeTruthy();
  });
  it("surfaces an expired session during upload as the banner", async () => {
    mount(fakeApi({ uploadDocument: vi.fn<OnboardingApi["uploadDocument"]>(() => Promise.resolve(fail(401, "unauthenticated"))) }));
    await screen.findByText(label("seller.kyc.status.title"));
    fireEvent.change(screen.getByLabelText(t("seller.kyc.docs.chooseFor", { doc: t("seller.kyc.doc.tax_card") })), { target: { files: [pdf()] } });
    await waitFor(() => { expect(screen.getAllByRole("alert").some((a) => a.textContent.includes(t("seller.error.unauthenticated")))).toBe(true); });
  });

  it("validates the IBAN and holder name, saves, and shows only the last characters", async () => {
    const api = fakeApi({ get: vi.fn<OnboardingApi["get"]>().mockResolvedValueOnce(ok(wire())).mockResolvedValue(ok(wire({ gaps: ["document:tax_card"] }))) });
    mount(api);
    await screen.findByText(label("seller.kyc.status.title"));
    const save = screen.getByRole("button", { name: label("seller.kyc.bank.save") });
    fireEvent.change(screen.getByLabelText(label("seller.kyc.bank.iban")), { target: { value: "EG00" } });
    fireEvent.click(save);
    expect(screen.getByText(label("seller.kyc.bank.err.iban"))).toBeTruthy();
    fireEvent.change(screen.getByLabelText(label("seller.kyc.bank.iban")), { target: { value: IBAN.replace(/(.{4})/g, "$1 ") } });
    fireEvent.click(save);
    expect(screen.getByText(label("seller.kyc.bank.err.name"))).toBeTruthy();
    fireEvent.change(screen.getByLabelText(label("seller.kyc.bank.name")), { target: { value: "شركة النور" } });
    fireEvent.click(save);
    await waitFor(() => { expect(api.mocks.setBank).toHaveBeenCalledWith(IBAN, "شركة النور"); });
    expect(await screen.findByText(t("seller.kyc.bank.onFileLast4", { tail: "0002" }))).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>(label("seller.kyc.bank.iban")).value).toBe("");
  });
  it("shows a bank-save failure, and a generic on-file note after reload", async () => {
    mount(fakeApi({ setBank: vi.fn<OnboardingApi["setBank"]>(() => Promise.resolve(fail(0, "network"))), get: vi.fn<OnboardingApi["get"]>(() => Promise.resolve(ok(wire({ gaps: [] })))) }));
    await screen.findByText(label("seller.kyc.status.title"));
    expect(screen.getByText(label("seller.kyc.bank.onFile"))).toBeTruthy();
    fireEvent.change(screen.getByLabelText(label("seller.kyc.bank.iban")), { target: { value: IBAN } });
    fireEvent.change(screen.getByLabelText(label("seller.kyc.bank.name")), { target: { value: "n" } });
    fireEvent.click(screen.getByRole("button", { name: label("seller.kyc.bank.save") }));
    expect((await screen.findAllByRole("alert")).some((a) => a.textContent === t("seller.kyc.error.network"))).toBe(true);
  });

  it("submits when complete and shows the new state", async () => {
    const api = fakeApi({ get: vi.fn<OnboardingApi["get"]>(() => Promise.resolve(ok(wire({ gaps: [] })))) });
    mount(api);
    await screen.findByText(label("seller.kyc.review.ready"));
    fireEvent.click(screen.getByRole("button", { name: label("seller.kyc.submit") }));
    await waitFor(() => { expect(api.mocks.submit).toHaveBeenCalled(); });
    expect(await screen.findByText(new RegExp(t("seller.kyc.state.SUBMITTED.desc")))).toBeTruthy();
    expect(screen.getByText(label("seller.kyc.locked"))).toBeTruthy();
    expect(screen.getByRole("button", { name: label("seller.kyc.submit") }).hasAttribute("disabled")).toBe(true);
  });
  it.each([
    ["under 21", fail(422, "signatory-under-21"), t("seller.kyc.error.under21", { age: 21 })],
    ["incomplete with gaps", fail(422, "kyc-incomplete", ["bank_account", "document:tax_card", "mystery"]), t("seller.kyc.error.incomplete")],
    ["conflict", fail(409, "invalid-transition"), t("seller.kyc.error.conflict")],
    ["network", fail(0, "network"), t("seller.kyc.error.network")],
    ["other problem", fail(403, "passkey-required"), t("seller.error.passkey")],
  ])("explains a failed submit: %s", async (_n, failure, text) => {
    mount(fakeApi({ get: vi.fn<OnboardingApi["get"]>(() => Promise.resolve(ok(wire({ gaps: [] })))), submit: vi.fn<OnboardingApi["submit"]>(() => Promise.resolve(failure)) }));
    await screen.findByText(label("seller.kyc.review.ready"));
    fireEvent.click(screen.getByRole("button", { name: label("seller.kyc.submit") }));
    expect((await screen.findAllByRole("alert")).some((a) => a.textContent.includes(text))).toBe(true);
  });
});

describe("KYC states", () => {
  const stateOf = async (status: OnboardingWire["status"], over: Partial<OnboardingWire> = {}) => {
    mount(fakeApi({ get: vi.fn<OnboardingApi["get"]>(() => Promise.resolve(ok(wire({ status, ...over })))) }));
    await screen.findByText(label("seller.kyc.status.title"));
  };
  it.each(["SUBMITTED", "AUTO_CHECKS", "APPROVED"] as const)("%s is on the track and locks editing", async (s) => {
    await stateOf(s);
    expect(screen.getByRole("listitem", { current: "step" }).textContent).toContain(t(`seller.kyc.state.${s}`));
    expect(screen.getByText(label("seller.kyc.locked"))).toBeTruthy();
    expect(screen.queryByText(label("seller.kyc.needsInfo.title"))).toBeNull();
  });
  it("NEEDS_INFO lists the items we need and keeps the forms editable", async () => {
    await stateOf("NEEDS_INFO", { decision_reason: "doc_unreadable" });
    const box = screen.getByText(label("seller.kyc.needsInfo.title")).closest("div") as HTMLElement;
    expect(within(box).getAllByRole("listitem")).toHaveLength(4);
    expect(within(box).getByText(t("seller.kyc.reason", { reason: "doc_unreadable" }))).toBeTruthy();
    expect(screen.queryByText(label("seller.kyc.locked"))).toBeNull();
    expect(screen.getByRole("button", { name: label("seller.kyc.bank.save") }).hasAttribute("disabled")).toBe(false);
  });
  it("REJECTED and SUSPENDED show the exit state and reason without a missing-items list", async () => {
    await stateOf("REJECTED", { decision_reason: "sanctions_hit" });
    expect(screen.getByText(t("seller.kyc.reason", { reason: "sanctions_hit" }))).toBeTruthy();
    expect(screen.queryByText(label("seller.kyc.needsInfo.title"))).toBeNull();
    cleanup();
    await stateOf("SUSPENDED");
    expect(screen.getByText(new RegExp(t("seller.kyc.state.SUSPENDED.desc")))).toBeTruthy();
  });
});
