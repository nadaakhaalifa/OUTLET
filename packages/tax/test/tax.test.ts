import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { money, percentOf, add } from "@outlet/money";
import {
  InMemoryTaxRateProvider, TaxError, addExclusive, allocateVatAcrossLines, commissionInvoiceLines,
  allocateVatWithLineDiscounts, buildReceipt, ourB2cSupplies, splitInclusive, taxSnapshotForLine, toOrderLineTaxColumns,
} from "../src/index.js";

const egp = (n: bigint) => money(n, "EGP");
const runs = { numRuns: 1000 };
const amt = fc.bigInt({ min: 0n, max: 10_000_000_000n });
const bpsArb = fc.integer({ min: 0, max: 3000 });

describe("pinned ledger examples", () => {
  it("delivery 6000 -> 737 VAT, 5263 net", () => {
    const s = splitInclusive(egp(6000n), 1400);
    expect([s.vat.amountMinor, s.net.amountMinor]).toEqual([737n, 5263n]);
  });
  it("commission 2625 -> 368 (tie to even), 13492 -> 1889, trap 2257 vs 2256", () => {
    expect(addExclusive(egp(2625n), 1400).vat.amountMinor).toBe(368n);
    const a = addExclusive(egp(13492n), 1400).vat.amountMinor;
    expect(a).toBe(1889n);
    expect(a + 368n).toBe(2257n);
    expect(addExclusive(egp(16117n), 1400).vat.amountMinor).toBe(2256n);
  });
  it("10000 voucher over A/B/C -> 6494/2337/1169", () => {
    const r = allocateVatAcrossLines(
      [{ id: "A", gross: egp(249900n), bps: 1400 }, { id: "B", gross: egp(89950n), bps: 1400 }, { id: "C", gross: egp(45000n), bps: 1400 }],
      egp(10000n), "platform",
    );
    expect(r.lines.map((l) => l.discount.amountMinor)).toEqual([6494n, 2337n, 1169n]);
  });
});

describe("properties", () => {
  it("net+vat==gross; round trip; monotonic", () => {
    fc.assert(fc.property(amt, bpsArb, (g, b) => {
      const s = splitInclusive(egp(g), b);
      expect(s.net.amountMinor + s.vat.amountMinor).toBe(g);
      const x = addExclusive(egp(g), b);
      expect(x.net.amountMinor + x.vat.amountMinor).toBe(x.gross.amountMinor);
      const back = splitInclusive(x.gross, b);
      expect(back.gross.amountMinor).toBe(x.gross.amountMinor);
      const d = back.net.amountMinor - g;
      expect(d >= -1n && d <= 1n).toBe(true);
      expect(splitInclusive(egp(g + 1n), b).vat.amountMinor >= s.vat.amountMinor).toBe(true);
    }), runs);
  });
  it("allocation: sum discounts == discount; sum line vat == invoice vat; both funding modes", () => {
    const lines = fc.array(amt, { minLength: 1, maxLength: 8 });
    fc.assert(fc.property(lines, fc.double({ min: 0, max: 1, noNaN: true }), fc.boolean(), fc.boolean(), (gs, frac, seller, flag) => {
      const total = gs.reduce((a, b) => a + b, 0n);
      const disc = BigInt(Math.floor(Number(total) * frac));
      const r = allocateVatAcrossLines(gs.map((g, i) => ({ id: String(i), gross: egp(g), bps: 1400 })), egp(disc), seller ? "seller" : "platform",
        { platformFundedDiscountReducesBase: flag });
      expect(r.lines.reduce((a, l) => a + l.discount.amountMinor, 0n)).toBe(disc);
      expect(r.lines.reduce((a, l) => a + l.vat.amountMinor, 0n)).toBe(r.invoiceVat.amountMinor);
      expect(r.payableTotal.amountMinor).toBe(total - disc);
      for (const l of r.lines) expect(l.net.amountMinor + l.vat.amountMinor).toBe(l.gross.amountMinor);
    }), runs);
  });
});

