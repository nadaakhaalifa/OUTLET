import { describe, expect, it } from "vitest";
import { InMemoryBrandPort } from "./fake";
import {
  EMPTY_DRAFT, afterFailure, buildDashboard, filterProducts, maskedBuyer, movePhoto, normalizeEgPhone, orderActions, parseEgp, publishGate,
  queueOf, rejectValid, serverClock, slaCountdown, validateDraft, validateGtin, validateIban, validateReturnPolicy, validateTitleAr, validateVacation,
  type BrandProduct, type DashboardData, type PhotoItem, type ProductDraft,
} from "./model";

const done = (id: string): PhotoItem => ({ localId: id, uri: `file://${id}`, uploadId: id, progress: 1, state: "done" });
const good: ProductDraft = { ...EMPTY_DRAFT, photos: [done("a")], titleAr: "فستان كتان", categoryId: "c", condition: "new_with_tags", priceInput: "1,250.50", sizes: [{ label: "M", stock: "3" }], sizeChartId: "sc" };

describe("price parsing", () => {
  it("parses to piastres without floats, incl. Eastern digits", () => {
    expect(parseEgp("1,250.5")).toEqual({ ok: true, piastres: 125050n });
    expect(parseEgp("١٢٥٠٫٥٠")).toEqual({ ok: true, piastres: 125050n });
    expect(parseEgp("0.1")).toEqual({ ok: true, piastres: 10n });
  });
  it("rejects bad input", () => {
    expect(parseEgp("")).toMatchObject({ code: "empty" });
    expect(parseEgp("abc")).toMatchObject({ code: "format" });
    expect(parseEgp("1.234")).toMatchObject({ code: "too_many_decimals" });
    expect(parseEgp("0")).toMatchObject({ code: "not_positive" });
    expect(parseEgp("99999999")).toMatchObject({ code: "too_large" });
  });
});

