import { describe, expect, it } from "vitest";
import {
  PDPC_NOTICE_HOURS,
  breachClocks,
  breachHasOverdueClock,
  buildDsarQueue,
  checkExporterCoverage,
  exportableTables,
  newExportRequest,
  notifyPdpc,
  planErasure,
  pseudonymFor,
  recordBreach,
  startDeletion,
  triageBreach,
  type DeletionRequest,
  type InventoryField,
  type InventoryTable,
  DSAR_SLA_DAYS,
} from "./index";

const T0 = 1_800_000_000_000;
const H = 3_600_000;
const D = 24 * H;

const f = (name: string, over: Partial<InventoryField> = {}): InventoryField => ({
  name,
  piiClass: "P2",
  onErasure: "delete",
  retention: null,
  dsarExport: true,
  ...over,
});
const t = (name: string, fields: InventoryField[]): InventoryTable => ({ name, storage: "platform_db", fields });

describe("planErasure", () => {
  it("erase vs pseudonymise vs retain-by-law, strongest wins per table", () => {
    const plan = planErasure([
      t("profile", [f("name"), f("id", { piiClass: "P1", onErasure: "not_personal" })]),
      t("orders", [f("user_id", { onErasure: "pseudonymize", retention: "orders_tax_records" }), f("note")]),
      t("webhooks", [f("body", { onErasure: "retain_legal", retention: "raw_webhooks_financial" })]),
      t("catalog", [f("title", { piiClass: "P0", onErasure: "not_personal" })]),
    ]);
    const by = Object.fromEntries(plan.tables.map((p) => [p.table, p]));
    expect(by["profile"]?.action).toBe("erase");
    expect(by["orders"]).toMatchObject({
      action: "pseudonymise",
      pseudonymiseFields: ["user_id"],
      eraseFields: ["note"],
      retentionKeys: ["orders_tax_records"],
    });
    expect(by["webhooks"]?.action).toBe("retain_by_law");
    expect(by["catalog"]?.action).toBe("none");
    expect(plan.counts).toEqual({ erase: 1, pseudonymise: 1, retain_by_law: 1, none: 1 });
  });

  it("is deterministic regardless of input order and rejects duplicate tables", () => {
    const a = t("a", [f("x")]);
    const b = t("b", [f("y", { onErasure: "pseudonymize" })]);
    expect(planErasure([a, b])).toEqual(planErasure([b, a]));
    expect(() => planErasure([a, a])).toThrow(/duplicate/);
  });

  it("pseudonym is stable, keyed externally and never the raw id", () => {
    const h = (s: string) => `h(${s.length})`;
    expect(pseudonymFor("u1", h)).toBe(pseudonymFor("u1", h));
    expect(pseudonymFor("u1", (s) => s.split("").reverse().join(""))).not.toContain("u1".toUpperCase());
    expect(() => pseudonymFor("", h)).toThrow();
  });
});

describe("exporter coverage", () => {
  const tables = [
    t("users", [f("phone", { piiClass: "P3" })]),
    t("orders", [f("user_id")]),
    t("secret_notes", [f("n", { dsarExport: false })]),
    t("catalog", [f("title", { piiClass: "P0", dsarExport: false, onErasure: "not_personal" })]),
  ];

  it("lists only P2/P3 tables tagged for export", () => {
    expect(exportableTables(tables)).toEqual(["orders", "users"]);
  });

  it("flags missing, unknown, duplicate, unexplained and contradictory entries", () => {
    const ok = checkExporterCoverage(tables, [{ key: "a", tables: ["users"] }], [{ table: "orders", reason: "hash only" }]);
    expect(ok.ok).toBe(true);
    const bad = checkExporterCoverage(
      tables,
      [
        { key: "a", tables: ["users", "ghost"] },
        { key: "b", tables: ["users"] },
      ],
      [
        { table: "orders", reason: " " },
        { table: "users", reason: "why" },
      ],
    );
    expect(bad).toMatchObject({
      missing: [],
      unknown: ["ghost"],
      duplicates: ["users"],
      unexplained: ["orders"],
      contradictory: ["users"],
      ok: false,
    });
    expect(checkExporterCoverage(tables, [], []).missing).toEqual(["orders", "users"]);
  });
});

