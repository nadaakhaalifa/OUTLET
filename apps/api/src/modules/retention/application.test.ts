import { describe, expect, it } from "vitest";
import { InMemoryBlobDelete, InMemoryPurgeExecutor, InMemoryRunStore, RecordingMetrics } from "./adapters/in-memory";
import { PurgeRetentionJob, RunRetention, UnknownRetentionRuleError, periodFor } from "./application/purge";
import { retentionCutoffMs } from "./domain/bridge";
import { TARGETS } from "./domain/catalog";
import type { PurgeTarget } from "./domain/ports";

const NOW = Date.UTC(2026, 9, 11, 1, 0, 0);
const target = (id: string): PurgeTarget => {
  const t = TARGETS.find((x) => x.id === id);
  if (t === undefined) throw new Error(id);
  return t;
};

function setup() {
  const blobs = new InMemoryBlobDelete();
  const executor = new InMemoryPurgeExecutor(blobs);
  const runs = new InMemoryRunStore();
  const metrics = new RecordingMetrics();
  let n = 0;
  const runner = new RunRetention({ executor, runs, metrics, clock: { nowMs: () => NOW }, ids: { uuidV7: () => `00000000-0000-7000-8000-${String(++n).padStart(12, "0")}` } });
  return { executor, runs, metrics, runner, blobs };
}
const rows = (n: number, atMs: number, p = "r") => Array.from({ length: n }, (_, i) => ({ id: `${p}${atMs}-${i}`, atMs }));

