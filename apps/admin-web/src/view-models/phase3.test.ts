import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ALL_KILL_SWITCHES, FLAG_REGISTRY } from "@outlet/feature-flags";
import type { CreatorPayoutWire, CreatorStatus } from "../api/phase3-schemas";
import type { FlagWire, PlusPlanWire } from "../api/schemas";
import { catalogs } from "../i18n";
import { EXPECTED_KILL_SWITCHES } from "./flags";
import { actionAvailability, creatorRows, DECISIONS_BY_STATUS, decisionReasonError, payoutGate, payoutRows } from "./creators";
import { ALL_SWITCH_KEYS, killSwitchBoard, switchLabel, toRow } from "./killswitch";
import { navAllowsPath, navFor } from "./nav";
import { planGroups, validatePlusForm } from "./plus";
import { evaluationRows, shadowView, validateGuardrailForm, validateRunForm } from "./ranking";

const NOW = Date.parse("2026-10-11T10:00:00Z");
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const flag = (key: string, enabled: boolean): FlagWire => ({ key, kind: "kill_switch", description: "d", enabled, is_default: !enabled });

describe("kill-switch board covers the whole registry (cannot drift)", () => {
  it("lists exactly the registry kill switches", () => {
    const registry = FLAG_REGISTRY.filter((f) => f.kind === "kill_switch").map((f) => f.key).sort();
    expect([...ALL_SWITCH_KEYS].sort()).toEqual(registry);
    expect(registry).toEqual(Object.keys(ALL_KILL_SWITCHES).sort());
  });
  it("names every Phase 3 switch", () => {
    for (const k of ["kill.public_catalog", "kill.wardrobe", "kill.wardrobe_vision", "kill.ranking_v2_shadow", "kill.creator_program", "kill.creator_payouts"]) {
      expect(ALL_SWITCH_KEYS, k).toContain(k);
    }
  });
  it("every key has an AR and EN label, and every Phase 2 and 3 key a blocked-effect sentence", () => {
    for (const k of ALL_SWITCH_KEYS) {
      expect(switchLabel(k, "en"), k).not.toBe(k);
      expect(switchLabel(k, "ar"), k).not.toBe(k);
      if ((EXPECTED_KILL_SWITCHES as readonly string[]).includes(k)) continue; // the 14 spec A2.12 switches carry no effect text by design
      expect(toRow(flag(k, false), "en").blockedMeans, `${k} en`).not.toBeNull();
      expect(toRow(flag(k, false), "ar").blockedMeans, `${k} ar`).not.toBeNull();
    }
  });
  it("a board built from the registry has no unreported rows and no key twice", () => {
    const b = killSwitchBoard(ALL_SWITCH_KEYS.map((k) => flag(k, false)), "en");
    expect(b.notReported).toEqual([]);
    const keys = b.groups.flatMap((g) => g.rows.map((r) => r.key));
    expect(new Set(keys).size).toBe(ALL_SWITCH_KEYS.length);
    for (const g of b.groups) expect(catalogs.en[`sw.group.${g.group}`]).toBeTruthy();
  });
});

const payout = (over: Partial<CreatorPayoutWire> = {}): CreatorPayoutWire => ({
  id: U(1), creator_id: U(2), amount: { amount: "150000", currency: "EGP" }, state: "SCHEDULED", attempt: 0, created_by: U(9), ...over,
});

