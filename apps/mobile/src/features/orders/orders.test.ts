import { describe, expect, it } from "vitest";
import {
  FIXTURE_ORDERS, InMemoryOrdersPort, applyCancelled, canCancel, formatDay, progress, resumable, returnable, safeReceiptUrl, sortOrders, trackingTimeline,
} from "./model";

describe("cancellation", () => {
  it("is allowed only before shipping", () => {
    for (const s of ["PENDING_PAYMENT", "PAID", "CONFIRMED_COD", "ACCEPTED", "PACKED"] as const) expect(canCancel(s)).toBe(true);
    for (const s of ["SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED", "CANCELLED", "RTO"] as const) expect(canCancel(s)).toBe(false);
  });
  it("marks only the targeted seller order as cancelled", async () => {
    const gs = await new InMemoryOrdersPort().list();
    const next = applyCancelled(gs, "so-2");
    expect(next.flatMap((g) => g.sellerOrders).find((o) => o.id === "so-2")?.status).toBe("CANCELLED");
    expect(next.flatMap((g) => g.sellerOrders).find((o) => o.id === "so-1")?.status).toBe("SHIPPED");
  });
});

describe("progress", () => {
  it("marks steps up to the current one", () => {
    const p = progress("PACKED");
    expect(p.onPath).toBe(true);
    expect(p.steps.filter((s) => s.done).map((s) => s.step)).toEqual(["PAID", "ACCEPTED", "PACKED"]);
    expect(p.steps.find((s) => s.current)?.step).toBe("PACKED");
  });
  it("treats COD confirmation as paid and off-path states as no progress", () => {
    expect(progress("CONFIRMED_COD").steps.find((s) => s.current)?.step).toBe("PAID");
    expect(progress("CANCELLED").onPath).toBe(false);
    expect(progress("CANCELLED").steps.some((s) => s.done)).toBe(false);
  });
});

describe("receipts and returns", () => {
  it("opens only https receipt links", () => {
    expect(safeReceiptUrl({ uuid: "u", url: "https://eta.example/r" })).toBe("https://eta.example/r");
    expect(safeReceiptUrl({ uuid: "u", url: "javascript:alert(1)" })).toBeNull();
    expect(safeReceiptUrl({ uuid: "u", url: null })).toBeNull();
    expect(safeReceiptUrl(null)).toBeNull();
  });
  it("offers returns only after delivery", () => {
    const so = FIXTURE_ORDERS.flatMap((g) => g.sellerOrders);
    expect(returnable(so.find((o) => o.id === "so-0")!)).toBe(true);
    expect(returnable(so.find((o) => o.id === "so-1")!)).toBe(false);
  });
});

describe("list", () => {
  it("sorts newest first and flags unfinished payments as resumable", () => {
    const s = sortOrders(FIXTURE_ORDERS);
    expect(s.map((g) => g.id)).toEqual(["og-3", "og-2", "og-1"]);
    expect(resumable(s[0]!)).toBe(true);
    expect(resumable(s[1]!)).toBe(false);
  });
  it("orders tracking events newest first and formats days with locale digits", () => {
    const sh = FIXTURE_ORDERS[0]!.sellerOrders[0]!.shipment!;
    expect(trackingTimeline(sh)[0]?.status).toBe("in_transit");
    expect(formatDay("2026-10-09T10:00:00Z", (s) => s)).toBe("2026-10-09");
    expect(formatDay("garbage", (s) => s)).toBe("");
  });
});

import { FIXTURE_ORDERS as FX, filterOrders, groupStatusKey, orderBucket } from "./model";
import { describe as d2, expect as e2, it as i2 } from "vitest";

d2("order filters", () => {
  i2("buckets groups honestly", () => {
    e2(FX.map(orderBucket)).toEqual(["active", "delivered", "active"]);
    e2(filterOrders(FX, "delivered").map((g) => g.id)).toEqual(["og-1"]);
    e2(filterOrders(FX, "all")).toHaveLength(3);
  });
  i2("headline status is the least advanced active seller order", () => {
    e2(groupStatusKey(FX[0]!)).toBe("PACKED");
    e2(groupStatusKey(FX[2]!)).toBe("PENDING_PAYMENT");
  });
});
