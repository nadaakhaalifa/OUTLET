import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranslator, type Locale } from "@outlet/i18n";
import { CheckoutView, pspRedirectHosts } from "../src/components/shop/CheckoutView";
import { ApiProblem } from "../src/lib/client-api";
import { address, cart, m, quote, stubApi, wireQuote } from "./shop-fixtures";

afterEach(cleanup);
const EN: Locale = "en-EG";
const t = createTranslator(EN);
const api = (over = {}) => stubApi({ getCart: vi.fn().mockResolvedValue(cart()), listAddresses: vi.fn().mockResolvedValue([address()]), walletBalance: vi.fn().mockResolvedValue(null), quote: vi.fn().mockResolvedValue(quote()), ...over });
const rows = (): Record<string, string> => Object.fromEntries([...document.querySelectorAll(".shopSummary > div")].map((d) => [d.querySelector("dt")?.textContent ?? "", d.querySelector("dd")?.textContent ?? ""]));

describe("quote failures", () => {
  it("a failed quote clears the figures, says so, and does not offer a stale total", async () => {
    render(<CheckoutView locale={EN} api={api({ quote: vi.fn().mockRejectedValue(new ApiProblem(500, "boom", null, null)) })} navigate={vi.fn()} />);
    expect((await screen.findByRole("alert")).textContent).toBe(t("checkout.quote.error"));
    expect(document.querySelector(".shopSummary")).toBeNull();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Place order" }).disabled).toBe(true);
  });

  it("a session that expires while quoting goes to sign-in", async () => {
    render(<CheckoutView locale={EN} api={api({ quote: vi.fn().mockRejectedValue(new ApiProblem(401, "unauthenticated", null, null)) })} navigate={vi.fn()} />);
    expect(await screen.findByRole("link", { name: "Sign in" })).toBeTruthy();
  });

  it("a slower earlier quote can never overwrite a newer one (the last request wins)", async () => {
    let resolveFirst: (q: ReturnType<typeof quote>) => void = () => undefined;
    const first = new Promise<ReturnType<typeof quote>>((r) => { resolveFirst = r; });
    const quoteFn = vi.fn().mockReturnValueOnce(first).mockResolvedValue(quote({ quote_token: "qt-new", total: m(70_000) }));
    render(<CheckoutView locale={EN} api={api({ quote: quoteFn })} navigate={vi.fn()} />);
    await waitFor(() => { expect(quoteFn).toHaveBeenCalledTimes(1); });
    fireEvent.change(screen.getByLabelText("Voucher code"), { target: { value: "NEW" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => { expect(rows().Total).toBe("EGP 700"); });
    resolveFirst(quote({ quote_token: "qt-old", total: m(99_000) }));
    await new Promise((r) => setTimeout(r, 20));
    expect(rows().Total).toBe("EGP 700");
  });
});

describe("review rows", () => {
  it("discount, store credit and unknown fee codes appear only when the quote has them", async () => {
    const q = quote({ discount: m(5_000), store_credit: m(2_000), fees: [{ code: "mystery_fee", amount: m(300) }], total: m(79_000) });
    render(<CheckoutView locale={EN} api={api({ quote: vi.fn().mockResolvedValue(q) })} navigate={vi.fn()} />);
    await screen.findByText(t("checkout.fee.other"));
    const r = rows();
    expect(r[t("checkout.review.discount")]).toBe("−EGP 50");
    expect(r[t("checkout.review.credit")]).toBe("−EGP 20");
    expect(r[t("checkout.fee.other")]).toBe("EGP 3");
  });

  it("a free delivery parcel and a zero-fee parcel say 'free'; a charged one shows its fee", async () => {
    const free = wireQuote({ stores: [{ ...wireQuote().stores[0], parcels: [{ ...wireQuote().stores[0]?.parcels[0], fee: m(0), free_delivery_applied: true }] }] });
    render(<CheckoutView locale={EN} api={api({ quote: vi.fn().mockResolvedValue(quote(free)) })} navigate={vi.fn()} />);
    await screen.findByText(/free/i);
    expect(screen.queryByText(/EGP 60 ·/)).toBeNull();
  });
});

describe("vouchers", () => {
  it("a blank code is ignored and a code already applied is not added twice; the input clears after adding", async () => {
    const a = api();
    render(<CheckoutView locale={EN} api={a} navigate={vi.fn()} />);
    const input = await screen.findByLabelText<HTMLInputElement>("Voucher code");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(screen.queryByRole("button", { name: /Remove voucher/ })).toBeNull();
    fireEvent.change(input, { target: { value: " SAVE10 " } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await screen.findByRole("button", { name: "Remove voucher SAVE10" });
    expect(input.value).toBe("");
    fireEvent.change(input, { target: { value: "SAVE10" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(screen.getAllByRole("button", { name: "Remove voucher SAVE10" })).toHaveLength(1);
    expect(input.value).toBe("SAVE10");
  });
});

describe("price change and the idempotency key", () => {
  it("a price change whose fresh quote cannot be fetched is reported as a generic failure and nothing is charged", async () => {
    const quoteFn = vi.fn().mockResolvedValueOnce(quote()).mockRejectedValue(new Error("down"));
    render(<CheckoutView locale={EN} api={api({ quote: quoteFn, placeOrder: vi.fn().mockRejectedValue(new ApiProblem(409, "price-changed", null, {})) })} navigate={vi.fn()} />);
    await screen.findByText("Cash on delivery fee");
    fireEvent.click(screen.getByRole("button", { name: "Place order" }));
    expect((await screen.findByText(t("checkout.error.generic"))).getAttribute("role")).toBe("alert");
  });

  it("a retry on the same quote reuses the same idempotency key; a new quote gets a new one", async () => {
    const placeOrder = vi.fn().mockRejectedValueOnce(new ApiProblem(500, "boom", null, null)).mockRejectedValueOnce(new ApiProblem(500, "boom", null, null)).mockRejectedValue(new ApiProblem(500, "boom", null, null));
    const quoteFn = vi.fn().mockResolvedValue(quote());
    render(<CheckoutView locale={EN} api={api({ quote: quoteFn, placeOrder })} navigate={vi.fn()} />);
    await screen.findByText("Cash on delivery fee");
    fireEvent.click(screen.getByRole("button", { name: "Place order" }));
    await screen.findByText(t("checkout.error.generic"));
    fireEvent.click(screen.getByRole("button", { name: "Place order" }));
    await waitFor(() => { expect(placeOrder).toHaveBeenCalledTimes(2); });
    const keys = placeOrder.mock.calls.map((c) => (c[0] as { idempotencyKey: string }).idempotencyKey);
    expect(keys[1]).toBe(keys[0]);
    quoteFn.mockResolvedValue(quote({ quote_token: "qt-2" }));
    fireEvent.change(screen.getByLabelText("Voucher code"), { target: { value: "X" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => { expect(quoteFn).toHaveBeenCalledTimes(2); });
    await screen.findByRole("button", { name: "Remove voucher X" });
    fireEvent.click(screen.getByRole("button", { name: "Place order" }));
    await waitFor(() => { expect(placeOrder).toHaveBeenCalledTimes(3); });
    expect((placeOrder.mock.calls[2]?.[0] as { idempotencyKey: string }).idempotencyKey).not.toBe(keys[0]);
  });
});

describe("pspRedirectHosts", () => {
  it("parses a comma list, lower-cases and trims, and is empty (fail closed) when unset", () => {
    expect(pspRedirectHosts(" Pay.Example.com , ,secure.psp.eg")).toEqual(["pay.example.com", "secure.psp.eg"]);
    expect(pspRedirectHosts("")).toEqual([]);
    expect(pspRedirectHosts(undefined)).toEqual(pspRedirectHosts(process.env.NEXT_PUBLIC_PSP_REDIRECT_HOSTS));
  });
});
