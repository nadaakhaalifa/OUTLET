/**
 * DEV-FIXTURES-ONLY demo brand ("Nile Outlet"). Reachable solely through `demoBrandPortIfAllowed`, which returns null in any
 * release build and in any build that talks to a real API (see `isDemoBrandAllowed` in services/release-guard.ts).
 * Everything here is invented sample data; a reference price is attached only to products whose claim is "verified_discount".
 */
import { isDemoBrandAllowed, type BackendConfig } from "../../services/release-guard";
import { InMemoryBrandPort, type BrandSeed } from "./fake";
import type { DashboardSummary, PeriodTotals, SummaryPeriod } from "./summaryModel";
import type { BrandAccount, BrandOrder, BrandOrderLine, BrandPort, BrandProduct, DashboardData, OrderStatus, StoreSettings } from "./model";

const H = 3_600_000;
const D = 24 * H;

export const DEMO_ACCOUNT: BrandAccount = {
  storeId: "00000000-0000-4000-8000-00000000d3a0",
  name: { ar: "نايل أوتلت", en: "Nile Outlet" },
  role: "owner",
  kind: "local",
};

type P = Pick<BrandProduct, "id" | "status" | "titleAr" | "titleEn" | "priceFrom" | "totalStock" | "sizes" | "claim"> & { ref?: bigint; ageH: number };
const PRODUCTS: readonly P[] = [
  { id: "d-p01", status: "active", titleAr: "فستان كتان أبيض", titleEn: "White linen dress", priceFrom: 129_000n, ref: 189_000n, totalStock: 14, sizes: 4, claim: "verified_discount", ageH: 30 },
  { id: "d-p02", status: "active", titleAr: "قميص قطن أزرق", titleEn: "Blue cotton shirt", priceFrom: 45_000n, totalStock: 2, sizes: 3, claim: "none", ageH: 20 },
  { id: "d-p03", status: "active", titleAr: "بنطلون جينز واسع", titleEn: "Wide-leg jeans", priceFrom: 89_900n, ref: 125_000n, totalStock: 22, sizes: 5, claim: "verified_discount", ageH: 60 },
  { id: "d-p04", status: "active", titleAr: "حقيبة جلد طبيعي", titleEn: "Natural leather bag", priceFrom: 210_000n, totalStock: 7, sizes: 1, claim: "lowest_30d", ageH: 72 },
  { id: "d-p05", status: "paused", titleAr: "حذاء جلد كلاسيك", titleEn: "Classic leather shoe", priceFrom: 175_000n, totalStock: 9, sizes: 5, claim: "launch_price", ageH: 170 },
  { id: "d-p06", status: "active", titleAr: "فستان حرير أسود", titleEn: "Black silk dress", priceFrom: 260_000n, ref: 340_000n, totalStock: 6, sizes: 3, claim: "verified_discount", ageH: 100 },
  { id: "d-p07", status: "active", titleAr: "بلوزة شيفون", titleEn: "Chiffon blouse", priceFrom: 59_500n, totalStock: 18, sizes: 4, claim: "none", ageH: 90 },
  { id: "d-p08", status: "draft", titleAr: "جاكيت دنيم", titleEn: "Denim jacket", priceFrom: null, totalStock: 0, sizes: 1, claim: "none", ageH: 4 },
  { id: "d-p09", status: "active", titleAr: "سنيكرز أبيض", titleEn: "White sneakers", priceFrom: 139_000n, totalStock: 12, sizes: 6, claim: "launch_price", ageH: 40 },
  { id: "d-p10", status: "active", titleAr: "حجاب قطن", titleEn: "Cotton scarf", priceFrom: 22_000n, totalStock: 40, sizes: 1, claim: "none", ageH: 200 },
  { id: "d-p11", status: "active", titleAr: "تنورة ميدي", titleEn: "Midi skirt", priceFrom: 74_000n, ref: 99_000n, totalStock: 10, sizes: 4, claim: "verified_discount", ageH: 55 },
  { id: "d-p12", status: "active", titleAr: "حزام جلد", titleEn: "Leather belt", priceFrom: 31_000n, totalStock: 25, sizes: 3, claim: "none", ageH: 120 },
];

const line = (id: string, title: string, size: string | null, qty: number, price: bigint): BrandOrderLine => ({ id, title, sizeLabel: size, qty, unitPrice: price });

