import { describe, expect, it } from "vitest";
import { cairoParts, nextCairoOccurrence } from "./cairo";
import { RecordingMetrics, StaticCapabilityGate } from "./defaults";
import { InMemoryLeaderLock, advisoryKey } from "./leader-lock";
import { Scheduler, type Job, type LogFields, type SchedulerDeps, type WorkerClock, type WorkerLogger, type WorkerTimers } from "./scheduler";

class FakeTime implements WorkerClock, WorkerTimers {
  private timers: { at: number; fn: () => void; live: boolean }[] = [];
  constructor(private ms = Date.UTC(2026, 9, 11, 0, 0, 0)) {}
  nowMs(): number {
    return this.ms;
  }
  after(ms: number, fn: () => void): { cancel(): void } {
    const t = { at: this.ms + ms, fn, live: true };
    this.timers.push(t);
    return { cancel: () => (t.live = false) };
  }
  async flush(): Promise<void> {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  }
  async advance(ms: number): Promise<void> {
    const end = this.ms + ms;
    for (;;) {
      const next = this.timers.filter((t) => t.live && t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (next === undefined) break;
      this.ms = Math.max(this.ms, next.at);
      next.live = false;
      next.fn();
      await this.flush();
    }
    this.ms = end;
    await this.flush();
  }
}

class MemLogger implements WorkerLogger {
  readonly lines: { level: string; event: string; fields: LogFields }[] = [];
  log(level: "info" | "warn" | "error", event: string, fields: LogFields): void {
    this.lines.push({ level, event, fields });
  }
}

function build(time: FakeTime, lockFactory: () => InMemoryLeaderLock, gate = new StaticCapabilityGate(), extra: Partial<SchedulerDeps> = {}) {
  const metrics = new RecordingMetrics();
  const logger = new MemLogger();
  const scheduler = new Scheduler({ clock: time, timers: time, lock: lockFactory(), metrics, logger, gate, random: () => 0, ...extra });
  return { scheduler, metrics, logger };
}

const job = (over: Partial<Job> & Pick<Job, "run">): Job => ({
  name: "j",
  cadence: { kind: "interval", everyMs: 1_000 },
  lockKey: "k",
  timeoutMs: 500,
  criticality: "routine",
  ...over,
});

describe("scheduler", () => {
  it("runs on its interval and not before", async () => {
    const time = new FakeTime();
    const { scheduler } = build(time, InMemoryLeaderLock.shared(() => time.nowMs()));
    let runs = 0;
    scheduler.register(job({ run: async () => void runs++ }));
    await scheduler.tick();
    expect(runs).toBe(0);
    await time.advance(1_000);
    await scheduler.tick();
    expect(runs).toBe(1);
    await scheduler.tick();
    expect(runs).toBe(1);
    await time.advance(1_000);
    await scheduler.tick();
    expect(runs).toBe(2);
    expect(scheduler.status()[0]?.lastSuccessAtMs).toBe(time.nowMs());
  });

  it("applies jitter within the configured bound", () => {
    const time = new FakeTime();
    const { scheduler } = build(time, InMemoryLeaderLock.shared(() => time.nowMs()), undefined, { random: () => 0.5, jitterFraction: 0.1 });
    scheduler.register(job({ run: async () => undefined }));
    expect(scheduler.status()[0]?.nextRunAtMs).toBe(time.nowMs() + 1_000 + 50);
  });

  it("never lets two schedulers run the same job at once, and the other takes over after release", async () => {
    const time = new FakeTime();
    const lockOf = InMemoryLeaderLock.shared(() => time.nowMs());
    const a = build(time, lockOf);
    const b = build(time, lockOf);
    let concurrent = 0;
    let maxConcurrent = 0;
    let total = 0;
    const slow = job({
      timeoutMs: 400,
      run: async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise<void>((r) => time.after(100, r));
        concurrent--;
        total++;
      },
    });
    a.scheduler.register(slow);
    b.scheduler.register(slow);
    await time.advance(1_000);
    const both = Promise.all([a.scheduler.tick(), b.scheduler.tick()]);
    await time.flush();
    await time.advance(100);
    await both;
    expect(maxConcurrent).toBe(1);
    expect(total).toBe(1);
    const outcomes = [...a.metrics.runs, ...b.metrics.runs].map((r) => r.outcome).sort();
    expect(outcomes).toEqual(["skipped_not_leader", "success"]);
  });

  it("times a job out, aborts its signal, records failure and releases the lock", async () => {
    const time = new FakeTime();
    const lockOf = InMemoryLeaderLock.shared(() => time.nowMs());
    const { scheduler, metrics } = build(time, lockOf);
    let aborted = false;
    scheduler.register(
      job({
        run: (ctx) =>
          new Promise<never>(() => {
            ctx.signal.addEventListener("abort", () => (aborted = true));
          }),
      }),
    );
    await time.advance(1_000);
    const t = scheduler.tick();
    await time.flush();
    await time.advance(500);
    await t;
    expect(aborted).toBe(true);
    expect(metrics.runs.at(-1)?.outcome).toBe("timeout");
    expect(metrics.gauges.get("j")?.consecutiveFailures).toBe(1);
    expect(await lockOf().tryAcquire("k", 1_000)).not.toBeNull();
  });

  it("backs off exponentially on failure, resets on success, tracks the dead-man gauge", async () => {
    const time = new FakeTime();
    const { scheduler, metrics, logger } = build(time, InMemoryLeaderLock.shared(() => time.nowMs()), undefined, { backoff: { baseMs: 1_000, capMs: 4_000 } });
    let fail = true;
    scheduler.register(job({ cadence: { kind: "interval", everyMs: 100 }, run: async () => { if (fail) throw new Error("user 0100 failed"); } }));
    const delays: number[] = [];
    for (let i = 0; i < 4; i++) {
      await time.advance(i === 0 ? 100 : delays[i - 1] ?? 0);
      await scheduler.tick();
      delays.push((scheduler.status()[0]?.nextRunAtMs ?? 0) - time.nowMs());
    }
    expect(delays).toEqual([1_000, 2_000, 4_000, 4_000]);
    expect(metrics.gauges.get("j")).toEqual({ lastSuccessAtMs: null, consecutiveFailures: 4 });
    fail = false;
    await time.advance(4_000);
    await scheduler.tick();
    expect(metrics.gauges.get("j")).toEqual({ lastSuccessAtMs: time.nowMs(), consecutiveFailures: 0 });
    // Logs carry the error class only, never the message.
    expect(JSON.stringify(logger.lines)).not.toContain("0100");
  });

  it("skips a blocked capability and records skipped_blocked without running", async () => {
    const time = new FakeTime();
    const gate = new StaticCapabilityGate(new Set(["drops"]));
    const { scheduler, metrics } = build(time, InMemoryLeaderLock.shared(() => time.nowMs()), gate);
    let runs = 0;
    scheduler.register(job({ capability: "drops", run: async () => void runs++ }));
    await time.advance(1_000);
    await scheduler.tick();
    expect(runs).toBe(0);
    expect(metrics.runs.at(-1)?.outcome).toBe("skipped_blocked");
    gate.blocked = new Set();
    await time.advance(1_000);
    await scheduler.tick();
    expect(runs).toBe(1);
  });

  it("skips disabled jobs", async () => {
    const time = new FakeTime();
    const { scheduler, metrics } = build(time, InMemoryLeaderLock.shared(() => time.nowMs()));
    scheduler.register(job({ enabled: () => false, run: async () => { throw new Error("must not run"); } }));
    await time.advance(1_000);
    await scheduler.tick();
    expect(metrics.runs.at(-1)?.outcome).toBe("skipped_disabled");
  });

  it("shuts down gracefully: stops the loop, waits for in-flight work, starts nothing new", async () => {
    const time = new FakeTime();
    const { scheduler } = build(time, InMemoryLeaderLock.shared(() => time.nowMs()));
    let finished = false;
    let runs = 0;
    scheduler.register(
      job({
        timeoutMs: 10_000,
        run: async () => {
          runs++;
          await new Promise<void>((r) => time.after(300, r));
          finished = true;
        },
      }),
    );
    scheduler.start(100);
    await time.advance(1_100);
    expect(runs).toBe(1);
    const down = scheduler.shutdown(5_000);
    await time.advance(300);
    await down;
    expect(finished).toBe(true);
    await time.advance(5_000);
    expect(runs).toBe(1);
  });

  it("does not overlap a job with itself inside one process", async () => {
    const time = new FakeTime();
    const { scheduler } = build(time, InMemoryLeaderLock.shared(() => time.nowMs()));
    let concurrent = 0;
    let max = 0;
    scheduler.register(job({ timeoutMs: 5_000, run: async () => { concurrent++; max = Math.max(max, concurrent); await new Promise<void>((r) => time.after(2_500, r)); concurrent--; } }));
    scheduler.start(100);
    await time.advance(8_000);
    const down = scheduler.shutdown(5_000);
    await time.advance(3_000);
    await down;
    expect(max).toBe(1);
  });
});

