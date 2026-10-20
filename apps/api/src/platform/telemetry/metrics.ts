import { metrics, type Counter, type Histogram, type Meter } from "@opentelemetry/api";

/**
 * Every instrument the Prometheus rules (infra/observability/prometheus/rules) read. Names are the
 * OTel names; Prometheus names are derived by `promName`. A rename breaks metric-registry.test.ts.
 */
const LATENCY_S = [0.005, 0.01, 0.025, 0.05, 0.1, 0.15, 0.25, 0.3, 0.5, 1, 2.5, 5, 10];

export interface InstrumentSpec {
  readonly name: string;
  readonly kind: "counter" | "histogram" | "gauge";
  readonly unit: string;
  readonly description: string;
}

export const INSTRUMENTS: readonly InstrumentSpec[] = [
  { name: "http.server.request.duration", kind: "histogram", unit: "s", description: "HTTP server request duration" },
  { name: "outlet.checkout.attempts", kind: "counter", unit: "1", description: "Checkout attempts by outcome (placed|failed|declined)" },
  { name: "outlet.reserve.duration", kind: "histogram", unit: "s", description: "Inventory reserve transaction latency" },
  { name: "outlet.search.duration", kind: "histogram", unit: "s", description: "Search latency" },
  { name: "outlet.payment.confirmation.duration", kind: "histogram", unit: "s", description: "Webhook to order PAID latency" },
  { name: "outlet.refund.sla", kind: "counter", unit: "1", description: "Refund initiation SLA outcome (met|missed)" },
  { name: "outlet.reconciliation.unmatched_lines", kind: "gauge", unit: "{line}", description: "Unmatched reconciliation lines by age bucket" },
  { name: "outlet.mobile.sessions", kind: "counter", unit: "1", description: "Mobile sessions by crashed flag (client-reported)" },
  { name: "outlet.outbox.lag", kind: "gauge", unit: "s", description: "Age of the oldest unpublished outbox event" },
  { name: "outlet.worker.job.runs", kind: "counter", unit: "1", description: "Worker job runs by outcome" },
  { name: "outlet.worker.job.duration", kind: "histogram", unit: "s", description: "Worker job duration" },
  { name: "outlet.worker.last_success", kind: "gauge", unit: "s", description: "Unix time of the last successful run per job" },
  { name: "outlet.worker.consecutive_failures", kind: "gauge", unit: "1", description: "Consecutive failures per job" },
  { name: "outlet.provider.calls", kind: "counter", unit: "1", description: "External provider calls by provider and outcome" },
  { name: "outlet.provider.call.duration", kind: "histogram", unit: "s", description: "External provider call latency" },
  { name: "outlet.provider.ready", kind: "gauge", unit: "1", description: "Provider readiness (1 ready, 0 not)" },
  { name: "outlet.db.query.duration", kind: "histogram", unit: "s", description: "DB query duration by application_name" },
  // --- track 3 (ledger integrity result, ADR-0046) ---
  { name: "outlet.ledger.integrity.ok", kind: "gauge", unit: "1", description: "Latest completed ledger integrity run: 1 ok, 0 failed or audit evidence missing. Read from the table on every collection" },
  { name: "outlet.ledger.integrity.last_completed_age_seconds", kind: "gauge", unit: "s", description: "Seconds since the latest completed ledger integrity run started (since the first attempt when none completed)" },
  { name: "outlet.ledger.integrity.runs", kind: "counter", unit: "1", description: "Ledger integrity attempts by outcome (completed|error|timeout)" },
  { name: "outlet.ledger.integrity.audit_failed", kind: "counter", unit: "1", description: "Completed integrity runs rolled back because the audit insert failed" },
  // --- end track 3 ---
  // --- dashboard foundations (admin reads) ---
  { name: "outlet.admin.me.requests", kind: "counter", unit: "1", description: "GET /v1/admin/me requests by outcome" },
  { name: "outlet.admin.metrics.reads", kind: "counter", unit: "1", description: "Allowed admin platform metric series reads by metric" },
  // --- track 6 (analytics rollups, ADR-0045) ---
  { name: "outlet.analytics.rollup_default_partition_rows", kind: "gauge", unit: "{row}", description: "Rows in the DEFAULT partition of a rollup table by table; > 0 means the partition job fell behind (M2)" },
  { name: "outlet.analytics.rollup.reconciliations", kind: "counter", unit: "1", description: "Rollup reconciliation runs by scope, mode (hourly|nightly|backfill) and outcome (ok|corrected|error)" },
  { name: "outlet.analytics.rollup.mismatches", kind: "gauge", unit: "{row}", description: "Mismatching rollup keys found by the latest reconciliation run by scope and mode" },
  // --- end track 6 ---
  // --- creators accrual DLQ (docs/runbooks/creators-accrual-dlq.md) ---
  { name: "outlet.outbox.dead_lettered", kind: "gauge", unit: "{event}", description: "Dead-lettered outbox events (up to the first 500) by event type; > 0 for order_line.closed / order_group.paid means a creator accrual or attribution never completed" },
  // --- end creators accrual DLQ ---
  // --- search index sync (spec section 4: staleness SLO < 60 s) ---
  { name: "outlet.search.sync.events", kind: "counter", unit: "1", description: "Search index sync events by outcome (indexed|removed|ignored|stale_retry|invalid)" },
  { name: "outlet.search.sync.lag", kind: "histogram", unit: "s", description: "Seconds from the catalog event to the search index write (SLO p95 < 60)" },
];

