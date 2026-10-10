import { Global, Module, type DynamicModule } from "@nestjs/common";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { IdempotencyService, InMemoryIdempotencyStore } from "@outlet/idempotency";
import { createDefaultRules } from "@outlet/policy";
import type { AppConfig } from "../config/env";
import { InMemoryAuditSink, InMemoryRateLimiter } from "./dev-fixtures";
import { HealthController, ReadinessRegistry } from "./health.controller";
import { IdempotencyInterceptor } from "./idempotency.interceptor";
import type { Clock, IdGenerator } from "./ports";
import { PolicyGuard } from "./policy.guard";
import { ProblemFilter } from "./problem.filter";
import { RateLimitGuard } from "./rate-limit.guard";
import { createIdGenerator, nodeCsprng, systemClock } from "./system-adapters";
import {
  APP_CONFIG,
  AUDIT_SINK,
  CLOCK,
  CSPRNG,
  ID_GENERATOR,
  IDEMPOTENCY_SERVICE,
  POLICY_RULES,
  RATE_LIMITER,
} from "./tokens";

export class NoProductionAdaptersError extends Error {
  constructor() {
    super("No production adapters exist yet: set DEV_FIXTURES outside production or implement them.");
    this.name = "NoProductionAdaptersError";
  }
}

/** Overrides for tests: a controllable clock and deterministic ids. */
export interface PlatformOverrides {
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
}

/**
 * Cross-cutting infrastructure: clock, randomness, ids, idempotency, rate limiting, policy rules,
 * audit, problem filter, global guards and interceptor. Guard order is registration order:
 * rate limit first (counts unauthenticated floods), then policy.
 */
@Global()
@Module({})
export class PlatformModule {
  static forRoot(config: AppConfig, overrides: PlatformOverrides = {}): DynamicModule {
    if (config.adapters !== "in-memory-dev") throw new NoProductionAdaptersError();
    const clock = overrides.clock ?? systemClock;
    const ids = overrides.ids ?? createIdGenerator(clock, nodeCsprng);
    return {
      module: PlatformModule,
      controllers: [HealthController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: CLOCK, useValue: clock },
        { provide: CSPRNG, useValue: nodeCsprng },
        { provide: ID_GENERATOR, useValue: ids },
        {
          provide: IDEMPOTENCY_SERVICE,
          useValue: new IdempotencyService({
            // DEVELOPMENT FIXTURE store: per process, lost on restart.
            store: new InMemoryIdempotencyStore(),
            clock,
            newClaimToken: () => ids.hex(16),
          }),
        },
        { provide: RATE_LIMITER, useValue: new InMemoryRateLimiter() },
        { provide: AUDIT_SINK, useValue: new InMemoryAuditSink() },
        {
          provide: POLICY_RULES,
          // VERIFY BEFORE LAUNCH: owner to set both dual-approval thresholds (policy README).
          // The values below are test placeholders for the admin routes, which this API does not expose yet.
          useValue: createDefaultRules({
            refundDualApprovalAtOrAboveMinor: 0n,
            payoutDualApprovalAtOrAboveMinor: 0n,
          }),
        },
        ReadinessRegistry,
        PolicyGuard,
        RateLimitGuard,
        IdempotencyInterceptor,
        { provide: APP_FILTER, useClass: ProblemFilter },
        { provide: APP_GUARD, useClass: RateLimitGuard },
        { provide: APP_GUARD, useClass: PolicyGuard },
        { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
      ],
      exports: [
        APP_CONFIG,
        CLOCK,
        CSPRNG,
        ID_GENERATOR,
        IDEMPOTENCY_SERVICE,
        RATE_LIMITER,
        AUDIT_SINK,
        POLICY_RULES,
        ReadinessRegistry,
      ],
    };
  }
}
