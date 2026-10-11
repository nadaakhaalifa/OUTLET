import type { PaymentMethodId, ProviderId } from "./types";

/**
 * PSP failover router: pure functions over an immutable circuit-breaker state (spec 7 "PSP outage
 * -> failover to the secondary PSP"). The caller owns the storage of `BreakerState` and the clock.
 */
export type BreakerState =
  | { readonly kind: "closed"; readonly failures: number }
  | { readonly kind: "open"; readonly openedAtMs: number }
  | { readonly kind: "half_open"; readonly probeStartedAtMs: number };

export interface BreakerConfig {
  /** Consecutive infrastructure failures that open the breaker. */
  readonly failureThreshold: number;
  /** How long the breaker stays open before one probe is allowed. */
  readonly openMs: number;
  /** A probe with no result after this long is abandoned and another is allowed. */
  readonly probeTimeoutMs: number;
}

export const DEFAULT_BREAKER_CONFIG: BreakerConfig = { failureThreshold: 5, openMs: 30_000, probeTimeoutMs: 10_000 };

export const CLOSED: BreakerState = { kind: "closed", failures: 0 };

export function validateBreakerConfig(c: BreakerConfig): BreakerConfig {
  if (!Number.isInteger(c.failureThreshold) || c.failureThreshold < 1) throw new RangeError("failureThreshold must be >= 1");
  if (!Number.isInteger(c.openMs) || c.openMs < 1) throw new RangeError("openMs must be >= 1");
  if (!Number.isInteger(c.probeTimeoutMs) || c.probeTimeoutMs < 1) throw new RangeError("probeTimeoutMs must be >= 1");
  return c;
}

/** Whether a call may go to a provider now, and the state after taking that decision. */
export function admit(state: BreakerState, nowMs: number, cfg: BreakerConfig): { allowed: boolean; next: BreakerState } {
  switch (state.kind) {
    case "closed":
      return { allowed: true, next: state };
    case "open":
      if (nowMs - state.openedAtMs >= cfg.openMs) return { allowed: true, next: { kind: "half_open", probeStartedAtMs: nowMs } };
      return { allowed: false, next: state };
    case "half_open":
      if (nowMs - state.probeStartedAtMs >= cfg.probeTimeoutMs) {
        return { allowed: true, next: { kind: "half_open", probeStartedAtMs: nowMs } };
      }
      return { allowed: false, next: state };
  }
}

/** A read-only view for availability: would a call be admitted? Does not consume the probe. */
export function wouldAdmit(state: BreakerState, nowMs: number, cfg: BreakerConfig): boolean {
  if (state.kind === "closed") return true;
  if (state.kind === "open") return nowMs - state.openedAtMs >= cfg.openMs;
  return nowMs - state.probeStartedAtMs >= cfg.probeTimeoutMs;
}

export function onSuccess(_state: BreakerState): BreakerState {
  return CLOSED;
}

/** Only infrastructure failures (unavailable, timeout) are recorded. Declines are not failures. */
export function onFailure(state: BreakerState, nowMs: number, cfg: BreakerConfig): BreakerState {
  switch (state.kind) {
    case "closed": {
      const failures = state.failures + 1;
      return failures >= cfg.failureThreshold ? { kind: "open", openedAtMs: nowMs } : { kind: "closed", failures };
    }
    case "half_open":
      return { kind: "open", openedAtMs: nowMs };
    case "open":
      return state;
  }
}

export interface RoutePolicy {
  /** Ordered provider preference per method; first entry is the primary. */
  readonly order: Readonly<Partial<Record<PaymentMethodId, readonly ProviderId[]>>>;
  readonly defaultOrder: readonly ProviderId[];
}

export function providerOrder(policy: RoutePolicy, method: PaymentMethodId, supports: (p: ProviderId) => boolean): readonly ProviderId[] {
  const configured = policy.order[method] ?? policy.defaultOrder;
  const seen = new Set<string>();
  const out: ProviderId[] = [];
  for (const p of configured) {
    if (seen.has(p) || !supports(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

export type BreakerStates = Readonly<Record<ProviderId, BreakerState>>;

export type RouteDecision =
  | { readonly kind: "selected"; readonly provider: ProviderId; readonly states: BreakerStates }
  | { readonly kind: "none"; readonly states: BreakerStates };

/**
 * First provider in `order` whose breaker admits a call. Skipped providers keep their state; the
 * selected provider's state moves (an open breaker whose cool-down has passed becomes half_open).
 */
export function selectProvider(
  order: readonly ProviderId[],
  states: BreakerStates,
  nowMs: number,
  cfg: BreakerConfig,
  exclude: ReadonlySet<ProviderId> = new Set(),
): RouteDecision {
  for (const p of order) {
    if (exclude.has(p)) continue;
    const current = states[p] ?? CLOSED;
    const { allowed, next } = admit(current, nowMs, cfg);
    if (allowed) return { kind: "selected", provider: p, states: { ...states, [p]: next } };
  }
  return { kind: "none", states };
}
