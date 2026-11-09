import { createLogger } from "@outlet/logger";
import { initTelemetry } from "@outlet/observability";
import pg from "pg";
import { pgPoolOptions, pgSqlClient } from "./platform/db.js";
import { parseWorkerEnv } from "./worker/config.js";
import { startWorker } from "./worker/main.js";

/** Worker process entry (ADR-0016): `node dist/worker.js`. Composition lives in worker/main.ts (tested); this file only owns pools, telemetry and signals. */
const env = parseWorkerEnv(process.env);
const log = createLogger({ level: env.NODE_ENV === "production" ? "info" : "debug" });
const telemetry = initTelemetry({ serviceName: "outlex-worker", env: env.NODE_ENV, exporter: env.OTEL_EXPORTER });
const workerPool = new pg.Pool(pgPoolOptions(env.DATABASE_URL_WORKER, "worker", env.PG_POOL_MAX));
const appPool = new pg.Pool(pgPoolOptions(env.DATABASE_URL_APP, "worker", env.PG_POOL_MAX));
const running = await startWorker({ env, worker: pgSqlClient<"outlet_worker">(workerPool), app: pgSqlClient<"outlet_app">(appPool), log });

let stopping = false;
const shutdown = async (signal: string): Promise<void> => {
  if (stopping) return;
  stopping = true;
  log.info("worker draining", { signal });
  const { drained } = await running.stop();
  await Promise.allSettled([workerPool.end(), appPool.end(), telemetry.shutdown()]);
  process.exitCode = drained ? 0 : 1;
};
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
