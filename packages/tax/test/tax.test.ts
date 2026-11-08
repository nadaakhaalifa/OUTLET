import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { money, percentOf, add } from "@outlet/money";
import {
  InMemoryTaxRateProvider, TaxError, addExclusive, allocateVatAcrossLines, commissionInvoiceLines,
  ourB2cSupplies, splitInclusive, taxSnapshotForLine, toOrderLineTaxColumns,
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
    expect(() => { p.upsert({ marketId: "eg", category: "standard", bps: 1000, validFrom: new Date("2027-01-01"), validTo: null }); }).toThrow(TaxError);
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
    expect(taxSnapshotForLine({ marketId: "eg", taxCategory: "standard" }, new Date("2026-06-01"), p).bps).toBe(1400);
  });
  it("invalid inputs", () => {
    expect(() => splitInclusive(egp(1n), 20000)).toThrow(TaxError);
    expect(() => splitInclusive(egp(-1n), 1400)).toThrow(TaxError);
    expect(() => addExclusive(egp(-1n), 1400)).toThrow(TaxError);
    expect(percentOf(add(egp(1n), egp(1n)), 0n).amountMinor).toBe(0n);
  });
});
