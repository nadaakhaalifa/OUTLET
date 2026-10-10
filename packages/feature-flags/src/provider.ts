/**
 * Structurally compatible with the OpenFeature server-side Provider contract
 * (https://openfeature.dev/specification/sections/providers) so a real OpenFeature provider
 * (self-hosted, per spec A2.12) can be adapted without changing callers. The OpenFeature SDK
 * is deliberately not a dependency yet.
 */
export type EvaluationContext = Readonly<Record<string, string | number | boolean | undefined>> & {
  readonly targetingKey?: string;
};

export type ErrorCode =
  | "PROVIDER_NOT_READY"
  | "FLAG_NOT_FOUND"
  | "PARSE_ERROR"
  | "TYPE_MISMATCH"
  | "TARGETING_KEY_MISSING"
  | "INVALID_CONTEXT"
  | "GENERAL";

export type Reason = "STATIC" | "DEFAULT" | "TARGETING_MATCH" | "DISABLED" | "ERROR" | "UNKNOWN";

export interface ResolutionDetails<T> {
  readonly value: T;
  readonly variant?: string;
  readonly reason?: Reason;
  readonly errorCode?: ErrorCode;
  readonly errorMessage?: string;
}

export interface FlagProvider {
  readonly metadata: { readonly name: string };
  readonly runsOn?: "server" | "client";
  resolveBooleanEvaluation(
    flagKey: string,
    defaultValue: boolean,
    context: EvaluationContext,
  ): ResolutionDetails<boolean> | Promise<ResolutionDetails<boolean>>;
  resolveStringEvaluation(
    flagKey: string,
    defaultValue: string,
    context: EvaluationContext,
  ): ResolutionDetails<string> | Promise<ResolutionDetails<string>>;
  resolveNumberEvaluation(
    flagKey: string,
    defaultValue: number,
    context: EvaluationContext,
  ): ResolutionDetails<number> | Promise<ResolutionDetails<number>>;
}
