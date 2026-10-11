import { beginCompensation, isTerminal } from "../domain/bridge";
import type { SagaRecord } from "../domain/ports";
import type { CheckoutContext } from "./context";
import { SagaRunner } from "./saga-runner";

export type LifecycleResult =
  | { readonly kind: "ok"; readonly record: SagaRecord }
  | { readonly kind: "not_found" }
  | { readonly kind: "not_cancellable" };

async function transition(
  ctx: CheckoutContext,
  runner: SagaRunner,
  orderGroupId: string,
  userId: string,
  mutate: (r: SagaRecord) => SagaRecord | "not_cancellable" | "noop",
): Promise<LifecycleResult> {
  for (let i = 0; i < 5; i += 1) {
    const rec = await ctx.repo.getForUser(orderGroupId, userId); // BOLA: foreign groups are not_found
    if (rec === null) return { kind: "not_found" };
    const m = mutate(rec);
    if (m === "not_cancellable") return { kind: "not_cancellable" };
    if (m === "noop") return { kind: "ok", record: (await runner.drive(orderGroupId)).record };
    const now = ctx.clock.nowMs();
    const next: SagaRecord = { ...m, version: rec.version + 1, updatedAtMs: now, nextWakeAtMs: now, attempts: 0 };
    if (await ctx.repo.save(next, rec.version, [])) return { kind: "ok", record: (await runner.drive(orderGroupId)).record };
  }
  throw new Error("could not update the saga after retries");
}

/** Shopper cancels before payment succeeded or stock was claimed; later it is an order cancellation (orders). */
export class CancelCheckout {
  private readonly runner: SagaRunner;
  constructor(private readonly ctx: CheckoutContext) {
    this.runner = new SagaRunner(ctx);
  }
  execute(input: { orderGroupId: string; userId: string }): Promise<LifecycleResult> {
    return transition(this.ctx, this.runner, input.orderGroupId, input.userId, (r) => {
      const f = r.facts;
      if (f.status === "CANCELLED" || f.status === "COMPENSATING") return "noop";
      if (isTerminal(f.status) || f.payment === "succeeded" || f.claimed || f.ordersPlaced) return "not_cancellable";
      return { ...r, facts: beginCompensation(f, "cancelled_by_shopper") };
    });
  }
}

/** Result of the OTP or WhatsApp confirmation for a risk-gated COD order. */
export class ConfirmCodOrder {
  private readonly runner: SagaRunner;
  constructor(private readonly ctx: CheckoutContext) {
    this.runner = new SagaRunner(ctx);
  }
  execute(input: { orderGroupId: string; userId: string; confirmed: boolean }): Promise<LifecycleResult> {
    return transition(this.ctx, this.runner, input.orderGroupId, input.userId, (r) => {
      const f = r.facts;
      if (f.method !== "cod") return "not_cancellable";
      if (f.codConfirmation !== "pending") return "noop";
      if (!input.confirmed) return { ...r, facts: beginCompensation(f, "cancelled_by_shopper") };
      return { ...r, facts: { ...f, codConfirmation: "confirmed" } };
    });
  }
}

/** Worker entry: re-drives every non-terminal saga whose wake time has passed. Idempotent. */
export class RecoverSagas {
  private readonly runner: SagaRunner;
  constructor(private readonly ctx: CheckoutContext) {
    this.runner = new SagaRunner(ctx);
  }
  async execute(limit = 50): Promise<{ readonly driven: number; readonly failed: number }> {
    const due = await this.ctx.repo.due(this.ctx.clock.nowMs(), limit);
    let driven = 0;
    let failed = 0;
    for (const r of due) {
      try {
        await this.runner.drive(r.orderGroupId);
        driven += 1;
      } catch {
        failed += 1;
      }
    }
    return { driven, failed };
  }
}

export class GetCheckoutStatus {
  constructor(private readonly ctx: CheckoutContext) {}
  execute(input: { orderGroupId: string; userId: string }): Promise<SagaRecord | null> {
    return this.ctx.repo.getForUser(input.orderGroupId, input.userId);
  }
}
