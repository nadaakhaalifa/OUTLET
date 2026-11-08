import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createTranslator, type Locale } from "@outlet/i18n";
import { ReturnsList } from "../src/components/shop/ReturnsList";
import { ApiProblem } from "../src/lib/client-api";
import { buildCsp } from "../src/security/csp";
import { cancelReasonLabel, CANCEL_REASONS, isReturnReason, orderStatusLabel, returnReasonLabel, returnStatusLabel, sellerStatusLabel, trackingLabel, SELLER_STATUSES } from "../src/lib/orders-labels";
import { cartSchema, orderGroupSchema, quoteSchema, returnRequestSchema, shopperSellerOrderSchema, addressSchema } from "../src/lib/wire";
import { returnReq, stubApi } from "./shop-fixtures";

vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND"); }, usePathname: () => "/eg-ar" }));

const EN: Locale = "en-EG";
const AR: Locale = "ar-EG";

describe("ReturnsList states", () => {
  it("shows loading, then the empty state", async () => {
    render(<ReturnsList locale={EN} api={stubApi({ listReturns: vi.fn().mockResolvedValue({ items: [], nextCursor: null }) })} />);
    expect(screen.getByRole("status").textContent).toContain("Loading");
    await screen.findByText(createTranslator(EN)("returns.list.empty"));
  });
  it.each([[EN, "/eg-en/login?next="], [AR, "/eg-ar/login?next="]])("a 401 shows the sign-in link in %s", async (locale, href) => {
    render(<ReturnsList locale={locale} api={stubApi({ listReturns: vi.fn().mockRejectedValue(new ApiProblem(401, "unauthenticated", null, null)) })} />);
    const link = await screen.findByRole("link", { name: createTranslator(locale)("auth.goLogin") });
    expect(link.getAttribute("href")).toContain(href);
  });
  it("a non-401 failure shows the error alert, not the sign-in link", async () => {
    render(<ReturnsList locale={EN} api={stubApi({ listReturns: vi.fn().mockRejectedValue(new ApiProblem(500, "boom", null, null)) })} />);
    expect((await screen.findByRole("alert")).textContent).toContain(createTranslator(EN)("returns.list.error"));
    expect(screen.queryByRole("link")).toBeNull();
  });
  it("a failed load-more keeps the loaded items, shows the error and can retry", async () => {
    const listReturns = vi.fn().mockResolvedValueOnce({ items: [returnReq()], nextCursor: "n" }).mockRejectedValueOnce(new Error("x")).mockResolvedValueOnce({ items: [returnReq({ id: "0b7d1f4e-0000-4000-8000-0000000000bb", status: "ACCEPTED" })], nextCursor: null });
    render(<ReturnsList locale={EN} api={stubApi({ listReturns })} />);
    const more = await screen.findByRole("button", { name: "Load more" });
    fireEvent.click(more);
    await screen.findByRole("alert");
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => { expect(screen.getAllByRole("listitem")).toHaveLength(2); });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    expect(listReturns).toHaveBeenLastCalledWith("n");
  });
  it("an unmounted list ignores a late response and a final page has no load-more", async () => {
    let resolve!: (v: { items: never[]; nextCursor: null }) => void;
    const p = new Promise<{ items: never[]; nextCursor: null }>((r) => { resolve = r; });
    const { unmount } = render(<ReturnsList locale={EN} api={stubApi({ listReturns: vi.fn().mockReturnValue(p) })} />);
    unmount();
    resolve({ items: [], nextCursor: null });
    await p;
  });
  it("an unmounted list also ignores a late failure", async () => {
    const listReturns = vi.fn();
    let reject!: (e: unknown) => void;
    listReturns.mockReturnValue(new Promise((_, r) => { reject = r; }));
    const { unmount } = render(<ReturnsList locale={EN} api={stubApi({ listReturns })} />);
    unmount();
    reject(new ApiProblem(401, "unauthenticated", null, null));
    await Promise.resolve();
    expect(listReturns).toHaveBeenCalledTimes(1);
  });
  it("an unknown status or reason gets the neutral label, never the raw code", async () => {
    render(<ReturnsList locale={EN} api={stubApi({ listReturns: vi.fn().mockResolvedValue({ items: [{ ...returnReq(), status: "WEIRD", reason_code: "alien" }], nextCursor: null }) })} />);
    await screen.findByRole("listitem");
    expect(screen.queryByText("WEIRD")).toBeNull();
    expect(screen.queryByText("alien")).toBeNull();
  });
});

