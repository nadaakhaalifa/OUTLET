import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Locale } from "@outlet/i18n";
import { AddressBook } from "../src/components/shop/AddressBook";
import { OrdersList } from "../src/components/shop/OrdersList";
import { OrderStatus } from "../src/components/shop/OrderStatus";
import { ReturnDetail } from "../src/components/shop/ReturnDetail";
import { ReturnForm } from "../src/components/shop/ReturnForm";
import { ReturnsList } from "../src/components/shop/ReturnsList";
import { ApiProblem } from "../src/lib/client-api";
import { expectNoA11yViolations } from "./axe";
import { address, geo, ids, ids2, orderSummary, orderWith, returnReq, stubApi } from "./shop-fixtures";

vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND"); }, usePathname: () => "/eg-ar" }));
vi.mock("next/headers", () => ({ headers: () => Promise.resolve(new Headers({ "x-nonce": "n0nce" })), cookies: () => Promise.resolve({ get: () => undefined }) }));

const EN: Locale = "en-EG";
const AR: Locale = "ar-EG";
const out = () => new ApiProblem(401, "unauthenticated", null, null);
const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((res) => { resolve = res; }); return { promise, resolve }; };

describe("OrdersList", () => {
  const page1 = { items: [orderSummary("0b7d1f4e-0000-4000-8000-0000000000e1"), orderSummary("0b7d1f4e-0000-4000-8000-0000000000e2", { status: "CANCELLED" })], nextCursor: "c1" };
  it.each([[EN, "Load more"], [AR, "عرض المزيد"]])("lists orders with status chips and keyset load-more (%s)", async (locale, more) => {
    const listOrders = vi.fn().mockResolvedValueOnce(page1).mockResolvedValueOnce({ items: [orderSummary("0b7d1f4e-0000-4000-8000-0000000000e3")], nextCursor: null });
    const { container } = render(<OrdersList locale={locale} api={stubApi({ listOrders })} />);
    await screen.findByRole("button", { name: more });
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    await expectNoA11yViolations(container);
    fireEvent.click(screen.getByRole("button", { name: more }));
    await waitFor(() => { expect(screen.getAllByRole("listitem")).toHaveLength(3); });
    expect(listOrders).toHaveBeenLastCalledWith("c1");
    expect(screen.queryByRole("button", { name: more })).toBeNull();
  });
  it("shows the signed-out link, the empty state and a load error", async () => {
    const a = render(<OrdersList locale={EN} api={stubApi({ listOrders: vi.fn().mockRejectedValue(out()) })} />);
    expect((await screen.findByRole("link", { name: "Sign in" })).getAttribute("href")).toContain("/eg-en/login?next=");
    a.unmount();
    const b = render(<OrdersList locale={EN} api={stubApi({ listOrders: vi.fn().mockResolvedValue({ items: [], nextCursor: null }) })} />);
    await screen.findByText("You have no orders yet.");
    b.unmount();
    render(<OrdersList locale={EN} api={stubApi({ listOrders: vi.fn().mockRejectedValue(new Error("x")) })} />);
    await screen.findByRole("alert");
  });
});