describe("creator payouts are gated by kill.creator_payouts and dual approval", () => {
  it("fails closed when the flag list is missing, unreported or Blocked", () => {
    expect(payoutGate(null).moneyActionsEnabled).toBe(false);
    expect(payoutGate([]).moneyActionsEnabled).toBe(false);
    expect(payoutGate([flag("kill.creator_payouts", false)])).toMatchObject({ state: "blocked", reported: true, moneyActionsEnabled: false });
    expect(payoutGate([flag("kill.creator_payouts", true)]).moneyActionsEnabled).toBe(true);
  });
  it("disables every money action while Blocked, but cancel stays available", () => {
    const gate = payoutGate([flag("kill.creator_payouts", false)]);
    for (const state of ["SCHEDULED", "ON_HOLD", "APPROVED", "SENT"] as const) {
      const [row] = payoutRows([payout({ state })], U(5));
      for (const a of row?.actions ?? []) {
        const av = actionAvailability(row!, a, gate, true);
        expect(av.enabled, `${state} ${a}`).toBe(a === "cancel");
      }
    }
  });
  it("blocks approving your own payout and every write when sensitive writes are off", () => {
    const gate = payoutGate([flag("kill.creator_payouts", true)]);
    const [own] = payoutRows([payout()], U(9));
    expect(actionAvailability(own!, "approve", gate, true)).toEqual({ enabled: false, why: "self_created" });
    const [other] = payoutRows([payout()], U(8));
    expect(actionAvailability(other!, "approve", gate, true)).toEqual({ enabled: true });
    expect(actionAvailability(other!, "approve", gate, false)).toEqual({ enabled: false, why: "writes_disabled" });
  });
  it("offers only the transitions of the payout machine", () => {
    const acts = (state: CreatorPayoutWire["state"]) => payoutRows([payout({ state })], null)[0]?.actions;
    expect(acts("SCHEDULED")).toEqual(["approve", "cancel"]);
    expect(acts("APPROVED")).toEqual(["send", "cancel"]);
    expect(acts("SENT")).toEqual(["outcome_settled", "outcome_rejected"]);
    for (const s of ["SETTLED", "FAILED", "CANCELLED"] as const) expect(acts(s)).toEqual([]);
  });
  it("amounts stay integer piastres", () => {
    expect(payoutRows([payout({ amount: { amount: "123456789012345678", currency: "EGP" } })], null)[0]?.amountMinor).toBe(123456789012345678n);
  });
});

describe("creator applications", () => {
  it("offers the right decisions per status and requires evidence to approve", () => {
    const statuses: CreatorStatus[] = ["APPLIED", "ACTIVE", "SUSPENDED", "REJECTED"];
    for (const s of statuses) {
      const [r] = creatorRows([{ id: U(3), user_id: U(4), handle: "h", display_name: "n", status: s, kyc_state: "APPROVED" }]);
      expect(r?.decisions).toEqual(DECISIONS_BY_STATUS[s]);
    }
    expect(decisionReasonError("approve", "  ")).toBe("required");
    expect(decisionReasonError("approve", "kyc ok")).toBeNull();
    expect(decisionReasonError("reject", "")).toBeNull();
    expect(decisionReasonError("reject", "x".repeat(201))).toBe("too_long");
  });
});

describe("ranking v2 view-models", () => {
  it("never turns a missing measurement into zero", () => {
    const v = shadowView({ window_hours: 24, runs: 0, personalized_runs: 0, bot_filtered_runs: 0, mean_overlap_permille: null, top1_same_permille: null, mean_rank_shift_milli: null, shadow_model_versions: [], served: "v1" });
    expect([v.meanOverlap, v.top1Same, v.meanRankShift]).toEqual([null, null, null]);
    const w = shadowView({ window_hours: 24, runs: 5, personalized_runs: 2, bot_filtered_runs: 1, mean_overlap_permille: 873, top1_same_permille: 600, mean_rank_shift_milli: 1250, shadow_model_versions: ["v2.1"], served: "v1" });
    expect(w).toMatchObject({ meanOverlap: "87.3%", top1Same: "60.0%", meanRankShift: "1.25", served: "v1" });
  });
  it("computes the nDCG delta in basis points", () => {
    const [e] = evaluationRows([{ id: U(1), request_key: "k", candidate_version: "c", baseline_version: "b", dataset: "synthetic", seed: 1, requests: 10, k: 10,
      candidate: { ndcg_bps: 7100, map_bps: 5000 }, baseline: { ndcg_bps: 7300, map_bps: 5100 }, passed: false, reasons: ["ndcg_regression"], created_at: "2026-10-11T10:00:00Z" }]);
    expect(e?.ndcgDeltaBps).toBe(-200);
    expect(e?.candidateNdcg).toBe("71.00%");
  });
  it("validates the evaluation run form against the contract bounds", () => {
    const ok = validateRunForm({ requestKey: "eval-2026-10-11", candidate: "v2.1", baseline: "v1", seed: "", requests: "500", k: "10" });
    expect(ok).toEqual({ ok: true, value: { request_key: "eval-2026-10-11", candidate: "v2.1", baseline: "v1", requests: 500, k: 10 } });
    const bad = validateRunForm({ requestKey: "short", candidate: "", baseline: "v1", seed: "-1", requests: "2001", k: "51" });
    expect(bad).toEqual({ ok: false, errors: ["request_key", "candidate", "seed", "requests", "k"] });
  });
  it("validates guardrail inputs: returns cannot exceed orders, config is all-or-nothing", () => {
    const arm = { orders: "100", returned: "10", complaints: "2" };
    const base = { control: arm, treatment: arm, minOrders: "", maxReturnBps: "", maxComplaintBps: "" };
    expect(validateGuardrailForm(base)).toEqual({ ok: true, body: { control: { orders: 100, returned: 10, complaints: 2 }, treatment: { orders: 100, returned: 10, complaints: 2 } } });
    expect(validateGuardrailForm({ ...base, treatment: { ...arm, returned: "101" } })).toEqual({ ok: false, errors: ["returned_gt_orders"] });
    expect(validateGuardrailForm({ ...base, minOrders: "50", maxReturnBps: "10001", maxComplaintBps: "5" })).toEqual({ ok: false, errors: ["config"] });
    fc.assert(fc.property(fc.integer({ min: 0, max: 1e6 }), fc.integer({ min: 0, max: 1e6 }), (orders, returned) => {
      const r = validateGuardrailForm({ ...base, control: { orders: String(orders), returned: String(returned), complaints: "0" } });
      expect(r.ok).toBe(returned <= orders);
    }));
  });
});

