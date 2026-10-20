import { describe, expect, it } from "vitest";
import type { ForecastItem, StoreChannel } from "../api/schemas-phase3";
import { createTranslator } from "../i18n";
import { forecastRows, forecastsView, parseHorizon, parseScope, reasonKey } from "./forecasts";
import { permissionsFor } from "../test/permissions";
import { navFor } from "./nav";
import { storeChannelRows, validateChannelRefs } from "./store-channels";

const item = (over: Partial<ForecastItem> = {}): ForecastItem => ({
  scope: "category_size", scope_key: "dress|M", horizon_days: 7, status: "ok", reason_codes: ["weekly_seasonality"], model_version: "m1",
  model: "ets_seasonal", interval: { p10: 4, p50: 9, p90: 15, nominal_coverage_bps: 8000 }, history: { comparable_units: 64, observed_days: 120 },
  backtest: { coverage_bps: 7800 }, ...over,
});

describe("forecast rows", () => {
  it("shows the interval and nominal coverage together, never a bare point", () => {
    const [r] = forecastRows([item()], "en");
    expect(r?.interval).toEqual({ p10: "4", p50: "9", p90: "15", coverage: "80%" });
    expect(Object.keys(r ?? {})).not.toContain("point");
  });
  it("gives no numbers for insufficient or suppressed cells", () => {
    const rows = forecastRows([
      item({ status: "insufficient_history", reason_codes: ["units_below_minimum"], interval: undefined, model: undefined }),
      item({ status: "suppressed", reason_codes: ["k_anonymity_below_minimum"], interval: undefined, scope_key: "x" }),
      // A server that leaked an interval on a non-ok status must not get it displayed.
      item({ status: "insufficient_history", scope_key: "leak" }),
    ], "en");
    for (const r of rows) { expect(r.interval).toBeNull(); expect(r.modelKey).toBeNull(); }
    expect(rows[0]?.reasons).toEqual(["forecasts.reason.units_below_minimum"]);
  });
  it("maps unknown reason codes to a neutral sentence and every known code has AR and EN copy", () => {
    expect(reasonKey("brand_new_code")).toBe("forecasts.reason.other");
    const en = createTranslator("en"), ar = createTranslator("ar");
    for (const c of ["units_below_minimum", "days_below_minimum", "no_valid_backtest", "k_anonymity_below_minimum", "baseline_served", "reconciled_to_parent"]) {
      expect(en(reasonKey(c))).not.toBe(reasonKey(c));
      expect(ar(reasonKey(c))).not.toBe(reasonKey(c));
    }
  });
  it("carries the stale flag and the localized advice-only notice", () => {
    const v = forecastsView({ store_id: "00000000-0000-4000-8000-000000000001", as_of_date: "2026-10-11", generated_at: "2026-10-11T02:00:00Z", stale: true,
      advice_only: true, notice: { en: "Advice only", ar: "للاسترشاد فقط" }, items: [], has_more: false }, "ar");
    expect(v.stale).toBe(true);
    expect(v.notice).toBe("للاسترشاد فقط");
  });
  it("parses filters strictly", () => {
    expect(parseScope("sku")).toBe("sku");
    expect(parseScope("everything")).toBeUndefined();
    expect(parseHorizon("14")).toBe("14");
    expect(parseHorizon("30")).toBeUndefined();
  });
});

describe("store channel references", () => {
  it("accepts opaque references for Odoo and Sheets only", () => {
    expect(validateChannelRefs({ kind: "odoo", tokenRef: "kms://secrets/odoo-prod", kmsKeyRef: "alias/seller-keys" })).toMatchObject({ ok: true, value: { kind: "odoo" } });
    expect(validateChannelRefs({ kind: "shopify", tokenRef: "kms://secrets/odoo-prod", kmsKeyRef: "alias/seller-keys" })).toEqual({ ok: false, errors: ["kind"] });
    expect(validateChannelRefs({ kind: "odoo", tokenRef: "short", kmsKeyRef: "has space in it" })).toEqual({ ok: false, errors: ["token_ref", "kms_key_ref"] });
  });
  it("never exposes a secret field in rows", () => {
    const c: StoreChannel = { id: "00000000-0000-4000-8000-000000000002", kind: "odoo", status: "active", target_id: null, has_secret: true, created_at: "2026-10-01T10:00:00Z" };
    expect(Object.keys(storeChannelRows([c], "en")[0] ?? {}).sort()).toEqual(["createdAt", "id", "kindKey", "status"]);
  });
});

describe("navigation", () => {
  it("lists forecasts by store_product.read, not by role name", () => {
    expect(navFor(permissionsFor("catalog")).map((n) => n.href)).toContain("/forecasts");
    expect(navFor(permissionsFor("catalog", ["store_product.read"])).map((n) => n.href)).not.toContain("/forecasts");
  });
});