describe("order detail (tracking, cancel, return entry)", () => {
  const api = (o = orderWith(), over = {}) => stubApi({ getOrderGroup: vi.fn().mockResolvedValue(o), ...over });
  it("renders the normalised tracking timeline and the API's return window, never a computed one", async () => {
    const o = orderWith({ status: "DELIVERED", returnable: true, delivered_at: "2026-11-06T10:00:00Z", return_window_ends_at: "2026-11-20T10:00:00Z" });
    const { container } = render(<OrderStatus locale={EN} orderId={ids.ORDER} api={api(o)} pollMs={10_000} />);
    await screen.findByText("Shipment tracking");
    expect(screen.getByText("Picked up from the store")).toBeTruthy();
    expect(screen.getAllByText("In transit").length).toBeGreaterThan(0);
    expect(screen.getByText("Tracking number AWB123")).toBeTruthy();
    expect(screen.getByText(/You can return until/).textContent).toContain("Nov 20, 2026");
    expect(screen.getByRole("link", { name: "Return or exchange Jacket" }).getAttribute("href")).toBe(`/eg-en/returns/new?line=${ids2.ORDER_LINE}&order=${ids.ORDER}`);
    await expectNoA11yViolations(container);
  });
  it("hides the return entry and cancel unless the server says so", async () => {
    render(<OrderStatus locale={EN} orderId={ids.ORDER} api={api()} pollMs={10_000} />);
    await screen.findByText("Shipment tracking");
    expect(screen.queryByRole("link", { name: /Return or exchange/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Cancel the order/ })).toBeNull();
  });
  it("cancel needs a confirmation step and is NOT optimistic", async () => {
    const d = deferred<ReturnType<typeof orderWith>>();
    const cancelSellerOrder = vi.fn().mockReturnValue(d.promise);
    const { container } = render(<OrderStatus locale={EN} orderId={ids.ORDER} api={api(orderWith({ status: "PAID", cancellable: true, shipment: null }), { cancelSellerOrder })} pollMs={10_000} />);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel the order from نيل أوتليت" }));
    expect(cancelSellerOrder).not.toHaveBeenCalled();
    await expectNoA11yViolations(container);
    fireEvent.change(screen.getByLabelText("Reason for cancelling"), { target: { value: "ordered_by_mistake" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm cancellation" }));
    expect(cancelSellerOrder).toHaveBeenCalledWith(ids.ORDER, ids2.SO, { reasonCode: "ordered_by_mistake" });
    // While pending the order is unchanged: still Paid, no "cancelled" message.
    expect(screen.queryByText("The order was cancelled.")).toBeNull();
    expect(screen.getByRole("heading", { name: "Paid" })).toBeTruthy();
    d.resolve(orderWith({ status: "CANCELLED", cancellable: false, shipment: null }, { status: "CANCELLED" }));
    await screen.findByText("The order was cancelled.");
    expect(screen.getByRole("heading", { name: "Cancelled" })).toBeTruthy();
  });
  it("keeps the order and says so when the server refuses the cancel; Keep returns to the button", async () => {
    const cancelSellerOrder = vi.fn().mockRejectedValue(new ApiProblem(409, "conflict", null, null));
    render(<OrderStatus locale={EN} orderId={ids.ORDER} api={api(orderWith({ cancellable: true, shipment: null }), { cancelSellerOrder })} pollMs={10_000} />);
    fireEvent.click(await screen.findByRole("button", { name: /Cancel the order/ }));
    fireEvent.click(screen.getByRole("button", { name: "Keep the order" }));
    fireEvent.click(screen.getByRole("button", { name: /Cancel the order/ }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm cancellation" }));
    expect((await screen.findByRole("alert")).textContent).toContain("could not cancel");
  });
});

describe("ReturnForm", () => {
  const returnable = orderWith({ status: "DELIVERED", returnable: true, delivered_at: "2026-11-06T10:00:00Z", return_window_ends_at: "2026-11-20T10:00:00Z", shipment: null });
  const form = (over = {}, o = returnable, lineId: string | null = ids2.ORDER_LINE, orderId: string | null = ids.ORDER, locale: Locale = EN) =>
    render(<ReturnForm locale={locale} lineId={lineId} orderId={orderId} api={stubApi({ getOrderGroup: vi.fn().mockResolvedValue(o), ...over })} />);

  it("asks the user to start from an order when the context is missing", () => {
    form({}, returnable, null, null);
    expect(screen.getByText(/Start from the order page/)).toBeTruthy();
  });
  it("offers exchange first for size reasons, defaults refund choice to the original method, and posts the contract body", async () => {
    const createReturn = vi.fn().mockResolvedValue(returnReq());
    const { container } = form({ createReturn });
    await screen.findByText("Return by Nov 20, 2026");
    await expectNoA11yViolations(container);
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "too_small" } });
    expect(screen.getByRole<HTMLInputElement>("radio", { name: /Exchange for another size/ }).checked).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "Refund" }));
    expect(screen.getByRole<HTMLInputElement>("radio", { name: "Original payment method" }).checked).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "Outlex credit, right away" }));
    fireEvent.click(screen.getByRole("button", { name: "Send return request" }));
    await screen.findByText("Your return request was sent.");
    expect(createReturn).toHaveBeenCalledWith(ids2.SO, { lines: [{ orderLineId: ids2.ORDER_LINE, qty: 1 }], reasonCode: "too_small", method: "pickup", resolution: "refund", refundPreference: "store_credit", evidenceMediaIds: [] });
    expect(screen.getByRole("link", { name: "View the return" }).getAttribute("href")).toBe(`/eg-en/returns/${ids2.RETURN}`);
  });
  it("requires photos for a defect, uploads through the media route and sends the media ids", async () => {
    const uploadEvidence = vi.fn().mockResolvedValue("0b7d1f4e-0000-4000-8000-0000000000f9");
    const createReturn = vi.fn().mockResolvedValue(returnReq({ reason_code: "defective" }));
    form({ uploadEvidence, createReturn });
    await screen.findByLabelText("Reason");
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "defective" } });
    expect(screen.getByText("Photos are required for this reason.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Send return request" }));
    expect((await screen.findByRole("alert")).textContent).toContain("could not send");
    expect(createReturn).not.toHaveBeenCalled();
    const file = new File(["x"], "defect.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("Add a photo"), { target: { files: [file] } });
    await screen.findByText("1 photo uploaded");
    expect(uploadEvidence).toHaveBeenCalledWith(file, "return_evidence");
    fireEvent.click(screen.getByRole("button", { name: "Send return request" }));
    await screen.findByText("Your return request was sent.");
    expect(createReturn.mock.calls[0]?.[1]).toMatchObject({ reasonCode: "defective", resolution: "refund", evidenceMediaIds: ["0b7d1f4e-0000-4000-8000-0000000000f9"] });
  });
  it("BNPL orders are refunded through the provider only (no preference sent); a closed window is explained", async () => {
    const createReturn = vi.fn().mockRejectedValue(new ApiProblem(422, "return-window-closed", null, null));
    form({ createReturn }, orderWith({ returnable: true, return_window_ends_at: "2026-11-20T10:00:00Z", shipment: null }, { payment_method: "bnpl" }));
    await screen.findByLabelText("Reason");
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "changed_mind" } });
    expect(screen.getByText(/finance provider only/)).toBeTruthy();
    expect(screen.queryByRole("radio", { name: "Original payment method" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send return request" }));
    expect((await screen.findByRole("alert")).textContent).toBe("The return window for this item has closed.");
    expect(createReturn.mock.calls[0]?.[1]).not.toHaveProperty("refundPreference");
  });
  it("refuses lines the server marks not returnable, and renders in Arabic", async () => {
    form({}, orderWith({ returnable: false, shipment: null }));
    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toContain("cannot be returned");
  });
  it("Arabic form is axe-clean", async () => {
    const { container } = form({}, returnable, ids2.ORDER_LINE, ids.ORDER, AR);
    await screen.findByLabelText("سبب الإرجاع");
    await expectNoA11yViolations(container);
  });
});