describe("V62 flag", () => {
  const lines = [{ id: "a", gross: egp(11400n), bps: 1400 }];
  it("default: platform-funded keeps full base", () => {
    expect(allocateVatAcrossLines(lines, egp(1140n), "platform").invoiceVat.amountMinor).toBe(1400n);
  });
  it("flag true reduces base; seller-funded always reduces", () => {
    expect(allocateVatAcrossLines(lines, egp(1140n), "platform", { platformFundedDiscountReducesBase: true }).invoiceVat.amountMinor).toBe(1260n);
    expect(allocateVatAcrossLines(lines, egp(1140n), "seller").invoiceVat.amountMinor).toBe(1260n);
  });
  it("rejects bad input; zero discount and zero total", () => {
    expect(() => allocateVatAcrossLines([], egp(0n), "seller")).toThrow(TaxError);
    expect(() => allocateVatAcrossLines(lines, egp(99999n), "seller")).toThrow(TaxError);
    expect(allocateVatAcrossLines([{ id: "z", gross: egp(0n), bps: 1400 }], egp(0n), "seller").invoiceVat.amountMinor).toBe(0n);
  });
});

describe("invoices", () => {
  const p = InMemoryTaxRateProvider.withMarketDefaults();
  const rate = p.rateAt("eg", "standard", new Date());
  it("commission line 17500 x 15% = 2625 + 368", () => {
    const [l] = commissionInvoiceLines({ id: "so1", commissionBase: egp(17500n) }, 1500, rate);
    expect([l?.net.amountMinor, l?.vat.amountMinor, l?.gross.amountMinor]).toEqual([2625n, 368n, 2993n]);
    expect(() => commissionInvoiceLines({ id: "x", commissionBase: egp(1n) }, -1, rate)).toThrow(TaxError);
  });
  it("b2c delivery fee 6000 -> 737; zero fees skipped", () => {
    const r = ourB2cSupplies({ id: "og", deliveryFees: [{ ref: "a", gross: egp(6000n) }, { ref: "b", gross: egp(0n) }] }, rate);
    expect(r).toHaveLength(1);
    expect(r[0]?.vat.amountMinor).toBe(737n);
  });
});

describe("rates and snapshot", () => {
  it("seeds EG, rejects reduced, honours history, blocks overlap", () => {
    const p = InMemoryTaxRateProvider.withMarketDefaults();
    expect(p.rateAt("eg", "standard", new Date("2026-01-01")).bps).toBe(1400);
    expect(() => p.rateAt("eg", "reduced", new Date())).toThrow(TaxError);
    expect(() => { p.upsert({ marketId: "eg", category: "standard", bps: 1000, validFrom: new Date(0), validTo: null }); }).toThrow(TaxError);
    expect(() => { p.upsert({ marketId: "eg", category: "reduced", bps: 20000, validFrom: new Date(0), validTo: null }); }).toThrow(TaxError);
    expect(() => { p.upsert({ marketId: "eg", category: "reduced", bps: 500, validFrom: new Date(5), validTo: new Date(5) }); }).toThrow(TaxError);
  });
  it("historical order recomputes with its day's rate", () => {
    const p = new InMemoryTaxRateProvider();
    p.upsert({ marketId: "eg", category: "standard", bps: 1300, validFrom: new Date("2020-01-01"), validTo: new Date("2025-01-01") });
    p.upsert({ marketId: "eg", category: "standard", bps: 1400, validFrom: new Date("2025-01-01"), validTo: null });
    const s = taxSnapshotForLine({ marketId: "eg", taxCategory: "standard" }, new Date("2024-06-01"), p);
    expect(s.bps).toBe(1300);
    expect(toOrderLineTaxColumns(s)).toEqual({ tax_category: "standard", vat_rate_bp: 1300 });
    const full = taxSnapshotForLine({ marketId: "eg", taxCategory: "standard", base: egp(6000n) }, new Date("2024-06-01"), p);
    expect(toOrderLineTaxColumns(full)).toEqual({ tax_category: "standard", vat_rate_bp: 1300, vat_minor: splitInclusive(egp(6000n), 1300).vat.amountMinor });
    expect(taxSnapshotForLine({ marketId: "eg", taxCategory: "standard" }, new Date("2026-06-01"), p).bps).toBe(1400);
  });
  it("invalid inputs", () => {
    expect(() => splitInclusive(egp(1n), 20000)).toThrow(TaxError);
    expect(() => splitInclusive(egp(-1n), 1400)).toThrow(TaxError);
    expect(() => addExclusive(egp(-1n), 1400)).toThrow(TaxError);
    expect(percentOf(add(egp(1n), egp(1n)), 0n).amountMinor).toBe(0n);
  });
});

