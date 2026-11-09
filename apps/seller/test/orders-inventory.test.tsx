import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it, vi } from "vitest";
import { createTranslator, type Locale } from "@outlet/i18n";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

import { InventoryTable, type InventoryRow } from "../src/components/inventory/InventoryTable";
import { OrderActions } from "../src/components/orders/OrderActions";
import { SlaCountdown } from "../src/components/orders/SlaCountdown";
import { StatusChip } from "../src/components/orders/StatusChip";
import { safeHref, slaKindOf, slaRemaining } from "../src/lib/sla";
import { DISPATCH_SLA_HOURS, PARCEL_WEIGHT_G } from "../src/lib/policy-limits";
import { fail, fakeApi, ok } from "./fake-api";

const LOCALES: Locale[] = ["ar-EG", "en-EG"];
const clean = async (): Promise<string[]> => (await axe.run(document.body, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } })).violations.map((v) => v.id);
const ORDER = "22222222-2222-4222-8222-222222222222";

describe.each(LOCALES)("OrderActions (%s)", (locale) => {
  const t = createTranslator(locale);
  const mount = (actions: string[], api = fakeApi().api) => render(<OrderActions locale={locale} marketId="EG" orderId={ORDER} actions={actions} api={api} />);

  it("asks for confirmation first and calls the API only after Confirm; never updates optimistically", async () => {
    const f = fakeApi();
    mount(["accept", "reject"], f.api);
    fireEvent.click(screen.getByRole("button", { name: t("seller.orders.action.accept") }));
    expect(f.api.acceptOrder).not.toHaveBeenCalled();
    expect(screen.getByText(t("seller.orders.confirm.accept", { hours: DISPATCH_SLA_HOURS }))).toBeTruthy();
    expect(await clean()).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: t("seller.orders.confirm.yes") }));
    await waitFor(() => { expect(f.api.acceptOrder).toHaveBeenCalledWith(ORDER); });
    expect((await screen.findByRole("status")).textContent).toContain(t("seller.orders.result.accepted"));
    expect(refresh).toHaveBeenCalled();
  });

  it("cancel leaves the order untouched", () => {
    const f = fakeApi();
    mount(["pack"], f.api);
    fireEvent.click(screen.getByRole("button", { name: t("seller.orders.action.pack") }));
    fireEvent.click(screen.getByRole("button", { name: t("seller.orders.confirm.cancel") }));
    expect(f.api.packOrder).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: t("seller.orders.action.pack") })).toBeTruthy();
  });

  it("reject requires a reason", async () => {
    const f = fakeApi();
    mount(["reject"], f.api);
    fireEvent.click(screen.getByRole("button", { name: t("seller.orders.action.reject") }));
    fireEvent.click(screen.getByRole("button", { name: t("seller.orders.confirm.yes") }));
    expect((await screen.findByRole("alert")).textContent).toContain(t("seller.orders.reject.required"));
    expect(f.api.rejectOrder).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(t("seller.orders.reject.reason")), { target: { value: "damaged" } });
    fireEvent.change(screen.getByLabelText(t("seller.orders.reject.note")), { target: { value: " فيه خدش " } });
    fireEvent.click(screen.getByRole("button", { name: t("seller.orders.confirm.yes") }));
    await waitFor(() => { expect(f.api.rejectOrder).toHaveBeenCalledWith(ORDER, "damaged", "فيه خدش"); });
  });

  it("cancel is offered only from PAID to PACKED, needs a reason, explains the full refund and health impact, then calls the API", async () => {
    const f = fakeApi();
    const { unmount } = render(<OrderActions locale={locale} marketId="EG" orderId={ORDER} actions={[]} status="SHIPPED" api={f.api} />);
    expect(screen.queryByRole("button", { name: t("seller.orders.action.cancel") })).toBeNull();
    unmount();
    render(<OrderActions locale={locale} marketId="EG" orderId={ORDER} actions={["pack"]} status="PACKED" api={f.api} />);
    fireEvent.click(screen.getByRole("button", { name: t("seller.orders.action.cancel") }));
    expect(screen.getByText(t("seller.orders.confirm.cancel_order"))).toBeTruthy();
    expect(screen.queryByLabelText(t("seller.orders.reject.note"))).toBeNull();
    expect(await clean()).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: t("seller.orders.confirm.yes") }));
    expect((await screen.findByRole("alert")).textContent).toContain(t("seller.orders.cancel.required"));
    expect(f.api.cancelOrder).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(t("seller.orders.cancel.reason")), { target: { value: "cannot_fulfil" } });
    fireEvent.click(screen.getByRole("button", { name: t("seller.orders.confirm.yes") }));
    await waitFor(() => { expect(f.api.cancelOrder).toHaveBeenCalledWith(ORDER, "cannot_fulfil"); });
    expect((await screen.findByRole("status")).textContent).toContain(t("seller.orders.result.cancelled"));
    expect(refresh).toHaveBeenCalled();
  });

  it.each([["cancel-after-shipping", 409, "seller.orders.err.cancelAfterShipping"], ["order-not-cancellable", 409, "seller.orders.err.notCancellable"], ["not-found", 404, "seller.error.notFound"]] as const)("cancel maps %s to a clear message", async (code, status, key) => {
    const f = fakeApi();
    f.api.cancelOrder = vi.fn(() => Promise.resolve(fail(status, code)));
    render(<OrderActions locale={locale} marketId="EG" orderId={ORDER} actions={[]} status="PAID" api={f.api} />);
    fireEvent.click(screen.getByRole("button", { name: t("seller.orders.action.cancel") }));
    fireEvent.change(screen.getByLabelText(t("seller.orders.cancel.reason")), { target: { value: "other" } });
    fireEvent.click(screen.getByRole("button", { name: t("seller.orders.confirm.yes") }));
    expect((await screen.findByRole("alert")).textContent).toContain(t(key));
  });

  it("ship validates the weight, shows the AWB and a safe label link only", async () => {
    const f = fakeApi();
    f.api.shipOrder.mockResolvedValueOnce(ok({ id: ORDER, awb: "AWB-9", label_url: "javascript:alert(1)" }));
    mount(["ship"], f.api);
    fireEvent.click(screen.getByRole("button", { name: t("seller.orders.action.ship") }));
    fireEvent.change(screen.getByLabelText(t("seller.orders.ship.weight")), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: t("seller.orders.confirm.yes") }));
    expect((await screen.findByRole("alert")).textContent).toContain(t("seller.orders.ship.weightInvalid", { min: PARCEL_WEIGHT_G.min, max: PARCEL_WEIGHT_G.max }));
    fireEvent.change(screen.getByLabelText(t("seller.orders.ship.weight")), { target: { value: "850" } });
    fireEvent.click(screen.getByRole("button", { name: t("seller.orders.confirm.yes") }));
    await waitFor(() => { expect(f.api.shipOrder).toHaveBeenCalledWith(ORDER, 850); });
    expect((await screen.findByRole("status")).textContent).toContain("AWB-9");
    expect(screen.queryByRole("link", { name: t("seller.orders.label.download") })).toBeNull();
  });

  it("shows a label download when the courier gives an https link", async () => {
    const f = fakeApi();
    f.api.shipOrder.mockResolvedValueOnce(ok({ id: ORDER, awb: "AWB-1", label_url: "https://labels.example/awb-1.pdf" }));
    mount(["ship"], f.api);
    fireEvent.click(screen.getByRole("button", { name: t("seller.orders.action.ship") }));
    fireEvent.change(screen.getByLabelText(t("seller.orders.ship.weight")), { target: { value: "500" } });
    fireEvent.click(screen.getByRole("button", { name: t("seller.orders.confirm.yes") }));
    expect((await screen.findByRole("link", { name: t("seller.orders.label.download") })).getAttribute("href")).toBe("https://labels.example/awb-1.pdf");
  });

  it.each([
    [fail(409, "invalid-transition"), "seller.orders.err.invalid"],
    [fail(503, "courier-unconfigured"), "seller.orders.err.courier"],
    [fail(409, "delivery-data-unavailable"), "seller.orders.err.delivery"],
    [fail(403, "forbidden"), "seller.error.forbidden"],
  ] as const)("maps %j to a message and keeps the confirmation open", async (failure, key) => {
    const f = fakeApi();
    f.api.packOrder.mockResolvedValueOnce(failure);
    mount(["pack"], f.api);
    fireEvent.click(screen.getByRole("button", { name: t("seller.orders.action.pack") }));
    fireEvent.click(screen.getByRole("button", { name: t("seller.orders.confirm.yes") }));
    expect((await screen.findByRole("alert")).textContent).toContain(t(key));
    expect(screen.getByRole("button", { name: t("seller.orders.confirm.yes") })).toBeTruthy();
    expect(await clean()).toEqual([]);
  });

  it("says so when nothing can be done", () => {
    mount([]);
    expect(screen.getByText(t("seller.orders.actions.none"))).toBeTruthy();
  });
});

