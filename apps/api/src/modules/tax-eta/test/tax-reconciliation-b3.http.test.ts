import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TOKENS, bearer, createTaxHarness, type TaxHarness } from "./harness";

let h: TaxHarness;
beforeEach(async () => {
  h = await createTaxHarness();
});
afterEach(async () => {
  await h.close();
});

const get = (path: string, token: string | null) => {
  let r = h.http().get(path);
  if (token !== null) r = r.set(bearer(token));
  return r;
};
const DAY = "/v1/admin/tax/reconciliation?date=2026-10-10";
const RANGE = (from: string, to: string) => `/v1/admin/tax/reconciliation?from=${from}&to=${to}`;

describe("tax reconciliation: authority_checked (B-3, F-2)", () => {
  it("is true only when ETA was actually queried", async () => {
    const ok = await get(DAY, TOKENS.adminFinance);
    expect(ok.status).toBe(200);
    expect(ok.body.authority_checked).toBe(true);
    h.eta.dayReportUnavailable = true;
    // A different day: a past day answered earlier is served from the cache and would not hit the port.
    const down = await get("/v1/admin/tax/reconciliation?date=2026-10-09", TOKENS.adminFinance);
    expect(down.status).toBe(200);
    // The internal-only result still says reconciled; the flag is what tells the console not to show it.
    expect(down.body.authority_checked).toBe(false);
  });

  it("is false when the ETA port throws (Unconfigured in production)", async () => {
    Object.assign(h.eta, {
      dayReport: async () => {
        throw new Error("provider_not_configured");
      },
    });
    const r = await get("/v1/admin/tax/reconciliation?date=2026-10-08", TOKENS.adminOps);
    expect(r.status).toBe(200);
    expect(r.body.authority_checked).toBe(false);
  });
});

describe("tax reconciliation: from/to range (B-3)", () => {
  it("answers 404 while release.admin.finance_views is blocked", async () => {
    expect((await get(RANGE("2026-10-01", "2026-10-03"), TOKENS.adminFinance)).status).toBe(404);
    // The single-day form is unchanged.
    expect((await get(DAY, TOKENS.adminFinance)).status).toBe(200);
  });

  it("returns one report per Cairo day, ascending, each with its own authority flag", async () => {
    h.financeViewsFlag.on = true;
    const r = await get(RANGE("2026-10-08", "2026-10-10"), TOKENS.adminFinance);
    expect(r.status).toBe(200);
    expect(r.body.days.map((d: { date: string }) => d.date)).toEqual(["2026-10-08", "2026-10-09", "2026-10-10"]);
    for (const d of r.body.days) expect(d.authority_checked).toBe(true);
    const single = await get(DAY, TOKENS.adminFinance);
    expect(r.body.days[2]).toEqual(single.body);
    const one = await get(RANGE("2026-10-10", "2026-10-10"), TOKENS.adminOps);
    expect(one.body.days).toHaveLength(1);
  });

  it("accepts exactly 31 days and rejects 32, reversed ranges and bad shapes with 400 (the platform's validation status)", async () => {
    h.financeViewsFlag.on = true;
    expect((await get(RANGE("2026-10-01", "2026-10-31"), TOKENS.adminFinance)).body.days).toHaveLength(31);
    expect((await get(RANGE("2026-10-01", "2026-11-01"), TOKENS.adminFinance)).status).toBe(400);
    expect((await get(RANGE("2026-10-10", "2026-10-01"), TOKENS.adminFinance)).status).toBe(400);
    expect((await get(RANGE("2026-02-30", "2026-03-01"), TOKENS.adminFinance)).status).toBe(400);
    expect((await get("/v1/admin/tax/reconciliation?from=2026-10-01", TOKENS.adminFinance)).status).toBe(400);
    expect((await get("/v1/admin/tax/reconciliation?date=2026-10-10&from=2026-10-01&to=2026-10-02", TOKENS.adminFinance)).status).toBe(400);
    expect((await get("/v1/admin/tax/reconciliation", TOKENS.adminFinance)).status).toBe(400);
  });

  it("keeps the admin gate: others never see the range, flag on or off", async () => {
    for (const on of [false, true]) {
      h.financeViewsFlag.on = on;
      const p = RANGE("2026-10-08", "2026-10-09");
      expect((await get(p, null)).status).toBe(401);
      expect((await get(p, TOKENS.shopper)).status).toBe(401);
      expect((await get(p, TOKENS.ownerA)).status).toBe(401);
      expect((await get(p, TOKENS.adminSupport)).status).toBe(403);
      expect((await get(p, TOKENS.adminNoPasskey)).status).toBe(403);
    }
  });

  it("audits every read before answering", async () => {
    h.financeViewsFlag.on = true;
    const before = h.audit.entries.length;
    await get(RANGE("2026-10-08", "2026-10-09"), TOKENS.adminFinance);
    expect(h.audit.entries.slice(before).some((e) => e.ruleId === "tax_eta.admin" && e.effect === "allow")).toBe(true);
  });
});

describe("tax reconciliation: cost caps and caching", () => {
  it("sends no-store, rate limits the range form to 5 per minute and caches past days", async () => {
    h.financeViewsFlag.on = true;
    let calls = 0;
    const real = h.eta.dayReport.bind(h.eta) as (a: number, b: number) => Promise<unknown>;
    Object.assign(h.eta, {
      dayReport: async (a: number, b: number) => {
        calls += 1;
        return real(a, b);
      },
    });
    const first = await get(RANGE("2026-10-01", "2026-10-03"), TOKENS.adminFinance);
    expect(first.headers["cache-control"]).toBe("private, no-store");
    expect(calls).toBe(3);
    await get(RANGE("2026-10-01", "2026-10-03"), TOKENS.adminFinance);
    expect(calls).toBe(3);
    for (let i = 0; i < 3; i += 1) expect((await get(RANGE("2026-10-01", "2026-10-02"), TOKENS.adminFinance)).status).toBe(200);
    const limited = await get(RANGE("2026-10-01", "2026-10-02"), TOKENS.adminFinance);
    expect(limited.status).toBe(429);
    expect((await get(DAY, TOKENS.adminFinance)).headers["cache-control"]).toBe("private, no-store");
  });
});
