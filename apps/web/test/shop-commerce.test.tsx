import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Locale } from "@outlet/i18n";
import { money } from "@outlet/money";
import { BagView } from "../src/components/shop/BagView";
import { CheckoutView, freshQuoteFrom, isSafeRedirect } from "../src/components/shop/CheckoutView";
import { OrderStatus } from "../src/components/shop/OrderStatus";
import { ApiProblem } from "../src/lib/client-api";
import { expectNoA11yViolations } from "./axe";
import { address, cart, geo, ids, m, order, placed, quote, stubApi, wireLine, wireQuote } from "./shop-fixtures";

afterEach(() => { vi.useRealTimers(); });
const EN: Locale = "en-EG";
const brief = { id: ids.PROD, title_ar: "جاكيت", title_en: "Jacket", skus: [{ sku_id: ids.SKU, size_label: "M" }] };
const deferred = <T,>() => { let resolve!: (v: T) => void; let reject!: (e: unknown) => void; const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };
const out = () => new ApiProblem(401, "unauthenticated", null, null);

const bagApi = (over = {}) => stubApi({ getCart: vi.fn().mockResolvedValue(cart()), getProductBrief: vi.fn().mockResolvedValue(brief), ...over });

describe("BagView", () => {
  it("groups by store with free-delivery progress, product names and server totals only", async () => {
    render(<BagView locale={EN} api={bagApi()} />);
    await screen.findByRole("heading", { name: "نيل أوتليت" });
    expect(screen.getByRole("progressbar").getAttribute("aria-valuetext")).toBe("Add EGP 1,200 from نيل أوتليت to get free delivery");
    expect(await screen.findByText("Jacket")).toBeTruthy();
    expect(screen.getByText("Size M")).toBeTruthy();
    expect(screen.getByText("Items subtotal").nextElementSibling?.textContent).toBe("EGP 800");
    expect(screen.getByRole("link", { name: "Go to checkout" }).getAttribute("href")).toBe("/eg-en/checkout");
    expect(document.querySelector("[style]")).toBeNull();
  });

  it("quantity is optimistic: it changes at once, totals stay the server's, and the server cart replaces it", async () => {
    const d = deferred<ReturnType<typeof cart>>();
    const api = bagApi({ setQty: vi.fn().mockReturnValue(d.promise) });
    const { container } = render(<BagView locale={EN} api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Increase quantity of Jacket" }));
    expect(container.querySelector("output")?.textContent).toBe("2");
    expect(screen.getByText("Items subtotal").nextElementSibling?.textContent).toBe("EGP 800");
    expect(api.setQty).toHaveBeenCalledWith(ids.LINE, 2);
    expect((screen.getByRole<HTMLButtonElement>("button", { name: "Increase quantity of Jacket" })).disabled).toBe(true);
    await act(async () => { d.resolve(cart([wireLine({ qty: 2 })], { items_subtotal: m(160_000) })); await d.promise; });
    expect(screen.getByText("Items subtotal").nextElementSibling?.textContent).toBe("EGP 1,600");
  });

  it("rolls the quantity back and says so when the server refuses", async () => {
    const api = bagApi({ setQty: vi.fn().mockRejectedValue(new ApiProblem(409, "stock-shortfall", null, null)) });
    const { container } = render(<BagView locale={EN} api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Increase quantity of Jacket" }));
    expect((await screen.findByRole("alert")).textContent).toBe("We could not update the quantity. We restored the previous one.");
    expect(container.querySelector("output")?.textContent).toBe("1");
  });

  it("stays within 1..10 and removes a line from the server's answer (not optimistic)", async () => {
    const d = deferred<ReturnType<typeof cart>>();
    const api = bagApi({ getCart: vi.fn().mockResolvedValue(cart([wireLine({ qty: 10 })])), removeLine: vi.fn().mockReturnValue(d.promise) });
    render(<BagView locale={EN} api={api} />);
    const inc = await screen.findByRole("button", { name: "Increase quantity of Jacket" });
    expect((inc as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Remove Jacket" }));
    expect(screen.getByRole("heading", { name: "نيل أوتليت" })).toBeTruthy();
    await act(async () => { d.resolve(cart([])); await d.promise; });
    expect(screen.getByText("Your bag is empty")).toBeTruthy();
  });

  it("shows honest price dropped / rose chips from the server prices, and nothing when unchanged", async () => {
    const dropped = wireLine({ price_at_add: m(90_000), current_price: { current_price: m(80_000), claim_type: "plain", price_proof_path: "/p" } });
    const rose = wireLine({ id: "line-2", price_at_add: m(70_000), current_price: { current_price: m(80_000), claim_type: "plain", price_proof_path: "/p" } });
    render(<BagView locale={EN} api={bagApi({ getCart: vi.fn().mockResolvedValue(cart([dropped, rose, wireLine({ id: "line-3" })])) })} />);
    expect(await screen.findByText("Price dropped since you added it (was EGP 900)")).toBeTruthy();
    expect(screen.getByText("Price rose since you added it (was EGP 700)")).toBeTruthy();
    expect(screen.getAllByText(/since you added it/)).toHaveLength(2);
  });

  it("an unavailable line and a store-locked line lose the stepper and are labelled; no checkout link when nothing is buyable", async () => {
    const lines = [wireLine({ available: false }), wireLine({ id: "line-2" })];
    const c = cart(lines, { notices: [{ code: "store_suspended", line_id: "line-2" }, { code: "threshold_changed" }] });
    render(<BagView locale={EN} api={bagApi({ getCart: vi.fn().mockResolvedValue(c) })} />);
    await screen.findByText("Currently unavailable");
    expect(screen.getByText("This store is paused. This item will not be included in your order.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Increase quantity/ })).toBeNull();
    expect(screen.queryByRole("link", { name: "Go to checkout" })).toBeNull();
    expect(screen.getByText(/free delivery threshold changed/)).toBeTruthy();
  });

  it("defect acknowledgement is offered when required and posts the card version", async () => {
    const line = wireLine({ defect_ack_required: true, defect_card_id: "dc1", defect_card_version: 4, defect_ack_count: 2 });
    const api = bagApi({ getCart: vi.fn().mockResolvedValue(cart([line])), ackDefects: vi.fn().mockResolvedValue(cart([wireLine({ defect_ack_required: true, defect_ack_at: "2026-11-08T10:00:00Z" })])) });
    render(<BagView locale={EN} api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "I have seen the defects (2)" }));
    await waitFor(() => { expect(api.ackDefects).toHaveBeenCalledWith(ids.LINE, { defectCardId: "dc1", version: 4, defectCount: 2 }); });
    await waitFor(() => { expect(screen.queryByRole("button", { name: /seen the defects/ })).toBeNull(); });
  });

  it("falls back to a generic name when the product lookup fails, and handles sign-out / load errors", async () => {
    const { unmount } = render(<BagView locale={EN} api={bagApi({ getProductBrief: vi.fn().mockRejectedValue(new Error("x")) })} />);
    await screen.findAllByText("Item");
    unmount();
    const o = render(<BagView locale={EN} api={bagApi({ getCart: vi.fn().mockRejectedValue(out()) })} />);
    expect((await screen.findByRole("link", { name: "Sign in" })).getAttribute("href")).toBe("/eg-en/login?next=%2Feg-en%2Fbag");
    o.unmount();
    render(<BagView locale={EN} api={bagApi({ getCart: vi.fn().mockRejectedValue(new Error("x")) })} />);
    expect((await screen.findByRole("alert")).textContent).toBe("We could not load your bag.");
  });

  it.each([["ar-EG"], ["en-EG"]] as const)("has no axe violations (%s)", async (locale) => {
    const { container } = render(<BagView locale={locale} api={bagApi()} />);
    await screen.findByText(locale === "en-EG" ? "Jacket" : "جاكيت");
    await expectNoA11yViolations(container);
  });
});

describe("helpers", () => {
  it("only https or same-origin redirects are followed", () => {
    expect(isSafeRedirect("https://pay.example/x", "http://localhost:3100", ["pay.example"])).toBe(true);
    expect(isSafeRedirect("https://pay.example/x", "http://localhost:3100", [])).toBe(false);
    expect(isSafeRedirect("https://other.example/x", "http://localhost:3100", ["pay.example"])).toBe(false);
    expect(isSafeRedirect("http://pay.example/x", "http://localhost:3100", ["pay.example"])).toBe(false);
    expect(isSafeRedirect("http://localhost:3100/eg-ar/orders/1", "http://localhost:3100")).toBe(true);
    for (const bad of ["javascript:alert(1)", "http://evil.test/x", "data:text/html,x", "//evil.test"]) expect(isSafeRedirect(bad, "http://localhost:3100")).toBe(false);
  });
  it("reads the fresh quote from the 409 body, top level or nested", () => {
    expect(freshQuoteFrom(wireQuote())?.quote_token).toBe("qt-1");
    expect(freshQuoteFrom({ quote: wireQuote({ quote_token: "n" }) })?.quote_token).toBe("n");
    expect(freshQuoteFrom({ type: "x" })).toBeNull();
    expect(freshQuoteFrom(null)).toBeNull();
  });
});

const GEO = { governorate: [geo("g1", "governorate", "القاهرة")], city: [geo("c1", "city", "مدينة نصر", "g1")], district: [] };
const checkoutApi = (over = {}) => stubApi({
  getCart: vi.fn().mockResolvedValue(cart()), listAddresses: vi.fn().mockResolvedValue([address()]), walletBalance: vi.fn().mockResolvedValue(null),
  quote: vi.fn().mockResolvedValue(quote()), geoAreas: vi.fn((level: "governorate" | "city" | "district") => Promise.resolve(GEO[level])), ...over,
});
const placeBtn = () => screen.getByRole("button", { name: "Place order" });

describe("CheckoutView", () => {
  it("quotes on first render with the default address and shows every fee, delivery, VAT and total before payment", async () => {
    const api = checkoutApi();
    render(<CheckoutView locale={EN} api={api} navigate={vi.fn()} />);
    await screen.findByText("Cash on delivery fee");
    expect(api.quote).toHaveBeenCalledWith({ addressId: ids.ADDR, method: "card", voucherCodes: [] });
    expect(screen.getByText("نيل أوتليت: EGP 60 · 2 to 4 days")).toBeTruthy();
    const rows = Object.fromEntries([...document.querySelectorAll(".shopSummary > div")].map((d) => [d.querySelector("dt")?.textContent ?? "", d.querySelector("dd")?.textContent ?? ""]));
    expect(rows).toEqual({ Items: "EGP 800", Delivery: "EGP 60", "Cash on delivery fee": "EGP 25", "VAT (included)": "EGP 105", Total: "EGP 860" });
    expect(screen.queryByText(/You saved/)).toBeNull();
    expect(document.querySelector("[style]")).toBeNull();
  });

  it("lists only the methods the quote returns; unavailable ones are disabled", async () => {
    render(<CheckoutView locale={EN} api={checkoutApi()} navigate={vi.fn()} />);
    await screen.findByLabelText("Card");
    expect(screen.getByLabelText("Cash on delivery")).toBeTruthy();
    expect(screen.queryByLabelText("Apple Pay")).toBeNull();
    expect((screen.getByLabelText<HTMLInputElement>(/Installments/)).disabled).toBe(true);
  });

  it("shows 'You saved' only when the quote returns verified savings", async () => {
    render(<CheckoutView locale={EN} api={checkoutApi({ quote: vi.fn().mockResolvedValue(quote({ verified_savings: m(30_000) })) })} navigate={vi.fn()} />);
    expect(await screen.findByText("You saved EGP 300 against verified reference prices")).toBeTruthy();
  });

  it("card path: places once with the quote token, client total and a stable idempotency key, then follows an https redirect", async () => {
    const d = deferred<ReturnType<typeof placed>>();
    const api = checkoutApi({ placeOrder: vi.fn().mockReturnValue(d.promise) });
    const navigate = vi.fn();
    render(<CheckoutView locale={EN} api={api} navigate={navigate} />);
    await screen.findByText("Cash on delivery fee");
    fireEvent.click(placeBtn());
    fireEvent.click(screen.getAllByRole("button", { name: /Placing your order/ })[0]!);
    expect(api.placeOrder).toHaveBeenCalledTimes(1);
    const arg = (api.placeOrder as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { quoteToken: string; clientTotal: ReturnType<typeof money>; acceptPriceChange: boolean; idempotencyKey: string; method: string };
    expect(arg).toMatchObject({ quoteToken: "qt-1", acceptPriceChange: false, method: "card" });
    expect(arg.clientTotal).toEqual(money(86_000n, "EGP"));
    expect(arg.idempotencyKey).toMatch(/-7[0-9a-f]{3}-/);
    expect(navigate).not.toHaveBeenCalled();
    await act(async () => { d.resolve(placed({ kind: "redirect", url: "https://pay.example/session/1" })); await d.promise; });
    expect(navigate).toHaveBeenCalledWith("https://pay.example/session/1");
  });

  it("an unsafe redirect URL is ignored and the shopper lands on the order page", async () => {
    const navigate = vi.fn();
    render(<CheckoutView locale={EN} api={checkoutApi({ placeOrder: vi.fn().mockResolvedValue(placed({ kind: "redirect", url: "javascript:alert(1)" })) })} navigate={navigate} />);
    await screen.findByText("Cash on delivery fee");
    fireEvent.click(placeBtn());
    await waitFor(() => { expect(navigate).toHaveBeenCalledWith(`/eg-en/orders/${ids.ORDER}`); });
  });

  it("COD path: selecting COD re-quotes with that method, explains confirmation, and goes to the order page", async () => {
    const api = checkoutApi({ placeOrder: vi.fn().mockResolvedValue(placed({ kind: "cod_confirmation" }, "CONFIRMED_COD")) });
    const navigate = vi.fn();
    render(<CheckoutView locale={EN} api={api} navigate={navigate} />);
    await screen.findByText("Cash on delivery fee");
    fireEvent.click(screen.getByLabelText("Cash on delivery"));
    await screen.findByText(/send a code to confirm the order/);
    await waitFor(() => { expect(api.quote).toHaveBeenLastCalledWith({ addressId: ids.ADDR, method: "cod", voucherCodes: [] }); });
    fireEvent.click(placeBtn());
    await waitFor(() => { expect(navigate).toHaveBeenCalledWith(`/eg-en/orders/${ids.ORDER}`); });
    expect((api.placeOrder as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({ method: "cod" });
  });

  it("409 price-changed shows the delta, does not charge, and re-places only after the shopper accepts the new prices", async () => {
    const fresh = wireQuote({ quote_token: "qt-2", items_subtotal: m(84_000), total: m(90_000) });
    const placeOrder = vi.fn().mockRejectedValueOnce(new ApiProblem(409, "price-changed", null, { type: "https://x/price-changed", quote: fresh })).mockResolvedValueOnce(placed({ kind: "none" }));
    const navigate = vi.fn();
    render(<CheckoutView locale={EN} api={checkoutApi({ placeOrder })} navigate={navigate} />);
    await screen.findByText("Cash on delivery fee");
    fireEvent.click(placeBtn());
    const alert = await screen.findByText("Prices changed");
    const box = alert.closest<HTMLElement>("[role=alert]")!;
    expect(within(box).getByText("Items: was EGP 800, now EGP 840")).toBeTruthy();
    expect(within(box).getByText("Total: was EGP 860, now EGP 900")).toBeTruthy();
    expect(within(box).queryByText(/Delivery:/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Place order" })).toBeNull();
    expect(placeOrder).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Accept new prices and place order" }));
    await waitFor(() => { expect(navigate).toHaveBeenCalledWith(`/eg-en/orders/${ids.ORDER}`); });
    const second = placeOrder.mock.calls[1]?.[0] as { quoteToken: string; acceptPriceChange: boolean; clientTotal: ReturnType<typeof money>; idempotencyKey: string };
    const first = placeOrder.mock.calls[0]?.[0] as { idempotencyKey: string };
    expect(second).toMatchObject({ quoteToken: "qt-2", acceptPriceChange: true });
    expect(second.clientTotal).toEqual(money(90_000n, "EGP"));
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
  });

  it("price-changed without a quote in the body falls back to a fresh quote request", async () => {
    const quoteFn = vi.fn().mockResolvedValueOnce(quote()).mockResolvedValueOnce(quote({ quote_token: "qt-3", total: m(88_000) }));
    render(<CheckoutView locale={EN} api={checkoutApi({ quote: quoteFn, placeOrder: vi.fn().mockRejectedValue(new ApiProblem(409, "price-changed", null, {})) })} navigate={vi.fn()} />);
    await screen.findByText("Cash on delivery fee");
    fireEvent.click(placeBtn());
    expect(await screen.findByText("Total: was EGP 860, now EGP 880")).toBeTruthy();
  });

  it.each([
    [new ApiProblem(409, "stock-shortfall", null, null), "Some items are no longer in stock. Review your bag."],
    [new ApiProblem(422, "defect-ack-missing", null, null), "Confirm you have seen the item defects in your bag."],
    [new ApiProblem(403, "cod-not-allowed", null, null), "Cash on delivery is not available for this order. Choose another method."],
    [new ApiProblem(403, "age-capacity", null, null), "This option requires a higher age."],
    [new ApiProblem(500, "unknown", null, null), "We could not place the order. You have not been charged."],
  ])("maps a %s refusal to a clear message", async (problem, text) => {
    render(<CheckoutView locale={EN} api={checkoutApi({ placeOrder: vi.fn().mockRejectedValue(problem) })} navigate={vi.fn()} />);
    await screen.findByText("Cash on delivery fee");
    fireEvent.click(placeBtn());
    expect((await screen.findByText(text)).getAttribute("role")).toBe("alert");
    expect((placeBtn() as HTMLButtonElement).disabled).toBe(false);
  });

  it("credit is offered only with a balance and is sent as store_credit; vouchers go into the quote", async () => {
    const api = checkoutApi({ walletBalance: vi.fn().mockResolvedValue(money(5_000n, "EGP")) });
    render(<CheckoutView locale={EN} api={api} navigate={vi.fn()} />);
    fireEvent.click(await screen.findByLabelText("Use Outlex credit (EGP 50)"));
    await waitFor(() => { expect(api.quote).toHaveBeenLastCalledWith({ addressId: ids.ADDR, method: "card", voucherCodes: [], storeCredit: money(5_000n, "EGP") }); });
    fireEvent.change(screen.getByLabelText("Voucher code"), { target: { value: "WELCOME" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => { expect(api.quote).toHaveBeenLastCalledWith(expect.objectContaining({ voucherCodes: ["WELCOME"] })); });
    fireEvent.click(screen.getByRole("button", { name: "Remove voucher WELCOME" }));
    await waitFor(() => { expect(api.quote).toHaveBeenLastCalledWith(expect.objectContaining({ voucherCodes: [] })); });
  });

  it("no wallet balance means no credit option", async () => {
    render(<CheckoutView locale={EN} api={checkoutApi()} navigate={vi.fn()} />);
    await screen.findByText("Cash on delivery fee");
    expect(screen.queryByText(/Use Outlex credit/)).toBeNull();
  });

  it("with no saved address the structured Egyptian form is shown (governorate, then city) and saving selects the new address", async () => {
    const created = address({ id: "new-addr" });
    const api = checkoutApi({ listAddresses: vi.fn().mockResolvedValue([]), createAddress: vi.fn().mockResolvedValue(created) });
    render(<CheckoutView locale={EN} api={api} navigate={vi.fn()} />);
    await screen.findByText(/No saved address/);
    expect(api.quote).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Recipient name"), { target: { value: "منى" } });
    fireEvent.change(screen.getByLabelText("Recipient mobile"), { target: { value: "٠١٠١٢٣٤٥٦٧٨" } });
    await screen.findByRole("option", { name: "القاهرة" });
    fireEvent.change(screen.getByLabelText("Governorate"), { target: { value: "g1" } });
    await screen.findByRole("option", { name: "مدينة نصر" });
    fireEvent.change(screen.getByLabelText("City"), { target: { value: "c1" } });
    fireEvent.change(screen.getByLabelText("Street"), { target: { value: "شارع النيل" } });
    fireEvent.change(screen.getByLabelText("Building"), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "Save address" }));
    expect((await screen.findAllByText(/Landmark/))[0]).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("Check the address details.");
    expect(api.createAddress).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/Landmark/), { target: { value: "جنب الصيدلية" } });
    fireEvent.click(screen.getByRole("button", { name: "Save address" }));
    await waitFor(() => { expect(api.createAddress).toHaveBeenCalledWith(expect.objectContaining({ phoneE164: "+201012345678", governorateId: "g1", districtId: "c1", landmark: "جنب الصيدلية" })); });
    await waitFor(() => { expect(api.quote).toHaveBeenCalledWith(expect.objectContaining({ addressId: "new-addr" })); });
  });

  it("empty bag, signed-out and load failures render honest states", async () => {
    const e = render(<CheckoutView locale={EN} api={checkoutApi({ getCart: vi.fn().mockResolvedValue(cart([])) })} navigate={vi.fn()} />);
    expect(await screen.findByText("Your bag is empty. Add items before checkout.")).toBeTruthy();
    e.unmount();
    const o = render(<CheckoutView locale={EN} api={checkoutApi({ listAddresses: vi.fn().mockRejectedValue(out()) })} navigate={vi.fn()} />);
    expect((await screen.findByRole("link", { name: "Sign in" })).getAttribute("href")).toBe("/eg-en/login?next=%2Feg-en%2Fcheckout");
    o.unmount();
    const q = render(<CheckoutView locale={EN} api={checkoutApi({ quote: vi.fn().mockRejectedValue(new ApiProblem(500, "x", null, null)) })} navigate={vi.fn()} />);
    expect((await screen.findAllByText("We could not calculate your total. Try again."))[0]).toBeTruthy();
    expect((placeBtn() as HTMLButtonElement).disabled).toBe(true);
    q.unmount();
    render(<CheckoutView locale={EN} api={checkoutApi({ getCart: vi.fn().mockRejectedValue(new Error("x")) })} navigate={vi.fn()} />);
    expect((await screen.findByRole("alert")).textContent).toBe("We could not load your bag.");
  });

  it.each([["ar-EG"], ["en-EG"]] as const)("has no axe violations (%s)", async (locale) => {
    const { container } = render(<CheckoutView locale={locale} api={checkoutApi({ walletBalance: vi.fn().mockResolvedValue(money(5_000n, "EGP")) })} navigate={vi.fn()} />);
    await waitFor(() => { expect(container.querySelector(".shopSummary")).not.toBeNull(); });
    await expectNoA11yViolations(container);
  });
});

describe("OrderStatus", () => {
  it("polls while payment is pending (webhook may land after the redirect) and stops once PAID", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const getOrderGroup = vi.fn().mockResolvedValueOnce(order()).mockResolvedValueOnce(order()).mockResolvedValue(order({ status: "PAID" }));
    render(<OrderStatus locale={EN} orderId={ids.ORDER} api={stubApi({ getOrderGroup })} pollMs={1000} />);
    expect(await screen.findByText("Waiting for payment")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    await screen.findByText("Paid");
    const calls = getOrderGroup.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(getOrderGroup.mock.calls.length).toBe(calls);
    expect(screen.getByText("Total").nextElementSibling?.textContent).toBe("EGP 860");
  });

  it("an order already paid when the shopper arrives is shown immediately without polling", async () => {
    const getOrderGroup = vi.fn().mockResolvedValue(order({ status: "PAID" }));
    render(<OrderStatus locale={EN} orderId={ids.ORDER} api={stubApi({ getOrderGroup })} pollMs={10} />);
    await screen.findByText("Paid");
    await new Promise((r) => setTimeout(r, 60));
    expect(getOrderGroup).toHaveBeenCalledTimes(1);
  });

  it("shows the Fawry reference with its expiry while payment is pending", async () => {
    const o = order({ payment_method: "fawry", client_action: { kind: "fawry_reference", reference: "987654321", expires_at: "2026-11-09T10:00:00Z" } });
    render(<OrderStatus locale={EN} orderId={ids.ORDER} api={stubApi({ getOrderGroup: vi.fn().mockResolvedValue(o) })} pollMs={60_000} />);
    expect(await screen.findByText(/Fawry code: 987654321/)).toBeTruthy();
    expect(screen.getByText(/Expires/)).toBeTruthy();
  });

  it("COD confirmation takes a 6-digit code (Eastern digits accepted) and reports a wrong one", async () => {
    const confirmCod = vi.fn().mockRejectedValueOnce(new ApiProblem(422, "invalid-code", null, null)).mockResolvedValueOnce(order({ status: "CONFIRMED_COD", payment_method: "cod", client_action: null }));
    const api = stubApi({ getOrderGroup: vi.fn().mockResolvedValue(order({ status: "CONFIRMED_COD", payment_method: "cod", client_action: { kind: "cod_confirmation" } })), confirmCod });
    render(<OrderStatus locale={EN} orderId={ids.ORDER} api={api} pollMs={60_000} />);
    const input = await screen.findByLabelText(/Confirmation code/);
    fireEvent.change(input, { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect((await screen.findAllByText("The code must be 6 digits."))[0]).toBeTruthy();
    fireEvent.change(input, { target: { value: "١٢٣٤٥٦" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect((await screen.findAllByText("The code is incorrect."))[0]).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => { expect(screen.queryByLabelText(/Confirmation code/)).toBeNull(); });
    expect(confirmCod).toHaveBeenLastCalledWith(ids.ORDER, "123456");
  });

  it("offers a continue-to-payment link only for a safe URL, and handles signed-out and errors", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const o = order({ client_action: { kind: "redirect", url: "https://pay.example/s/1" } });
    const a = render(<OrderStatus locale={EN} orderId={ids.ORDER} api={stubApi({ getOrderGroup: vi.fn().mockResolvedValue(o) })} pollMs={60_000} />);
    expect((await screen.findByRole("link", { name: "Continue to payment" })).getAttribute("href")).toBe("https://pay.example/s/1");
    a.unmount();
    const b = render(<OrderStatus locale={EN} orderId={ids.ORDER} api={stubApi({ getOrderGroup: vi.fn().mockRejectedValue(out()) })} />);
    expect((await screen.findByRole("link", { name: "Sign in" })).getAttribute("href")).toContain("/eg-en/login?next=");
    b.unmount();
    render(<OrderStatus locale={EN} orderId={ids.ORDER} api={stubApi({ getOrderGroup: vi.fn().mockRejectedValue(new Error("x")) })} pollMs={60_000} />);
    expect((await screen.findByRole("alert")).textContent).toBe("We could not load the order status.");
  });

  it.each([["ar-EG"], ["en-EG"]] as const)("has no axe violations (%s)", async (locale) => {
    const o = order({ client_action: { kind: "fawry_reference", reference: "1234", expires_at: "2026-11-09T10:00:00Z" } });
    const { container } = render(<OrderStatus locale={locale} orderId={ids.ORDER} api={stubApi({ getOrderGroup: vi.fn().mockResolvedValue(o) })} pollMs={60_000} />);
    await screen.findByRole("heading", { level: 2 });
    await expectNoA11yViolations(container);
  });
});