describe.each(LOCALES)("InventoryTable (%s)", (locale) => {
  const t = createTranslator(locale);
  const rows: InventoryRow[] = [
    { sku_id: "s1", seller_sku: "SKU-1", size_label: "M", product_title_ar: "فستان", on_hand: 50, committed: 2, available: 48, low_stock: false, version: 3 },
    { sku_id: "s2", seller_sku: "SKU-2", size_label: null, product_title_ar: "حذاء", on_hand: 2, committed: 0, available: 2, low_stock: true, version: 1 },
    { sku_id: "s3", seller_sku: "SKU-3", size_label: "L", product_title_ar: "شنطة", on_hand: 0, committed: 0, available: 0, low_stock: true, version: 0 },
  ];

  it("shows real counts, a low-stock and an out-of-stock badge, and is accessible", async () => {
    render(<InventoryTable locale={locale} marketId="EG" rows={rows} api={fakeApi().api} />);
    const body = screen.getAllByRole("row").slice(1);
    expect(within(body[0]!).getByText(t("seller.inventory.status.ok"))).toBeTruthy();
    expect(within(body[1]!).getByText(t("seller.inventory.status.low"))).toBeTruthy();
    expect(within(body[2]!).getByText(t("seller.inventory.status.out"))).toBeTruthy();
    expect(await clean()).toEqual([]);
  });

  it("the adjust form needs a non-zero whole number and a reason, then sends the version it saw", async () => {
    const f = fakeApi();
    f.api.adjustStock.mockResolvedValueOnce(ok({ sku_id: "s1", location_id: "l", on_hand: 45, committed: 2, available: 43, low_stock: false, version: 4 }));
    render(<InventoryTable locale={locale} marketId="EG" rows={rows} api={f.api} />);
    fireEvent.click(screen.getAllByRole("button", { name: new RegExp(t("seller.inventory.adjust")) })[0]!);
    expect(await clean()).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: t("seller.inventory.adjust.submit") }));
    expect((await screen.findByRole("alert")).textContent).toContain(t("seller.inventory.adjust.invalid"));
    expect(f.api.adjustStock).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(t("seller.inventory.adjust.delta")), { target: { value: "-5" } });
    fireEvent.change(screen.getByLabelText(t("seller.inventory.adjust.reason")), { target: { value: "damage" } });
    fireEvent.click(screen.getByRole("button", { name: t("seller.inventory.adjust.submit") }));
    await waitFor(() => { expect(f.api.adjustStock).toHaveBeenCalledWith({ sku_id: "s1", delta: -5, reason: "damage", expected_version: 3 }); });
    expect((await screen.findByRole("status")).textContent).toContain(t("seller.inventory.adjust.saved", { onHand: 45 }));
  });

  it("a stale version shows the conflict message and reloads the numbers", async () => {
    const f = fakeApi();
    f.api.adjustStock.mockResolvedValueOnce(fail(409, "version-conflict"));
    refresh.mockClear();
    render(<InventoryTable locale={locale} marketId="EG" rows={rows} api={f.api} />);
    fireEvent.click(screen.getAllByRole("button", { name: new RegExp(t("seller.inventory.adjust")) })[1]!);
    fireEvent.change(screen.getByLabelText(t("seller.inventory.adjust.delta")), { target: { value: "3" } });
    fireEvent.change(screen.getByLabelText(t("seller.inventory.adjust.reason")), { target: { value: "received" } });
    fireEvent.click(screen.getByRole("button", { name: t("seller.inventory.adjust.submit") }));
    expect((await screen.findByRole("alert")).textContent).toContain(t("seller.inventory.err.version"));
    expect(refresh).toHaveBeenCalled();
  });
});

