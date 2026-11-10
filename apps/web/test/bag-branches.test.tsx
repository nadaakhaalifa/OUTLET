import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranslator, type Locale } from "@outlet/i18n";
import { BagView } from "../src/components/shop/BagView";
import { ApiProblem } from "../src/lib/client-api";
import { cart, ids, stubApi, wireLine } from "./shop-fixtures";

afterEach(cleanup);
const EN: Locale = "en-EG";
const t = createTranslator(EN);
const brief = { id: ids.PROD, title_ar: "جاكيت", title_en: "Jacket", skus: [{ sku_id: ids.SKU, size_label: "M" }] };
const bagApi = (over = {}) => stubApi({ getCart: vi.fn().mockResolvedValue(cart()), getProductBrief: vi.fn().mockResolvedValue(brief), ...over });
const out = () => new ApiProblem(401, "unauthenticated", null, null);

describe("BagView failure paths", () => {
  it("a session that expired while changing a quantity returns to sign-in, restoring nothing stale", async () => {
    render(<BagView locale={EN} api={bagApi({ setQty: vi.fn().mockRejectedValue(out()) })} />);
    fireEvent.click(await screen.findByRole("button", { name: "Increase quantity of Jacket" }));
    expect(await screen.findByRole("link", { name: "Sign in" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a refused removal keeps the line and says so; an expired session while removing goes to sign-in", async () => {
    const api = bagApi({ removeLine: vi.fn().mockRejectedValueOnce(new ApiProblem(500, "boom", null, null)).mockRejectedValueOnce(out()) });
    render(<BagView locale={EN} api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove Jacket" }));
    expect((await screen.findByRole("alert")).textContent).toBe(t("bag.error.remove"));
    expect(screen.getByRole("button", { name: "Remove Jacket" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove Jacket" }));
    expect(await screen.findByRole("link", { name: "Sign in" })).toBeTruthy();
  });

  it("a failed defect acknowledgement shows the generic error and keeps the button; a missing ack count is sent as zero", async () => {
    const line = wireLine({ defect_ack_required: true, defect_card_id: "dc1", defect_card_version: 4 });
    const ackDefects = vi.fn().mockRejectedValueOnce(new Error("down"));
    render(<BagView locale={EN} api={bagApi({ getCart: vi.fn().mockResolvedValue(cart([line])), ackDefects })} />);
    fireEvent.click(await screen.findByRole("button", { name: "I have seen the defects (0)" }));
    await waitFor(() => { expect(ackDefects).toHaveBeenCalledWith(ids.LINE, { defectCardId: "dc1", version: 4, defectCount: 0 }); });
    expect((await screen.findByRole("alert")).textContent).toBe(t("error.generic"));
    expect(screen.getByRole("button", { name: "I have seen the defects (0)" })).toBeTruthy();
  });

  it("a defect that requires acknowledgement but has no card id offers nothing to send", async () => {
    const ackDefects = vi.fn();
    const line = wireLine({ defect_ack_required: true, defect_card_id: null, defect_card_version: null });
    render(<BagView locale={EN} api={bagApi({ getCart: vi.fn().mockResolvedValue(cart([line])), ackDefects })} />);
    const btn = await screen.findByRole("button", { name: /seen the defects/ });
    fireEvent.click(btn);
    expect(ackDefects).not.toHaveBeenCalled();
  });

  it("the defect-changed notice is shown only when the server sent it", async () => {
    const withNotice = cart([wireLine()], { notices: [{ code: "defect_card_changed", line_id: ids.LINE }] });
    const { unmount } = render(<BagView locale={EN} api={bagApi({ getCart: vi.fn().mockResolvedValue(withNotice) })} />);
    expect(await screen.findByText(t("bag.notice.defect"))).toBeTruthy();
    unmount();
    render(<BagView locale={EN} api={bagApi()} />);
    await screen.findByRole("heading", { name: "نيل أوتليت" });
    expect(screen.queryByText(t("bag.notice.defect"))).toBeNull();
  });

  it("quantity cannot go below one or repeat the current value", async () => {
    const setQty = vi.fn().mockResolvedValue(cart());
    render(<BagView locale={EN} api={bagApi({ setQty })} />);
    const dec = await screen.findByRole<HTMLButtonElement>("button", { name: "Decrease quantity of Jacket" });
    expect(dec.disabled).toBe(true);
    fireEvent.click(dec);
    expect(setQty).not.toHaveBeenCalled();
  });
});