/** OTel instrument name -> Prometheus base metric name (OTLP to Prometheus translation). */
export function promName(spec: InstrumentSpec): string {
  const base = spec.name.replace(/\./g, "_");
  // The OTLP translation does not repeat a unit suffix the name already ends with (track 3 gauge).
  const unitSuffix = spec.unit === "s" && !base.endsWith("_seconds") ? "_seconds" : "";
  const total = spec.kind === "counter" ? "_total" : "";
  return `${base}${unitSuffix}${total}`;
}

/** Metric names a Prometheus rule may use: base plus histogram suffixes. */
export function registeredPromNames(): ReadonlySet<string> {
  const names = new Set<string>();
  for (const s of INSTRUMENTS) {
    const n = promName(s);
    names.add(n);
    if (s.kind === "histogram") for (const suf of ["_bucket", "_count", "_sum"]) names.add(`${n}${suf}`);
  }
  return names;
}

export interface Instruments {
  counter(name: string): Counter;
  histogram(name: string): Histogram;
  /** Last-value gauges are modelled as observable gauges fed from `setGauge`. */
  setGauge(name: string, value: number, attrs?: Record<string, string | number | boolean>): void;
}

function spec(name: string): InstrumentSpec {
  const s = INSTRUMENTS.find((i) => i.name === name);
  if (s === undefined) throw new Error(`unregistered instrument ${name}`);
  return s;
}

/** Builds instruments on the global meter. With no SDK installed they are no-ops. */
export function createInstruments(meter: Meter = metrics.getMeter("outlet-api")): Instruments {
  const counters = new Map<string, Counter>();
  const histograms = new Map<string, Histogram>();
  const gaugeValues = new Map<string, Map<string, { value: number; attrs: Record<string, string | number | boolean> }>>();
  const observed = new Set<string>();
  return {
    counter(name) {
      const s = spec(name);
      let c = counters.get(name);
      if (c === undefined) {
        c = meter.createCounter(name, { unit: s.unit, description: s.description });
        counters.set(name, c);
      }
      return c;
    },
    histogram(name) {
      const s = spec(name);
      let h = histograms.get(name);
      if (h === undefined) {
        h = meter.createHistogram(name, { unit: s.unit, description: s.description, advice: { explicitBucketBoundaries: LATENCY_S } });
        histograms.set(name, h);
      }
      return h;
    },
    setGauge(name, value, attrs = {}) {
      const s = spec(name);
      let series = gaugeValues.get(name);
      if (series === undefined) {
        series = new Map();
        gaugeValues.set(name, series);
      }
      series.set(JSON.stringify(attrs), { value, attrs });
      if (!observed.has(name)) {
        observed.add(name);
        const g = meter.createObservableGauge(name, { unit: s.unit, description: s.description });
        g.addCallback((r) => {
          for (const e of gaugeValues.get(name)?.values() ?? []) r.observe(e.value, e.attrs);
        });
      }
    },
  };
}

let shared: Instruments | undefined;
/** Process-wide instruments, created lazily so they bind to the provider installed at startup. */
export function instruments(): Instruments {
  shared ??= createInstruments();
  return shared;
}
/** Test hook: drop cached instruments so a new MeterProvider is picked up. */
export function resetInstruments(): void {
  shared = undefined;
}

// --- track 3 (ledger integrity result, ADR-0046): table-backed gauges --------------------------------------------
export interface IntegrityGaugeReading {
  /** null: not reported (no completed row), so the absence rule fires. */
  readonly ok: 0 | 1 | null;
  readonly ageSeconds: number | null;
  /** Worker mode label (batch or event) so the staleness rules can pick the right threshold. */
  readonly mode: string;
}

/**
 * Registers the two integrity gauges as observable gauges whose callback READS THE TABLE on every
 * collection (H5): a dead worker or a stuck scheduler cannot freeze or hide the value. `read` is
 * expected to cache the row for a short time itself. A read failure reports nothing (absence, not 0).
 */
export function registerIntegrityGauges(read: () => Promise<IntegrityGaugeReading>, meter: Meter = metrics.getMeter("outlet-api")): void {
  const okSpec = spec("outlet.ledger.integrity.ok");
  const ageSpec = spec("outlet.ledger.integrity.last_completed_age_seconds");
  const ok = meter.createObservableGauge(okSpec.name, { unit: okSpec.unit, description: okSpec.description });
  const age = meter.createObservableGauge(ageSpec.name, { unit: ageSpec.unit, description: ageSpec.description });
  meter.addBatchObservableCallback(
    async (r) => {
      let v: IntegrityGaugeReading;
      try {
        v = await read();
      } catch {
        return;
      }
      if (v.ok !== null) r.observe(ok, v.ok, { mode: v.mode });
      if (v.ageSeconds !== null) r.observe(age, v.ageSeconds, { mode: v.mode });
    },
    [ok, age],
  );
}
