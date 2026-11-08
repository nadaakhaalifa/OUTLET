import { randomUUID } from "node:crypto";
import { withDbContext } from "@outlet/db";
import { afterEach, describe, expect, it } from "vitest";
import { COVERAGE_RATES_SQL, ShippingQuoteService } from "../src/index.js";
import { buildWorld, countStatements, errorCode, staffOf } from "./fixtures.js";
import type { World } from "./fixtures.js";
import type { BagStore } from "../src/index.js";

let w: World | undefined;
afterEach(async () => { await w?.close(); w = undefined; });
const world = async (): Promise<World> => (w = await buildWorld());

const GOV27 = ["CAI", "GZ", "KB", "ALX", "BH", "GH", "DK", "DT", "KFS", "MNF", "SHR", "PTS", "IS", "SUZ", "FYM", "BNS", "MN", "AST", "SHG", "KN", "LX", "ASN", "BA", "JS", "SIN", "MT", "WAD"];
const store = (storeId: string, subtotalMinor: bigint, extra: Partial<BagStore> = {}): BagStore => ({ storeId, subtotalMinor, thresholdMinor: 200_000n, lines: [{ weightG: 600, codAllowed: true }], ...extra });
const bag = (stores: BagStore[], plus = false) => ({ currency: "EGP" as const, plus, stores });
const addr = { governorateCode: "CAI", street: "Tahrir", building: "5" };

describe("seed", () => {
  it("has the 27 governorates with Arabic and English names and a zone each", async () => {
    const x = await world();
    const r = await x.raw.query<{ code: string; name_ar: string; name_en: string; shipping_zone_code: string }>("SELECT code, name_ar, name_en, shipping_zone_code FROM geo_areas WHERE market_id = 'EG' AND level = 'governorate'");
    expect(r.rows.map((g) => g.code).sort()).toEqual([...GOV27].sort());
    expect(r.rows.every((g) => g.name_ar.length > 0 && g.name_en.length > 0 && g.shipping_zone_code.length > 0)).toBe(true);
    const cities = await x.raw.query<{ n: string }>("SELECT count(*)::text AS n FROM geo_areas WHERE level = 'city'");
    expect(Number(cities.rows[0]?.n)).toBeGreaterThanOrEqual(10);
  });
});

describe("AddressValidator", () => {
  it("resolves governorate -> city and exposes COD eligibility", async () => {
    const x = await world();
    const a = await x.validator.validate(x.user, { ...addr, cityCode: "CAI-NASR", landmark: "Next to the mosque", pin: { lat: 30.05, lng: 31.3 } });
    expect(a.areaIds).toEqual([await x.area("CAI-NASR"), await x.area("CAI")]);
    expect(a.codEligible).toBe(true);
    expect((await x.validator.validate(x.user, addr)).codEligible).toBe(false);
  });
  it("rejects unknown codes, a city under the wrong governorate and incomplete input", async () => {
    const x = await world();
    expect(await errorCode(x.validator.validate(x.user, { ...addr, governorateCode: "XX" }))).toBe("INVALID_ADDRESS");
    expect(await errorCode(x.validator.validate(x.user, { ...addr, cityCode: "GZ-6OCT" }))).toBe("INVALID_ADDRESS");
    expect(await errorCode(x.validator.validate(x.user, { governorateCode: "CAI" }))).toBe("INVALID_ADDRESS");
  });
});