describe("RunRetention", () => {
  it("keeps a row exactly at the retention limit and purges one tick older", async () => {
    const { executor, runner } = setup();
    const t = target("auth.sessions");
    const cutoff = retentionCutoffMs(NOW, periodFor(t));
    executor.seed(t.id, [{ id: "edge", atMs: cutoff }, { id: "old", atMs: cutoff - 1 }]);
    const r = await runner.runTarget(t);
    expect(r.purged).toBe(1);
    expect(executor.remaining(t.id).map((x) => x.id)).toEqual(["edge"]);
  });

  it("skips rows under legal hold or failing the state guard (open dispute, ACTIVE reservation)", async () => {
    const { executor, runner } = setup();
    const t = target("return_evidence.closed");
    const old = retentionCutoffMs(NOW, periodFor(t)) - 1;
    executor.seed(t.id, [
      { id: "held", atMs: old, held: true, blobRef: "u1" },
      { id: "dispute", atMs: old, guarded: true, blobRef: "u2" },
      { id: "free", atMs: old, blobRef: "u3" },
    ]);
    const r = await runner.runTarget(t);
    expect(r).toMatchObject({ purged: 1, eligible: 1, held: 1 });
    expect(executor.remaining(t.id).map((x) => x.id).sort()).toEqual(["dispute", "held"]);
    expect(executor.deleted).toEqual(["free"]);
  });

  it("deletes the blob before the row", async () => {
    const { executor, runner, blobs } = setup();
    const t = target("return_evidence.closed");
    executor.seed(t.id, [{ id: "a", atMs: 0, blobRef: "upload-1" }]);
    await runner.runTarget(t);
    expect(blobs.deleted).toEqual(["upload-1"]);
  });

  it("is idempotent: a rerun purges nothing more", async () => {
    const { executor, runner } = setup();
    const t = target("carts.idle");
    executor.seed(t.id, rows(5, 0));
    expect((await runner.runTarget(t)).purged).toBe(5);
    const again = await runner.runTarget(t);
    expect(again).toMatchObject({ purged: 0, eligible: 0, status: "COMPLETED" });
  });

  it("batch loop terminates, uses the batch size and reports PARTIAL when capped", async () => {
    const { executor, runner } = setup();
    const t = target("inbox.processed");
    executor.seed(t.id, rows(25, 0));
    const full = await runner.runTarget(t, { batchSize: 10 });
    expect(full).toMatchObject({ purged: 25, batches: 3, status: "COMPLETED" });
    expect(executor.batchCalls).toEqual([10, 10, 5]);

    executor.seed(t.id, rows(25, 1, "s"));
    const capped = await runner.runTarget(t, { batchSize: 10, maxBatches: 2 });
    expect(capped).toMatchObject({ purged: 20, batches: 2, status: "PARTIAL" });
  });

  it("an exact multiple of the batch size needs one empty batch to finish", async () => {
    const { executor, runner } = setup();
    const t = target("inbox.processed");
    executor.seed(t.id, rows(20, 0));
    const r = await runner.runTarget(t, { batchSize: 10 });
    expect(r).toMatchObject({ purged: 20, batches: 3 });
  });

  it("dry run counts, reports lag, mutates nothing and emits no purge counter", async () => {
    const { executor, runner, metrics, runs } = setup();
    const t = target("notification_log.sent");
    const c = retentionCutoffMs(NOW, periodFor(t));
    executor.seed(t.id, [{ id: "a", atMs: c - 5_000 }, { id: "b", atMs: c - 1_000 }]);
    const r = await runner.runTarget(t, { dryRun: true });
    expect(r).toMatchObject({ purged: 0, eligible: 2, batches: 0, lagSeconds: Math.floor((NOW - (c - 5_000)) / 1000) });
    expect(executor.remaining(t.id)).toHaveLength(2);
    expect(metrics.counters).toEqual([]);
    expect((await runs.list())[0]).toMatchObject({ dryRun: true, status: "COMPLETED", rowsPurged: 0 });
  });

  it("emits the inventory metric name per rule and writes a purge ledger entry", async () => {
    const { executor, runner, metrics, runs } = setup();
    const t = target("devices.stale");
    executor.seed(t.id, rows(3, 0));
    await runner.runRule("device_records");
    expect(metrics.counters).toEqual([{ name: "privacy_devices_purged_total", value: 3, labels: { rule: "device_records", target: "devices.stale", mode: "live" } }]);
    expect(metrics.gauges.map((g) => g.name)).toContain("retention_oldest_eligible_lag_seconds");
    const [run] = await runs.list("device_records");
    expect(run).toMatchObject({ targetId: "devices.stale", status: "COMPLETED", rowsPurged: 3, batches: 1, dryRun: false });
    expect(run?.finishedMs).not.toBeNull();
  });

  it("records a failed target, keeps going and the job throws so the scheduler sees it", async () => {
    const { executor, runner, runs } = setup();
    executor.seed("auth.sessions", rows(1, 0));
    executor.seed("auth.session_families", rows(1, 0, "f"));
    executor.failOn = "auth.sessions";
    const job = new PurgeRetentionJob(runner);
    await expect(job.run("auth_credentials")).rejects.toThrow(/1 target/);
    const all = await runs.list("auth_credentials");
    expect(all.map((r) => [r.targetId, r.status, r.errorCode])).toEqual([
      ["auth.sessions", "FAILED", "Error"],
      ["auth.session_families", "COMPLETED", null],
    ]);
    expect(executor.remaining("auth.session_families")).toHaveLength(0);
  });

  it("never purges inside the tax period, and refuses a financial rule shorter than the floor", async () => {
    const { executor, runner } = setup();
    const fin: PurgeTarget = { id: "test.tax", ruleId: "orders_tax_records", table: "order_groups", action: "delete", pk: "id", age: "t.closed_at" };
    const sixYears = retentionCutoffMs(NOW, { value: 6, unit: "years" });
    const eightYears = retentionCutoffMs(NOW, { value: 8, unit: "years" });
    executor.seed(fin.id, [{ id: "six", atMs: sixYears }, { id: "eight", atMs: eightYears }]);
    const r = await runner.runTarget(fin);
    expect(r.purged).toBe(1);
    expect(executor.remaining(fin.id).map((x) => x.id)).toEqual(["six"]);

    const bad: PurgeTarget = { ...fin, id: "test.tax2", ruleId: "delivery_records" };
    await expect(runner.runTarget(bad)).rejects.toThrow(/legal floor|no retention period|shorter/);
  });

  it("event-driven rules use the target grace", async () => {
    const { executor, runner } = setup();
    const t = target("size_profiles.deleted");
    const c = retentionCutoffMs(NOW, { value: 30, unit: "days" });
    executor.seed(t.id, [{ id: "edge", atMs: c }, { id: "old", atMs: c - 1 }]);
    expect((await runner.runTarget(t)).purged).toBe(1);
  });

  it("rejects a rule with no targets", async () => {
    const { runner } = setup();
    await expect(runner.runRule("audit_log")).rejects.toBeInstanceOf(UnknownRetentionRuleError);
  });
});
