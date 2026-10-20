import { sha256Hex } from "@outlet/idempotency";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { InMemoryIntegrityRuns } from "../adapters/in-memory-integrity";
import { cachedGaugeReader } from "../application/integrity-gauge";
import { mapReport } from "../application/integrity-recorder";
import {
  STALE_AFTER_MS,
  canonicalReport,
  computeIntegrityState,
  gaugeValues,
  type IntegrityMode,
  type StoredRun,
} from "../domain/integrity-runs";
import { HEAD, FakeClock, driftRow, failedReport, okReport, recorderFor, uid } from "./integrity-fixtures";

const SYSTEM = { actorId: null, role: "system" } as const;
const H26 = 26 * 3_600_000;

const setup = () => {
  const clock = new FakeClock();
  const runs = new InMemoryIntegrityRuns(clock);
  return { clock, runs };
};
const okJob = { run: async () => okReport() };

describe("mapReport", () => {
  it("maps the report to the row with no recomputation and a stable hash", () => {
    const a = mapReport(okReport(), sha256Hex);
    const b = mapReport(okReport(), sha256Hex);
    expect(a.reportSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(a.reportSha256).toBe(b.reportSha256);
    expect(a).toMatchObject({ ok: true, trialOk: true, chainOk: true, chainLength: 12n, chainHeadHash: HEAD, driftCount: 0, sampleTruncated: false });
  });

  it("maps a failed report and the hash changes with any field", () => {
    const f = mapReport(failedReport(), sha256Hex);
    expect(f).toMatchObject({ ok: false, trialOk: false, chainOk: false, chainLength: 0n, chainHeadHash: null, driftCount: 1 });
    expect(f.chainFailure).toEqual({ seq: 7n, entryId: uid(77), reason: "entry_hash_mismatch" });
    expect(f.trialOffenders).toEqual([{ currency: "EGP", totalMinor: -5n }]);
    expect(f.reportSha256).not.toBe(mapReport(okReport(), sha256Hex).reportSha256);
  });

  it("caps the sample at 50 ordered by absolute difference then user id, and flags truncation", () => {
    const drift = Array.from({ length: 60 }, (_, i) => driftRow(i + 1, i % 2 === 0 ? BigInt(i + 1) : -BigInt(i + 1)));
    const m = mapReport(okReport({ ok: false, storeCredit: { drift, negative: [] } }), sha256Hex);
    expect(m.driftCount).toBe(60);
    expect(m.sample).toHaveLength(50);
    expect(m.sampleTruncated).toBe(true);
    const abs = m.sample.map((s) => (s.differenceMinor < 0n ? -s.differenceMinor : s.differenceMinor));
    expect([...abs].sort((x, y) => (x > y ? -1 : 1))).toEqual(abs);
    expect(abs[0]).toBe(60n);
  });

  it("ties on difference order by user id; hash does not depend on input order", () => {
    const rows = [driftRow(3, 5n), driftRow(1, 5n), driftRow(2, -5n)];
    const a = mapReport(okReport({ ok: false, storeCredit: { drift: rows, negative: [] } }), sha256Hex);
    const b = mapReport(okReport({ ok: false, storeCredit: { drift: [...rows].reverse(), negative: [] } }), sha256Hex);
    expect(a.sample.map((s) => s.userId)).toEqual([uid(1), uid(2), uid(3)]);
    expect(a.reportSha256).toBe(b.reportSha256);
  });

  it("canonical JSON has a fixed key order and bigint strings", () => {
    const { reportSha256: _h, ...rest } = mapReport(failedReport(), sha256Hex);
    const json = canonicalReport(rest);
    expect(json.startsWith('{"chain":')).toBe(true);
    expect(json).toContain('"total_minor":"-5"');
    expect(json).toContain('"seq":"7"');
  });

  it("caps offenders at 8", () => {
    const offenders = Array.from({ length: 12 }, (_, i) => ({ currency: `C${i}`, total: 1n }));
    expect(mapReport(okReport({ ok: false, trialBalance: { ok: false, offenders } }), sha256Hex).trialOffenders).toHaveLength(8);
  });
});

describe("computeIntegrityState", () => {
  const at = (startedAtMs: number, ok = true, auditEvidence: "present" | "missing" = "present") => ({ ok, startedAtMs, auditEvidence });
  const attempt = (outcome: "error" | "completed" = "completed") => ({ attemptId: uid(1), startedAtMs: 0, outcome, errorCode: null });
  const NOW = 1_000_000_000_000;

  it("never_run with nothing, error_only with attempts but no completed run", () => {
    expect(computeIntegrityState({ latest: null, latestAttempt: null, nowMs: NOW, mode: "batch" })).toMatchObject({ state: "never_run", stale: false, staleAfterMs: null });
    expect(computeIntegrityState({ latest: null, latestAttempt: attempt("error"), nowMs: NOW, mode: "batch" }).state).toBe("error_only");
  });

  it("ok then stale exactly at 26 h + 1 ms in batch mode", () => {
    const start = NOW - H26;
    expect(computeIntegrityState({ latest: at(start), latestAttempt: attempt(), nowMs: NOW, mode: "batch" })).toMatchObject({ state: "ok", stale: false, staleAfterMs: NOW });
    const s = computeIntegrityState({ latest: at(start), latestAttempt: attempt(), nowMs: NOW + 1, mode: "batch" });
    expect(s).toMatchObject({ state: "stale", stale: true, cadence: "nightly_0230_cairo" });
  });

  it("event mode goes stale after 90 min, cadence every_30_min", () => {
    const start = NOW - 90 * 60_000;
    expect(computeIntegrityState({ latest: at(start), latestAttempt: attempt(), nowMs: NOW, mode: "event" }).state).toBe("ok");
    expect(computeIntegrityState({ latest: at(start), latestAttempt: attempt(), nowMs: NOW + 1, mode: "event" })).toMatchObject({ state: "stale", cadence: "every_30_min" });
  });

  it("failed beats stale beats ok; missing audit evidence is failed; a later error never hides a failed run", () => {
    expect(computeIntegrityState({ latest: at(NOW - 2 * H26, false), latestAttempt: attempt(), nowMs: NOW, mode: "batch" })).toMatchObject({ state: "failed", stale: true });
    expect(computeIntegrityState({ latest: at(NOW, true, "missing"), latestAttempt: attempt(), nowMs: NOW, mode: "batch" }).state).toBe("failed");
    expect(computeIntegrityState({ latest: at(NOW, false), latestAttempt: attempt("error"), nowMs: NOW, mode: "batch" }).state).toBe("failed");
  });

  it("property: stale is exactly now > startedAt + threshold; failed always wins", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 4 * H26 }),
        fc.boolean(),
        fc.constantFrom<"present" | "missing">("present", "missing"),
        fc.constantFrom<IntegrityMode>("batch", "event"),
        (age, ok, ev, mode) => {
          const r = computeIntegrityState({ latest: at(NOW - age, ok, ev), latestAttempt: attempt(), nowMs: NOW, mode });
          const stale = age > STALE_AFTER_MS[mode];
          expect(r.stale).toBe(stale);
          expect(r.state).toBe(!ok || ev === "missing" ? "failed" : stale ? "stale" : "ok");
        },
      ),
    );
  });
});

