import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranslator, type Locale } from "@outlet/i18n";

vi.mock("next/navigation", () => ({ usePathname: () => "/eg-en", useRouter: () => ({ back: vi.fn(), refresh: vi.fn() }) }));

import { SalesAndOrders } from "../src/components/home/SalesAndOrders";
import type { Range } from "../src/lib/dashboard";
import { DASH_NOW, dashboardFixture, forbidden, unavailable } from "./fake-data";

afterEach(cleanup);
const egp = (minor: string) => ({ amount_minor: minor, currency: "EGP" });
const day = (offset: number) => new Date(Date.UTC(2026, 10, 10) + offset * 86_400_000).toISOString().slice(0, 10);
const view = (over: Parameters<typeof dashboardFixture>[0], range: Range = "30d", locale: Locale = "en-EG") =>
  render(<SalesAndOrders resp={dashboardFixture(over, range)} range={range} now={DASH_NOW} t={createTranslator(locale)} locale={locale} base="/eg-en" rtl={locale === "ar-EG"} />);
const T = createTranslator("en-EG");
const okTile = (key: string, data: unknown) => ({ key, status: "ok" as const, as_of: "2026-11-10T08:59:30Z", data });
const HIDDEN = { sales_series: forbidden("sales_series"), orders_by_step: forbidden("orders_by_step"), top_stores: forbidden("top_stores"), verified_discount_share: forbidden("verified_discount_share") };

describe("SalesAndOrders states", () => {
  it("renders nothing at all when the role may see none of its four tiles", () => {
    const { container } = view(HIDDEN);
    expect(container.innerHTML).toBe("");
  });

  it("without GMV permission the chart is the orders series with an orders summary, never a money figure", () => {
    const orders = Array.from({ length: 7 }, (_, i) => ({ day: day(i - 6), value: i + 1 }));
    view({ sales_series: okTile("sales_series", { orders, gmv: null, total_orders: 28, total_gmv: null }), top_stores: forbidden("top_stores") }, "7d");
    expect(screen.getAllByText(T("admin.home.sales.ordersTitle")).length).toBeGreaterThan(0);
    expect(screen.getByText(T("admin.home.sales.summaryOrders", { total: "28" }))).toBeTruthy();
    expect(screen.queryByText(/EGP/)).toBeNull();
  });

  it("a series with neither orders nor GMV says there is no series instead of drawing an empty chart", () => {
    view({ sales_series: okTile("sales_series", { orders: null, gmv: null, total_orders: null, total_gmv: null }) });
    expect(screen.getByText(T("admin.home.sales.noSeries"))).toBeTruthy();
  });

  it("a long range is shown in weekly buckets with the weekly title", () => {
    view({}, "90d");
    expect(screen.getAllByText(T("admin.home.sales.gmvTitleWeek")).length).toBeGreaterThan(0);
  });

  it("an unreadable series, steps or top-stores read each say why, in their own panel", () => {
    view({ sales_series: unavailable("sales_series", "stale"), orders_by_step: unavailable("orders_by_step", "read_failed"), top_stores: unavailable("top_stores", "not_connected"), verified_discount_share: unavailable("verified_discount_share", "not_connected") });
    expect(screen.getAllByText(T("admin.home.unavailable.stale")).length).toBeGreaterThan(0);
    expect(screen.getAllByText(T("admin.home.unavailable.read_failed")).length).toBeGreaterThan(0);
    expect(screen.getAllByText(T("admin.home.unavailable.not_connected")).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByTestId("panel-unavailable").length).toBeGreaterThanOrEqual(1);
  });
});

describe("SalesAndOrders panels", () => {
  it("no verified discounts yet says so instead of 0%; some show a percentage", () => {
    view({ verified_discount_share: okTile("verified_discount_share", { verified: 0, live_skus: 0 }) });
    expect(screen.getByText(T("admin.home.verified.none"))).toBeTruthy();
    cleanup();
    view({ verified_discount_share: okTile("verified_discount_share", { verified: 30, live_skus: 120 }) });
    expect(screen.getByText(/25/)).toBeTruthy();
  });

  it("top stores: the 'other stores' row appears only when there are other stores; an English reader gets the English name, falling back to Arabic", () => {
    const item = (name_en: string | null) => ({ store_id: "5702e000-0000-4000-8000-000000000001", name_ar: "متجر النيل", name_en, orders: 12, gmv: egp("900000") });
    view({ top_stores: okTile("top_stores", { items: [item("Nile Store")], other: { stores: 0, orders: 0, gmv: egp("0") } }) });
    expect(screen.getByText("Nile Store")).toBeTruthy();
    expect(screen.queryByText(T("admin.home.topStores.other", { stores: "3" }))).toBeNull();
    cleanup();
    view({ top_stores: okTile("top_stores", { items: [item(null)], other: { stores: 3, orders: 7, gmv: egp("100000") } }) });
    expect(screen.getByText("متجر النيل")).toBeTruthy();
    expect(screen.getByText(T("admin.home.topStores.other", { stores: "3" }))).toBeTruthy();
    cleanup();
    view({ top_stores: okTile("top_stores", { items: [item("Nile Store")], other: { stores: 0, orders: 0, gmv: egp("0") } }) }, "30d", "ar-EG");
    expect(screen.getByText("متجر النيل")).toBeTruthy();
  });

  it("no top stores in the window shows the empty text, and steps that are all zero still list every step", () => {
    view({ top_stores: okTile("top_stores", { items: [], other: { stores: 0, orders: 0, gmv: egp("0") } }), orders_by_step: okTile("orders_by_step", { paid_awaiting_accept: 0, accepted: 0, packed: 0, in_transit: 0, delivery_failed: 0 }) });
    expect(screen.getByText(T("admin.home.topStores.empty"))).toBeTruthy();
    expect(screen.getByText(T("admin.home.steps.delivery_failed"))).toBeTruthy();
  });

  it("the active range pill is marked and links keep the base path", () => {
    const { container } = view({}, "7d");
    const pills = [...container.querySelectorAll<HTMLAnchorElement>("a.rangePill")];
    expect(pills.map((a) => a.getAttribute("href"))).toEqual(["/eg-en?range=7d", "/eg-en?range=30d", "/eg-en?range=90d"]);
    expect(pills.map((a) => a.hasAttribute("aria-current"))).toEqual([true, false, false]);
  });
});