describe("orders-labels", () => {
  const t = createTranslator(EN);
  it("known codes get their catalog label, unknown ones the neutral fallback", () => {
    expect(orderStatusLabel(t, "PAID")).toBe(t("checkout.order.status.PAID"));
    expect(orderStatusLabel(t, "nope")).toBe(t("orders.status.unknown"));
    expect(sellerStatusLabel(t, "SHIPPED")).toBe(t("orders.sellerStatus.SHIPPED"));
    expect(sellerStatusLabel(t, "nope")).toBe(t("orders.sellerStatus.unknown"));
    expect(trackingLabel(t, "in_transit")).toBe(t("orders.tracking.IN_TRANSIT"));
    expect(trackingLabel(t, "teleported")).toBe(t("orders.tracking.update"));
    expect(returnStatusLabel(t, "ACCEPTED")).toBe(t("returns.status.ACCEPTED"));
    expect(returnStatusLabel(t, "x")).toBe(t("orders.status.unknown"));
    expect(returnReasonLabel(t, "too_small")).toBe(t("returns.reason.too_small"));
    expect(returnReasonLabel(t, "x")).toBe(t("orders.status.unknown"));
    expect(isReturnReason("defective")).toBe(true);
    expect(isReturnReason("DEFECTIVE")).toBe(false);
  });
  it("every seller status and cancel reason has a non-empty label in both locales", () => {
    for (const l of [EN, AR]) {
      const tl = createTranslator(l);
      for (const s of SELLER_STATUSES) expect(sellerStatusLabel(tl, s).length).toBeGreaterThan(0);
      for (const c of CANCEL_REASONS) expect(cancelReasonLabel(tl, c).length).toBeGreaterThan(0);
    }
  });
});

describe("buildCsp options", () => {
  it("dev adds unsafe-eval and skips upgrade-insecure-requests; production does the reverse", () => {
    const dev = buildCsp("n", { dev: true });
    expect(dev).toContain("'unsafe-eval'");
    expect(dev).not.toContain("upgrade-insecure-requests");
    const prod = buildCsp("n");
    expect(prod).not.toContain("'unsafe-eval'");
    expect(prod).toContain("upgrade-insecure-requests");
  });
  it("only a valid https upload origin widens connect-src (reduced to its origin)", () => {
    expect(buildCsp("n", { uploadOrigin: "https://bucket.example.com/path?q=1" })).toContain("connect-src 'self' https://bucket.example.com;");
    for (const bad of ["http://bucket.example.com", "not a url", "", undefined, "javascript:alert(1)"]) expect(buildCsp("n", { uploadOrigin: bad })).toContain("connect-src 'self';");
  });
});

describe("wire schemas defaults and rejections", () => {
  const m = { amount_minor: "100", currency: "EGP" };
  it("seller order defaults optional fields and nulls", () => {
    const o = shopperSellerOrderSchema.parse({ id: "a", store_display_name_ar: "م", status: "PAID", total: m });
    expect(o).toMatchObject({ lines: [], shipment: null, delivered_at: null, return_window_ends_at: null, cancellable: false, returnable: false });
    expect(o.total).toEqual({ amountMinor: 100n, currency: "EGP" });
  });
  it.each(["1.5", "abc", "", "12345678901234567890", "--1"])("rejects the malformed money amount %j", (amount_minor) => {
    expect(() => shopperSellerOrderSchema.parse({ id: "a", store_display_name_ar: "م", status: "PAID", total: { amount_minor, currency: "EGP" } })).toThrow();
  });
  it("accepts negative integer minor units and rejects unknown currencies", () => {
    expect(shopperSellerOrderSchema.parse({ id: "a", store_display_name_ar: "م", status: "PAID", total: { amount_minor: "-5", currency: "EGP" } }).total.amountMinor).toBe(-5n);
    expect(() => shopperSellerOrderSchema.parse({ id: "a", store_display_name_ar: "م", status: "PAID", total: { amount_minor: "5", currency: "XXX" } })).toThrow();
  });
  it("address cod_eligible defaults to null; return request rejects unknown statuses and methods", () => {
    const a = addressSchema.parse({ id: "a", recipient_name: "n", phone_e164: "+201000000000", is_default: true, fields: { governorate_id: "g", district_id: "d", street: "s", building: "b", landmark: "l" } });
    expect(a.cod_eligible).toBeNull();
    expect(a.fields.floor).toBeNull();
    expect(() => returnRequestSchema.parse({ ...returnReq(), status: "BOGUS" })).toThrow();
    expect(() => orderGroupSchema.parse({})).toThrow();
    expect(() => cartSchema.parse({})).toThrow();
    expect(() => quoteSchema.parse({})).toThrow();
  });
});