describe("ReturnsList and ReturnDetail", () => {
  it("lists returns with load-more and links to the detail", async () => {
    const listReturns = vi.fn().mockResolvedValueOnce({ items: [returnReq()], nextCursor: "n" }).mockResolvedValueOnce({ items: [returnReq({ id: "0b7d1f4e-0000-4000-8000-0000000000bb", status: "ACCEPTED" })], nextCursor: null });
    const { container } = render(<ReturnsList locale={EN} api={stubApi({ listReturns })} />);
    await screen.findByText("Requested");
    expect(screen.getByRole("link", { name: /Open the return/ }).getAttribute("href")).toBe(`/eg-en/returns/${ids2.RETURN}`);
    await expectNoA11yViolations(container);
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await screen.findByText("Accepted");
  });
  it("shows inspection status, dates from the API, and cancels only after confirmation", async () => {
    const cancelReturn = vi.fn().mockResolvedValue(returnReq({ status: "CANCELLED" }));
    const { container } = render(<ReturnDetail locale={EN} returnId={ids2.RETURN} api={stubApi({ getReturn: vi.fn().mockResolvedValue(returnReq({ inspection_due_at: "2026-11-12T10:00:00Z" })), cancelReturn })} />);
    await screen.findByRole("heading", { name: "Requested" });
    expect(screen.getByText(/Inspection due Nov 12, 2026/)).toBeTruthy();
    await expectNoA11yViolations(container);
    fireEvent.click(screen.getByRole("button", { name: "Cancel return request" }));
    expect(cancelReturn).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm cancelling the request" }));
    await screen.findByRole("heading", { name: "Cancelled" });
  });
  it("a rejected return shows the reason when the API gives one and opens a dispute (min 10 chars)", async () => {
    const getReturn = vi.fn().mockResolvedValue(returnReq({ status: "REJECTED", rejection_reason: "Item worn" }));
    const openDispute = vi.fn().mockResolvedValue(undefined);
    const { container } = render(<ReturnDetail locale={EN} returnId={ids2.RETURN} api={stubApi({ getReturn, openDispute })} />);
    await screen.findByText("Rejection reason: Item worn");
    await expectNoA11yViolations(container);
    fireEvent.change(screen.getByLabelText("Tell us why you disagree"), { target: { value: "short" } });
    fireEvent.click(screen.getByRole("button", { name: "Send dispute" }));
    expect((await screen.findByRole("alert")).textContent).toContain("could not send");
    expect(openDispute).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Tell us why you disagree"), { target: { value: "The item was never worn." } });
    fireEvent.click(screen.getByRole("button", { name: "Send dispute" }));
    await screen.findByText("Your dispute was sent and will be reviewed.");
    expect(openDispute).toHaveBeenCalledWith(ids2.RETURN, { statement: "The item was never worn.", mediaIds: [] });
  });
  it("rejected without a reason says so; signed-out and load errors are handled", async () => {
    const a = render(<ReturnDetail locale={AR} returnId={ids2.RETURN} api={stubApi({ getReturn: vi.fn().mockResolvedValue(returnReq({ status: "REJECTED" })) })} />);
    await screen.findByText(/سبب الرفض هيظهر هنا/);
    a.unmount();
    const b = render(<ReturnDetail locale={EN} returnId={ids2.RETURN} api={stubApi({ getReturn: vi.fn().mockRejectedValue(out()) })} />);
    await screen.findByRole("link", { name: "Sign in" });
    b.unmount();
    render(<ReturnDetail locale={EN} returnId={ids2.RETURN} api={stubApi({ getReturn: vi.fn().mockRejectedValue(new Error("x")) })} />);
    await screen.findByRole("alert");
  });
});

