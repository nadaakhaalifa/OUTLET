import { randomInt } from "node:crypto";
import { formatLogLine } from "../platform/telemetry/logger";
import { instruments } from "../platform/telemetry/metrics";
import type { CapabilityGate, LogFields, WorkerClock, WorkerLogger, WorkerMetrics, WorkerTimers, JobOutcome } from "./scheduler";

export const systemWorkerClock: WorkerClock = { nowMs: () => Date.now() };

export const systemTimers: WorkerTimers = {
  after(ms, fn) {
    const t = setTimeout(fn, ms);
    return { cancel: () => clearTimeout(t) };
  },
};

export const cryptoRandom = (): number => randomInt(0, 1_000_000) / 1_000_000;

/** JSON lines on stdout. Fields are ids and counters only (see WorkerLogger). */
export const jsonLogger = (write: (line: string) => void = (l) => process.stdout.write(`${l}\n`)): WorkerLogger => ({
  log(level, event, fields: LogFields) {
    write(formatLogLine(level, event, fields));
  },
});

/**
 * The platform has no metrics port yet, so the dead-man gauge is emitted as a structured log line
 * (`worker.metric`) that the log pipeline can alert on: `worker_last_success_at_seconds{job}` and
 * `worker_consecutive_failures{job}`. Swap for a real exporter when the platform grows one.
 */
export const logMetrics = (logger: WorkerLogger): WorkerMetrics => ({
  jobRan(name, outcome, durationMs) {
    logger.log("info", "worker.metric", { metric: "worker_job_runs_total", job: name, outcome, durationMs });
  },
  deadMan(name, s) {
    logger.log("info", "worker.metric", {
      metric: "worker_dead_man",
      job: name,
      last_success_at: s.lastSuccessAtMs,
      consecutive_failures: s.consecutiveFailures,
    });
  },
});

/**
 * Worker metrics into the OTel meter (no-op instruments when telemetry is not configured), while
 * keeping the `worker.metric` log line as the fallback so alerts keep working without a collector.
 */
export const otelMetrics = (logger: WorkerLogger, telemetryEnabled: boolean): WorkerMetrics => {
  const fallback = logMetrics(logger);
  if (!telemetryEnabled) return fallback;
  return {
    jobRan(name, outcome, durationMs) {
      const i = instruments();
      i.counter("outlet.worker.job.runs").add(1, { job: name, outcome });
      i.histogram("outlet.worker.job.duration").record(durationMs / 1000, { job: name, outcome });
      fallback.jobRan(name, outcome, durationMs);
    },
    deadMan(name, s) {
      const i = instruments();
      if (s.lastSuccessAtMs !== null) i.setGauge("outlet.worker.last_success", s.lastSuccessAtMs / 1000, { job: name });
      i.setGauge("outlet.worker.consecutive_failures", s.consecutiveFailures, { job: name });
      fallback.deadMan(name, s);
    },
  };
};

export class RecordingMetrics implements WorkerMetrics {
  readonly runs: { name: string; outcome: JobOutcome }[] = [];
  readonly gauges = new Map<string, { lastSuccessAtMs: number | null; consecutiveFailures: number }>();
  jobRan(name: string, outcome: JobOutcome): void {
    this.runs.push({ name, outcome });
  }
  deadMan(name: string, s: { lastSuccessAtMs: number | null; consecutiveFailures: number }): void {
    this.gauges.set(name, { ...s });
  }
}

/** Kill switches from `WORKER_BLOCKED_CAPABILITIES` (comma separated), until the flag service has a worker-readable adapter. */
export class EnvCapabilityGate implements CapabilityGate {
  private readonly blocked: ReadonlySet<string>;
  constructor(raw: string | undefined) {
    this.blocked = new Set((raw ?? "").split(",").map((s) => s.trim()).filter((s) => s !== ""));
  }
  async isBlocked(capability: string): Promise<boolean> {
    return this.blocked.has(capability);
  }
}

export class StaticCapabilityGate implements CapabilityGate {
  constructor(public blocked: ReadonlySet<string> = new Set()) {}
  async isBlocked(c: string): Promise<boolean> {
    return this.blocked.has(c);
  }
}
