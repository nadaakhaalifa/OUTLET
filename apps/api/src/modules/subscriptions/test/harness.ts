import { DAY_MS, type PlusPlan } from "../domain/bridge";
import {
  FakeAgePolicy,
  FakeCardVault,
  FakeFlags,
  FakeLedger,
  FakeNotices,
  FakePersonKeys,
  FakePlanApprovals,
  FakeRecurringCharges,
  FakeRefunds,
  FakeTaxReceipts,
  HmacKeyHasher,
  InMemorySubscriptionStore,
} from "../adapters/in-memory";
import { GetMyPlus, PlusEntitlements, RecordBenefitUsed, ReverseBenefit } from "../application/member";
import { CancelPlus, PausePlus, ReactivatePlus, RefundPlus, ResumePlus, SwitchPlan } from "../application/manage";
import { ListPlans, PublishPlanVersion } from "../application/plans";
import { DEFAULT_PLUS_CONFIG, type PlusDeps } from "../application/shared";
import { Subscribe } from "../application/subscribe";
import { HandleRecurringWebhook, RecognizeDeferredRevenue, RunRenewalSweep } from "../application/sweeper";

/** A month with 30 days, so the spec example (10 days used, 20 unused) is exact. */
export const START_MS = Date.UTC(2026, 3, 10, 9, 0, 0);
export { DAY_MS };

export class FakeClock {
  constructor(private ms = START_MS) {}
  nowMs(): number {
    return this.ms;
  }
  advance(ms: number): void {
    this.ms += ms;
  }
  advanceDays(d: number): void {
    this.ms += d * DAY_MS;
  }
}

export const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export function createPlusWorld() {
  const clock = new FakeClock();
  let seq = 0;
  const ids = { uuidV7: (): string => `00000000-0000-7000-8000-${String(++seq).padStart(12, "0")}` };
  const store = new InMemorySubscriptionStore();
  const plans = store.seedDefaultPlans(ids);
  const monthly = plans.find((p) => p.code === "plus_monthly") as PlusPlan;
  const yearly = plans.find((p) => p.code === "plus_yearly") as PlusPlan;
  const ages = new FakeAgePolicy();
  const persons = new FakePersonKeys();
  const vault = new FakeCardVault();
  const charges = new FakeRecurringCharges();
  const refunds = new FakeRefunds();
  const ledger = new FakeLedger();
  const receipts = new FakeTaxReceipts();
  const notices = new FakeNotices();
  const flags = new FakeFlags();
  const approvals = new FakePlanApprovals();
  const d: PlusDeps = {
    store,
    clock,
    ids,
    cfg: DEFAULT_PLUS_CONFIG,
    ledger,
    receipts,
    notices,
    flags,
    charges,
    refunds,
    ages,
    persons,
    vault,
    hasher: new HmacKeyHasher("test-secret"),
  };
  return {
    d,
    clock,
    ids,
    store,
    monthly,
    yearly,
    ages,
    persons,
    vault,
    charges,
    refunds,
    ledger,
    receipts,
    notices,
    flags,
    approvals,
    uc: {
      plans: new ListPlans(store, clock),
      subscribe: new Subscribe(d),
      cancel: new CancelPlus(d),
      reactivate: new ReactivatePlus(d),
      pause: new PausePlus(d),
      resume: new ResumePlus(d),
      switchPlan: new SwitchPlan(d),
      refund: new RefundPlus(d),
      mine: new GetMyPlus(store, clock),
      entitlements: new PlusEntitlements(store, clock),
      recordBenefit: new RecordBenefitUsed(store, clock, ids),
      reverseBenefit: new ReverseBenefit(store, clock),
      sweep: new RunRenewalSweep(d),
      recognize: new RecognizeDeferredRevenue(d),
      webhook: new HandleRecurringWebhook(d),
      publish: new PublishPlanVersion(store, clock, ids, approvals, notices),
    },
    /** A 30 year old with a phone, a device and a saved card token. */
    member(n: number, o: { age?: number; fingerprint?: string; phone?: string } = {}) {
      const userId = U(n);
      ages.setAge(userId, o.age ?? 30);
      persons.set(userId, o.phone ?? `phone-${n}`);
      const tokenRef = `tok_${n}`;
      vault.add(userId, tokenRef, o.fingerprint ?? `fp-${n}`);
      return { userId, tokenRef, deviceId: `dev-${n}` };
    },
    subscribeInput(
      m: { userId: string; tokenRef: string; deviceId: string },
      o: { plan?: string; requestKey?: string; method?: "card" | "mobile_wallet" | "apple_pay" } = {},
    ) {
      return {
        userId: m.userId,
        planCode: o.plan ?? "plus_monthly",
        tokenRef: m.tokenRef,
        deviceId: m.deviceId,
        method: o.method ?? ("card" as const),
        requestKey: o.requestKey ?? `req-${m.userId}`,
      };
    },
  };
}

export type PlusWorld = ReturnType<typeof createPlusWorld>;
