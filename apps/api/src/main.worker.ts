import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { ConfigError, loadConfig } from "./config/env";
import { startTelemetry, traceJob } from "./platform/telemetry";
import { MODULE_BINDINGS } from "./production/bindings";
import { PRODUCTION_RUNTIME, type ProductionRuntime } from "./production/compose";
import { BRAND_EVENT_CONSUMER, type BrandEventConsumerPort } from "./modules/admin";
import { AUTO_BUY_EVENT_CONSUMER } from "./modules/auto-buy";
import { CreatorTokens } from "./modules/creators";
import { ORDER_DELIVERY_CONSUMER } from "./modules/orders";
import { SEARCH_SYNC_EVENT_CONSUMER } from "./modules/search";
import { createProductionRelay } from "./production/relay";
import {
  EnvCapabilityGate,
  InMemoryLeaderLock,
  PgAdvisoryLeaderLock,
  Scheduler,
  JOB_SPECS,
  buildJobs,
  cryptoRandom,
  jsonLogger,
  otelMetrics,
  systemTimers,
  systemWorkerClock,
  type LeaderLock,
  type PgPoolLike,
} from "./workers";

/**
 * Worker entrypoint: boots the Nest container without an HTTP listener and runs the scheduler.
 * Run two or more replicas safely: every job takes a leader lock first.
 */
async function bootstrap(): Promise<void> {
  const telemetry = startTelemetry(process.env, "outlet-worker");
  const config = loadConfig(process.env);
  const app = await NestFactory.createApplicationContext(AppModule.register(config), { bufferLogs: false });
  app.enableShutdownHooks();
  const logger = jsonLogger();

  let lock: LeaderLock;
  let closePool: () => Promise<void> = async () => undefined;
  if (config.databaseUrl !== undefined) {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: config.databaseUrl, max: 4, application_name: "outlet-worker-locks" });
    closePool = () => pool.end();
    lock = new PgAdvisoryLeaderLock(pool as unknown as PgPoolLike);
  } else {
    // Single process development only: with no database there is nothing shared to lock on.
    logger.log("warn", "worker.in_memory_lock", { reason: "DATABASE_URL unset" });
    lock = InMemoryLeaderLock.shared(() => Date.now())();
  }

  const scheduler = new Scheduler({
    clock: systemWorkerClock,
    timers: systemTimers,
    lock,
    metrics: otelMetrics(logger, telemetry.enabled),
    logger,
    // Production default: drops stay blocked (kill.drops is blocked by the flag registry) unless the operator overrides.
    gate: new EnvCapabilityGate(process.env["WORKER_BLOCKED_CAPABILITIES"] ?? (config.adapters === "production" ? "drops" : undefined)),
    random: cryptoRandom,
  });
  // Relay jobs need the Postgres transaction store, which only the production composition has. One
  // relay drains the outbox: `payment.*` events go to the checkout saga bridge through the inbox;
  // other event types are acknowledged and counted (ADR-0029). Without it, events never drain.
  const blockedJobs = new Set(
    config.adapters === "production"
      ? JOB_SPECS.filter((s) => MODULE_BINDINGS[s.ownerModule]?.status === "blocked").map((s) => s.name)
      : [],
  );
  let outboxRelay: { runOnce(): Promise<object> } | undefined;
  if (config.adapters === "production") {
    const runtime = app.get<ProductionRuntime>(PRODUCTION_RUNTIME, { strict: false });
    const brandEvents = app.get<BrandEventConsumerPort | null>(BRAND_EVENT_CONSUMER, { strict: false });
    const autoBuyEvents = app.get<{ handle(e: { messageId: string; type: string; payload: unknown }): Promise<unknown> } | null>(AUTO_BUY_EVENT_CONSUMER, { strict: false });
    // The creators module is `blocked` in production (bindings.ts): its consumer is not in the graph
    // until it is composed, and a missing provider means "acknowledge unrouted", not a boot failure.
    type EventHandler = { handle(e: { messageId: string; type: string; payload: unknown; occurredAtMs?: number }): Promise<unknown> };
    const optional = (token: symbol): EventHandler | null => {
      try {
        return app.get<EventHandler>(token, { strict: false });
      } catch {
        return null;
      }
    };
    const creatorEvents = optional(CreatorTokens.CREATOR_EVENT_CONSUMER);
    const orderEvents = optional(ORDER_DELIVERY_CONSUMER);
    const searchEvents = optional(SEARCH_SYNC_EVENT_CONSUMER);
    const relay = createProductionRelay(runtime, { brandEvents, autoBuyEvents, creatorEvents, orderEvents, searchEvents });
    outboxRelay = { runOnce: () => traceJob("outbox.relay", () => relay.runOnce()) };
  } else {
    logger.log("warn", "worker.no_outbox_relay", { reason: "DEV_FIXTURES: no Postgres outbox" });
  }
  for (const job of buildJobs({
    ...(outboxRelay === undefined ? {} : { extras: { outboxRelay } }),
    resolve: (token) => app.get(token, { strict: false }),
    eventMode: () => process.env["WORKER_EVENT_MODE"] === "true",
    nowMs: () => Date.now(),
  })) {
    // Jobs owned by a module that is not composed in production have no provider to resolve.
    if (blockedJobs.has(job.name)) {
      logger.log("warn", "worker.job_skipped", { job: job.name, reason: "owner module not composed" });
      continue;
    }
    scheduler.register(job);
  }
  scheduler.start();
  logger.log("info", "worker.started", { jobs: scheduler.status().length });

  let closing = false;
  const stop = (): void => {
    if (closing) return;
    closing = true;
    void scheduler
      .shutdown(25_000)
      .then(closePool)
      .then(() => telemetry.shutdown())
      .then(() => app.close())
      .then(() => process.exit(0));
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

bootstrap().catch((err: unknown) => {
  process.stderr.write(`${err instanceof ConfigError ? err.message : err instanceof Error ? `${err.name}: ${err.message}` : "worker startup failed"}\n`);
  process.exit(1);
});
