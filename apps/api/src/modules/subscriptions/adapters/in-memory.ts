import { createHmac } from "node:crypto";
import { DEFAULT_PLAN_DEFINITIONS, type JournalEntry, type PlusPlan, type PlusSubscription, type SubscriptionState } from "../domain/bridge";
import type {
  MetricsCounts,
  AgePolicyPort,
  CardVaultPort,
  ChargeOutcome,
  ChargeRequest,
  CommitResult,
  EntitlementRow,
  FeatureGatePort,
  InvoiceRecord,
  KeyHasherPort,
  LedgerPort,
  MemberNoticePort,
  MemberNoticeTemplate,
  PersonKeyPort,
  PlanPriceApprovalPort,
  PlusEvent,
  PlusRefundPort,
  RecurringChargePort,
  SavingsRow,
  SignupRecord,
  SubscriptionChange,
  SubscriptionStore,
  TaxReceiptPort,
} from "../domain/ports";

const invoiceKey = (i: Pick<InvoiceRecord, "subscriptionId" | "cycle" | "attempt">): string =>
  `${i.subscriptionId}:${i.cycle}:${i.attempt}`;

export class InMemorySubscriptionStore implements SubscriptionStore {
  readonly events: PlusEvent[] = [];
  private readonly plans = new Map<string, PlusPlan>();
  private readonly subs = new Map<string, PlusSubscription>();
  private readonly invoices = new Map<string, InvoiceRecord>();
  private readonly entitlements = new Map<string, EntitlementRow[]>();
  private readonly claims = new Map<string, string>();
  private readonly signups = new Map<string, SignupRecord>();
  private readonly webhooks = new Set<string>();
  private readonly savings = new Map<string, SavingsRow>();

  /** Dev and test seed: the spec 01 launch plans (200 EGP monthly, 800 EGP yearly, 14 day trial). */
  seedDefaultPlans(ids: { uuidV7(): string }, effectiveFromMs = 0): readonly PlusPlan[] {
    return DEFAULT_PLAN_DEFINITIONS.map((d) => {
      const p: PlusPlan = {
        id: ids.uuidV7(),
        code: d.code,
        interval: d.interval,
        priceMinor: d.priceMinor,
        version: 1,
        active: true,
        trialDays: d.trialDays,
        effectiveFromMs,
        notifiedAtMs: null,
      };
      this.plans.set(p.id, p);
      return p;
    });
  }

  async listPlanVersions(code?: string): Promise<readonly PlusPlan[]> {
    return [...this.plans.values()].filter((p) => code === undefined || p.code === code);
  }
  async getPlan(id: string): Promise<PlusPlan | null> {
    return this.plans.get(id) ?? null;
  }
  async savePlan(plan: PlusPlan, events: readonly PlusEvent[]): Promise<"ok" | "exists"> {
    for (const p of this.plans.values()) {
      if (p.id !== plan.id && p.code === plan.code && p.version === plan.version) return "exists";
    }
    this.plans.set(plan.id, plan);
    this.events.push(...events);
    return "ok";
  }

  async getSubscription(id: string): Promise<PlusSubscription | null> {
    return this.subs.get(id) ?? null;
  }
  async getLiveByUser(userId: string): Promise<PlusSubscription | null> {
    for (const s of this.subs.values()) if (s.userId === userId && s.status !== "EXPIRED") return s;
    return null;
  }
  async getLatestByUser(userId: string): Promise<PlusSubscription | null> {
    const live = await this.getLiveByUser(userId);
    if (live !== null) return live;
    const all = [...this.subs.values()].filter((s) => s.userId === userId);
    return all.sort((a, b) => b.createdAtMs - a.createdAtMs)[0] ?? null;
  }
  async listDue(nowMs: number, limit: number): Promise<readonly PlusSubscription[]> {
    return [...this.subs.values()]
      .filter((s) => s.status !== "EXPIRED" && s.nextActionAtMs !== null && s.nextActionAtMs <= nowMs)
      .sort((a, b) => (a.nextActionAtMs ?? 0) - (b.nextActionAtMs ?? 0) || a.id.localeCompare(b.id))
      .slice(0, limit);
  }
  async listLiveByPlanCode(code: string): Promise<readonly PlusSubscription[]> {
    return [...this.subs.values()].filter((s) => s.status !== "EXPIRED" && s.planCode === code);
  }

