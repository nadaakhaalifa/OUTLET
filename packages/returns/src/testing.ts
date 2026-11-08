import type { Money } from "@outlet/money";
import type { EvidencePort, KillSwitchPort, ProviderRefundPort, ProviderRefundResult, RestockPort, ReturnPolicyPort } from "./application/ports.js";

export class FakePolicy implements ReturnPolicyPort {
  readonly excluded = new Set<string>();
  swap = false;
  plus = false;
  nonReturnable(skuIds: readonly string[]): Promise<ReadonlySet<string>> {
    return Promise.resolve(new Set(skuIds.filter((s) => this.excluded.has(s))));
  }
  sizeSwapAvailable(): Promise<boolean> {
    return Promise.resolve(this.swap);
  }
  isPlusMember(): Promise<boolean> {
    return Promise.resolve(this.plus);
  }
}

export class FakeEvidence implements EvidencePort {
  ready = true;
  allReady(): Promise<boolean> {
    return Promise.resolve(this.ready);
  }
}

export class FakeRestock implements RestockPort {
  readonly applied: { skuId: string; qty: number; decision: string; key: string }[] = [];
  apply(req: Parameters<RestockPort["apply"]>[0]): Promise<void> {
    this.applied.push({ skuId: req.skuId, qty: req.qty, decision: req.decision, key: req.idempotencyKey });
    return Promise.resolve();
  }
}

export class FakeKill implements KillSwitchPort {
  readonly engaged = new Set<string>();
  isEngaged(key: string): Promise<boolean> {
    return Promise.resolve(this.engaged.has(key));
  }
}

/** Records every provider call; scripted outcomes are consumed in order, default accepted. Replays of one idempotency key return the first result. */
export class FakeProvider implements ProviderRefundPort {
  readonly calls: { refundId: string; route: string; amount: Money; key: string }[] = [];
  readonly script: ProviderRefundResult[] = [];
  reversible = true;
  private readonly byKey = new Map<string, ProviderRefundResult>();
  canReverse(): boolean {
    return this.reversible;
  }
  refund(req: Parameters<ProviderRefundPort["refund"]>[0]): Promise<ProviderRefundResult> {
    this.calls.push({ refundId: req.refundId, route: req.route, amount: req.amount, key: req.idempotencyKey });
    const prior = this.byKey.get(req.idempotencyKey);
    if (prior !== undefined) return Promise.resolve(prior);
    const res = this.script.shift() ?? { outcome: "accepted" as const, providerRef: `ref_${req.idempotencyKey}` };
    if (res.outcome === "accepted") this.byKey.set(req.idempotencyKey, res);
    return Promise.resolve(res);
  }
}