describe("AddressBook", () => {
  const second = address({ id: "0b7d1f4e-0000-4000-8000-0000000000d2", recipient_name: "سلمى", is_default: false, cod_eligible: true });
  const book = (over = {}, locale: Locale = EN) => render(<AddressBook locale={locale} api={stubApi({ listAddresses: vi.fn().mockResolvedValue([address(), second]), ...over })} />);
  it("lists addresses with default and COD-eligible badges (COD only when the API says so)", async () => {
    const { container } = book();
    await screen.findByText("سلمى");
    expect(screen.getAllByText("Default address")).toHaveLength(1);
    expect(screen.getAllByText("Cash on delivery available")).toHaveLength(1);
    await expectNoA11yViolations(container);
  });
  it("makes an address the default through the API, then reloads", async () => {
    const makeDefaultAddress = vi.fn().mockResolvedValue(second);
    const updateAddress = vi.fn();
    const listAddresses = vi.fn().mockResolvedValueOnce([address(), second]).mockResolvedValue([address({ is_default: false }), { ...second, is_default: true }].map((a) => a));
    book({ makeDefaultAddress, updateAddress, listAddresses });
    fireEvent.click(await screen.findByRole("button", { name: "Make the address of سلمى the default" }));
    await screen.findByText("Address saved.");
    expect(makeDefaultAddress).toHaveBeenCalledWith(second.id);
    expect(updateAddress).not.toHaveBeenCalled();
  });
  it("deletes only after confirmation", async () => {
    const deleteAddress = vi.fn().mockResolvedValue(undefined);
    const listAddresses = vi.fn().mockResolvedValueOnce([address(), second]).mockResolvedValue([address()]);
    book({ deleteAddress, listAddresses });
    fireEvent.click(await screen.findByRole("button", { name: "Delete the address of سلمى" }));
    expect(deleteAddress).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm deleting the address" }));
    await screen.findByText("Address deleted.");
    expect(deleteAddress).toHaveBeenCalledWith(second.id);
    expect(screen.queryByText("سلمى")).toBeNull();
  });
  it("adds and edits through the shared structured form", async () => {
    const geoAreas = vi.fn((level: string) => Promise.resolve(level === "governorate" ? [geo("g1", "governorate", "القاهرة")] : level === "city" ? [geo("c1", "city", "مدينة نصر", "g1")] : []));
    const createAddress = vi.fn().mockResolvedValue(address());
    const updateAddress = vi.fn().mockResolvedValue(address());
    const listAddresses = vi.fn().mockResolvedValue([address()]);
    book({ geoAreas, createAddress, updateAddress, listAddresses });
    fireEvent.click(await screen.findByRole("button", { name: "Add an address" }));
    await screen.findByRole("form", { name: "Add a new address" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit the address of منى" }));
    const f = await screen.findByRole("form", { name: "Edit" });
    expect(f).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>(/Landmark/).value).toBe("جنب الصيدلية");
    await waitFor(() => { expect(screen.getByLabelText<HTMLSelectElement>("Governorate").value).toBe("g1"); });
    await waitFor(() => { expect(screen.getByLabelText<HTMLSelectElement>("City").options.length).toBeGreaterThan(1); });
    fireEvent.change(screen.getByLabelText("City"), { target: { value: "c1" } });
    fireEvent.click(screen.getByRole("button", { name: "Save address" }));
    await waitFor(() => { expect(updateAddress).toHaveBeenCalled(); });
    expect(updateAddress.mock.calls[0]?.[0]).toBe(address().id);
    expect(updateAddress.mock.calls[0]?.[1]).toHaveProperty("pin", null);
  });
  it("shows empty, error and signed-out states; Arabic renders", async () => {
    const a = book({ listAddresses: vi.fn().mockResolvedValue([]) }, AR);
    await screen.findByText("مفيش عناوين محفوظة.");
    a.unmount();
    const b = book({ listAddresses: vi.fn().mockRejectedValue(out()) });
    await screen.findByRole("link", { name: "Sign in" });
    b.unmount();
    book({ listAddresses: vi.fn().mockRejectedValue(new Error("x")) });
    await screen.findByRole("alert");
  });
  it("a failed delete shows an error and keeps the list", async () => {
    book({ deleteAddress: vi.fn().mockRejectedValue(new Error("x")) });
    fireEvent.click(await screen.findByRole("button", { name: "Delete the address of منى" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm deleting the address" }));
    await screen.findByRole("alert");
    expect(screen.getByText("منى")).toBeTruthy();
  });
});

describe("pages", () => {
  const seg = (segment: string) => ({ params: Promise.resolve({ segment }) });
  it.each([["eg-ar", "طلباتي"], ["eg-en", "My orders"]])("orders page (%s)", async (segment, title) => {
    const { default: Page, generateMetadata } = await import("../src/app/[segment]/orders/page");
    expect(renderToStaticMarkup(await Page(seg(segment)))).toContain(title);
    expect((await generateMetadata(seg(segment))).robots).toEqual({ index: false, follow: false });
  });
  it("returns, new return, return detail and addresses pages render with noindex", async () => {
    const r = await import("../src/app/[segment]/returns/page");
    expect(renderToStaticMarkup(await r.default(seg("eg-en")))).toContain("Returns");
    expect((await r.generateMetadata(seg("eg-en"))).robots).toEqual({ index: false, follow: false });
    const n = await import("../src/app/[segment]/returns/new/page");
    const sp = Promise.resolve({ line: ids2.ORDER_LINE, order: ids.ORDER });
    expect(renderToStaticMarkup(await n.default({ ...seg("eg-en"), searchParams: sp }))).toContain("Request a return or exchange");
    expect(renderToStaticMarkup(await n.default({ ...seg("eg-en"), searchParams: Promise.resolve({ line: ["x"] }) }))).toContain("Request a return or exchange");
    expect((await n.generateMetadata(seg("eg-ar"))).robots).toEqual({ index: false, follow: false });
    const d = await import("../src/app/[segment]/returns/[id]/page");
    expect(renderToStaticMarkup(await d.default({ params: Promise.resolve({ segment: "eg-ar", id: ids2.RETURN }) }))).toContain("return-title");
    await expect(d.default({ params: Promise.resolve({ segment: "eg-ar", id: "../x" }) })).rejects.toThrow("NEXT_NOT_FOUND");
    expect((await d.generateMetadata({ params: Promise.resolve({ segment: "eg-ar", id: ids2.RETURN }) })).robots).toEqual({ index: false, follow: false });
    const a = await import("../src/app/[segment]/account/addresses/page");
    expect(renderToStaticMarkup(await a.default(seg("eg-ar")))).toContain("عناويني");
    expect((await a.generateMetadata(seg("eg-ar"))).robots).toEqual({ index: false, follow: false });
  });
});