describe("quoteForBag", () => {
  it("quotes the cheapest courier and reports NO_COVERAGE for an uncovered destination", async () => {
    const x = await world();
    await x.cover("alpha", "CAI", { sla: 2, cod: true });
    await x.cover("beta", "CAI", { sla: 3 });
    await x.rate("alpha", "CAIRO_GIZA", [[0, 1000, 5500], [1000, 5000, 9000]]);
    await x.rate("beta", "CAIRO_GIZA", [[0, 1000, 4800], [1000, 5000, 9500]]);
    const cairo = await x.validator.validate(x.user, addr);
    const [r] = await x.quotes.quoteForBag(x.user, bag([store(x.storeA, 50_000n)]), cairo);
    expect(r).toMatchObject({ ok: true, quote: { courier: "beta", etaDays: 3, codAvailable: false } });
    const alex = await x.validator.validate(x.user, { ...addr, governorateCode: "ALX" });
    expect(await x.quotes.quoteForBag(x.user, bag([store(x.storeA, 50_000n)]), alex)).toEqual([{ storeId: x.storeA, ok: false, code: "NO_COVERAGE" }]);
  });

  it("inactive coverage is ignored", async () => {
    const x = await world();
    await x.cover("alpha", "CAI", { active: false });
    await x.rate("alpha", "CAIRO_GIZA", [[0, 5000, 5000]]);
    const [r] = await x.quotes.quoteForBag(x.user, bag([store(x.storeA, 1n)]), await x.validator.validate(x.user, addr));
    expect(r).toMatchObject({ ok: false, code: "NO_COVERAGE" });
  });

  it("city coverage is more specific than governorate coverage", async () => {
    const x = await world();
    await x.cover("alpha", "CAI", { sla: 4 });
    await x.cover("alpha", "CAI-NASR", { sla: 1 });
    await x.rate("alpha", "CAIRO_GIZA", [[0, 5000, 5000]]);
    const a = await x.validator.validate(x.user, { ...addr, cityCode: "CAI-NASR" });
    const [r] = await x.quotes.quoteForBag(x.user, bag([store(x.storeA, 1n)]), a);
    expect(r).toMatchObject({ ok: true, quote: { etaDays: 1 } });
  });

  it("free-delivery acceptance (master prompt 6): A 1,950 + 60 EGP, B 2,100 alone, Plus", async () => {
    const x = await world();
    await x.cover("alpha", "CAI");
    await x.rate("alpha", "CAIRO_GIZA", [[0, 5000, 6000]]);
    const a = await x.validator.validate(x.user, addr);
    const fee = async (sub: bigint, plus = false): Promise<bigint> => {
      const [r] = await x.quotes.quoteForBag(x.user, bag([store(x.storeA, sub)], plus), a);
      if (r?.ok !== true) throw new Error("no quote");
      return r.quote.fee.amountMinor;
    };
    expect(await fee(195_000n)).toBe(6000n);
    expect(await fee(195_000n + 6_000n)).toBe(0n);
    expect(await fee(210_000n)).toBe(0n);
    expect(await fee(1_000n, true)).toBe(0n);
  });

  it("rate-card validity by date and version", async () => {
    const x = await world();
    await x.cover("alpha", "CAI");
    await x.rate("alpha", "CAIRO_GIZA", [[0, 5000, 5000]], { from: "2030-01-01T00:00:00Z", to: "2030-07-01T00:00:00Z", version: 1 });
    await x.rate("alpha", "CAIRO_GIZA", [[0, 5000, 7000]], { from: "2030-06-15T00:00:00Z", version: 2 });
    const a = await x.validator.validate(x.user, addr);
    const priceAt = async (iso: string): Promise<string> => {
      x.now.value = new Date(iso);
      const [r] = await x.quotes.quoteForBag(x.user, bag([store(x.storeA, 1n)]), a);
      return r?.ok === true ? r.quote.fee.amountMinor.toString() : (r as { code: string }).code;
    };
    expect(await priceAt("2029-12-31T00:00:00Z")).toBe("NO_COVERAGE");
    expect(await priceAt("2030-03-01T00:00:00Z")).toBe("5000");
    expect(await priceAt("2030-06-20T00:00:00Z")).toBe("7000"); // overlap: the later valid_from wins
    expect(await priceAt("2030-08-01T00:00:00Z")).toBe("7000"); // v1 expired
  });

  it("store settings: allowed couriers, threshold override, handling days; a foreign tenant cannot change them", async () => {
    const x = await world();
    await x.cover("alpha", "CAI");
    await x.cover("beta", "CAI");
    await x.rate("alpha", "CAIRO_GIZA", [[0, 5000, 4000]]);
    await x.rate("beta", "CAIRO_GIZA", [[0, 5000, 3000]]);
    const a = await x.validator.validate(x.user, addr);
    await x.settings.put(staffOf(x.storeA), x.storeA, { freeThresholdOverrideMinor: 100_000n, allowedCouriers: ["alpha"], handlingDays: 3 });
    const [r] = await x.quotes.quoteForBag(x.user, bag([store(x.storeA, 120_000n), ]), a);
    expect(r).toMatchObject({ ok: true, handlingDays: 3, quote: { courier: "alpha", freeDelivery: true } });
    const [other] = await x.quotes.quoteForBag(x.user, bag([store(x.storeB, 120_000n)]), a);
    expect(other).toMatchObject({ ok: true, handlingDays: 1, quote: { courier: "beta", freeDelivery: false } });

    const staffA = staffOf(x.storeA);
    expect(await errorCode(x.settings.put(staffA, x.storeB, { freeThresholdOverrideMinor: 0n, allowedCouriers: [], handlingDays: 1 }))).toBe("not_found");
    expect(await errorCode(x.settings.get(staffA, x.storeB))).toBe("not_found");
    expect(await errorCode(x.settings.put(staffA, x.storeA, { freeThresholdOverrideMinor: -1n, allowedCouriers: [], handlingDays: 1 }))).toBe("INVALID_INPUT");
    expect(await x.settings.get(staffA, x.storeA)).toMatchObject({ allowedCouriers: ["alpha"], handlingDays: 3 });
  });

  it("S1: the shopper quote path reads only the public projection, written in the same transaction; outlet_app cannot read store_shipping_settings", async () => {
    const x = await world();
    await x.settings.put(staffOf(x.storeA), x.storeA, { freeThresholdOverrideMinor: 5_000n, allowedCouriers: ["alpha"], handlingDays: 4 });
    const proj = await x.raw.query<{ handling_days: number; free_threshold_override_minor: string }>("SELECT handling_days, free_threshold_override_minor FROM shipping_public_store_settings WHERE store_ref = $1", [x.storeA]);
    expect(proj.rows[0]).toMatchObject({ handling_days: 4 });
    await x.settings.put(staffOf(x.storeA), x.storeA, { freeThresholdOverrideMinor: null, allowedCouriers: [], handlingDays: 2 });
    expect((await x.raw.query<{ handling_days: number }>("SELECT handling_days FROM shipping_public_store_settings WHERE store_ref = $1", [x.storeA])).rows[0]?.handling_days).toBe(2);
    const shopper = await withDbContext(x.app, { kind: "user", marketId: "EG", userId: x.user }, (tx) => tx.query("SELECT store_id FROM store_shipping_settings"));
    expect(shopper.rows).toHaveLength(0);
    await expect(withDbContext(x.app, { kind: "user", marketId: "EG", userId: x.user }, (tx) => tx.query("DELETE FROM shipping_public_store_settings"))).rejects.toThrow(/permission denied/);
  });

  it("RLS below the service: a store context sees only its own settings and cannot write another store; the shopper cannot write", async () => {
    const x = await world();
    await x.raw.query("INSERT INTO store_shipping_settings (store_id, market_id, handling_days) VALUES ($1,'EG',2), ($2,'EG',5)", [x.storeA, x.storeB]);
    const seen = await withDbContext(x.app, { kind: "store", marketId: "EG", storeId: x.storeA }, (tx) => tx.query<{ store_id: string }>("SELECT store_id FROM store_shipping_settings"));
    expect(seen.rows.map((r) => r.store_id)).toEqual([x.storeA]);
    const wrongWrite = withDbContext(x.app, { kind: "store", marketId: "EG", storeId: x.storeA }, (tx) => tx.query("UPDATE store_shipping_settings SET handling_days = 9 WHERE store_id = $1", [x.storeB]));
    await wrongWrite;
    const check = await x.raw.query<{ handling_days: number }>("SELECT handling_days FROM store_shipping_settings WHERE store_id = $1", [x.storeB]);
    expect(check.rows[0]?.handling_days).toBe(5);
    await expect(withDbContext(x.app, { kind: "user", marketId: "EG", userId: x.user }, (tx) => tx.query("UPDATE store_shipping_settings SET handling_days = 9"))).resolves.toMatchObject({ rows: [] });
    const still = await x.raw.query<{ handling_days: number }>("SELECT handling_days FROM store_shipping_settings ORDER BY handling_days");
    expect(still.rows.map((r) => r.handling_days)).toEqual([2, 5]);
    await expect(withDbContext(x.app, { kind: "user", marketId: "EG", userId: x.user }, (tx) => tx.query("DELETE FROM courier_coverage"))).rejects.toThrow();
  });

  it("uses at most 2 statements for a multi-store bag", async () => {
    const x = await world();
    await x.cover("alpha", "CAI");
    await x.rate("alpha", "CAIRO_GIZA", [[0, 5000, 4000]]);
    const a = await x.validator.validate(x.user, addr);
    const statements = await countStatements(x.app, async (c) => {
      const svc = new ShippingQuoteService({ client: c, marketId: "EG", now: () => x.now.value });
      const r = await svc.quoteForBag(x.user, bag([store(x.storeA, 1n), store(x.storeB, 1n), store(randomUUID(), 1n)]), a);
      expect(r).toHaveLength(3);
    });
    expect(statements).toHaveLength(2);
  });
});