describe("breach clocks", () => {
  const base = () =>
    recordBreach({ id: "b", detectedAtMs: T0, severity: "critical", summary: "leak", affectedCount: 3 }, T0);

  it("derives triage 4 h, PDPC 72 h and subjects 3 days purely from the clock", () => {
    const c = breachClocks(base(), T0 + H);
    expect(c.triage).toEqual({ dueAtMs: T0 + 4 * H, status: "pending", msRemaining: 3 * H });
    expect(c.pdpc.dueAtMs).toBe(T0 + PDPC_NOTICE_HOURS * H);
    expect(c.subjects.dueAtMs).toBe(T0 + PDPC_NOTICE_HOURS * H + 3 * D);
  });

  it("flips to overdue one millisecond after the deadline, not before", () => {
    const b = base();
    expect(breachClocks(b, T0 + 72 * H).pdpc.status).toBe("pending");
    expect(breachClocks(b, T0 + 72 * H + 1).pdpc.status).toBe("overdue");
    expect(breachHasOverdueClock(b, T0 + 4 * H + 1)).toBe(true);
  });

  it("subject clock never slides later when the PDPC notice is late, and records met_late", () => {
    let b = triageBreach(base(), "notify", T0 + 2 * H);
    b = notifyPdpc(b, T0 + 80 * H);
    const c = breachClocks(b, T0 + 81 * H);
    expect(c.pdpc.status).toBe("met_late");
    expect(c.subjects.dueAtMs).toBe(T0 + 72 * H + 3 * D);
    const early = breachClocks(notifyPdpc(triageBreach(base(), "notify", T0 + 2 * H), T0 + 10 * H), T0 + 11 * H);
    expect(early.subjects.dueAtMs).toBe(T0 + 10 * H + 3 * D);
    expect(c.triage.status).toBe("met");
  });

  it("no notification required switches both notice clocks off", () => {
    const b = triageBreach(base(), "no_notification_required", T0 + H);
    const c = breachClocks(b, T0 + 500 * H);
    expect(c.pdpc.status).toBe("not_required");
    expect(c.subjects.status).toBe("not_required");
    expect(breachHasOverdueClock(b, T0 + 500 * H)).toBe(false);
  });

  it("rejects future detection and empty summaries", () => {
    expect(() => recordBreach({ id: "b", detectedAtMs: T0 + 1, severity: "low", summary: "x", affectedCount: 0 }, T0)).toThrow();
    expect(() => recordBreach({ id: "b", detectedAtMs: T0, severity: "low", summary: " ", affectedCount: 0 }, T0)).toThrow();
  });
});

describe("DSAR queue", () => {
  const del = (id: string, at: number): DeletionRequest => {
    const r = startDeletion(
      { id, userId: `u-${id}`, acknowledgedForfeiture: true },
      { openOrders: 0, openReturns: 0, openDisputes: 0, storeCreditMinor: 0n },
      at,
    );
    if (r.kind !== "ok") throw new Error("x");
    return r.request;
  };

  it("orders overdue first, then by due date, and summarises", () => {
    const now = T0 + (DSAR_SLA_DAYS + 1) * D;
    const old = del("old", T0);
    const mid = newExportRequest({ id: "mid", userId: "u", locale: "en" }, now - 29 * D + H);
    const fresh = del("fresh", now - D);
    const q = buildDsarQueue([fresh, mid, old], now);
    expect(q.items.map((i) => i.id)).toEqual(["old", "mid", "fresh"]);
    expect(q.summary).toMatchObject({ open: 3, overdue: 2, byKind: { export: 1, delete: 2 } });
    expect(q.items[1]?.readyTargetMissed).toBe(true);
  });

  it("hides closed requests unless asked and filters by kind", () => {
    const done = { ...del("done", T0), status: "completed" as const };
    expect(buildDsarQueue([done], T0).items).toEqual([]);
    expect(buildDsarQueue([done], T0, { includeClosed: true }).items).toHaveLength(1);
    expect(buildDsarQueue([del("a", T0)], T0, { kind: "export" }).items).toEqual([]);
  });
});