describe("SlaCountdown and chips", () => {
  it("counts down from the server clock, flags late deadlines, and ticks", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const t = createTranslator("en-EG");
    render(<SlaCountdown locale="en-EG" kind="accept" deadline="2030-01-01T05:30:00.000Z" serverTime="2030-01-01T00:00:00.000Z" />);
    expect(screen.getByText(t("seller.orders.sla.acceptIn", { time: t("seller.orders.sla.time", { hours: 5, minutes: 30 }) }))).toBeTruthy();
    act(() => { vi.advanceTimersByTime(30_000 * 60); });
    expect(screen.getByText(t("seller.orders.sla.acceptIn", { time: t("seller.orders.sla.time", { hours: 5, minutes: 0 }) }))).toBeTruthy();
    vi.useRealTimers();
  });
  it("a passed dispatch deadline reads as late", () => {
    const t = createTranslator("ar-EG");
    render(<SlaCountdown locale="ar-EG" kind="dispatch" deadline="2030-01-01T00:00:00.000Z" serverTime="2030-01-01T02:10:00.000Z" />);
    const el = screen.getByText(t("seller.orders.sla.dispatchLate", { time: t("seller.orders.sla.time", { hours: 2, minutes: 10 }) }));
    expect(el.getAttribute("data-late")).toBe("true");
  });
  it("status chips are text, translated, and unknown states fall back to the code", () => {
    const t = createTranslator("en-EG");
    render(<><StatusChip t={t} status="PAID" /><StatusChip t={t} status="WEIRD" /></>);
    expect(screen.getByText(t("seller.orders.status.PAID")).getAttribute("data-tone")).toBe("action");
    expect(screen.getByText("WEIRD")).toBeTruthy();
  });
});

describe("sla helpers", () => {
  it("computes remaining and late spans", () => {
    expect(slaRemaining(new Date("2030-01-01T01:30:00Z"), new Date("2030-01-01T00:00:00Z"))).toEqual({ late: false, hours: 1, minutes: 30 });
    expect(slaRemaining(new Date("2030-01-01T00:00:00Z"), new Date("2030-01-01T03:05:59Z"))).toEqual({ late: true, hours: 3, minutes: 5 });
  });
  it("maps states to the deadline that applies", () => {
    expect([slaKindOf("PAID"), slaKindOf("CONFIRMED_COD"), slaKindOf("ACCEPTED"), slaKindOf("PACKED"), slaKindOf("SHIPPED")]).toEqual(["accept", "accept", "dispatch", "dispatch", null]);
  });
  it("only follows https or same-origin label links", () => {
    expect([safeHref(null), safeHref("https://x.test/a.pdf"), safeHref("/labels/1.pdf"), safeHref("//evil.test/x"), safeHref("http://x.test"), safeHref("data:text/html,x")]).toEqual([null, "https://x.test/a.pdf", "/labels/1.pdf", null, null, null]);
  });
});
