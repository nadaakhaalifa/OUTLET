import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AggregationTemporality, InMemoryMetricExporter, MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { describe, expect, it } from "vitest";
import { INSTRUMENTS, promName, registerIntegrityGauges, registeredPromNames } from "../../../platform/telemetry/metrics";
import { InMemoryIntegrityRuns } from "../adapters/in-memory-integrity";
import { cachedGaugeReader } from "../application/integrity-gauge";
import { FakeClock, okReport, recorderFor } from "./integrity-fixtures";

const RULES = readFileSync(fileURLToPath(new URL("../../../../../../infra/observability/prometheus/rules/ledger-integrity.rules.yaml", import.meta.url)), "utf8");

const collect = async (reader: PeriodicExportingMetricReader, exporter: InMemoryMetricExporter) => {
  exporter.reset();
  await reader.forceFlush();
  const out = new Map<string, { value: number; attrs: Record<string, unknown> }[]>();
  for (const rm of exporter.getMetrics()) {
    for (const sm of rm.scopeMetrics) {
      for (const m of sm.metrics) {
        out.set(m.descriptor.name, m.dataPoints.map((d) => ({ value: d.value as number, attrs: d.attributes })));
      }
    }
  }
  return out;
};

describe("table-backed OTel gauges", () => {
  it("export from the table on every collection; the age grows with no worker; nothing is exported for an empty table", async () => {
    const clock = new FakeClock();
    const runs = new InMemoryIntegrityRuns(clock);
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 });
    const provider = new MeterProvider({ readers: [reader] });
    const read = cachedGaugeReader(runs, clock, 30_000);
    registerIntegrityGauges(async () => ({ ...(await read()), mode: "batch" }), provider.getMeter("test"));

    expect((await collect(reader, exporter)).size).toBe(0);

    await recorderFor(runs, clock, { run: async () => okReport() }).recorder.run("nightly");
    // the empty read is cached for 30 s, so the new row shows after the cache window
    expect((await collect(reader, exporter)).size).toBe(0);
    clock.advance(31_000);
    let m = await collect(reader, exporter);
    expect(m.get("outlet.ledger.integrity.ok")).toEqual([{ value: 1, attrs: { mode: "batch" } }]);
    expect(m.get("outlet.ledger.integrity.last_completed_age_seconds")?.[0]?.value).toBe(31);

    // inside the cache window the age still grows on every collection
    clock.advance(10_000);
    m = await collect(reader, exporter);
    expect(m.get("outlet.ledger.integrity.last_completed_age_seconds")?.[0]?.value).toBe(41);
    clock.advance(7_200_000);
    m = await collect(reader, exporter);
    expect(m.get("outlet.ledger.integrity.last_completed_age_seconds")?.[0]?.value).toBe(7241);

    runs.audit.length = 0; // tampering: the evidence disappears
    clock.advance(31_000);
    m = await collect(reader, exporter);
    expect(m.get("outlet.ledger.integrity.ok")?.[0]?.value).toBe(0);
    await provider.shutdown();
  });

  it("a failing table read exports nothing (absence, never a stale or zero value)", async () => {
    const clock = new FakeClock();
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 });
    const provider = new MeterProvider({ readers: [reader] });
    registerIntegrityGauges(async () => Promise.reject(new Error("db")), provider.getMeter("test"));
    expect((await collect(reader, exporter)).size).toBe(0);
    void clock;
    await provider.shutdown();
  });
});

describe("registry and rule file agree", () => {
  it("every metric the integrity rules read is a registered instrument", () => {
    const names = registeredPromNames();
    const used = [...RULES.matchAll(/\b(outlet_ledger_integrity_[a-z_]+)/g)].map((m) => m[1] ?? "");
    expect(used.length).toBeGreaterThan(4);
    for (const n of new Set(used)) expect(names.has(n), n).toBe(true);
    expect(INSTRUMENTS.filter((i) => i.name.startsWith("outlet.ledger.integrity.")).map(promName).sort()).toEqual([
      "outlet_ledger_integrity_audit_failed_total",
      "outlet_ledger_integrity_last_completed_age_seconds",
      "outlet_ledger_integrity_ok",
      "outlet_ledger_integrity_runs_total",
    ]);
  });

  it("L3: no rule label or annotation carries hash-chain, entry or balance details", () => {
    const body = RULES.split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");
    for (const forbidden of ["head_hash", "seq", "entry_id", "drift", "_minor", "entry_hash", "report_sha256", "user_id"]) {
      expect(body.includes(forbidden), forbidden).toBe(false);
    }
  });

  it("the staleness thresholds match the application constants (26 h and 90 min)", () => {
    expect(RULES).toContain('{mode="batch"} > 93600');
    expect(RULES).toContain('{mode="event"} > 5400');
    expect(RULES).toContain("absent_over_time(outlet_ledger_integrity_ok[30m])");
  });
});
