import { ApiError, dataOf } from "../../services/api-client";
import { guard, money, ms, msOrNull, toMoney, type AdapterContext } from "../../services/wire";
import type { BudgetPort, BudgetSettings, BudgetSummary } from "./model";

/**
 * /v1/me/budget*. Next-cycle installments, the wishlist affordability list and the server clock are not in
 * BudgetSummary (gap): they are 0n / [] / this device's clock until the contract carries them.
 */
export class ApiBudgetPort implements BudgetPort {
  constructor(private readonly ctx: AdapterContext) {}

  consent(): Promise<boolean> {
    return guard(async () => dataOf(await this.ctx.client.getConsents()).consents.some((c) => c.purpose === "budget_insights" && c.granted));
  }

  setConsent(granted: boolean): Promise<void> {
    return guard(async () => {
      const current = dataOf(await this.ctx.client.getConsents()).consents.find((c) => c.purpose === "budget_insights");
      dataOf(await this.ctx.client.updateConsents({ body: { changes: [{ purpose: "budget_insights", granted, policy_version: current?.policy_version ?? "1" }] } }));
    });
  }

  summary(): Promise<BudgetSummary> {
    return guard(async () => {
      const s = dataOf(await this.ctx.client.getMyBudgetSummary());
      const items = s.installments?.items ?? [];
      const settings: BudgetSettings | null =
        s.state === "active" && s.budget !== undefined && s.payday !== undefined
          ? { amount: money(s.budget), payday: s.payday, capMode: s.cap?.mode ?? "off" }
          : null;
      return {
        settings,
        spentThisCycle: s.spent !== undefined ? money(s.spent) : 0n,
        bagTotal: s.bag !== undefined && s.bag !== null ? money(s.bag) : 0n,
        installmentsDueThisCycle: s.installments !== undefined ? money(s.installments.total) : 0n,
        installmentsNextCycle: 0n,
        installments: items.map((i, n) => ({ id: `${i.provider}:${n}`, provider: i.provider, monthly: money(i.monthly), source: i.source })),
        wishlist: [],
        serverNowMs: this.ctx.nowMs(),
        unlockAtMs: msOrNull(s.cap?.unlock_at),
      };
    });
  }

  saveSettings(s: BudgetSettings, idempotencyKey: string): Promise<void> {
    return guard(async () => {
      dataOf(await this.ctx.client.putMyBudget({ body: { amount: toMoney(s.amount), payday: s.payday, cap_mode: s.capMode } }, { idempotencyKey }));
    });
  }

  requestUnlock(idempotencyKey: string): Promise<{ unlockAtMs: number }> {
    return guard(async () => {
      const r = dataOf(await this.ctx.client.requestBudgetCapUnlock(undefined, { idempotencyKey }));
      return { unlockAtMs: ms(r.unlock_at) };
    });
  }
}

export function isConsentRequired(e: unknown): boolean {
  return e instanceof ApiError && e.status === 403 && e.code === "consent_required";
}