describe("RecordIntegrityRun", () => {
  it("writes started then completed with the same attempt id, audit row with run id and hash", async () => {
    const { clock, runs } = setup();
    const { recorder, counters } = recorderFor(runs, clock, okJob);
    const out = await recorder.run("nightly");
    expect(out).toEqual({ ok: 1, drift_count: 0, negative_count: 0 });
    expect(runs.rows.map((r) => r.outcome)).toEqual(["started", "completed"]);
    expect(runs.rows[0]?.attemptId).toBe(runs.rows[1]?.attemptId);
    expect(runs.audit).toHaveLength(1);
    expect(runs.audit[0]).toMatchObject({ runId: runs.rows[1]?.id, chainId: "ledger-integrity:2026-10" });
    expect(counters.runs).toEqual(["completed"]);
    const snap = await runs.snapshot(SYSTEM);
    expect(snap.latest?.auditEvidence).toBe("present");
    expect(snap.latest?.startedAtMs).toBe(runs.rows[0]?.startedAtMs);
  });

  it("H4: an audit insert failure leaves no completed row, gauges keep the previous values, audit_failed counted", async () => {
    const { clock, runs } = setup();
    const first = recorderFor(runs, clock, okJob);
    await first.recorder.run("nightly");
    const prev = await runs.snapshot(SYSTEM);
    clock.advance(3_600_000);
    runs.auditFailure = () => true;
    const { recorder, counters } = recorderFor(runs, clock, okJob);
    await expect(recorder.run("nightly")).rejects.toThrow("could not be recorded");
    expect(runs.rows.filter((r) => r.outcome === "completed")).toHaveLength(1);
    expect(runs.audit).toHaveLength(1);
    expect(counters.auditFailed).toBe(1);
    expect(counters.logs.map((l) => l.event)).toContain("ledger_integrity_record_failed");
    const after = await runs.snapshot(SYSTEM);
    expect(after.latest?.id).toBe(prev.latest?.id);
    // the failed attempt shows as an error attempt with code audit_failed
    expect(after.latestAttempt).toMatchObject({ outcome: "error", errorCode: "audit_failed" });
    const g = gaugeValues(after.latest, after.firstStartedAtMs, clock.nowMs());
    expect(g.ok).toBe(1);
    expect(g.ageSeconds).toBe(3600);
  });

  it("retries the final transaction 3 times with backoff and succeeds when the audit recovers", async () => {
    const { clock, runs } = setup();
    let calls = 0;
    runs.auditFailure = () => ++calls < 3;
    const sleeps: number[] = [];
    const { recorder, counters } = recorderFor(runs, clock, okJob, { sleep: async (ms) => void sleeps.push(ms) });
    await recorder.run("intraday");
    expect(calls).toBe(3);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[1]).toBeGreaterThan(sleeps[0] ?? 0);
    expect(runs.rows.filter((r) => r.outcome === "completed")).toHaveLength(1);
    expect(counters.auditFailed).toBe(0);
  });

  it("failed then error: latest stays the failed run, state failed, error attempt reported", async () => {
    const { clock, runs } = setup();
    await recorderFor(runs, clock, { run: async () => failedReport() }).recorder.run("nightly");
    clock.advance(60_000);
    const boom = recorderFor(runs, clock, { run: async () => Promise.reject(new Error("db down with secret 123")) });
    await expect(boom.recorder.run("nightly")).rejects.toThrow("db down");
    const snap = await runs.snapshot(SYSTEM);
    const st = computeIntegrityState({ latest: snap.latest, latestAttempt: snap.latestAttempt, nowMs: clock.nowMs(), mode: "batch" });
    expect(st.state).toBe("failed");
    expect(snap.latest?.ok).toBe(false);
    expect(snap.latestAttempt).toMatchObject({ outcome: "error", errorCode: "job_error" });
    expect(boom.counters.runs).toEqual(["error"]);
    expect(JSON.stringify(boom.counters.logs)).not.toContain("secret");
  });

  it("only errors so far: error_only, gauges report no ok and age since the first attempt", async () => {
    const { clock, runs } = setup();
    await expect(recorderFor(runs, clock, { run: async () => Promise.reject(new Error("x")) }).recorder.run("nightly")).rejects.toThrow();
    clock.advance(120_000);
    const snap = await runs.snapshot(SYSTEM);
    expect(snap.latest).toBeNull();
    expect(computeIntegrityState({ latest: null, latestAttempt: snap.latestAttempt, nowMs: clock.nowMs(), mode: "batch" }).state).toBe("error_only");
    expect(gaugeValues(null, snap.firstStartedAtMs, clock.nowMs())).toEqual({ ok: null, ageSeconds: 120 });
  });

  it("a started-row failure means the job never runs (fail closed)", async () => {
    const { clock, runs } = setup();
    runs.writeFailure = () => true;
    let ran = false;
    const { recorder } = recorderFor(runs, clock, { run: async () => ((ran = true), okReport()) });
    await expect(recorder.run("nightly")).rejects.toThrow("write failed");
    expect(ran).toBe(false);
  });

  it("a job that exceeds its timeout is recorded as a timeout attempt", async () => {
    const { clock, runs } = setup();
    const { recorder, counters } = recorderFor(runs, clock, { run: () => new Promise(() => undefined) }, { timeoutMs: { nightly: 5, intraday: 5, manual: 5 } });
    await expect(recorder.run("nightly")).rejects.toThrow("timed out");
    expect((await runs.snapshot(SYSTEM)).latestAttempt).toMatchObject({ outcome: "timeout", errorCode: "job_timeout" });
    expect(counters.runs).toEqual(["timeout"]);
  });

  it("logs carry the attempt id only", async () => {
    const { clock, runs } = setup();
    runs.writeFailure = null;
    runs.auditFailure = () => true;
    const { recorder, counters } = recorderFor(runs, clock, { run: async () => failedReport() });
    await expect(recorder.run("nightly")).rejects.toThrow();
    for (const l of counters.logs) expect(Object.keys(l).sort()).toEqual(["attemptId", "event"]);
  });
});

