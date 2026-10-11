import type { Clock } from "../../../platform/ports";
import type { CreateIntentRequest, CreatedIntent, PaymentProviderPort, ProviderResult } from "../domain/ports";
import {
  CLOSED,
  onFailure,
  onSuccess,
  providerOrder,
  selectProvider,
  wouldAdmit,
  type BreakerConfig,
  type BreakerStates,
  type PaymentMethodId,
  type ProviderId,
  type RoutePolicy,
} from "../domain/seam";

export type Sleeper = (ms: number) => Promise<void>;

/** Exponential backoff with full jitter, bounded. `random` is injected so tests are deterministic. */
export function backoffMs(attempt: number, random: () => number, baseMs = 100, capMs = 2_000): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** (attempt - 1));
  return Math.floor(random() * ceiling);
}

export interface PspRouterOptions {
  readonly policy: RoutePolicy;
  readonly breaker: BreakerConfig;
  /** Attempts per provider for an ambiguous (timeout) outcome. Spec 7: retry idempotently x3. */
  readonly maxAttempts: number;
  readonly sleep: Sleeper;
  readonly random: () => number;
}

export type RoutedCreate = {
  readonly result: ProviderResult<CreatedIntent>;
  /** Provider that produced `result`, or null when none could be reached. */
  readonly provider: ProviderId | null;
};

/**
 * Applies the pure router (packages/domain/src/payments/router.ts) to real calls and owns the
 * per-process breaker state. Failover rule (spec section P6): only a definitive `unavailable`
 * moves to the next provider; a timeout or malformed response is retried on the SAME provider
 * and then surfaced, because the first PSP may already hold the intent.
 */
export class PspRouter {
  private states: BreakerStates = {};

  constructor(
    private readonly providers: ReadonlyMap<ProviderId, PaymentProviderPort>,
    private readonly clock: Clock,
    private readonly opts: PspRouterOptions,
  ) {}

  order(method: PaymentMethodId): readonly ProviderId[] {
    return providerOrder(this.opts.policy, method, (p) => this.providers.get(p)?.methods.includes(method) === true);
  }

  /** Read-only: is at least one provider for this method currently admitting calls? */
  isAvailable(method: PaymentMethodId): boolean {
    const now = this.clock.nowMs();
    return this.order(method).some((p) => wouldAdmit(this.states[p] ?? CLOSED, now, this.opts.breaker));
  }

  breakerState(provider: ProviderId): BreakerStates[string] {
    return this.states[provider] ?? CLOSED;
  }

  provider(id: ProviderId): PaymentProviderPort | null {
    return this.providers.get(id) ?? null;
  }

  async create(
    req: CreateIntentRequest,
    beforeCall: (provider: ProviderId) => Promise<void>,
  ): Promise<RoutedCreate> {
    const tried = new Set<ProviderId>();
    const order = this.order(req.method);
    for (;;) {
      const sel = selectProvider(order, this.states, this.clock.nowMs(), this.opts.breaker, tried);
      this.states = sel.states;
      if (sel.kind === "none") return { result: { kind: "unavailable", code: "no_provider_available" }, provider: null };
      const port = this.providers.get(sel.provider);
      if (port === undefined) {
        tried.add(sel.provider);
        continue;
      }
      await beforeCall(sel.provider);
      const result = await this.attempt(sel.provider, () => port.createIntent(req));
      if (result.kind === "unavailable") {
        tried.add(sel.provider);
        continue;
      }
      return { result, provider: sel.provider };
    }
  }

  /** Calls bound to the provider that owns the intent: never fails over. */
  async pinned<T>(provider: ProviderId, call: (p: PaymentProviderPort) => Promise<ProviderResult<T>>): Promise<ProviderResult<T>> {
    const port = this.providers.get(provider);
    if (port === undefined) return { kind: "invalid_request", code: "unknown_provider" };
    return this.attempt(provider, () => call(port));
  }

  private async attempt<T>(provider: ProviderId, call: () => Promise<ProviderResult<T>>): Promise<ProviderResult<T>> {
    let last: ProviderResult<T> = { kind: "timeout" };
    for (let i = 1; i <= this.opts.maxAttempts; i++) {
      last = await call();
      const now = this.clock.nowMs();
      switch (last.kind) {
        case "ok":
        case "declined":
        case "invalid_request":
          // A decline or a bad request proves the PSP answered: it is not an infrastructure failure.
          this.states = { ...this.states, [provider]: onSuccess(this.states[provider] ?? CLOSED) };
          return last;
        case "unavailable":
          this.states = { ...this.states, [provider]: onFailure(this.states[provider] ?? CLOSED, now, this.opts.breaker) };
          return last;
        case "timeout":
        case "invalid_response":
          this.states = { ...this.states, [provider]: onFailure(this.states[provider] ?? CLOSED, now, this.opts.breaker) };
          if (i < this.opts.maxAttempts) await this.opts.sleep(backoffMs(i, this.opts.random));
      }
    }
    return last;
  }
}
