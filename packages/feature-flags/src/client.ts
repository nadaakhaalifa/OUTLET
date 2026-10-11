import { FLAG_REGISTRY, describeFlagState, isKnownFlag, paymentKillSwitch, type FlagKey, type FlagState, type PaymentMethod } from "./registry";
import type { EvaluationContext, FlagProvider, ResolutionDetails } from "./provider";

export interface FlagDecision {
  readonly key: string;
  readonly enabled: boolean;
  /** Why the value is what it is; for logs and metrics. */
  readonly source: "provider" | "default_unknown_flag" | "default_provider_error" | "default_provider_threw" | "default_invalid_value";
}

export interface FlagClientDeps {
  readonly provider: FlagProvider;
  /** Called on every fail-closed fallback. Must not throw; errors from it are swallowed. */
  readonly onFallback?: (d: FlagDecision) => void;
}

/**
 * Evaluates registry flags only. Every path that is not a clean boolean from the provider returns
 * the registry default (false): fail closed. The client never throws.
 */
export class FlagClient {
  private readonly defaults = new Map(FLAG_REGISTRY.map((d) => [d.key as string, d.defaultValue] as const));

  constructor(private readonly deps: FlagClientDeps) {}

  async isEnabled(key: FlagKey, context: EvaluationContext = {}): Promise<boolean> {
    return (await this.evaluate(key, context)).enabled;
  }

  async isPaymentMethodEnabled(method: PaymentMethod, context: EvaluationContext = {}): Promise<boolean> {
    return this.isEnabled(paymentKillSwitch(method), context);
  }

  /** "allowed" when the capability may run, "blocked" otherwise (including every fail-closed path). */
  async describeState(key: FlagKey, context: EvaluationContext = {}): Promise<FlagState> {
    return describeFlagState((await this.evaluate(key, context)).enabled);
  }

  async evaluate(key: string, context: EvaluationContext = {}): Promise<FlagDecision> {
    if (!isKnownFlag(key)) return this.fallback({ key, enabled: false, source: "default_unknown_flag" });
    const def = this.defaults.get(key) ?? false;
    let details: ResolutionDetails<boolean>;
    try {
      details = await this.deps.provider.resolveBooleanEvaluation(key, def, context);
    } catch {
      return this.fallback({ key, enabled: def, source: "default_provider_threw" });
    }
    if (details.errorCode !== undefined) return this.fallback({ key, enabled: def, source: "default_provider_error" });
    if (typeof details.value !== "boolean") return this.fallback({ key, enabled: def, source: "default_invalid_value" });
    return { key, enabled: details.value, source: "provider" };
  }

  private fallback(d: FlagDecision): FlagDecision {
    try {
      this.deps.onFallback?.(d);
    } catch {
      // observability must never change the decision
    }
    return d;
  }
}
