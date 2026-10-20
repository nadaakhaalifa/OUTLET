import type { ZodType } from "zod";

/** Data class of a prompt field (data_inventory.yaml). Only P0 and P1 may reach an external model. */
export type DataClass = "P0" | "P1" | "P2" | "P3";

/**
 * A typed, delimited prompt input. `trust: "untrusted"` is seller, product or user text: it is
 * scrubbed, checked by the injection heuristics and rendered inside a delimited data envelope.
 */
export interface DataField {
  readonly name: string;
  readonly value: string;
  readonly dataClass: DataClass;
  readonly trust: "trusted" | "untrusted";
  /** When true and the field is hostile or blocked, the whole request is refused instead of neutralised. */
  readonly required?: boolean;
}

export interface PromptTemplate<T> {
  readonly id: string;
  /** Bump on any wording or schema change: it is part of the cache key and the audit hash. */
  readonly version: number;
  readonly feature: string;
  /** Flag key evaluated before every call (fail closed). */
  readonly killSwitch: string;
  readonly system: string;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
  /** Output is parsed as JSON and validated; anything else is rejected (LLM05). */
  readonly output: ZodType<T>;
}

export type UnavailableReason =
  | "disabled"
  | "kill_switch"
  | "breaker_open"
  | "budget_exceeded"
  | "provider_error"
  | "timeout"
  | "invalid_output"
  | "residency"
  | "injection"
  | "unknown_prompt";

export type GatewayResult<T> =
  | {
      readonly kind: "ok";
      readonly value: T;
      readonly cached: boolean;
      readonly tokensIn: number;
      readonly tokensOut: number;
      /** Fields whose content was neutralised by the injection heuristics. */
      readonly neutralisedFields: readonly string[];
    }
  | { readonly kind: "unavailable"; readonly reason: UnavailableReason };

export interface GatewayRequest<T> {
  readonly prompt: PromptTemplate<T>;
  readonly userId: string;
  readonly fields: readonly DataField[];
  /** Stable, non-sensitive description of the request used for the cache key (for example filters). */
  readonly cacheKeyInput: unknown;
  /** Shopper granted `cross_border_ml` (spec B1). Not sufficient on its own: a licence is also required. */
  readonly crossBorderConsent: boolean;
  /** Extra server-side acceptance check, for example "ids belong to the candidate set" (LLM05). */
  readonly accept?: (value: T) => boolean;
}

// ---- ports ----------------------------------------------------------------------------------

export interface ProviderRequest {
  readonly model: string;
  readonly system: string;
  /** Rendered, delimited data envelope. */
  readonly data: string;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
}

export interface ProviderResponse {
  /** Raw JSON text the model produced. Never trusted. */
  readonly text: string;
  readonly model: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
}

/** The only seam to a vendor SDK. No real implementation exists in this repository. */
export interface LlmProviderPort {
  complete(req: ProviderRequest): Promise<ProviderResponse>;
}

export interface FlagPort {
  isEnabled(key: string): Promise<boolean>;
}

export type AuditOutcome = "ok" | "cached" | "invalid_output" | "provider_error" | "timeout" | "blocked";

/** Audit rows hold hashes and counters only (T12). There is no text or user column by design. */
export interface AuditRecord {
  readonly id: string;
  readonly feature: string;
  readonly promptId: string;
  readonly promptHash: string;
  readonly model: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly latencyMs: number;
  readonly outcome: AuditOutcome;
  readonly atMs: number;
}

export interface AuditStore {
  record(r: AuditRecord): Promise<void>;
  list(feature: string, limit: number): Promise<readonly AuditRecord[]>;
}

export interface TokenUsageStore {
  /** Tokens consumed by `userId` for `feature` on the UTC `day` (YYYY-MM-DD). */
  used(userId: string, day: string, feature: string): Promise<number>;
  add(userId: string, day: string, feature: string, tokens: number): Promise<void>;
}

export interface GatewayCachePort {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
}

export interface GatewayConfig {
  /** Master switch. Default false: the LLM is off until a flag AND this setting are on. */
  readonly enabled: boolean;
  readonly model: string;
  /** A transfer licence for the external vendor exists (ADR-0025, VERIFY BEFORE LAUNCH). Default false. */
  readonly transferLicensed: boolean;
  readonly dailyTokensPerUser: number;
  readonly cacheTtlMs: number;
  /** Cost model for the global breaker, micro-EGP per token. */
  readonly costMicrosPerToken: number;
  readonly globalCostCapMicrosPerHour: number;
  readonly breakerFailureThreshold: number;
  readonly breakerOpenMs: number;
}

export const DEFAULT_GATEWAY_CONFIG: GatewayConfig = {
  enabled: false,
  model: "pinned-model-v1",
  transferLicensed: false,
  dailyTokensPerUser: 20_000,
  cacheTtlMs: 10 * 60_000,
  costMicrosPerToken: 20,
  globalCostCapMicrosPerHour: 50_000_000,
  breakerFailureThreshold: 5,
  breakerOpenMs: 60_000,
};