describe("plan editor: family and student plans", () => {
  const f = { code: "plus_family_year", interval: "year", priceEgp: "1200", trialDays: "0", effectiveFrom: new Date(NOW + 31 * 864e5).toISOString() };
  it("requires 2 to 8 seats on a family plan and none elsewhere", () => {
    expect(validatePlusForm({ ...f, kind: "family", seatLimit: "4" }, NOW)).toMatchObject({ ok: true, value: { kind: "family", seat_limit: 4 } });
    expect(validatePlusForm({ ...f, kind: "family", seatLimit: "" }, NOW)).toEqual({ ok: false, errors: ["seats"] });
    expect(validatePlusForm({ ...f, kind: "family", seatLimit: "9" }, NOW)).toEqual({ ok: false, errors: ["seats"] });
    expect(validatePlusForm({ ...f, kind: "student", seatLimit: "3" }, NOW)).toEqual({ ok: false, errors: ["seats"] });
    const stu = validatePlusForm({ ...f, kind: "student", seatLimit: "" }, NOW);
    expect(stu).toMatchObject({ ok: true, value: { kind: "student" } });
    const ind = validatePlusForm({ ...f }, NOW);
    expect(ind.ok && "kind" in ind.value).toBe(false);
    expect(validatePlusForm({ ...f, kind: "gold" }, NOW)).toEqual({ ok: false, errors: ["kind"] });
  });
  it("shows kind and seats, defaulting older rows to individual", () => {
    const base: PlusPlanWire = { id: "p1", code: "plus_m", interval: "month", price: { amount_minor: "20000", currency: "EGP" }, trial_days: 0, version: 1, active: true, effective_from: "2026-01-01T00:00:00Z", members_notified_at: null };
    const g = planGroups([base, { ...base, id: "p2", code: "plus_f", kind: "family", seat_limit: 4 }], NOW);
    expect(g.flatMap((x) => x.versions).map((v) => [v.kind, v.seatLimit])).toEqual([["family", 4], ["individual", null]]);
  });
});

describe("navigation", () => {
  it("gates the new pages by role (links only; the API stays the authority)", () => {
    expect(navAllowsPath(["ops"], "/ranking")).toBe(true);
    expect(navAllowsPath(["finance"], "/ranking")).toBe(false);
    expect(navAllowsPath(["finance"], "/creators")).toBe(true);
    expect(navAllowsPath(["support"], "/creators")).toBe(false);
    expect(navFor(null)).toEqual([]);
  });
});