describe("A1 per-line funder discounts", () => {
  const lineArb = fc.record({
    gross: fc.bigInt({ min: 0n, max: 1_000_000n }),
    bps: fc.constantFrom(0, 500, 1400, 2500),
    pRatio: fc.bigInt({ min: 0n, max: 100n }),
    sRatio: fc.bigInt({ min: 0n, max: 100n }),
  });
  it("one rounding per line, mixed bps, zero-gross mixed in, base follows the flag", () => {
    fc.assert(
      fc.property(fc.array(lineArb, { minLength: 1, maxLength: 8 }), fc.boolean(), (ls, flag) => {
        const lines = ls.map((l, i) => {
          const p = (l.gross * l.pRatio) / 200n;
          const sd = (l.gross * l.sRatio) / 200n; // p + sd <= gross
          return { id: String(i), gross: egp(l.gross), bps: l.bps, platformDiscount: egp(p), sellerDiscount: egp(sd) };
        });
        const r = allocateVatWithLineDiscounts(lines, { platformFundedDiscountReducesBase: flag });
        let vat = 0n;
        r.lines.forEach((a, i) => {
          const src = lines[i]!;
          const base = src.gross.amountMinor - src.sellerDiscount.amountMinor - (flag ? src.platformDiscount.amountMinor : 0n);
          const exp = splitInclusive(egp(base), src.bps);
          expect(a.vat.amountMinor).toBe(exp.vat.amountMinor);
          expect(a.net.amountMinor + a.vat.amountMinor).toBe(base);
          expect(a.payable.amountMinor).toBe(src.gross.amountMinor - src.sellerDiscount.amountMinor - src.platformDiscount.amountMinor);
          vat += a.vat.amountMinor;
        });
        expect(r.invoiceVat.amountMinor).toBe(vat);
      }),
      runs,
    );
  });
  it("rejects line discounts above the gross", () => {
    expect(() => allocateVatWithLineDiscounts([{ id: "a", gross: egp(100n), bps: 1400, platformDiscount: egp(60n), sellerDiscount: egp(41n) }])).toThrow(TaxError);
  });
  it("old single-funder wrapper equals the per-line path", () => {
    fc.assert(
      fc.property(fc.array(fc.bigInt({ min: 0n, max: 100_000n }), { minLength: 1, maxLength: 6 }), fc.bigInt({ min: 0n, max: 100n }), fc.boolean(), (gs, pct, seller) => {
        const total = gs.reduce((a, b) => a + b, 0n);
        const disc = (total * pct) / 100n;
        const lines = gs.map((g, i) => ({ id: String(i), gross: egp(g), bps: 1400 }));
        const r = allocateVatAcrossLines(lines, egp(disc), seller ? "seller" : "platform");
        expect(r.lines.reduce((a, l) => a + l.discount.amountMinor, 0n)).toBe(disc);
        expect(r.lines.reduce((a, l) => a + (seller ? l.platformDiscount : l.sellerDiscount).amountMinor, 0n)).toBe(0n);
      }),
      runs,
    );
  });
});

describe("A2 posted commission figures (ledger I14)", () => {
  it("echoes the posted commission and vat exactly, without recompute", () => {
    const rate = InMemoryTaxRateProvider.withMarketDefaults().rateAt("eg", "standard", new Date());
    fc.assert(
      fc.property(amt, amt, (c, v) => {
        const [l] = commissionInvoiceLines({ id: "so", commissionBase: egp(17500n) }, 1500, rate, { posted: { commission: egp(c), vat: egp(v) } });
        expect([l?.net.amountMinor, l?.vat.amountMinor, l?.gross.amountMinor]).toEqual([c, v, c + v]);
      }),
      runs,
    );
    expect(() => commissionInvoiceLines({ id: "so", commissionBase: egp(1n) }, 1500, rate, { posted: { commission: egp(-1n), vat: egp(0n) } })).toThrow(TaxError);
  });
});

