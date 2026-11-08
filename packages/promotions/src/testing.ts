import type { AbuseSignalsPort, AbuseVerdict, AuditPort, KillSwitchPort, OrderFactsPort } from "./application/ports.js";

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
