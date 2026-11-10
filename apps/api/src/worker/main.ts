import { contextClient } from "@outlet/db";
import type { RoleSqlClient } from "@outlet/db";
import { FlagService, PostgresFlagStore } from "@outlet/flags";
import type { Logger } from "@outlet/logger";
import { listMarkets } from "@outlet/markets-config";
import { createRetentionMetrics, createWorkerMetrics } from "@outlet/observability";
import type { WorkerMetrics } from "@outlet/observability";
import { errorCode } from "@outlet/outbox";
import { leaseMsFor } from "./config.js";
import type { WorkerEnv } from "./config.js";
import { startHealthServer } from "./health.js";
import type { HealthServer, WorkerHealth } from "./health.js";
import { boundedClient } from "./bounded.js";
import { marketJobs, selectSearchEngine } from "./jobs.js";
import type { KillRead, WorkerAppClient } from "./jobs.js";
import { MarketRunner } from "./runner.js";
import { RollupScheduler } from "./scheduler.js";

export interface WorkerDeps {
  readonly env: WorkerEnv;
  readonly worker: RoleSqlClient<"outlet_worker">;
  /** Separate small outlet_app pool; every use is composed in jobs.ts and listed in ADR-0016. Never used for kill switches. */
  readonly app: WorkerAppClient;
  readonly log: Logger;
  /** Defaults to every configured market (markets-config), ids upper-cased as in cli.ts. */
  readonly markets?: readonly { readonly marketId: string; readonly timezone: string }[];
  /** Defaults to FlagService over feature_flags on the WORKER pool (migration 0037; 5 s cache; money switches fail closed when unreadable). */
  readonly kill?: KillRead;
  readonly metrics?: WorkerMetrics;
  readonly now?: () => Date;
  /** Liveness budget: a loop that has not beaten for this long makes /livez 503. Default 3 x max(poll max, scheduler interval) + 30 s. */
  readonly livenessMs?: number;
}

export interface RunningWorker {
  readonly runners: readonly MarketRunner[];
  readonly scheduler: RollupScheduler;
  readonly healthPort: number;
  health(): WorkerHealth;
  /** SIGTERM path: stop claiming, let in-flight handlers finish within WORKER_DRAIN_MS (max 30 s), stop the scheduler, close the health port. */
  stop(): Promise<{ readonly drained: boolean }>;
}

/** Composition of the worker process (ADR-0016). Pools and telemetry belong to the entry point (worker.ts); everything here runs on the given clients. */
export const startWorker = async (d: WorkerDeps): Promise<RunningWorker> => {
  const now = d.now ?? (() => new Date());
  const metrics = d.metrics ?? createWorkerMetrics();
  const kill: KillRead =
    d.kill ?? new FlagService({ store: new PostgresFlagStore(d.worker), audit: { record: () => Promise.resolve() }, onError: (e) => { d.log.warn("worker: flag store read failed", { error: errorCode(e) }); } });
  const retentionMetrics = createRetentionMetrics();
  const markets = d.markets ?? listMarkets().map((m) => ({ marketId: m.id.toUpperCase(), timezone: m.timezone }));
  const runners = markets.map(
    (m) =>
      new MarketRunner({
        marketId: m.marketId,
        relayDb: contextClient(d.worker, { kind: "worker", marketId: m.marketId, job: "outbox.relay" }),
        // Consumer transactions carry statement_timeout = handler timeout (F3); the relay's own client is not bounded.
        jobs: marketJobs({ marketId: m.marketId, integrityBudgetMs: d.env.WORKER_INTEGRITY_BUDGET_MS, snapshotSigner: snapshotSignerFromEnv(d.env), retention: { dryRun: d.env.WORKER_RETENTION_DRY_RUN, budgetMs: d.env.WORKER_RETENTION_BUDGET_MS, metrics: retentionMetrics, log: d.log }, searchEngine: selectSearchEngine(d.env, d.log), worker: boundedClient(d.worker, d.env.WORKER_HANDLER_TIMEOUT_MS), app: boundedClient(d.app, d.env.WORKER_HANDLER_TIMEOUT_MS), kill, now }),
        kill, metrics, log: d.log, now,
        pollMs: d.env.WORKER_POLL_MS, pollMaxMs: d.env.WORKER_POLL_MAX_MS, batchSize: d.env.WORKER_BATCH_SIZE, maxAttempts: d.env.WORKER_MAX_ATTEMPTS,
        leaseMs: leaseMsFor(d.env), handlerTimeoutMs: d.env.WORKER_HANDLER_TIMEOUT_MS, lagMs: d.env.WORKER_LAG_MS,
      }),
  );
  const scheduler = new RollupScheduler({ markets, worker: d.worker, kill, metrics, log: d.log, now });
  const livenessMs = d.livenessMs ?? 3 * Math.max(d.env.WORKER_POLL_MAX_MS, d.env.WORKER_SCHEDULER_MS) + 30_000;
  const startedAt = now().getTime();
  let draining = false;
  let stopped = false;
  const fresh = (beat: Date | null): boolean => now().getTime() - (beat?.getTime() ?? startedAt) <= livenessMs;
  const health = (): WorkerHealth => ({
    live: !stopped && runners.every((r) => fresh(r.lastBeat())) && fresh(scheduler.lastBeat()),
    draining,
    schedulerLastTickAt: scheduler.lastBeat()?.toISOString() ?? null,
    markets: runners.map((r) => r.status()),
  });
  const server: HealthServer = await startHealthServer({ host: d.env.WORKER_HEALTH_HOST, port: d.env.WORKER_HEALTH_PORT, health });
  for (const r of runners) r.start();
  scheduler.start(d.env.WORKER_SCHEDULER_MS);
  d.log.info("worker started", { markets: markets.map((m) => m.marketId), jobs: runners[0]?.status().consumers.map((c) => c.job) ?? [], health_port: server.port });
  return {
    runners, scheduler, healthPort: server.port, health,
    stop: async () => {
      draining = true;
      const deadline = Math.min(d.env.WORKER_DRAIN_MS, 30_000);
      const [drained] = await Promise.all([Promise.all(runners.map((r) => r.stop(deadline))).then((all) => all.every(Boolean)), scheduler.stop()]);
      stopped = true;
      await server.close();
      d.log.info("worker stopped", { drained });
      return { drained };
    },
  };
};
