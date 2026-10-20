import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { JOB_SPECS } from "../../../workers/registry";
import { buildRetentionPolicy, FINANCIAL_RULES, verifyCoverage, type InventoryLike } from "../domain/bridge";
import { DISPOSITIONS, TARGETS } from "../domain/catalog";
import { RULE_PARAMS } from "../domain/rules.snapshot";
import { assertSafeTarget } from "../adapters/kysely-store";
import { periodFor } from "../application/purge";
import { migratedTables } from "./pglite-db";

const INVENTORY = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../../docs/privacy/data_inventory.yaml");
const inventory = parse(readFileSync(INVENTORY, "utf8")) as InventoryLike;
const policy = buildRetentionPolicy(inventory);
const refs = TARGETS.map((t) => ({ id: t.id, ruleId: t.ruleId, table: t.table, dependents: (t.dependents ?? []).map((d) => d.table) }));

describe("retention policy derived from data_inventory.yaml", () => {
  it("the runtime rule snapshot matches the inventory (period, job, metric, after)", () => {
    const fromYaml = Object.fromEntries([...policy.values()].map((r) => [r.id, { period: r.period, after: r.after, purgeJob: r.purgeJob, purgeMetric: r.purgeMetric }]));
    expect(RULE_PARAMS).toEqual(fromYaml);
  });

  it("every inventory rule with a finite or event-driven retention has a purge handler or an explicit exemption", () => {
    const report = verifyCoverage(policy, DISPOSITIONS, refs, migratedTables());
    expect(report.problems).toEqual([]);
  });

  it("fails loudly when a rule loses its handler (the checker is not vacuous)", () => {
    const without = DISPOSITIONS.filter((d) => d.ruleId !== "auth_credentials");
    expect(verifyCoverage(policy, without, refs, migratedTables()).problems.join("\n")).toContain("auth_credentials");
  });

  it("pending tables are exactly the inventory tables not in migrations (tracked, not silently skipped)", () => {
    const { pending } = verifyCoverage(policy, DISPOSITIONS, refs, migratedTables());
    const pendingNames = [...pending.values()].flat();
    expect(pendingNames).toContain("support_tickets");
    expect(pendingNames).toContain("seller_kyc_records");
    for (const t of pendingNames) expect(migratedTables().has(t)).toBe(false);
  });

  it("owned_elsewhere exemptions name a registered worker job", () => {
    const names = new Set(JOB_SPECS.map((s) => s.name));
    for (const d of DISPOSITIONS) if (d.rest?.kind === "owned_elsewhere") expect(names.has(d.rest.owner ?? "")).toBe(true);
  });

  it("append-only and financial stores are never purge targets", () => {
    const never = ["journal_entries", "postings", "audit_log", "price_events", "payment_events_raw", "consent_records", "ledger_entry_chain"];
    for (const t of TARGETS) expect(never).not.toContain(t.table);
    for (const t of TARGETS) expect(FINANCIAL_RULES.has(t.ruleId)).toBe(false);
  });

  it("every target has a period, a safe shape and unique id", () => {
    expect(new Set(TARGETS.map((t) => t.id)).size).toBe(TARGETS.length);
    for (const t of TARGETS) {
      expect(() => periodFor(t)).not.toThrow();
      expect(() => assertSafeTarget(t)).not.toThrow();
      expect(migratedTables().has(t.table)).toBe(true);
      expect(policy.get(t.ruleId)?.tables.has(t.table)).toBe(true);
    }
  });

  it("rejects an injected fragment", () => {
    const base = TARGETS[0];
    if (base === undefined) throw new Error("no targets");
    expect(() => assertSafeTarget({ ...base, where: "true; DROP TABLE users" })).toThrow();
    expect(() => assertSafeTarget({ ...base, table: "sessions; x" })).toThrow();
  });
});
