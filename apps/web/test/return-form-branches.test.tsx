import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranslator, type Locale } from "@outlet/i18n";
import { ReturnForm } from "../src/components/shop/ReturnForm";
import { ApiProblem } from "../src/lib/client-api";
import { ids, ids2, orderWith, returnReq, stubApi, wireSellerOrder } from "./shop-fixtures";

vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND"); }, usePathname: () => "/eg-en" }));

afterEach(cleanup);
const EN: Locale = "en-EG";
const t = createTranslator(EN);
const lineWire = () => (wireSellerOrder().lines as Record<string, unknown>[])[0] ?? {};
const returnable = (over: Record<string, unknown> = {}) => orderWith({ status: "DELIVERED", returnable: true, delivered_at: "2026-11-06T10:00:00Z", return_window_ends_at: "2026-11-20T10:00:00Z", shipment: null, ...over });
const form = (api: Record<string, unknown>, lineId: string | null = ids2.ORDER_LINE, orderId: string | null = ids.ORDER) =>
  render(<ReturnForm locale={EN} lineId={lineId} orderId={orderId} api={stubApi(api)} />);

describe("ReturnForm loading outcomes", () => {
  it("an expired session sends the user to sign-in with the return page as the destination", async () => {
    form({ getOrderGroup: vi.fn().mockRejectedValue(new ApiProblem(401, "unauthenticated", null, null)) });
    const link = await screen.findByRole("link", { name: "Sign in" });
    expect(decodeURIComponent(link.getAttribute("href") ?? "")).toBe(`/eg-en/login?next=/eg-en/returns/new?line=${ids2.ORDER_LINE}&order=${ids.ORDER}`);
  });

  it("a load failure, or a line that is not in the order, is the same honest error and no form", async () => {
    const { unmount } = form({ getOrderGroup: vi.fn().mockRejectedValue(new Error("boom")) });
    expect((await screen.findByRole("alert")).textContent).toBe(t("returns.new.loadError"));
    unmount();
    form({ getOrderGroup: vi.fn().mockResolvedValue(returnable()) }, "0b7d1f4e-0000-4000-8000-00000000ffff");
    expect((await screen.findByRole("alert")).textContent).toBe(t("returns.new.loadError"));
    expect(screen.queryByRole("form")).toBeNull();
  });

  it("an order that is not returnable shows why instead of the form", async () => {
    form({ getOrderGroup: vi.fn().mockResolvedValue(returnable({ returnable: false })) });
    expect((await screen.findByRole("alert")).textContent).toBe(t("returns.new.notReturnable"));
  });
});

describe("ReturnForm fields", () => {
  it("no window note when the order has no window end; a line of several units offers a quantity that is sent", async () => {
    const createReturn = vi.fn().mockResolvedValue(returnReq());
    const o = returnable({ return_window_ends_at: null, lines: [{ ...lineWire(), qty: 3 }] });
    form({ getOrderGroup: vi.fn().mockResolvedValue(o), createReturn });
    await screen.findByLabelText("Reason");
    expect(screen.queryByText(/Return by/)).toBeNull();
    fireEvent.change(screen.getByLabelText(t("returns.new.qty")), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "changed_mind" } });
    fireEvent.click(screen.getByRole("button", { name: "Send return request" }));
    await screen.findByText("Your return request was sent.");
    expect(createReturn.mock.calls[0]?.[1]).toMatchObject({ lines: [{ orderLineId: ids2.ORDER_LINE, qty: 2 }], reasonCode: "changed_mind", resolution: "refund" });
  });

  it("a single-unit line has no quantity field; clearing the reason removes the photo section; an unknown reason value is treated as none", async () => {
    form({ getOrderGroup: vi.fn().mockResolvedValue(returnable()) });
    await screen.findByLabelText("Reason");
    expect(screen.queryByLabelText(t("returns.new.qty"))).toBeNull();
    expect(screen.queryByText(t("returns.photos.title"))).toBeNull();
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "changed_mind" } });
    expect(screen.getByText(t("returns.photos.title"))).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "" } });
    expect(screen.queryByText(t("returns.photos.title"))).toBeNull();
  });

  it("choosing no file does not call the upload; a failed upload shows the photo error and adds nothing", async () => {
    const uploadEvidence = vi.fn().mockRejectedValue(new ApiProblem(403, "upload-failed", null, null));
    form({ getOrderGroup: vi.fn().mockResolvedValue(returnable()), uploadEvidence });
    await screen.findByLabelText("Reason");
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "defective" } });
    fireEvent.change(screen.getByLabelText("Add a photo"), { target: { files: [] } });
    expect(uploadEvidence).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Add a photo"), { target: { files: [new File(["x"], "a.png", { type: "image/png" })] } });
    expect((await screen.findByText(t("returns.photos.error")))).toBeTruthy();
    expect(screen.queryByText(/photo uploaded/)).toBeNull();
  });
});

describe("ReturnForm submit errors", () => {
  it("a closed return window is named; any other failure is the generic send error; the form stays for another try", async () => {
    const createReturn = vi.fn().mockRejectedValueOnce(new ApiProblem(409, "return-window-closed", null, null)).mockRejectedValueOnce(new ApiProblem(500, "boom", null, null));
    form({ getOrderGroup: vi.fn().mockResolvedValue(returnable()), createReturn });
    await screen.findByLabelText("Reason");
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "changed_mind" } });
    fireEvent.click(screen.getByRole("button", { name: "Send return request" }));
    expect((await screen.findByRole("alert")).textContent).toBe(t("returns.new.windowClosed"));
    fireEvent.click(screen.getByRole("button", { name: "Send return request" }));
    await waitFor(() => { expect(screen.getByRole("alert").textContent).toBe(t("returns.new.error")); });
    expect(createReturn).toHaveBeenCalledTimes(2);
  });

  it("a BNPL order never sends a refund preference (the provider gets the money back)", async () => {
    const createReturn = vi.fn().mockResolvedValue(returnReq());
    form({ getOrderGroup: vi.fn().mockResolvedValue(orderWith({ status: "DELIVERED", returnable: true, delivered_at: "2026-11-06T10:00:00Z", return_window_ends_at: "2026-11-20T10:00:00Z", shipment: null }, { payment_method: "bnpl" })), createReturn });
    await screen.findByLabelText("Reason");
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "changed_mind" } });
    fireEvent.click(screen.getByRole("button", { name: "Send return request" }));
    await screen.findByText("Your return request was sent.");
    expect(createReturn.mock.calls[0]?.[1]).not.toHaveProperty("refundPreference");
  });
});
