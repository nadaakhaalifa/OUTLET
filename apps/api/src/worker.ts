import { createLogger } from "@outlet/logger";
import { initTelemetry } from "@outlet/observability";
import pg from "pg";
import { errorCode } from "@outlet/outbox";
import { pgPoolOptions, pgSqlClient } from "./platform/db.js";
import { parseWorkerEnv } from "./worker/config.js";
import { workerAppClient } from "./worker/jobs.js";
import { startWorker } from "./worker/main.js";

/** Worker process entry (ADR-0016): `node dist/worker.js`. Composition lives in worker/main.ts (tested); this file only owns pools, telemetry and signals. */
const env = parseWorkerEnv(process.env);
const log = createLogger({ level: env.NODE_ENV === "production" ? "info" : "debug" });
const telemetry = initTelemetry({ serviceName: "outlex-worker", env: env.NODE_ENV, exporter: env.OTEL_EXPORTER });
const workerPool = new pg.Pool(pgPoolOptions(env.DATABASE_URL_WORKER, "worker", env.PG_POOL_MAX));
// Separate, small app pool (max 2, application_name worker.app): its uses are listed in jobs.ts / ADR-0016; kill switches read the worker pool.
const appPool = new pg.Pool(pgPoolOptions(env.DATABASE_URL_APP, "worker.app", 2));
// A rejection nobody awaited means a loop is in an unknown state: log a code (never the message) and exit so the orchestrator restarts us.
process.on("unhandledRejection", (reason) => {
  log.error("worker: unhandled rejection, exiting", { error: errorCode(reason) });
  process.exit(1);
});
const running = await startWorker({ env, worker: pgSqlClient<"outlet_worker">(workerPool), app: workerAppClient(appPool), log });

let stopping = false;
const shutdown = async (signal: string): Promise<void> => {
  if (stopping) return;
  stopping = true;
  log.info("worker draining", { signal });
  const { drained } = await running.stop();
  await Promise.allSettled([workerPool.end(), appPool.end(), telemetry.shutdown()]);
  process.exitCode = drained ? 0 : 1;
  // An abandoned handler keeps the event loop alive; its lease expires and the event is redelivered, so do not wait for it.
  if (!drained) setTimeout(() => process.exit(1), 2_000).unref();
};
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