  async metricsCounts(sinceMs: number): Promise<MetricsCounts> {
    const byStatus: Record<SubscriptionState, number> = { TRIALING: 0, ACTIVE: 0, PAST_DUE: 0, PAUSED: 0, CANCELLED_AT_PERIOD_END: 0, EXPIRED: 0 };
    let createdSince = 0;
    let liveAtStart = 0;
    let endedSince = 0;
    for (const s of this.subs.values()) {
      byStatus[s.status] += 1;
      if (s.createdAtMs >= sinceMs) createdSince += 1;
      else if (s.status !== "EXPIRED" || s.periodEndMs >= sinceMs) {
        liveAtStart += 1;
        if (s.status === "EXPIRED") endedSince += 1;
      }
    }
    return { byStatus, createdSince, liveAtStart, endedSince };
  }

  async claimedTrialKeys(keyHashes: readonly string[]): Promise<ReadonlySet<string>> {
    return new Set(keyHashes.filter((k) => this.claims.has(k)));
  }

  async getInvoice(id: string): Promise<InvoiceRecord | null> {
    for (const i of this.invoices.values()) if (i.id === id) return i;
    return null;
  }
  async latestPaidInvoice(subscriptionId: string): Promise<InvoiceRecord | null> {
    const paid = [...this.invoices.values()].filter(
      (i) => i.subscriptionId === subscriptionId && (i.status === "PAID" || i.status === "REFUNDED"),
    );
    return paid.sort((a, b) => b.issuedAtMs - a.issuedAtMs || b.cycle - a.cycle || b.attempt - a.attempt)[0] ?? null;
  }
  async listInvoices(subscriptionId: string): Promise<readonly InvoiceRecord[]> {
    return [...this.invoices.values()]
      .filter((i) => i.subscriptionId === subscriptionId)
      .sort((a, b) => a.cycle - b.cycle || a.attempt - b.attempt);
  }
  async listForRecognition(limit: number): Promise<readonly InvoiceRecord[]> {
    return [...this.invoices.values()]
      .filter((i) => i.status === "PAID" && i.periodsRecognised < i.periodsTotal)
      .sort((a, b) => a.periodStartMs - b.periodStartMs)
      .slice(0, limit);
  }

  async getSignup(id: string): Promise<SignupRecord | null> {
    return this.signups.get(id) ?? null;
  }
  async getSignupByChargeKey(key: string): Promise<SignupRecord | null> {
    for (const s of this.signups.values()) if (s.chargeKey === key) return s;
    return null;
  }

  async entitlementRows(userId: string): Promise<readonly EntitlementRow[]> {
    return [...this.entitlements.values()].flat().filter((r) => r.userId === userId);
  }

  async addSavings(row: SavingsRow, events: readonly PlusEvent[]): Promise<"added" | "exists"> {
    for (const r of this.savings.values()) {
      if (r.orderGroupId === row.orderGroupId && r.benefit === row.benefit) return "exists";
    }
    this.savings.set(row.id, row);
    this.events.push(...events);
    return "added";
  }
  async reverseSavings(
    orderGroupId: string,
    atMs: number,
    events: (userId: string) => readonly PlusEvent[],
  ): Promise<number> {
    let n = 0;
    for (const [id, r] of this.savings) {
      if (r.orderGroupId === orderGroupId && r.reversedAtMs === null) {
        this.savings.set(id, { ...r, reversedAtMs: atMs });
        this.events.push(...events(r.userId));
        n += 1;
      }
    }
    return n;
  }
  async benefitUsedSince(userId: string, sinceMs: number): Promise<boolean> {
    return [...this.savings.values()].some((r) => r.userId === userId && r.reversedAtMs === null && r.createdAtMs >= sinceMs);
  }
  async listSavings(userId: string, limit: number): Promise<readonly SavingsRow[]> {
    return [...this.savings.values()]
      .filter((r) => r.userId === userId)
      .sort((a, b) => b.createdAtMs - a.createdAtMs)
      .slice(0, limit);
  }
  async totalSavedMinor(userId: string): Promise<bigint> {
    let t = 0n;
    for (const r of this.savings.values()) if (r.userId === userId && r.reversedAtMs === null) t += r.amountSavedMinor;
    return t;
  }

