import { withDbContext } from "@outlet/db";
import type { Queryable } from "@outlet/db";
import { money } from "@outlet/money";
import type { Currency, Money } from "@outlet/money";
import { ShippingError } from "../domain/errors.js";
import type { ShippingErrorCode } from "../domain/errors.js";
import { quoteShipment } from "../domain/quote.js";
import type { CourierOffer, QuoteLine, RateBand, ShipmentQuote } from "../domain/quote.js";
import { makeEnv } from "./env.js";
import type { Env, ShippingDeps } from "./env.js";
import type { ResolvedAddress } from "./address-validator.js";

export interface BagStore {
  readonly storeId: string;
  readonly subtotalMinor: bigint;
  /** Threshold from the bag (cart): the store settings override replaces it when set. */
  readonly thresholdMinor: bigint;
  readonly lines: readonly QuoteLine[];
}
export interface GroupedBag {
  readonly currency: Currency;
  readonly plus: boolean;
  readonly stores: readonly BagStore[];
}
export type StoreQuoteResult =
  | { readonly storeId: string; readonly ok: true; readonly quote: ShipmentQuote; readonly handlingDays: number }
  | { readonly storeId: string; readonly ok: false; readonly code: ShippingErrorCode };

export interface InternationalQuote {
  readonly incoterm: "DAP";
  readonly fee: Money;
  readonly courier: string;
  readonly serviceLevel: string;
  readonly chargeableGrams: number;
  /** Duties are paid by the shopper to the courier on arrival; no estimate is invented (duty_rules are not built, V34). */
  readonly dutiesEstimate: null;
}

interface CoverageRateRow {
  courier: string; service_level: string; geo_area_id: string; sla_days_p80: number; cod_supported: boolean;
  zone_code: string; weight_from_g: number; weight_to_g: number; weight_step_g: number; volumetric_divisor: number;
  price_minor: string | bigint; currency: Currency; valid_from: Date | string; version: number;
}
interface SettingsRow { store_id: string; free_threshold_override_minor: string | bigint | null; allowed_couriers: string[]; handling_days: number }

/** Statement 1: coverage joined to the zone of the covered area and to the rate bands valid at $3. Statement 2: store settings. */
export const COVERAGE_RATES_SQL = `SELECT c.courier, c.service_level, c.geo_area_id, c.sla_days_p80, c.cod_supported,
       r.zone_code, r.weight_from_g, r.weight_to_g, r.weight_step_g, r.volumetric_divisor, r.price_minor, r.currency, r.valid_from, r.version
  FROM courier_coverage c
  JOIN geo_areas g ON g.id = c.geo_area_id
  JOIN rate_cards r ON r.market_id = c.market_id AND r.courier = c.courier AND r.service_level = c.service_level AND r.zone_code = g.shipping_zone_code
 WHERE c.market_id = $1 AND c.active AND c.geo_area_id = ANY($2::uuid[])
   AND r.valid_from <= $3::timestamptz AND (r.valid_to IS NULL OR r.valid_to > $3::timestamptz)`;
export const SETTINGS_SQL = "SELECT store_ref AS store_id, free_threshold_override_minor, allowed_couriers, handling_days FROM shipping_public_store_settings WHERE store_ref = ANY($1::uuid[]) AND market_id = $2";

const ts = (v: Date | string): number => (v instanceof Date ? v : new Date(v)).getTime();

/** Folds rows into offers. When two rate versions cover the same band, the one with the latest valid_from (then highest version) wins. */
export function toOffers(rows: readonly CoverageRateRow[]): CourierOffer[] {
  const picked = new Map<string, CoverageRateRow>();
  for (const r of rows) {
    const key = [r.courier, r.service_level, r.geo_area_id, r.weight_from_g].join("|");
    const cur = picked.get(key);
    if (cur === undefined || ts(r.valid_from) > ts(cur.valid_from) || (ts(r.valid_from) === ts(cur.valid_from) && r.version > cur.version)) picked.set(key, r);
  }
  const offers = new Map<string, { head: CoverageRateRow; bands: RateBand[] }>();
  for (const r of picked.values()) {
    const key = [r.courier, r.service_level, r.geo_area_id].join("|");
    const o = offers.get(key) ?? { head: r, bands: [] };
    o.bands.push({ weightFromG: r.weight_from_g, weightToG: r.weight_to_g, priceMinor: BigInt(r.price_minor) });
    offers.set(key, o);
  }
  return [...offers.values()].map(({ head: h, bands }) => ({
    courier: h.courier, serviceLevel: h.service_level, geoAreaId: h.geo_area_id, slaDaysP80: h.sla_days_p80, codSupported: h.cod_supported,
    stepG: h.weight_step_g, volumetricDivisor: h.volumetric_divisor, currency: h.currency, bands: bands.sort((a, b) => a.weightFromG - b.weightFromG),
  }));
}

