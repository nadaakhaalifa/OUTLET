import { describe, expect, it } from "vitest";
import { buildRetentionPolicy, effectiveCutoffMs, FinancialRetentionError, isPurgeEligible, retentionCutoffMs, verifyCoverage, type InventoryLike } from "./index";

const NOW = Date.UTC(2026, 9, 11, 1, 0, 0);

describe("retentionCutoffMs", () => {
  it("handles hours, days, months, years", () => {
    expect(retentionCutoffMs(NOW, { value: 30, unit: "days" })).toBe(Date.UTC(2026, 8, 11, 1, 0, 0));
    expect(retentionCutoffMs(NOW, { value: 12, unit: "hours" })).toBe(NOW - 12 * 3_600_000);
    expect(retentionCutoffMs(NOW, { value: 25, unit: "months" })).toBe(Date.UTC(2024, 8, 11, 1, 0, 0));
    expect(retentionCutoffMs(NOW, { value: 7, unit: "years" })).toBe(Date.UTC(2019, 9, 11, 1, 0, 0));
  });
  it("clamps to the end of a shorter month", () => {
    expect(retentionCutoffMs(Date.UTC(2026, 4, 31), { value: 3, unit: "months" })).toBe(Date.UTC(2026, 1, 28));
    expect(retentionCutoffMs(Date.UTC(2028, 1, 29), { value: 1, unit: "years" })).toBe(Date.UTC(2027, 1, 28));
  });
  it("rejects non-positive periods", () => {
    expect(() => retentionCutoffMs(NOW, { value: 0, unit: "days" })).toThrow(RangeError);
  });
  it("keeps a row exactly at the cutoff and purges one tick older", () => {
    const c = retentionCutoffMs(NOW, { value: 30, unit: "days" });
    expect(isPurgeEligible(c, c)).toBe(false);
    expect(isPurgeEligible(c - 1, c)).toBe(true);
  });
});

describe("effectiveCutoffMs", () => {
  it("refuses a financial rule shorter than 5 years", () => {
    expect(() => effectiveCutoffMs(NOW, "orders_tax_records", { value: 1, unit: "years" }, true)).toThrow(FinancialRetentionError);
    expect(effectiveCutoffMs(NOW, "orders_tax_records", { value: 7, unit: "years" }, true)).toBe(Date.UTC(2019, 9, 11, 1));
    expect(effectiveCutoffMs(NOW, "orders_tax_records", { value: 5, unit: "years" }, true)).toBe(Date.UTC(2021, 9, 11, 1));
  });
  it("does not restrict non-financial rules", () => {
    expect(effectiveCutoffMs(NOW, "x", { value: 1, unit: "days" }, false)).toBe(NOW - 86_400_000);
  });
});

const inv: InventoryLike = {
  retention: {
    sess: { period: { value: 30, unit: "days" }, trigger: "expiry", after: "delete", purge_job: "purge_sessions", purge_metric: "m1", verify: true },
    tax: { period: { value: 7, unit: "years" }, trigger: "order_close", after: "pseudonymize", purge_job: "purge_tax", purge_metric: "m2", verify: true },
    cat: { period: null, trigger: "catalog_lifecycle", after: "none", purge_job: "archive", purge_metric: "m3", verify: false },
  },
  tables: [
    { name: "sessions", defaults: { retention: "sess", on_erasure: "delete" }, fields: [{}, {}] },
    { name: "otp", defaults: { retention: "sess", on_erasure: "delete" }, fields: [{}] },
    { name: "orders", defaults: { retention: "tax" }, fields: [{ on_erasure: "pseudonymize" }, { on_erasure: "retain_legal" }] },
    { name: "brands", defaults: { retention: "cat" }, fields: [{}] },
  ],
};

describe("buildRetentionPolicy", () => {
  it("groups tables and erasure modes per rule", () => {
    const p = buildRetentionPolicy(inv);
    expect([...(p.get("sess")?.tables.keys() ?? [])]).toEqual(["otp", "sessions"]);
    expect(p.get("tax")?.tables.get("orders")).toEqual(["pseudonymize", "retain_legal"]);
  });
});

describe("verifyCoverage", () => {
  const policy = buildRetentionPolicy(inv);
  const targets = [{ id: "sessions.expired", ruleId: "sess", table: "sessions" }];
  const migrated = new Set(["sessions", "orders", "brands"]);
  const rest = { kind: "retained_by_law", reason: "ledger-linked records kept for the tax period" } as const;

  it("passes when every finite rule is a target or an explicit exemption and reports pending tables", () => {
    const r = verifyCoverage(policy, [{ ruleId: "sess", targets: ["sessions.expired"] }, { ruleId: "tax", targets: [], rest }], targets, migrated);
    expect(r.problems).toEqual([]);
    expect(r.pending.get("sess")).toEqual(["otp"]);
  });
  it("fails when a finite rule has no handler", () => {
    const r = verifyCoverage(policy, [{ ruleId: "sess", targets: ["sessions.expired"] }], targets, migrated);
    expect(r.problems.join("\n")).toContain("rule tax");
  });
  it("fails when a migrated table is neither targeted nor exempt", () => {
    const r = verifyCoverage(policy, [{ ruleId: "sess", targets: [] }, { ruleId: "tax", targets: [], rest }], targets, new Set([...migrated, "otp"]));
    expect(r.problems.join("\n")).toContain("otp, sessions");
  });
  it("fails on a short exemption reason, unknown targets, wrong rule and missing owner", () => {
    const bad = verifyCoverage(
      policy,
      [
        { ruleId: "sess", targets: ["nope"], rest: { kind: "owned_elsewhere", reason: "short" } },
        { ruleId: "tax", targets: ["sessions.expired"], rest },
      ],
      targets,
      migrated,
    );
    const text = bad.problems.join("\n");
    expect(text).toContain("unknown target nope");
    expect(text).toContain("too short");
    expect(text).toContain("needs an owner");
    expect(text).toContain("belongs to sess");
  });
  it("rejects pending_tables when everything is migrated", () => {
    const r = verifyCoverage(policy, [{ ruleId: "sess", targets: ["sessions.expired"], rest: { kind: "pending_tables", reason: "waiting for the otp table to be built" } }, { ruleId: "tax", targets: [], rest }], targets, new Set(["sessions", "otp", "orders"]));
    expect(r.problems.join("\n")).toContain("pending_tables");
  });
  it("ignores rules that purge nothing (after none)", () => {
    expect(verifyCoverage(policy, [], [], new Set()).problems.join("\n")).not.toContain("rule cat");
  });
});