describe("Cairo cadence", () => {
  it("fires at 03:00 Cairo local time in winter (UTC+2) and summer (UTC+3)", () => {
    const winter = nextCairoOccurrence(Date.UTC(2026, 0, 10, 12, 0), { hour: 3, minute: 0 });
    expect(new Date(winter).toISOString()).toBe("2026-01-11T01:00:00.000Z");
    const summer = nextCairoOccurrence(Date.UTC(2026, 6, 10, 12, 0), { hour: 3, minute: 0 });
    expect(new Date(summer).toISOString()).toBe("2026-07-11T00:00:00.000Z");
    expect(cairoParts(summer).hour).toBe(3);
  });

  it("honours weekday and is strictly after the reference instant", () => {
    const sun = nextCairoOccurrence(Date.UTC(2026, 9, 11, 12, 0), { hour: 4, minute: 0, weekday: 0 });
    expect(cairoParts(sun).weekday).toBe(0);
    expect(sun).toBeGreaterThan(Date.UTC(2026, 9, 11, 12, 0));
    const exact = Date.UTC(2026, 0, 11, 1, 0);
    expect(nextCairoOccurrence(exact, { hour: 3, minute: 0 })).toBe(exact + 24 * 3_600_000);
  });

  it("schedules a Cairo job through the scheduler", async () => {
    const time = new FakeTime(Date.UTC(2026, 0, 10, 22, 0));
    const { scheduler } = build(time, InMemoryLeaderLock.shared(() => time.nowMs()));
    scheduler.register(job({ cadence: { kind: "cairo", hour: 3, minute: 0 }, run: async () => undefined }));
    expect(new Date(scheduler.status()[0]?.nextRunAtMs ?? 0).toISOString()).toBe("2026-01-11T01:00:00.000Z");
  });
});

describe("advisoryKey", () => {
  it("is stable and distinct per key", () => {
    expect(advisoryKey("job:a")).toBe(advisoryKey("job:a"));
    expect(advisoryKey("job:a")).not.toBe(advisoryKey("job:b"));
  });
});
