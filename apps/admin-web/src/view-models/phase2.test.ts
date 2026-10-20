import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ALL_KILL_SWITCHES, PHASE2_KILL_SWITCHES } from "@outlet/feature-flags";
import type { DoraReport, FlagWire, PlusPlanWire } from "../api/schemas";
import { catalogs } from "../i18n";
import { calendarRows, freezeWarning, megaEventsForYear } from "./calendar";
import { doraView, parseDora } from "./dora";
import { ALL_SWITCH_KEYS, changeSentence, killSwitchBoard, PHASE2_SWITCH_KEYS, stateFor, toRow } from "./killswitch";
import { navFor } from "./nav";
import { adsView, matchingView } from "./phase2ops";
import { earliestEffectiveMs, egpToMinor, planGroups, validatePlusForm } from "./plus";
import { mergeRewards, percentToPpm, ppmToPercent, validateOdds, validateRewardsEdit, type OddsOutcomeInput } from "./rewards";

const NOW = Date.parse("2026-10-11T10:00:00Z");
const flag = (key: string, enabled: boolean, isDefault = false): FlagWire => ({ key, kind: "kill_switch", description: "d", enabled, is_default: isDefault });

describe("kill-switch screen (ADR-0028)", () => {
  it("pins the key list and wording to packages/feature-flags", () => {
    expect([...PHASE2_SWITCH_KEYS].sort()).toEqual(Object.keys(PHASE2_KILL_SWITCHES).sort());
    expect([...ALL_SWITCH_KEYS].sort()).toEqual(Object.keys(ALL_KILL_SWITCHES).sort());
    for (const [k, v] of Object.entries(PHASE2_KILL_SWITCHES)) {
      const row = toRow(flag(k, false), "en");
      expect(row.blockedMeans, k).not.toBeNull();
      expect(v.description.toLowerCase(), k).toContain((row.blockedMeans ?? "?").toLowerCase().slice(0, 12));
      expect(row.label, k).not.toBe(k);
      expect(toRow(flag(k, false), "ar").label, k).not.toBe(k);
    }
  });
  it("renders Allowed / Blocked, never on / off, and fails closed for unreported keys", () => {
    const b = killSwitchBoard([flag("kill.plus.sales", true), flag("kill.drops", false, true)], "en");
    expect(b.allowedCount).toBe(1);
    expect(b.blockedCount).toBe(1);
    expect(b.notReported).toHaveLength(ALL_SWITCH_KEYS.length - 2);
    expect(stateFor([], "kill.gift_card_sales")).toEqual({ state: "blocked", reported: false });
  });
  it("change sentence states the resulting state in words", () => {
    const row = toRow(flag("kill.gift_card_redemption", true), "en");
    expect(changeSentence(row, "en")).toBe("After this change, Gift card redemption will be Blocked. Effect: Redemption answers 503.");
    const allow = toRow(flag("kill.gift_card_redemption", false), "en");
    expect(changeSentence(allow, "en")).toBe("After this change, Gift card redemption will be Allowed.");
    expect(changeSentence(allow, "ar")).toContain("مسموح");
  });
  it("copy never says kill switch on/off", () => {
    for (const cat of Object.values(catalogs)) for (const [k, v] of Object.entries(cat)) expect(v, k).not.toMatch(/\bswitch\b.{0,12}\b(on|off)\b|kill switch (on|off)/i);
  });
  it("every board group row is unique", () => {
    const all = ALL_SWITCH_KEYS.map((k) => flag(k, false));
    const b = killSwitchBoard(all, "ar");
    expect(b.groups.flatMap((g) => g.rows).length).toBe(ALL_SWITCH_KEYS.length);
    expect(b.notReported).toEqual([]);
  });
});