describe("A3 dated rates", () => {
  it("close() ends a period; a later-starting upsert auto-closes the open one", () => {
    const p = new InMemoryTaxRateProvider();
    p.upsert({ marketId: "eg", category: "standard", bps: 1300, validFrom: new Date(1000), validTo: null });
    p.upsert({ marketId: "eg", category: "standard", bps: 1400, validFrom: new Date(5000), validTo: null });
    expect(p.rateAt("eg", "standard", new Date(4999)).bps).toBe(1300);
    expect(p.rateAt("eg", "standard", new Date(5000)).bps).toBe(1400);
    p.close("eg", "standard", new Date(9000));
    expect(() => p.rateAt("eg", "standard", new Date(9000))).toThrow(TaxError);
    expect(() => { p.close("eg", "standard", new Date(3000)); }).not.toThrow();
    expect(() => { p.close("eg", "standard", new Date(1000)); }).toThrow(TaxError);
  });
  it("a closed new period inside a longer one is refused (would leave a gap)", () => {
    const p = new InMemoryTaxRateProvider();
    p.upsert({ marketId: "eg", category: "standard", bps: 1300, validFrom: new Date(0), validTo: null });
    expect(() => { p.upsert({ marketId: "eg", category: "standard", bps: 1400, validFrom: new Date(10), validTo: new Date(20) }); }).toThrow(TaxError);
  });
  it("property: exactly one rate at every instant from the first start", () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.integer({ min: 1, max: 10_000 }), { minLength: 1, maxLength: 12 }), fc.array(fc.integer({ min: 0, max: 3000 }), { minLength: 12, maxLength: 12 }), fc.array(fc.integer({ min: 0, max: 11_000 }), { minLength: 10, maxLength: 10 }), (starts, bpss, probes) => {
        const p = new InMemoryTaxRateProvider();
        const sorted = [...starts].sort((a, b) => a - b);
        for (const [i, st] of sorted.entries()) p.upsert({ marketId: "eg", category: "standard", bps: bpss[i] ?? 0, validFrom: new Date(st), validTo: null });
        const first = sorted[0] ?? 0;
        for (const t of probes) {
          const n = p.periodsAt("eg", "standard", new Date(t));
          expect(n).toBe(t >= first ? 1 : 0);
          if (t >= first) expect(p.rateAt("eg", "standard", new Date(t)).validFrom.getTime()).toBeLessThanOrEqual(t);
        }
      }),
      runs,
    );
  });
});

describe("A4 receipt discount line", () => {
  it("paid total == gross - discount, funder lines never a reference price", () => {
    fc.assert(
      fc.property(fc.array(fc.record({ g: fc.bigInt({ min: 0n, max: 100_000n }), a: fc.bigInt({ min: 0n, max: 50n }), b: fc.bigInt({ min: 0n, max: 50n }) }), { minLength: 1, maxLength: 6 }), fc.bigInt({ min: 0n, max: 20_000n }), (ls, fee) => {
        const r = allocateVatWithLineDiscounts(ls.map((l, i) => ({ id: String(i), gross: egp(l.g), bps: 1400, platformDiscount: egp((l.g * l.a) / 100n), sellerDiscount: egp((l.g * l.b) / 100n) })));
        const rate = InMemoryTaxRateProvider.withMarketDefaults().rateAt("eg", "standard", new Date());
        const fees = ourB2cSupplies({ id: "og", deliveryFees: [{ ref: "f", gross: egp(fee) }] }, rate);
        const doc = buildReceipt({ items: r.lines, deliveryFees: fees });
        expect(doc.paidTotal.amountMinor).toBe(doc.gross.amountMinor - doc.discount.amountMinor);
        const disc = doc.lines.flatMap((l) => (l.kind === "discount" ? [l.amount.amountMinor] : []));
        expect(disc.reduce((a, n) => a + n, 0n)).toBe(doc.discount.amountMinor);
      }),
      runs,
    );
  });
});