describe("gauges from the table", () => {
  it("the age keeps growing on every collection with no worker, even within the cache window", async () => {
    const { clock, runs } = setup();
    await recorderFor(runs, clock, okJob).recorder.run("nightly");
    const read = cachedGaugeReader(runs, clock, 30_000);
    expect(await read()).toEqual({ ok: 1, ageSeconds: 0 });
    clock.advance(10_000);
    expect(await read()).toEqual({ ok: 1, ageSeconds: 10 });
    clock.advance(3_600_000);
    expect((await read()).ageSeconds).toBe(3610);
  });

  it("a completed row whose audit evidence disappears reports ok 0 and state failed", async () => {
    const { clock, runs } = setup();
    await recorderFor(runs, clock, okJob).recorder.run("nightly");
    runs.audit.length = 0; // superuser removed the audit row
    const read = cachedGaugeReader(runs, clock, 0);
    expect((await read()).ok).toBe(0);
    const snap = await runs.snapshot(SYSTEM);
    expect(snap.latest?.auditEvidence).toBe("missing");
    expect(computeIntegrityState({ latest: snap.latest, latestAttempt: snap.latestAttempt, nowMs: clock.nowMs(), mode: "batch" }).state).toBe("failed");
  });

  it("an empty table reports nothing at all, so the absence rule fires", async () => {
    const { clock, runs } = setup();
    expect(await cachedGaugeReader(runs, clock)()).toEqual({ ok: null, ageSeconds: null });
  });

  it("a read failure propagates so the exporter reports nothing", async () => {
    const { clock } = setup();
    const broken = { snapshot: async () => Promise.reject(new Error("db")), listCompleted: async () => ({ items: [], next: null }) };
    await expect(cachedGaugeReader(broken, clock)()).rejects.toThrow("db");
  });

  it("non-ledger roles read nothing", async () => {
    const { clock, runs } = setup();
    await recorderFor(runs, clock, okJob).recorder.run("nightly");
    const snap = await runs.snapshot({ actorId: uid(5), role: "ops" as never });
    expect(snap.latest).toBeNull();
  });
});

describe("listCompleted keyset", () => {
  it("pages newest first without gaps or repeats", async () => {
    const { clock, runs } = setup();
    for (let i = 0; i < 5; i += 1) {
      await recorderFor(runs, clock, okJob).recorder.run("intraday");
      clock.advance(1_800_000);
    }
    const seen: StoredRun[] = [];
    let before = null as { ts: string; id: string } | null;
    for (let n = 0; n < 5; n += 1) {
      const p = await runs.listCompleted(SYSTEM, { limit: 2, before });
      seen.push(...p.items);
      if (p.next === null) break;
      before = p.next;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen.map((s) => s.id)).size).toBe(5);
    expect(seen.map((s) => s.startedAtMs)).toEqual([...seen.map((s) => s.startedAtMs)].sort((a, b) => b - a));
  });
});