describe("Plus pricing", () => {
  it("parses EGP to piastres without floats", () => {
    expect(egpToMinor("200")).toBe(20000n);
    expect(egpToMinor("199.5")).toBe(19950n);
    expect(egpToMinor("0")).toBeNull();
    expect(egpToMinor("1e3")).toBeNull();
    expect(egpToMinor("-5")).toBeNull();
  });
  const form = (eff: number) => ({ code: "plus_yearly", interval: "year", priceEgp: "800", trialDays: "14", effectiveFrom: new Date(eff).toISOString() });
  it("requires 30 days notice, boundary inclusive", () => {
    const e = earliestEffectiveMs(NOW);
    expect(validatePlusForm(form(e), NOW).ok).toBe(true);
    const r = validatePlusForm(form(e - 1), NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toContain("notice");
  });
  it("rejects bad code, interval, trial and price", () => {
    const r = validatePlusForm({ code: "x", interval: "week", priceEgp: "abc", trialDays: "99", effectiveFrom: "nope" }, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(new Set(r.errors)).toEqual(new Set(["code", "price", "trial", "date"]));
  });
  it("groups versions newest first and marks scheduled ones", () => {
    const p = (v: number, eff: number): PlusPlanWire => ({ id: `id${v}`, code: "plus_monthly", interval: "month", price: { amount_minor: "20000", currency: "EGP" }, trial_days: 0, version: v, active: v === 2, effective_from: new Date(eff).toISOString(), members_notified_at: null });
    const g = planGroups([p(1, NOW - 1000), p(2, NOW + 86_400_000)], NOW);
    expect(g[0]?.versions.map((x) => x.version)).toEqual([2, 1]);
    expect(g[0]?.versions[0]?.scheduled).toBe(true);
    expect(g[0]?.versions[1]?.scheduled).toBe(false);
  });
});

const row = (id: string, kind: string, percent: string, coins = "", voucher = ""): OddsOutcomeInput => ({ id, kind, percent, coins, voucher });
describe("game odds editor", () => {
  it("accepts exactly 100% and refuses anything else", () => {
    expect(validateOdds([row("a", "nothing", "70"), row("b", "coins", "29.9999", "5"), row("c", "voucher", "0.0001", "", "v1")]).ok).toBe(true);
    const under = validateOdds([row("a", "nothing", "99.9999")]);
    expect(under.ok).toBe(false);
    if (!under.ok) expect(under.errors).toContain("sum");
    const over = validateOdds([row("a", "nothing", "60"), row("b", "nothing", "40.0001")]);
    expect(over.ok).toBe(false);
  });
  it("requires coins for coin outcomes, voucher ids, unique ids, at least one row", () => {
    const r = validateOdds([row("a", "coins", "50"), row("a", "voucher", "50")]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(new Set(r.errors)).toEqual(new Set(["coins", "voucher", "duplicate_id"]));
    const e = validateOdds([]);
    if (!e.ok) expect(e.errors).toContain("empty");
  });
  it("percent <-> ppm round trip and total ppm is the sum", () => {
    expect(percentToPpm("12.5")).toBe(125_000);
    expect(percentToPpm("100.0001")).toBeNull();
    expect(percentToPpm("1.23456")).toBeNull();
    fc.assert(fc.property(fc.integer({ min: 0, max: 1_000_000 }), (n) => percentToPpm(ppmToPercent(n)) === n));
  });
  it("property: a split of 1,000,000 ppm into n parts always validates; off by one never does", () => {
    fc.assert(fc.property(fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 1, maxLength: 19 }), (parts) => {
      const used = parts.reduce((a, b) => a + b, 0);
      const rows = [...parts.map((p, i) => row(`o${i}`, "nothing", ppmToPercent(p))), row("rest", "nothing", ppmToPercent(1_000_000 - used))];
      const ok = validateOdds(rows).ok;
      const bad = validateOdds([...rows.slice(0, -1), row("rest", "nothing", ppmToPercent(Math.max(0, 1_000_000 - used - 1)))]).ok;
      return ok && !bad;
    }));
  });
});

describe("rewards config", () => {
  it("tiers must be strictly increasing, conversion positive", () => {
    const base = { piastresPerCoin: "1", silverFrom: "100", goldFrom: "200", blackFrom: "300", maxCoinsPerEvent: "50" };
    expect(validateRewardsEdit(base).ok).toBe(true);
    expect(validateRewardsEdit({ ...base, goldFrom: "100" }).errors).toContain("tiers");
    expect(validateRewardsEdit({ ...base, piastresPerCoin: "0" }).errors).toContain("piastres");
  });
  it("merge keeps untouched fields and drops version", () => {
    const m = mergeRewards({ version: 3, piastres_per_coin: "1", purchase_bps: "50", plus_bonus_bps: "0", review_base_coins: "1", review_photo_coins: "1", review_fit_coins: "1", profile_completion_coins: "1", fit_feedback_coins: "1", max_coins_per_event: "9", expiry_months: 12, expiring_notice_days: 30, silver_from: "1", gold_from: "2", black_from: "3", tier_downgrade_notice_days: 7, streak_milestones: [], daily_plays_per_game: 1, odds_publish_lead_hours: 24, max_game_coins: "5" },
      { piastresPerCoin: "2", silverFrom: "10", goldFrom: "20", blackFrom: "30", maxCoinsPerEvent: "99" }, "ap1");
    expect(m).toMatchObject({ purchase_bps: "50", piastres_per_coin: "2", max_coins_per_event: "99", approval_id: "ap1", expiry_months: 12 });
    expect("version" in m).toBe(false);
  });
});

describe("mega-event calendar", () => {
  it("has the five fixed/derived events with known fixed dates", () => {
    const ev = megaEventsForYear(2026);
    expect(new Set(ev.map((e) => e.id))).toEqual(new Set(["white_friday", "singles_day", "ramadan", "eid_al_fitr", "eid_al_adha", "mothers_day"]));
    const wf = ev.find((e) => e.id === "white_friday");
    expect(new Date((wf?.startMs ?? 0) + 6 * 3_600_000).toISOString().slice(0, 10)).toBe("2026-11-27");
    const md = ev.find((e) => e.id === "mothers_day");
    expect(new Date((md?.startMs ?? 0) + 6 * 3_600_000).toISOString().slice(0, 10)).toBe("2026-03-21");
    expect(ev.filter((e) => e.estimated).map((e) => e.id).sort()).toEqual(["eid_al_adha", "eid_al_fitr", "ramadan"]);
  });
  it("freeze starts exactly 48h before an event and warns while it applies", () => {
    const wf = megaEventsForYear(2026).find((e) => e.id === "white_friday");
    const start = wf?.startMs ?? 0;
    const at = (t: number) => calendarRows(t, [2026]).find((r) => r.event.id === "white_friday")?.state;
    expect(at(start - 48 * 3_600_000 - 1)).toBe("upcoming_freeze");
    expect(at(start - 48 * 3_600_000)).toBe("freeze_active");
    expect(at(start)).toBe("event_running");
    expect(freezeWarning(calendarRows(start - 3_600_000, [2026]))?.event.id).toBe("white_friday");
    expect(at(start + 3 * 86_400_000)).toBeUndefined();
  });
});

const dora = (over: Partial<DoraReport["metrics"]> = {}): DoraReport => ({
  schema: "outlet.dora.report/v1", generatedAt: "2026-10-11T00:00:00Z", window: { from: "2026-07-13T00:00:00Z", to: "2026-10-11T00:00:00Z", days: 90 },
  source: { mode: "offline", deploymentProxy: "commit", repo: null, ref: "HEAD", commitsInWindow: 22 },
  metrics: { deploymentFrequency: { count: 22, perDay: 0.2, perWeek: 1.7, band: "high" }, leadTimeForChanges: null,
    changeFailureRate: { ratio: 0, failures: 0, deployments: 22, basis: "b", band: "elite" }, timeToRecover: null,
    reworkRate: { ratio: null, reworkCommits: 0, changeCommits: 0, windowDays: 7, basis: "b" }, ...over },
  series: [], notes: ["n"],
});
describe("DORA view", () => {
  it("null metrics are 'not measured' (null), a measured zero stays 0, proxy is flagged", () => {
    const v = doraView(dora());
    expect(v.metrics.find((m) => m.id === "leadTime")?.value).toBeNull();
    expect(v.metrics.find((m) => m.id === "timeToRecover")?.value).toBeNull();
    expect(v.metrics.find((m) => m.id === "changeFailureRate")?.value).toBe("0");
    expect(v.metrics.find((m) => m.id === "reworkRate")?.value).toBeNull();
    expect(v.isProxy).toBe(true);
    expect(doraView({ ...dora(), source: { ...dora().source, deploymentProxy: "github-deployment" } }).isProxy).toBe(false);
  });
  it("parses the schema and refuses other shapes", () => {
    expect(parseDora(JSON.stringify(dora())).ok).toBe(true);
    expect(parseDora("{}").ok).toBe(false);
    expect(parseDora("not json").ok).toBe(false);
    expect(parseDora(JSON.stringify({ ...dora(), schema: "outlet.dora.report/v2" })).ok).toBe(false);
  });
});

describe("matching and ads views", () => {
  it("shows tau, shadow and label progress from the server numbers only", () => {
    const v = matchingView({ tau_bp: 9200, shadow_only: true, version: 1, labelled_pairs: 150, kappa_milli: 812 });
    expect(v).toMatchObject({ tauPercent: "92.00", kappa: "0.812", remainingPairs: 1850, setReady: false, shadowOnly: true });
    expect(matchingView({ tau_bp: 9250, shadow_only: false, version: 2, labelled_pairs: 2400, kappa_milli: 900 }).remainingPairs).toBe(0);
  });
  it("formats ads limits in basis points", () => {
    const v = adsView({ floor_price: { amount: "500", currency: "EGP" }, slots: 2, pricing: "gsp", frequency_cap_per_session_day: 3, click_token_ttl_ms: 1, click_dedupe_window_ms: 2, min_dwell_ms: 3, max_clicks_per_session_per_minute: 4, max_clicks_per_campaign_session_day: 5, bot_score_block_bps: 8050, vat_bps: 1400, min_top_up: { amount: "1", currency: "EGP" }, max_top_up: { amount: "2", currency: "EGP" } });
    expect(v.botBlockPercent).toBe("80.50");
    expect(v.vatPercent).toBe("14.00");
    expect(v.floorMinor).toBe(500n);
  });
});

describe("navigation", () => {
  it("lists the Phase 2 screens by role", () => {
    const ids = (r: Parameters<typeof navFor>[0]) => navFor(r).map((i) => i.id);
    expect(ids(["marketing"])).toEqual(expect.arrayContaining(["rewards", "calendar", "ads"]));
    expect(ids(["marketing"])).not.toContain("engineering");
    expect(ids(["security"])).toContain("engineering");
    expect(ids(["support"])).not.toContain("plus");
    expect(ids(null)).toEqual([]);
  });
});
