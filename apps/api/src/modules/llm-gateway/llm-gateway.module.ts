import { Global, Module, type DynamicModule } from "@nestjs/common";
import type { AppConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import type { Clock, IdGenerator } from "../../platform/ports";
import { CLOCK, ID_GENERATOR } from "../../platform/tokens";
import { LlmGateway } from "./application/gateway";
import {
  FakeLlmProvider,
  InMemoryAuditStore,
  InMemoryGatewayCache,
  InMemoryTokenUsage,
  StaticFlags,
} from "./adapters/in-memory";
import { GatewaySearchRefiner } from "./adapters/search-refiner";
import * as T from "./adapters/tokens";
import { defaultRegistry, type PromptRegistry } from "./domain/prompts";
import {
  DEFAULT_GATEWAY_CONFIG,
  type AuditStore,
  type FlagPort,
  type GatewayCachePort,
  type GatewayConfig,
  type LlmProviderPort,
  type TokenUsageStore,
} from "./domain/types";

export interface LlmGatewayModuleOptions {
  readonly config?: GatewayConfig;
  readonly registry?: PromptRegistry;
  readonly provider?: LlmProviderPort;
  readonly audit?: AuditStore;
  readonly usage?: TokenUsageStore;
  readonly cache?: GatewayCachePort;
  readonly flags?: FlagPort;
  /** Budget bucket for the search parse port, which carries no user id (see Build notes). */
  readonly searchBucketUserId?: string;
}

export class MissingLlmGatewayPortsError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`LlmGatewayModule requires real ${missing.join(", ")} outside test mode`);
    this.name = "MissingLlmGatewayPortsError";
  }
}

/** Reserved budget bucket for anonymous or system callers. */
export const SEARCH_BUCKET_USER_ID = "00000000-0000-4000-8000-0000000005ea";

@Global()
@Module({})
export class LlmGatewayModule {
  static forRoot(config: AppConfig, o: LlmGatewayModuleOptions = {}): DynamicModule {
    const production = config.adapters !== "in-memory-dev";
    if (production && (o.audit === undefined || o.usage === undefined)) throw new NoProductionAdaptersError();
    if (production || config.env !== "test") {
      const missing: string[] = [];
      if (o.provider === undefined) missing.push("provider (LlmProviderPort)");
      if (o.flags === undefined) missing.push("flags (FlagPort)");
      if (o.cache === undefined) missing.push("cache (GatewayCachePort)");
      if (missing.length > 0) throw new MissingLlmGatewayPortsError(missing);
    }
    const cfg = o.config ?? DEFAULT_GATEWAY_CONFIG;
    const RUNTIME = Symbol("llmGateway.Runtime");
    return {
      module: LlmGatewayModule,
      providers: [
        {
          provide: RUNTIME,
          inject: [CLOCK, ID_GENERATOR],
          useFactory: (clock: Clock, ids: IdGenerator) => {
            const provider = o.provider ?? new FakeLlmProvider();
            const audit = o.audit ?? new InMemoryAuditStore();
            const usage = o.usage ?? new InMemoryTokenUsage();
            const cache = o.cache ?? new InMemoryGatewayCache(() => clock.nowMs());
            const flags = o.flags ?? new StaticFlags();
            const gateway = new LlmGateway({
              provider,
              audit,
              usage,
              cache,
              flags,
              clock,
              ids,
              config: cfg,
              registry: o.registry ?? defaultRegistry(),
            });
            return { gateway, provider, audit, usage, cache, flags };
          },
        },
        { provide: T.LLM_GATEWAY, inject: [RUNTIME], useFactory: (r: { gateway: LlmGateway }) => r.gateway },
        { provide: T.LLM_PROVIDER, inject: [RUNTIME], useFactory: (r: { provider: LlmProviderPort }) => r.provider },
        { provide: T.LLM_AUDIT_STORE, inject: [RUNTIME], useFactory: (r: { audit: AuditStore }) => r.audit },
        {
          provide: T.LLM_SEARCH_REFINER,
          inject: [RUNTIME],
          useFactory: (r: { gateway: LlmGateway }) =>
            new GatewaySearchRefiner(r.gateway, () => o.searchBucketUserId ?? SEARCH_BUCKET_USER_ID),
        },
      ],
      exports: [T.LLM_GATEWAY, T.LLM_PROVIDER, T.LLM_AUDIT_STORE, T.LLM_SEARCH_REFINER],
    };
  }
}