describe("product form", () => {
  it("requires an Arabic title", () => {
    expect(validateTitleAr("")).toBe("required");
    expect(validateTitleAr("White dress")).toBe("arabic_required");
    expect(validateTitleAr("فس")).toBe("too_short");
    expect(validateTitleAr("فستان")).toBeNull();
  });
  it("publishes only when complete and says what is missing", () => {
    expect(publishGate(good, { sized: true }).canPublish).toBe(true);
    const g = publishGate({ ...EMPTY_DRAFT }, { sized: true });
    expect(g.canPublish).toBe(false);
    expect(g.missing).toEqual(expect.arrayContaining(["photos", "titleAr", "category", "condition", "price", "sizes"]));
  });
  it("requires defect photos for minor defects and finished uploads", () => {
    expect(publishGate({ ...good, condition: "minor_defect" }, { sized: true }).missing).toContain("defect_photos");
    const up: ProductDraft = { ...good, photos: [{ ...done("a"), state: "uploading" }] };
    expect(publishGate(up, { sized: true }).missing).toContain("uploads_pending");
  });
  it("needs a size chart for sized categories only", () => {
    expect(publishGate({ ...good, sizeChartId: null }, { sized: true }).missing).toContain("size_chart");
    expect(publishGate({ ...good, sizeChartId: null }, { sized: false }).canPublish).toBe(true);
  });
  it("validates sizes and barcodes", () => {
    expect(validateDraft({ ...good, sizes: [{ label: "M", stock: "1" }, { label: "m", stock: "2" }] }).sizes).toBe("size_duplicate");
    expect(validateDraft({ ...good, sizes: [{ label: "M", stock: "-1" }] }).sizes).toBe("stock_invalid");
    expect(validateGtin("4006381333931")).toBe(true);
    expect(validateGtin("4006381333932")).toBe(false);
  });
  it("reorders photos", () => {
    expect(movePhoto(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(movePhoto(["a"], 0, 3)).toEqual(["a"]);
  });
});

describe("IBAN", () => {
  // Valid-checksum Egyptian IBAN built for the test (EG + 2 check digits + 25 digits).
  const body = "0019000500000000263180002";
  const check = (() => {
    const n = BigInt(body + "141600"); // EG=1416, check digits 00
    return String(98n - (n % 97n)).padStart(2, "0");
  })();
  const iban = `EG${check}${body}`;
  it("accepts a valid checksum, tolerating spaces", () => {
    const r = validateIban(iban.replace(/(.{4})/g, "$1 "));
    expect(r).toMatchObject({ ok: true, normalized: iban, last4: iban.slice(-4) });
  });
  it("rejects wrong checksum, length and country", () => {
    const bad = iban.slice(0, -1) + (iban.endsWith("0") ? "1" : "0");
    expect(validateIban(bad)).toEqual({ ok: false, code: "checksum" });
    expect(validateIban("EG12")).toEqual({ ok: false, code: "length" });
    expect(validateIban("GB82WEST12345698765432")).toEqual({ ok: false, code: "country" });
  });
});

describe("SLA countdown (server time)", () => {
  it("uses the server clock offset, not the device clock", () => {
    const clock = serverClock(1_000_000_000_000, 1_000_000_000_000 - 3_600_000); // device is 1 h behind
    const deviceNow = 1_000_000_000_000 - 3_600_000;
    const acceptBy = 1_000_000_000_000 + 2 * 3_600_000;
    const s = slaCountdown(acceptBy, deviceNow + clock.offsetMs);
    expect(s).toMatchObject({ hours: 2, minutes: 0, level: "warning" });
  });
  it("warns under 4 h, breaches at 0", () => {
    expect(slaCountdown(10 * 3_600_000, 0).level).toBe("ok");
    expect(slaCountdown(3 * 3_600_000, 0).level).toBe("warning");
    expect(slaCountdown(100, 100).level).toBe("breached");
  });
});

describe("orders", () => {
  it("offers actions by status and role", () => {
    expect(orderActions("PAID", "owner", false)).toEqual(["accept", "reject"]);
    expect(orderActions("PAID", "owner", true)).toEqual([]);
    expect(orderActions("PAID", "catalog", false)).toEqual([]);
    expect(orderActions("PACKED", "warehouse", false)).toEqual(["markReady", "printLabel"]);
    expect(orderActions("DELIVERED", "owner", false)).toEqual([]);
  });
  it("masks buyer data until accepted", () => {
    const b = { firstName: "Mona", governorate: "Cairo", phoneRelay: "+20100" };
    expect(maskedBuyer(b, "PAID").phoneRelay).toBeNull();
    expect(maskedBuyer(b, "ACCEPTED").phoneRelay).toBe("+20100");
    expect(maskedBuyer(b, "CLOSED").phoneRelay).toBeNull();
  });
  it("groups statuses and validates reject", () => {
    expect(queueOf("CONFIRMED_COD")).toBe("awaiting");
    expect(queueOf("PACKED")).toBe("toPack");
    expect(rejectValid(null, "")).toBe(false);
    expect(rejectValid("other", "x")).toBe(false);
    expect(rejectValid("out_of_stock", "")).toBe(true);
  });
});

describe("dashboard", () => {
  const base: DashboardData = {
    serverNowMs: 0, freshnessAtMs: 0, salesToday: null, ordersToday: null, awaiting: [], lowStock: [],
    payout: { available: null, pendingRelease: null, held: 0n, heldReasons: [], nextPayoutAtMs: null },
    trust: { score: null, ladder: "good_standing", violations: 0, windowDays: 90, fixes: [] },
    health: { score: null, dispatchOnTimeBp: null, cancellationBp: null, returnBp: null },
  };
  it("keeps nulls unavailable, never zero", () => {
    const v = buildDashboard(base, { offsetMs: 0 }, 5 * 60_000);
    expect(v.sales).toEqual({ kind: "unavailable" });
    expect(v.orders).toEqual({ kind: "unavailable" });
    expect(v.payoutEligible).toEqual({ kind: "unavailable" });
    expect(v.payoutHeld).toBeNull();
    expect(v.freshnessMin).toBe(5);
  });
  it("keeps real zero as a value and sorts awaiting by deadline", () => {
    const o = (id: string, by: number) => ({ id, status: "PAID" as const, lines: [], subtotal: 1n, netToSeller: null, buyer: { firstName: null, governorate: "Cairo", phoneRelay: null }, payment: "prepaid" as const, acceptByMs: by, createdAtMs: 0, awbUrl: null });
    const v = buildDashboard({ ...base, salesToday: 0n, ordersToday: 0, awaiting: [o("late", 9_000_000), o("soon", 1_000)] }, { offsetMs: 0 }, 0);
    expect(v.sales).toEqual({ kind: "value", value: 0n });
    expect(v.awaiting.map((a) => a.order.id)).toEqual(["soon", "late"]);
  });
});

describe("store rules", () => {
  it("enforces statutory return minimums", () => {
    expect(validateReturnPolicy(14, 30)).toEqual({ changeOfMind: true, defect: true });
    expect(validateReturnPolicy(7, 30).changeOfMind).toBe(false);
    expect(validateReturnPolicy(14, 20).defect).toBe(false);
    expect(validateReturnPolicy(100, 30).changeOfMind).toBe(false);
  });
  it("validates vacation and phone", () => {
    expect(validateVacation(null, 0)).toBe("end_required");
    expect(validateVacation(100 * 86_400_000, 0)).toBe("too_long");
    expect(validateVacation(5 * 86_400_000, 0)).toBe("ok");
    expect(normalizeEgPhone("0100 123 4567")).toBe("+201001234567");
    expect(normalizeEgPhone("12345")).toBeNull();
  });
});

describe("misc", () => {
  it("filters products", () => {
    const p = (id: string, status: BrandProduct["status"], stock: number, ar: string): BrandProduct => ({ id, status, titleAr: ar, titleEn: null, coverUri: null, priceFrom: null, totalStock: stock, sizes: 1, claim: "none", updatedAtMs: 0 });
    const l = [p("1", "active", 10, "فستان"), p("2", "draft", 1, "قميص")];
    expect(filterProducts(l, "draft", "").map((x) => x.id)).toEqual(["2"]);
    expect(filterProducts(l, "lowStock", "").map((x) => x.id)).toEqual(["2"]);
    expect(filterProducts(l, "all", "فست").map((x) => x.id)).toEqual(["1"]);
  });
  it("keeps stale data offline", () => {
    const prev = { status: "ready", data: 1, stale: false } as const;
    expect(afterFailure(prev, "offline")).toEqual({ status: "ready", data: 1, stale: true });
    expect(afterFailure(prev, "failed").status).toBe("error");
  });
  it("fake port enforces roles and the strong-factor window", async () => {
    let t = 0;
    const p = new InMemoryBrandPort(() => t, "catalog");
    await expect(p.savePayoutAccount("x", "y")).rejects.toMatchObject({ kind: "forbidden" });
    const owner = new InMemoryBrandPort(() => t, "owner");
    await expect(owner.savePayoutAccount("x", "y")).rejects.toMatchObject({ kind: "session_expired" });
    await owner.verifyStrongFactor("123456");
    t = 400_000;
    await expect(owner.savePayoutAccount("x", "y")).rejects.toMatchObject({ kind: "session_expired" });
  });
});