function orders(t: number): readonly BrandOrder[] {
  const o = (id: string, status: OrderStatus, lines: BrandOrderLine[], net: bigint | null, firstName: string, governorate: string, payment: "prepaid" | "cod", acceptInH: number, ageH: number, awb: boolean): BrandOrder => ({
    id, status, lines, subtotal: lines.reduce((n, l) => n + l.unitPrice * BigInt(l.qty), 0n), netToSeller: net,
    buyer: { firstName, governorate, phoneRelay: "+20 10 5550 0" + id.slice(-3) }, payment, acceptByMs: t + acceptInH * H, createdAtMs: t - ageH * H, awbUrl: awb ? `https://example.invalid/awb/${id}.pdf` : null,
  });
  return [
    o("d-o1001", "PAID", [line("a1", "فستان كتان أبيض", "M", 1, 129_000n)], 112_000n, "منى", "القاهرة", "prepaid", 19, 5, false),
    o("d-o1002", "CONFIRMED_COD", [line("a2", "قميص قطن أزرق", "L", 2, 45_000n)], 78_000n, "كريم", "الجيزة", "cod", 2.5, 21, false),
    o("d-o1003", "ACCEPTED", [line("a3", "حقيبة جلد طبيعي", null, 1, 210_000n)], 183_000n, "سلمى", "الإسكندرية", "prepaid", -4, 28, false),
    o("d-o1004", "PACKED", [line("a4", "سنيكرز أبيض", "40", 1, 139_000n), line("a5", "حزام جلد", "M", 1, 31_000n)], 148_000n, "عمر", "القاهرة", "prepaid", -30, 52, true),
    o("d-o1005", "SHIPPED", [line("a6", "فستان حرير أسود", "S", 1, 260_000n)], 226_000n, "هبة", "المنصورة", "prepaid", -60, 80, true),
    o("d-o1006", "DELIVERED", [line("a7", "تنورة ميدي", "M", 1, 74_000n)], 64_000n, "ياسمين", "طنطا", "cod", -120, 150, true),
  ];
}

function dashboard(all: readonly BrandOrder[], t: number): DashboardData {
  return {
    serverNowMs: t,
    freshnessAtMs: t - 4 * 60_000,
    salesToday: 258_000n,
    ordersToday: 3,
    awaiting: all.filter((o) => o.status === "PAID" || o.status === "CONFIRMED_COD"),
    lowStock: [
      { skuId: "d-s1", productTitle: "قميص قطن أزرق", sizeLabel: "L", available: 1 },
      { skuId: "d-s2", productTitle: "فستان كتان أبيض", sizeLabel: "S", available: 2 },
      { skuId: "d-s3", productTitle: "فستان حرير أسود", sizeLabel: "XS", available: 0 },
    ],
    payout: { available: 412_500n, pendingRelease: 129_000n, held: 0n, heldReasons: [], nextPayoutAtMs: t + 3 * D },
    trust: { score: 82, ladder: "good_standing", violations: 0, windowDays: 90, fixes: [] },
    health: { score: 91, dispatchOnTimeBp: 9600, cancellationBp: null, returnBp: 640 },
    salesTrend: [96_000n, 184_000n, 142_000n, 301_000n, 228_000n, 175_000n, 258_000n],
    recentOrders: all.filter((o) => o.status === "PACKED" || o.status === "SHIPPED" || o.status === "DELIVERED" || o.status === "ACCEPTED"),
    plan: { code: "growth", name: { ar: "النمو", en: "Growth" } },
  };
}

/** Invented daily gross sales (EGP, oldest first) for the 60 days before today: a weekly rhythm plus a gentle upward drift. */
const DAILY_EGP: readonly number[] = Array.from({ length: 60 }, (_, i) => {
  const weekly = [0.82, 0.9, 1.0, 0.95, 1.25, 1.45, 1.1][i % 7] ?? 1;
  const wobble = [1.0, 1.08, 0.93, 1.04, 0.97, 1.12, 0.9][(i * 3) % 7] ?? 1;
  return Math.round(2_900 * weekly * wobble * (0.8 + i / 150));
});
const AVG_ORDER_EGP = 1_150;
const DEMO_TOP: readonly (readonly [string, number])[] = [["d-p01", 31], ["d-p03", 24], ["d-p11", 19], ["d-p09", 14], ["d-p07", 11]];

const cairoDay = (ms: number): string => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date(ms));
const bpsOf = (cur: bigint, prev: bigint): number | null => (prev === 0n ? null : Number(((cur - prev) * 10_000n * 2n + (cur - prev >= 0n ? prev : -prev)) / (prev * 2n)));

function totalsFor(grossEgp: number, days: number, withRepeat: boolean): PeriodTotals {
  const gross = BigInt(grossEgp) * 100n;
  const orders = Math.max(1, Math.round(grossEgp / AVG_ORDER_EGP));
  const units = Math.round(orders * 1.35);
  const returned = Math.round(units * 0.062);
  const views = orders * 44;
  const share = (pct: number) => Math.round((units * pct) / 100);
  return {
    grossSales: gross, netAfterCommission: (gross * 8_700n) / 10_000n, orders, units, averageOrderValue: gross / BigInt(orders),
    returnRateBp: Math.round((returned * 10_000) / units), repeatRateBp: withRepeat ? 1_840 : null,
    funnel: { views, bagAdds: Math.round(views * 0.092), checkouts: Math.round(views * 0.041), purchases: orders },
    topProducts: DEMO_TOP.map(([id, pct]) => {
      const u = Math.max(1, share(pct * (days > 1 ? 1 : 0.6)));
      const p = PRODUCTS.find((x) => x.id === id);
      return { productId: id, title: p === undefined ? null : { ar: p.titleAr, en: p.titleEn ?? p.titleAr }, units: u, grossSales: BigInt(u) * (p?.priceFrom ?? 0n) };
    }),
  };
}

