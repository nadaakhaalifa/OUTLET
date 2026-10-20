/** Public surface of the llm-gateway module (A2.3). Other code imports only this file. */
export { LlmGatewayModule, MissingLlmGatewayPortsError, SEARCH_BUCKET_USER_ID, type LlmGatewayModuleOptions } from "./llm-gateway.module";
export * from "./adapters/tokens";
export { LlmGateway, canonicalJson, estimateTokens, type GatewayDeps } from "./application/gateway";
export {
  FakeLlmProvider,
  InMemoryAuditStore,
  InMemoryGatewayCache,
  InMemoryTokenUsage,
  StaticFlags,
} from "./adapters/in-memory";
export { KyselyAuditStore, KyselyTokenUsage, type GatewayDb } from "./adapters/kysely-stores";
export { GatewaySearchRefiner } from "./adapters/search-refiner";
export { CostBreaker } from "./domain/breaker";
export { detectInjection } from "./domain/injection";
export { scrubPii } from "./domain/scrub";
export {
  STYLIST_INTENT,
  STYLIST_CHAT_INTENT,
  StylistChatIntentOutput,
  type StylistChatIntent,
  STYLIST_RERANK,
  SEARCH_PARSE,
  PromptRegistry,
  defaultRegistry,
  type StylistIntent,
  type StylistRerank,
} from "./domain/prompts";
export {
  DEFAULT_GATEWAY_CONFIG,
  type AuditRecord,
  type AuditStore,
  type DataField,
  type FlagPort,
  type GatewayCachePort,
  type GatewayConfig,
  type GatewayRequest,
  type GatewayResult,
  type LlmProviderPort,
  type PromptTemplate,
  type TokenUsageStore,
  type UnavailableReason,
} from "./domain/types";
