import { describe, expect, it } from "vitest";
import { URGENT_MS, countdownLabel, countdownTone, kpiTiles, sectionOrder } from "./dashboardModel";

const order = (id: string) => ({ order: { id } as never, sla: {} as never });

describe("dashboard model", () => {
  it("tone thresholds: calm at 3 h and above, urgent below, closed at 0", () => {
    expect(countdownTone(URGENT_MS)).toBe("calm");
    expect(countdownTone(URGENT_MS - 1)).toBe("urgent");
    expect(countdownTone(1)).toBe("urgent");
    expect(countdownTone(0)).toBe("closed");
    expect(countdownTone(-5)).toBe("closed");
  });
  it("kpi tiles keep null as unavailable and a real zero as a value", () => {
    const t = kpiTiles({ sales: { kind: "unavailable" }, orders: { kind: "value", value: 0 }, awaiting: [] });
    expect(t.map((x) => x.key)).toEqual(["sales", "orders", "awaiting"]);
    expect(t[0]?.metric).toEqual({ kind: "unavailable" });
    expect(t[1]?.metric).toEqual({ kind: "value", value: 0 });
    expect(t[2]?.metric).toEqual({ kind: "value", value: 0 });
    expect(kpiTiles({ sales: { kind: "value", value: 5n }, orders: { kind: "value", value: 1 }, awaiting: [order("a"), order("b")] })[2]?.metric).toEqual({ kind: "value", value: 2 });
  });
  it("section ordering: actions first when orders wait", () => {
    expect(sectionOrder({ awaiting: [order("a")], lowStock: [] })).toEqual(["actions", "money", "health"]);
    expect(sectionOrder({ awaiting: [order("a")], lowStock: [{ skuId: "s", productTitle: "p", sizeLabel: "M", available: 1 }] })).toEqual(["actions", "lowStock", "money", "health"]);
    expect(sectionOrder({ awaiting: [], lowStock: [] })).toEqual(["caughtUp", "money", "health"]);
  });
  it("countdown label", () => {
    expect(countdownLabel({ remainingMs: 0, hours: 0, minutes: 0 })).toEqual({ kind: "closed" });
    expect(countdownLabel({ remainingMs: 600_000, hours: 0, minutes: 10 })).toEqual({ kind: "minutes", minutes: 10 });
    expect(countdownLabel({ remainingMs: 8_000_000, hours: 2, minutes: 14 })).toEqual({ kind: "hoursMinutes", hours: 2, minutes: 14 });
  });
});