/** Realistic period overview in the same shape the API returns (7d/30d/today, previous period, funnel, top products). */
export function demoSummary(period: SummaryPeriod, now: number): DashboardSummary {
  const span = period === "today" ? 1 : period === "7d" ? 7 : 30;
  // Series ends with today: the last entry is the partial current day.
  const series = [...DAILY_EGP.slice(0, 59), Math.round((DAILY_EGP[59] ?? 0) * 0.55)];
  const sum = (a: readonly number[]) => a.reduce((n, v) => n + v, 0);
  const cur = series.slice(60 - span);
  const prevAll = series.slice(60 - 2 * span, 60 - span);
  const c = totalsFor(sum(cur), span, period === "30d");
  const p = totalsFor(sum(prevAll), span, period === "30d");
  const growth = (a: bigint, b: bigint) => bpsOf(a, b);
  const days = cur.map((v, i) => ({ day: cairoDay(now - (span - 1 - i) * 24 * H), grossSales: BigInt(v) * 100n }));
  return {
    period, current: c, previous: p,
    growth: {
      grossSales: growth(c.grossSales, p.grossSales), netAfterCommission: growth(c.netAfterCommission, p.netAfterCommission),
      orders: growth(BigInt(c.orders), BigInt(p.orders)), units: growth(BigInt(c.units), BigInt(p.units)),
      averageOrderValue: c.averageOrderValue === null || p.averageOrderValue === null ? null : growth(c.averageOrderValue, p.averageOrderValue),
    },
    dailySales: days,
    // Same honesty as the real API today: these four have no event source yet.
    unavailable: ["net_sales_after_returns", "cancellation_rate", "cod_refusal_by_governorate", "in_transit_payouts"],
    definitions: {
      gross_sales: "Sum of purchase gross value (VAT-inclusive) for orders placed in the period, before returns and commission.",
      net_after_commission: "Gross sales minus commission on those sales. Not net of returns and not the payout statement.",
      return_rate: "Units returned in the period divided by units sold in the period.",
      repeat_customer_rate: "Buyers with two or more orders in the period divided by distinct buyers; shown from 50 buyers.",
      funnel: "Consent-sampled client events (views, bag adds, checkouts) next to purchase facts; not a complete census.",
      growth: "(current - previous) / previous; shown as New when the previous period had none.",
    },
    asOfMs: now - 3 * 60_000, withinSlo: true, kMin: 50,
  };
}

function settings(): StoreSettings {
  return {
    name: DEMO_ACCOUNT.name,
    description: { ar: "ملابس وإكسسوارات من فائض الموسم بأسعار حقيقية.", en: "End-of-season clothing and accessories at real prices." },
    logoUri: null, coverUri: null,
    social: { instagram: "nile.outlet", website: "" },
    returnDays: { changeOfMind: 14, defect: 30 },
    shipping: { governorate: "Cairo", city: "Nasr City", street: "12 Abbas El Akkad", handlingHours: 48 },
    vacationEndMs: null,
    payout: { last4: "4821", holder: "Nile Outlet LLC", nameMatch: "match", activatesAtMs: null },
    notifications: { new_order: true, sla_warning: true, low_stock: true, payout: true, price_trust: true },
    version: 1,
  };
}

export function demoSeed(t: number): BrandSeed {
  const list: BrandProduct[] = PRODUCTS.map((p) => ({
    id: p.id, status: p.status, titleAr: p.titleAr, titleEn: p.titleEn, coverUri: null, priceFrom: p.priceFrom, totalStock: p.totalStock, sizes: p.sizes, claim: p.claim,
    // Reference price is carried only where the claim is verified: plain / launch / lowest-30d never get a strike-through.
    referencePrice: p.claim === "verified_discount" ? (p.ref ?? null) : null,
    updatedAtMs: t - p.ageH * H,
  }));
  return { account: DEMO_ACCOUNT, orders: orders(t), products: list, settings: settings(), dashboard, summary: demoSummary };
}

export function createDemoBrandPort(now: () => number = Date.now): BrandPort {
  return new InMemoryBrandPort(now, "owner", demoSeed(now()));
}

/** The only door to the demo brand: null unless a development build runs on the in-memory fixture backend. */
export function demoBrandPortIfAllowed(cfg: BackendConfig, isDev: boolean, now: () => number = Date.now): BrandPort | null {
  return isDemoBrandAllowed(cfg, isDev) ? createDemoBrandPort(now) : null;
}
