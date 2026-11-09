import { z } from "zod";

const pgUrl = z.url({ protocol: /^postgres(ql)?$/ });
const int = (min: number, max: number, dflt: number) => z.coerce.number().int().min(min).max(max).default(dflt);

/**
 * Worker process environment (ADR-0016), validated at boot. DATABASE_URL_WORKER is the outlet_worker pool (every job context). DATABASE_URL_APP is
 * the outlet_app pool, needed for two reads the worker role has no grant for by design: the kill-switch store (feature_flags) and the voucher confirm,
 * which runs in the shopper's user context (finding 11). Both are required: without them the worker refuses to start (fail closed).
 */
export const WorkerEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL_WORKER: pgUrl,
  DATABASE_URL_APP: pgUrl,
  PG_POOL_MAX: int(2, 50, 5),
  WORKER_HEALTH_HOST: z.string().min(1).default("0.0.0.0"),
  WORKER_HEALTH_PORT: int(1, 65_535, 9_464),
  /** Relay poll interval when busy-idle switches back to work; doubles while idle up to WORKER_POLL_MAX_MS. */
  WORKER_POLL_MS: int(50, 60_000, 500),
  WORKER_POLL_MAX_MS: int(100, 300_000, 10_000),
  WORKER_BATCH_SIZE: int(1, 500, 20),
  WORKER_MAX_ATTEMPTS: int(1, 50, 8),
  WORKER_HANDLER_TIMEOUT_MS: int(1_000, 120_000, 20_000),
  /** SIGTERM drain budget; capped at 30 s (ADR-0016). */
  WORKER_DRAIN_MS: int(0, 30_000, 30_000),
  WORKER_SCHEDULER_MS: int(1_000, 60_000, 5_000),
  WORKER_LAG_MS: int(1_000, 300_000, 15_000),
  OTEL_EXPORTER: z.enum(["otlp", "none"]).default("none"),
});
export type WorkerEnv = z.infer<typeof WorkerEnvSchema>;

/** Parses env; the error lists variable names and issue codes only (never values: connection strings are secrets). */
export const parseWorkerEnv = (env: Readonly<Record<string, string | undefined>>): WorkerEnv => {
  const r = WorkerEnvSchema.safeParse(env);
  if (!r.success) throw new Error(`invalid worker environment: ${r.error.issues.map((i) => `${i.path.join(".")} (${i.code})`).join(", ")}`);
  return r.data;
};

/** Lease must outlive a full batch of handler timeouts, so a slow batch is never claimed twice. */
export const leaseMsFor = (e: Pick<WorkerEnv, "WORKER_BATCH_SIZE" | "WORKER_HANDLER_TIMEOUT_MS">): number => e.WORKER_BATCH_SIZE * e.WORKER_HANDLER_TIMEOUT_MS + 60_000;
