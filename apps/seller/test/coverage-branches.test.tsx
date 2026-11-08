import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createTranslator, type Locale } from "@outlet/i18n";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

import { InventoryTable, type InventoryRow } from "../src/components/inventory/InventoryTable";
import { SlaCountdown } from "../src/components/orders/SlaCountdown";
import { fail, fakeApi } from "./fake-api";

const LOCALES: Locale[] = ["ar-EG", "en-EG"];

describe.each(LOCALES)("SlaCountdown all four states (%s)", (locale) => {
  const t = createTranslator(locale);
  const cases = [
    ["accept", "2030-01-01T03:00:00.000Z", "seller.orders.sla.acceptIn", false],
    ["accept", "2029-12-31T21:00:00.000Z", "seller.orders.sla.acceptLate", true],
    ["dispatch", "2030-01-01T03:00:00.000Z", "seller.orders.sla.dispatchIn", false],
    ["dispatch", "2029-12-31T21:00:00.000Z", "seller.orders.sla.dispatchLate", true],
  ] as const;
  it.each(cases)("%s with deadline %s uses %s (late=%s)", (kind, deadline, key, late) => {
    render(<SlaCountdown locale={locale} kind={kind} deadline={deadline} serverTime="2030-01-01T00:00:00.000Z" />);
    const el = screen.getByText(t(key, { time: t("seller.orders.sla.time", { hours: 3, minutes: 0 }) }));
    expect(el.getAttribute("data-late")).toBe(String(late));
    expect(el.getAttribute("datetime")).toBe(deadline);
  });
});

describe("InventoryTable failure mapping and form handling", () => {
  const rows: InventoryRow[] = [{ sku_id: "s1", seller_sku: "SKU-1", size_label: "M", product_title_ar: "فستان", on_hand: 5, committed: 0, available: 5, low_stock: false, version: 2 }];
  const t = createTranslator("en-EG");
  const attempt = async (failure: ReturnType<typeof fail>, delta = "-1") => {
    const f = fakeApi();
    f.api.adjustStock.mockResolvedValueOnce(failure);
    refresh.mockClear();
    render(<InventoryTable locale="en-EG" marketId="EG" rows={rows} api={f.api} />);
    fireEvent.click(screen.getByRole("button", { name: /Adjust/ }));
    fireEvent.change(screen.getByLabelText(t("seller.inventory.adjust.delta")), { target: { value: delta } });
    fireEvent.change(screen.getByLabelText(t("seller.inventory.adjust.reason")), { target: { value: "recount" } });
    fireEvent.click(screen.getByRole("button", { name: t("seller.inventory.adjust.submit") }));
    return (await screen.findByRole("alert")).textContent;
  };
  it.each([
    [fail(409, "insufficient-stock"), "seller.inventory.err.below"],
    [fail(409, "conflict"), "seller.inventory.err.below"],
    [fail(403, "forbidden"), "seller.error.forbidden"],
    [fail(404, "not-found"), "seller.error.notFound"],
    [fail(401, "unauthenticated"), "seller.error.unauthenticated"],
    [fail(429, "rate"), "seller.error.rate"],
    [fail(500, "boom"), "error.generic"],
  ] as const)("%j shows %s and does not reload", async (failure, key) => {
    expect(await attempt(failure)).toContain(t(key));
    expect(refresh).not.toHaveBeenCalled();
  });
  it.each(["abc", "0", "+0", "1234567", "1.5", ""])("rejects the delta %j without calling the API", async (delta) => {
    const f = fakeApi();
    render(<InventoryTable locale="en-EG" marketId="EG" rows={rows} api={f.api} />);
    fireEvent.click(screen.getByRole("button", { name: /Adjust/ }));
    fireEvent.change(screen.getByLabelText(t("seller.inventory.adjust.delta")), { target: { value: delta } });
    fireEvent.change(screen.getByLabelText(t("seller.inventory.adjust.reason")), { target: { value: "damage" } });
    fireEvent.click(screen.getByRole("button", { name: t("seller.inventory.adjust.submit") }));
    expect((await screen.findByRole("alert")).textContent).toContain(t("seller.inventory.adjust.invalid"));
    expect(f.api.adjustStock).not.toHaveBeenCalled();
  });
  it("toggles the form closed with the same button or Cancel, and clears the problem", async () => {
    render(<InventoryTable locale="en-EG" marketId="EG" rows={rows} api={fakeApi().api} />);
    const btn = screen.getByRole("button", { name: /Adjust/ });
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(btn);
    fireEvent.click(screen.getByRole("button", { name: t("seller.inventory.adjust.cancel") }));
    await waitFor(() => { expect(screen.queryByRole("form")).toBeNull(); });
  });
});