  async commit(c: SubscriptionChange): Promise<CommitResult> {
    if (c.webhookEvent !== undefined && this.webhooks.has(`${c.webhookEvent.provider}:${c.webhookEvent.eventId}`)) {
      return "duplicate_event";
    }
    if (c.trialClaims !== undefined && c.trialClaims.keyHashes.some((k) => this.claims.has(k))) return "trial_taken";
    let nextSub: PlusSubscription | null = null;
    if (c.subscription !== undefined) {
      const { value, expectedVersion } = c.subscription;
      const cur = this.subs.get(value.id);
      if (expectedVersion === null) {
        if (cur !== undefined) return "conflict";
        if (value.status !== "EXPIRED") {
          for (const s of this.subs.values()) {
            if (s.userId === value.userId && s.status !== "EXPIRED") return "already_subscribed";
          }
        }
        nextSub = { ...value, version: 1 };
      } else {
        if (cur === undefined || cur.version !== expectedVersion) return "conflict";
        nextSub = { ...value, version: expectedVersion + 1 };
      }
    }
    const seen = new Set<string>();
    for (const i of c.invoices ?? []) {
      const k = invoiceKey(i);
      for (const e of this.invoices.values()) {
        if (invoiceKey(e) === k && e.id !== i.id) return "conflict";
      }
      if (seen.has(k)) return "conflict";
      seen.add(k);
    }
    // all checks passed: apply
    if (nextSub !== null) this.subs.set(nextSub.id, nextSub);
    for (const i of c.invoices ?? []) this.invoices.set(i.id, i);
    if (c.entitlements !== undefined) this.entitlements.set(c.entitlements.subscriptionId, [...c.entitlements.rows]);
    if (c.trialClaims !== undefined) {
      for (const k of c.trialClaims.keyHashes) this.claims.set(k, c.trialClaims.subscriptionId);
    }
    if (c.webhookEvent !== undefined) this.webhooks.add(`${c.webhookEvent.provider}:${c.webhookEvent.eventId}`);
    if (c.signup !== undefined) this.signups.set(c.signup.id, c.signup);
    this.events.push(...c.events);
    return "ok";
  }
}

// ---- fakes for ports owned by other modules ---------------------------------------------------

export class FakeAgePolicy implements AgePolicyPort {
  minAge = 21;
  private readonly ages = new Map<string, number>();
  setAge(userId: string, age: number): void {
    this.ages.set(userId, age);
  }
  async plusMinAge(): Promise<number> {
    return this.minAge;
  }
  async ageYears(userId: string): Promise<number | null> {
    return this.ages.get(userId) ?? null;
  }
}

export class FakePersonKeys implements PersonKeyPort {
  private readonly phones = new Map<string, string>();
  set(userId: string, phoneHash: string): void {
    this.phones.set(userId, phoneHash);
  }
  async phoneHash(userId: string): Promise<string | null> {
    return this.phones.get(userId) ?? null;
  }
}

export class FakeCardVault implements CardVaultPort {
  private readonly tokens = new Map<string, { userId: string; fingerprint: string }>();
  add(userId: string, tokenRef: string, fingerprint: string): void {
    this.tokens.set(tokenRef, { userId, fingerprint });
  }
  async describe(userId: string, tokenRef: string): Promise<{ fingerprint: string } | null> {
    const t = this.tokens.get(tokenRef);
    return t !== undefined && t.userId === userId ? { fingerprint: t.fingerprint } : null;
  }
}

