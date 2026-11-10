import type { AbuseSignalsPort, CodeResolutionBudget, AbuseVerdict, AuditPort, KillSwitchPort, OrderFactsPort } from "./application/ports.js";

export class FakeKill implements KillSwitchPort {
  enabled = true;
  isEnabled(): Promise<boolean> { return Promise.resolve(this.enabled); }
}
export class FakeAbuse implements AbuseSignalsPort {
  verdict: AbuseVerdict = { allow: true };
  readonly calls: { userId: string; deviceId: string | null; promotionId: string }[] = [];
  assess(input: { userId: string; deviceId: string | null; promotionId: string }): Promise<AbuseVerdict> { this.calls.push(input); return Promise.resolve(this.verdict); }
}
export class FakeOrderFacts implements OrderFactsPort {
  cancelledBeforeShipping = false;
  wholeOrderCancelledBeforeShipping(): Promise<boolean> { return Promise.resolve(this.cancelledBeforeShipping); }
}
export class FakeAudit implements AuditPort {
  readonly entries: { action: string; targetId: string; actorType: string }[] = [];
  append(input: { action: string; targetId: string; actorType: string }): Promise<unknown> { this.entries.push({ action: input.action, targetId: input.targetId, actorType: input.actorType }); return Promise.resolve(); }
}
export class FakeCodeBudget implements CodeResolutionBudget {
  /** attempts allowed per (user, device) before consume() starts returning false */
  constructor(private readonly limit = 5) {}
  private readonly seen = new Map<string, number>();
  consume(input: { userId: string; deviceId: string | null }): Promise<boolean> {
    const key = `${input.userId}|${input.deviceId ?? ""}`;
    const n = (this.seen.get(key) ?? 0) + 1;
    this.seen.set(key, n);
    return Promise.resolve(n <= this.limit);
  }
}