describe("international (quote-only, kill switch)", () => {
  it("is disabled by default and quotes DAP with no invented duties when enabled", async () => {
    const x = await world();
    await x.raw.query("INSERT INTO shipping_zones (market_id, zone_code, kind, name_ar, name_en, countries) VALUES ('EG','INTL_GCC','international','الخليج','GCC','{SA,AE}')");
    await x.rate("alpha", "INTL_GCC", [[0, 2000, 40_000], [2000, 10_000, 90_000]]);
    const input = { countryCode: "SA", currency: "EGP" as const, lines: [{ weightG: 900, codAllowed: true }] };
    expect(await errorCode(x.quotes.quoteInternational(x.user, input))).toBe("INTERNATIONAL_DISABLED");
    x.intl.enabled = true;
    const q = await x.quotes.quoteInternational(x.user, input);
    expect(q).toMatchObject({ incoterm: "DAP", courier: "alpha", dutiesEstimate: null });
    expect(q.fee.amountMinor).toBe(40_000n);
    expect(await errorCode(x.quotes.quoteInternational(x.user, { ...input, countryCode: "US" }))).toBe("NO_COVERAGE");
  });
});

describe("explain", () => {
  it("the coverage + rates quote uses its indexes at 2,000 rate rows (seq scans off)", async () => {
    const x = await world();
    await x.cover("alpha", "CAI");
    await x.rate("alpha", "CAIRO_GIZA", [[0, 5000, 4000]]);
    await x.raw.query(
      `INSERT INTO rate_cards (id, market_id, courier, service_level, zone_code, weight_from_g, weight_to_g, price_minor, currency, valid_from)
       SELECT gen_random_uuid(), 'EG', 'c' || (i % 20), 'standard', (ARRAY['CAIRO_GIZA','ALEX_DELTA','CANAL','UPPER','REMOTE'])[1 + i % 5], 1000000 + i * 1000, 1000500 + i * 1000, 1000 + i, 'EGP', '2030-01-01'
         FROM generate_series(1, 2000) AS i`,
    );
    await x.raw.query("ANALYZE");
    const areaId = await x.area("CAI");
    const plan = await withDbContext(x.app, { kind: "user", marketId: "EG", userId: x.user }, async (tx) => {
      await tx.query("SET LOCAL enable_seqscan = off");
      return (await tx.query<Record<string, string>>(`EXPLAIN ${COVERAGE_RATES_SQL}`, ["EG", [areaId], x.now.value.toISOString()])).rows.map((r) => Object.values(r)[0]).join("\n");
    });
    expect(plan).toContain("rate_cards_quote_idx");
    expect(plan).toContain("courier_coverage_lookup_idx");
    expect(plan).not.toMatch(/Seq Scan/);
  });
});