/** Scripted PSP: the same idempotency key always returns the same outcome. */
export class FakeRecurringCharges implements RecurringChargePort {
  readonly requests: ChargeRequest[] = [];
  private readonly results = new Map<string, ChargeOutcome>();
  private readonly scripted: ChargeOutcome[] = [];
  /** Next unseen key gets this outcome (FIFO). Otherwise succeeds. */
  script(...outcomes: ChargeOutcome[]): void {
    this.scripted.push(...outcomes);
  }
  failNext(reason = "card_declined", n = 1): void {
    for (let i = 0; i < n; i += 1) this.script({ kind: "failed", provider: "fake_psp", reason });
  }
  async charge(req: ChargeRequest): Promise<ChargeOutcome> {
    this.requests.push(req);
    const prior = this.results.get(req.idempotencyKey);
    if (prior !== undefined) return prior;
    const out = this.scripted.shift() ?? {
      kind: "succeeded" as const,
      provider: "fake_psp",
      pspRef: `psp_${this.results.size + 1}`,
    };
    this.results.set(req.idempotencyKey, out);
    return out;
  }
  uniqueKeys(): number {
    return this.results.size;
  }
}

export class FakeRefunds implements PlusRefundPort {
  readonly refunds: { key: string; amountMinor: bigint; invoiceId: string }[] = [];
  fail = false;
  async refund(req: Parameters<PlusRefundPort["refund"]>[0]) {
    if (this.fail) return { kind: "failed" as const, reason: "psp_down" };
    if (!this.refunds.some((r) => r.key === req.idempotencyKey)) {
      this.refunds.push({ key: req.idempotencyKey, amountMinor: req.amountMinor, invoiceId: req.invoiceId });
    }
    return { kind: "initiated" as const };
  }
}

/** Idempotent on key; refuses an unbalanced entry like the real ledger would. */
export class FakeLedger implements LedgerPort {
  readonly entries: JournalEntry[] = [];
  async post(entry: JournalEntry): Promise<void> {
    if (this.entries.some((e) => e.idempotencyKey === entry.idempotencyKey)) return;
    const total = entry.postings.reduce((a, p) => a + p.amount.amount, 0n);
    if (total !== 0n) throw new Error(`unbalanced entry ${entry.kind}: ${total}`);
    this.entries.push(entry);
  }
  net(account: string): bigint {
    return this.entries.reduce(
      (a, e) => a + e.postings.filter((p) => p.account === account).reduce((s, p) => s + p.amount.amount, 0n),
      0n,
    );
  }
}

export class FakeTaxReceipts implements TaxReceiptPort {
  readonly queued: { invoiceId: string; grossMinor: bigint; vatMinor: bigint }[] = [];
  async queuePlusReceipt(i: { invoiceId: string; userId: string; grossMinor: bigint; vatMinor: bigint }): Promise<void> {
    if (!this.queued.some((q) => q.invoiceId === i.invoiceId)) {
      this.queued.push({ invoiceId: i.invoiceId, grossMinor: i.grossMinor, vatMinor: i.vatMinor });
    }
  }
}

export class FakeNotices implements MemberNoticePort {
  readonly sent: { userId: string; template: MemberNoticeTemplate; data: Readonly<Record<string, string | number>> }[] = [];
  async send(i: { userId: string; template: MemberNoticeTemplate; data: Readonly<Record<string, string | number>> }): Promise<void> {
    this.sent.push(i);
  }
}

/** All switches on by default in tests; `disable` models a kill switch being thrown. */
export class FakeFlags implements FeatureGatePort {
  private readonly off = new Set<string>();
  disable(key: string): void {
    this.off.add(key);
  }
  enable(key: string): void {
    this.off.delete(key);
  }
  async enabled(key: string): Promise<boolean> {
    return !this.off.has(key);
  }
}

export class FakePlanApprovals implements PlanPriceApprovalPort {
  private readonly approved = new Set<string>();
  approve(approvalId: string): void {
    this.approved.add(approvalId);
  }
  async consume(i: { approvalId: string }): Promise<boolean> {
    return this.approved.delete(i.approvalId);
  }
}

export class HmacKeyHasher implements KeyHasherPort {
  constructor(private readonly secret: string) {}
  hash(value: string): string {
    return createHmac("sha256", this.secret).update(value).digest("hex");
  }
}
