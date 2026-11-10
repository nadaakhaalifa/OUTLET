import { getMarket } from "@outlet/markets-config";

/** reduced is registered but has NO default rate in any market: fail closed until counsel confirms (V61/V62 family). */
export const TAX_CATEGORY_CODES = ["standard", "zero_rated", "exempt", "reduced"] as const;
export type TaxCategoryCode = (typeof TAX_CATEGORY_CODES)[number];

export interface TaxRate {
  readonly marketId: string;
  readonly category: TaxCategoryCode;
  readonly bps: number;
  /** inclusive */
  readonly validFrom: Date;
  /** exclusive; null = open ended */
  readonly validTo: Date | null;
}

export class TaxError extends Error {
  constructor(
    readonly code: "RATE_NOT_CONFIGURED" | "INVALID_RATE" | "OVERLAPPING_RATE" | "INVALID_INPUT",
    message: string,
  ) {
    super(message);
    this.name = "TaxError";
  }
}

/** Admin-editable rates (audited elsewhere). Persistence is a later adapter. */
export interface TaxRateProviderPort {
  rateAt(marketId: string, category: TaxCategoryCode, at: Date): TaxRate;
  upsert(rate: TaxRate): void;
}

const EPOCH = new Date(0);

export class InMemoryTaxRateProvider implements TaxRateProviderPort {
  private rates: TaxRate[] = [];

  /** Seeds standard from markets-config, zero_rated and exempt at 0. `reduced` is intentionally unseeded (VERIFY). */
  static withMarketDefaults(marketIds: readonly string[] = ["eg"]): InMemoryTaxRateProvider {
    const p = new InMemoryTaxRateProvider();
    for (const id of marketIds) {
      const m = getMarket(id);
      p.upsert({ marketId: id, category: "standard", bps: m.vatBps, validFrom: EPOCH, validTo: null });
      p.upsert({ marketId: id, category: "zero_rated", bps: 0, validFrom: EPOCH, validTo: null });
      p.upsert({ marketId: id, category: "exempt", bps: 0, validFrom: EPOCH, validTo: null });
    }
    return p;
  }

  upsert(rate: TaxRate): void {
    if (!Number.isInteger(rate.bps) || rate.bps < 0 || rate.bps > 10_000) {
      throw new TaxError("INVALID_RATE", "bps must be an integer in 0..10000");
    }
    if (rate.validTo !== null && rate.validTo.getTime() <= rate.validFrom.getTime()) {
      throw new TaxError("INVALID_RATE", "validTo must be after validFrom");
    }
    const end = (r: { validTo: Date | null }): number => (r.validTo === null ? Infinity : r.validTo.getTime());
    const clashes = this.rates.filter(
      (r) =>
        r.marketId === rate.marketId &&
        r.category === rate.category &&
        rate.validFrom.getTime() < end(r) &&
        r.validFrom.getTime() < end(rate),
    );
    // A later-starting rate closes the earlier period at its start, but only when no tail of the old period would be left uncovered.
    const closable = (r: TaxRate): boolean =>
      r.validFrom.getTime() < rate.validFrom.getTime() && (rate.validTo === null || (r.validTo !== null && r.validTo.getTime() <= rate.validTo.getTime()));
    if (clashes.some((r) => !closable(r))) throw new TaxError("OVERLAPPING_RATE", "rate periods must not overlap");
    for (const r of clashes) this.rates[this.rates.indexOf(r)] = { ...r, validTo: rate.validFrom };
    this.rates.push(rate);
  }

  /** Ends the period that is open at validTo (exclusive end). Leaves a gap until the next upsert: rateAt then throws RATE_NOT_CONFIGURED. */
  close(marketId: string, category: TaxCategoryCode, validTo: Date): void {
    const t = validTo.getTime();
    const i = this.rates.findIndex(
      (r) => r.marketId === marketId && r.category === category && r.validFrom.getTime() < t && (r.validTo === null || t < r.validTo.getTime()),
    );
    const hit = this.rates[i];
    if (hit === undefined) throw new TaxError("INVALID_RATE", "no period to close at that instant (validTo must be after the period start)");
    this.rates[i] = { ...hit, validTo };
  }

  /** Number of periods covering an instant (0 or 1 by construction); used by the invariant test. */
  periodsAt(marketId: string, category: TaxCategoryCode, at: Date): number {
    const t = at.getTime();
    return this.rates.filter((r) => r.marketId === marketId && r.category === category && r.validFrom.getTime() <= t && (r.validTo === null || t < r.validTo.getTime())).length;
  }

  rateAt(marketId: string, category: TaxCategoryCode, at: Date): TaxRate {
    const t = at.getTime();
    const hit = this.rates.find(
      (r) =>
        r.marketId === marketId &&
        r.category === category &&
        r.validFrom.getTime() <= t &&
        (r.validTo === null || t < r.validTo.getTime()),
    );
    if (!hit) throw new TaxError("RATE_NOT_CONFIGURED", `no ${category} rate for ${marketId} at ${at.toISOString()}`);
    return hit;
  }
}
