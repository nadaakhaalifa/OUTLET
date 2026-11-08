import "reflect-metadata";
import multipart from "@fastify/multipart";
import { Module } from "@nestjs/common";
import type { DynamicModule, Type } from "@nestjs/common";
import { APP_GUARD, APP_INTERCEPTOR, NestFactory } from "@nestjs/core";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { CONTROLLERS } from "./controllers.js";
import { READINESS, ReadinessProbe } from "./modules/health/index.js";
import { API_DEPS } from "./platform/deps.js";
import type { ApiDeps } from "./platform/deps.js";
import { AccessTokenGuard, KillSwitchGuard, PolicyGuard, RateLimitGuard } from "./platform/guards.js";
import { registerHooks } from "./platform/hooks.js";
import { IdempotencyInterceptor, SerializeInterceptor, TelemetryInterceptor } from "./platform/interceptors.js";
import { ProblemFilter } from "./platform/problem.filter.js";
import { assertRoutes, assertServedMatchesAudited, collectRoutes, servedRouteKey } from "./platform/route-registry.js";
import type { RouteDef } from "./platform/route-registry.js";

// Nest needs a class to hang the dynamic module on; all configuration is in buildModule.
@Module({})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- NestJS module marker class
export class ApiModule {}

export interface CreateAppOptions {
  /** Test-only controllers (guard and interceptor probes). Production uses CONTROLLERS only. */
  readonly extraControllers?: readonly Type[];
  readonly readiness?: ReadinessProbe;
}

/** Guard order matters (ADR draft H5): authenticate → authorize (+ tenant) → rate limit → kill switch. */
const GUARDS = [AccessTokenGuard, PolicyGuard, RateLimitGuard, KillSwitchGuard];
/** Interceptors run outer → inner: telemetry/timeout/headers → idempotency → response serializer. */
const INTERCEPTORS = [TelemetryInterceptor, IdempotencyInterceptor, SerializeInterceptor];

export const buildModule = (deps: ApiDeps, controllers: readonly Type[], readiness: ReadinessProbe): DynamicModule => ({
  module: ApiModule,
  controllers: [...controllers],
  providers: [
    { provide: API_DEPS, useValue: deps },
    { provide: READINESS, useValue: readiness },
    ...GUARDS.map((g) => ({ provide: APP_GUARD, useClass: g })),
    ...INTERCEPTORS.map((i) => ({ provide: APP_INTERCEPTOR, useClass: i })),
  ],
});

export interface ApiApp {
  readonly app: NestFastifyApplication;
  readonly routes: readonly RouteDef[];
}

/**
 * Builds and initialises the HTTP app (does not listen). Refuses to start when the route audit finds a route without
 * a policy declaration, rate limit, contract, pagination (lists) or reason code (BUILD-PROMPT §2).
 */
export const createApp = async (deps: ApiDeps, opts: CreateAppOptions = {}): Promise<ApiApp> => {
  const controllers = [...CONTROLLERS, ...(opts.extraControllers ?? [])];
  const routes = collectRoutes(controllers);
  assertRoutes(routes);
  const adapter = new FastifyAdapter({
    bodyLimit: deps.http.bodyLimitBytes,
    requestTimeout: deps.http.requestTimeoutMs,
    connectionTimeout: deps.http.requestTimeoutMs,
    trustProxy: deps.http.trustProxy as boolean | string | string[],
    return503OnClosing: true,
    logger: false,
  });
  const readiness = opts.readiness ?? new ReadinessProbe(deps.appClient, deps.lifecycle);
  const app = await NestFactory.create<NestFastifyApplication>(buildModule(deps, controllers, readiness), adapter, {
    logger: false,
    bodyParser: false,
    abortOnError: false,
  });
  const fastify = app.getHttpAdapter().getInstance();
  registerHooks(fastify, deps.logger, () => deps.clock.now().getTime());
  const served: string[] = [];
  fastify.addHook("onRoute", (r) => {
    for (const m of [r.method].flat()) if (m !== "HEAD" && m !== "OPTIONS") served.push(servedRouteKey(m, r.url));
  });
  // Seller photo uploads: one file of at most 10 MB per request (MediaService re-checks the size after sniffing).
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 4, parts: 5, headerPairs: 50 } });
  app.useGlobalFilters(new ProblemFilter(deps.logger));
  await app.init();
  await fastify.ready();
  try {
    assertServedMatchesAudited(served, routes);
  } catch (e) {
    await app.close();
    throw e;
  }
  return { app, routes };
};
