import { describe, expect, it } from "vitest";
import { EXPORT_EXEMPTIONS, EXPORTER_MANIFEST } from "./application/exporter-manifest";
import { planErasure, checkExporterCoverage, exportableTables } from "./domain/bridge";
import { loadInventoryTables } from "./test/fixtures";

/**
 * Gate (spec B1 data subject rights): every inventory table that holds P2/P3 data tagged for DSAR
 * export has an exporter, or an explicit exemption with a reason. Fix a failure by adding the table
 * to the owning module's exporter in application/exporter-manifest.ts, or exempt it with a reason.
 */
describe("export coverage against docs/privacy/data_inventory.yaml", () => {
  const tables = loadInventoryTables();

  it("loads a non-trivial inventory", () => {
    expect(tables.length).toBeGreaterThan(50);
    expect(exportableTables(tables).length).toBeGreaterThan(30);
  });

  it("covers every exportable table with an exporter or a reasoned exemption", () => {
    const report = checkExporterCoverage(tables, EXPORTER_MANIFEST, EXPORT_EXEMPTIONS);
    expect(report).toEqual({
      missing: [],
      unknown: [],
      duplicates: [],
      unexplained: [],
      contradictory: [],
      ok: true,
    });
  });

  it("every exemption has a substantive reason", () => {
    for (const e of EXPORT_EXEMPTIONS) expect(e.reason.length).toBeGreaterThan(20);
  });

  it("produces an erasure plan for the whole inventory with no table left undecided", () => {
    const plan = planErasure(tables);
    expect(plan.tables).toHaveLength(tables.length);
    const personal = tables.filter((t) => t.fields.some((f) => f.onErasure !== "not_personal"));
    const acting = plan.tables.filter((p) => p.action !== "none");
    expect(acting).toHaveLength(personal.length);
    // Financial and tax records are never erased outright (spec section 2 Rules).
    const by = new Map(plan.tables.map((p) => [p.table, p]));
    for (const name of ["order_groups", "payment_events_raw"]) {
      expect(by.get(name)?.action, name).not.toBe("erase");
    }
    expect(by.get("users")?.action).toBe("retain_by_law");
    expect(by.get("users")?.eraseFields).toContain("phone_e164");
  });
});