export class ShippingQuoteService {
  private readonly env: Env;
  constructor(deps: ShippingDeps) {
    this.env = makeEnv(deps);
  }

  /** Per-store quotes for a grouped bag in two statements (coverage + rates, store settings), however many stores the bag has. */
  async quoteForBag(userId: string, bag: GroupedBag, address: ResolvedAddress): Promise<StoreQuoteResult[]> {
    const at = this.env.now().toISOString();
    const { rates, settings } = await withDbContext(this.env.client, { kind: "user", marketId: this.env.marketId, userId }, async (tx: Queryable) => {
      const rates = await tx.query<CoverageRateRow>(COVERAGE_RATES_SQL, [this.env.marketId, address.areaIds, at]);
      const settings = await tx.query<SettingsRow>(SETTINGS_SQL, [bag.stores.map((s) => s.storeId), this.env.marketId]);
      return { rates: rates.rows, settings: settings.rows };
    });
    const offers = toOffers(rates);
    const byStore = new Map(settings.map((s) => [s.store_id, s] as const));
    return bag.stores.map((s): StoreQuoteResult => {
      const st = byStore.get(s.storeId);
      const threshold = st?.free_threshold_override_minor == null ? s.thresholdMinor : BigInt(st.free_threshold_override_minor);
      try {
        const quote = quoteShipment({
          storeId: s.storeId, destination: { areaIds: address.areaIds }, lines: s.lines, subtotalMinor: s.subtotalMinor, currency: bag.currency,
          plus: bag.plus, thresholdMinor: threshold, offers, ...(st === undefined ? {} : { allowedCouriers: st.allowed_couriers }),
        });
        return { storeId: s.storeId, ok: true, quote, handlingDays: st?.handling_days ?? 1 };
      } catch (e) {
        if (e instanceof ShippingError) return { storeId: s.storeId, ok: false, code: e.code };
        throw e;
      }
    });
  }

  /**
   * International DAP quote, quote-only, behind kill switch shipping.international.enabled (fail closed).
   * Uses rate cards of international zones listing the country; free-delivery rules do not apply (domestic only, spec 3).
   */
  async quoteInternational(userId: string, input: { countryCode: string; currency: Currency; lines: readonly QuoteLine[] }): Promise<InternationalQuote> {
    if (!(await this.env.isInternationalEnabled())) throw new ShippingError("INTERNATIONAL_DISABLED", "international shipping is disabled");
    const rows = (
      await withDbContext(this.env.client, { kind: "user", marketId: this.env.marketId, userId }, (tx) =>
        tx.query<CoverageRateRow>(
          `SELECT r.courier, r.service_level, z.zone_code AS geo_area_id, 1::int AS sla_days_p80, false AS cod_supported,
                  r.zone_code, r.weight_from_g, r.weight_to_g, r.weight_step_g, r.volumetric_divisor, r.price_minor, r.currency, r.valid_from, r.version
             FROM shipping_zones z JOIN rate_cards r ON r.market_id = z.market_id AND r.zone_code = z.zone_code
            WHERE z.market_id = $1 AND z.kind = 'international' AND $2 = ANY(z.countries)
              AND r.valid_from <= $3::timestamptz AND (r.valid_to IS NULL OR r.valid_to > $3::timestamptz)`,
          [this.env.marketId, input.countryCode, this.env.now().toISOString()],
        ),
      )
    ).rows;
    const offers = toOffers(rows);
    const zones = [...new Set(offers.map((o) => o.geoAreaId))];
    const q = quoteShipment({
      storeId: "international", destination: { areaIds: zones }, lines: input.lines.map((l) => ({ ...l, codAllowed: false })), subtotalMinor: 0n, currency: input.currency,
      plus: false, thresholdMinor: 2n ** 62n, offers,
    });
    return { incoterm: "DAP", fee: money(q.courierCost.amountMinor, input.currency), courier: q.courier, serviceLevel: q.serviceLevel, chargeableGrams: q.chargeableGrams, dutiesEstimate: null };
  }
}
