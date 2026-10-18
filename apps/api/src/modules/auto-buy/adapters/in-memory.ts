import type {
  AttemptRecord,
  AutoBuyDomainEvent,
  AutoBuyFlagsPort,
  AutoBuyStore,
  AutoBuyTx,
  BudgetGatePort,
  CardVaultPort,
  CatalogQuotePort,
  DeliverabilityPort,
  InventoryHoldPort,
  MandateRecord,
  MandateTextRecord,
  MandateWithLatest,
  MemberEligibilityPort,
  MitCheckoutPort,
  MitLookup,
  MitRequest,
  MitResult,
  Notice,
  NoticePort,
  OpsAuditPort,
  RiskPort,
  SkuQuote,
} from "../domain/ports";
import { OPEN_ATTEMPT_STATES, type BudgetDecision, type MandateLocale, type RiskDecision, type TokenState } from "../domain/bridge";

interface State {
  texts: Map<string, MandateTextRecord>;
  mandates: Map<string, MandateRecord>;
  attempts: Map<string, AttemptRecord>;
  events: AutoBuyDomainEvent[];
}

const textKey = (v: number, l: MandateLocale): string => `${v}:${l}`;
const clone = (s: State): State => ({
  texts: new Map(s.texts),
  mandates: new Map(s.mandates),
  attempts: new Map(s.attempts),
  events: [...s.events],
});

/**
 * In-memory store with the same observable contract as the Postgres adapter: transactions are
 * serialized, commit all-or-nothing, and enforce the unique keys and immutability of the migration.
 */
export class InMemoryAutoBuyStore implements AutoBuyStore {
  private state: State = { texts: new Map(), mandates: new Map(), attempts: new Map(), events: [] };
  private chain: Promise<unknown> = Promise.resolve();

  /** Test inspection. */
  get events(): readonly AutoBuyDomainEvent[] {
    return this.state.events;
  }
  get attemptsAll(): readonly AttemptRecord[] {
    return [...this.state.attempts.values()];
  }
  get mandatesAll(): readonly MandateRecord[] {
    return [...this.state.mandates.values()];
  }

  private tx(s: State): AutoBuyTx {
    const armedOf = (userId: string): MandateRecord[] => [...s.mandates.values()].filter((m) => m.userId === userId && m.status === "ARMED");
    return {
      getText: async (v, l) => s.texts.get(textKey(v, l)) ?? null,
      putText: async (r) => {
        const k = textKey(r.version, r.locale);
        if (s.texts.has(k)) throw new Error("auto_buy_mandate_texts rows are immutable");
        s.texts.set(k, r);
      },
      lockUser: async () => undefined, // run() is serialised in memory
      countArmed: async (userId) => armedOf(userId).length,
      insertMandate: async (r) => {
        if (armedOf(r.userId).some((m) => m.skuId === r.skuId)) return "duplicate_active";
        if (r.maxPrice < r.targetPrice || r.targetPrice <= 0n) throw new Error("check violation: auto_buy_mandates_max_ge_target");
        if ((r.mode === "unattended") !== (r.pspTokenRef !== null)) throw new Error("check violation: auto_buy_mandates_mode_token");
        s.mandates.set(r.id, r);
        return "inserted";
      },
      getMandateForUpdate: async (id) => s.mandates.get(id) ?? null,
      getOwnedMandateForUpdate: async (userId, id) => {
        const m = s.mandates.get(id);
        return m !== undefined && m.userId === userId ? m : null;
      },
      closeMandate: async (id, status, reason, atMs) => {
        const m = s.mandates.get(id);
        if (m === undefined) throw new Error("mandate not found");
        if (m.status !== "ARMED") throw new Error("a closed auto-buy mandate cannot be reopened");
        s.mandates.set(id, { ...m, status, closedReason: reason, updatedAtMs: atMs });
      },
      lastAttemptAt: async (mandateId) => {
        const times = [...s.attempts.values()].filter((a) => a.mandateId === mandateId && a.noticeSentAtMs !== null).map((a) => a.createdAtMs);
        return times.length === 0 ? null : Math.max(...times);
      },
      insertAttempt: async (r) => {
        const dup = [...s.attempts.values()].some((a) => a.mandateId === r.mandateId && a.priceEventId === r.priceEventId);
        if (dup) return "exists";
        s.attempts.set(r.id, r);
        return "inserted";
      },
      getAttemptForUpdate: async (id) => s.attempts.get(id) ?? null,
      getOwnedAttemptForUpdate: async (userId, id) => {
        const a = s.attempts.get(id);
        return a !== undefined && a.userId === userId ? a : null;
      },
      updateAttempt: async (r) => {
        const cur = s.attempts.get(r.id);
        if (cur === undefined) throw new Error("attempt not found");
        // Identity and trigger columns are fixed at insert, exactly as the SQL UPDATE leaves them.
        s.attempts.set(r.id, {
          ...r,
          mandateId: cur.mandateId,
          userId: cur.userId,
          priceEventId: cur.priceEventId,
          mode: cur.mode,
          triggerPrice: cur.triggerPrice,
          createdAtMs: cur.createdAtMs,
        });
      },
      openAttemptsOfMandate: async (mandateId) =>
        [...s.attempts.values()].filter((a) => a.mandateId === mandateId && OPEN_ATTEMPT_STATES.includes(a.state)),
      emit: async (events) => {
        s.events.push(...events);
      },
    };
  }

  run<T>(fn: (tx: AutoBuyTx) => Promise<T>): Promise<T> {
    const result = this.chain.then(async () => {
      const draft = clone(this.state);
      const out = await fn(this.tx(draft));
      this.state = draft;
      return out;
    });
    this.chain = result.catch(() => undefined);
    return result;
  }

  private snapshot(): State {
    return this.state;
  }

  async listForUser(userId: string, limit: number): Promise<readonly MandateWithLatest[]> {
    const s = this.snapshot();
    return [...s.mandates.values()]
      .filter((m) => m.userId === userId)
      .sort((a, b) => b.createdAtMs - a.createdAtMs || (a.id < b.id ? 1 : -1))
      .slice(0, limit)
      .map((mandate) => {
        const latest = [...s.attempts.values()]
          .filter((a) => a.mandateId === mandate.id)
          .sort((a, b) => b.createdAtMs - a.createdAtMs || (a.id < b.id ? 1 : -1))[0];
        return { mandate, latest: latest ?? null };
      });
  }

  async armedForSku(skuId: string, price: bigint, limit: number): Promise<readonly MandateRecord[]> {
    return [...this.snapshot().mandates.values()]
      .filter((m) => m.status === "ARMED" && m.skuId === skuId && m.targetPrice >= price)
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .slice(0, limit);
  }

  async armedForUser(userId: string, tokenRef: string | null): Promise<readonly MandateRecord[]> {
    return [...this.snapshot().mandates.values()].filter(
      (m) => m.userId === userId && m.status === "ARMED" && (tokenRef === null || m.pspTokenRef === tokenRef),
    );
  }

  private attemptsWhere(pred: (a: AttemptRecord) => boolean, limit: number): AttemptRecord[] {
    return [...this.snapshot().attempts.values()].filter(pred).sort((a, b) => a.updatedAtMs - b.updatedAtMs).slice(0, limit);
  }

  async dueAttempts(nowMs: number, limit: number): Promise<readonly AttemptRecord[]> {
    return this.attemptsWhere((a) => a.state === "NOTIFIED" && a.mode === "unattended" && a.cancelDeadlineMs !== null && a.cancelDeadlineMs <= nowMs, limit);
  }
  async staleNotices(beforeMs: number, limit: number): Promise<readonly AttemptRecord[]> {
    return this.attemptsWhere((a) => a.state === "NOTIFIED" && a.mode === "unattended" && a.cancelDeadlineMs !== null && a.cancelDeadlineMs <= beforeMs, limit);
  }
  async stuckTriggered(beforeMs: number, limit: number): Promise<readonly AttemptRecord[]> {
    return this.attemptsWhere((a) => a.state === "TRIGGERED" && a.createdAtMs <= beforeMs, limit);
  }
  async unresolvedCharges(beforeMs: number, limit: number): Promise<readonly AttemptRecord[]> {
    return this.attemptsWhere((a) => a.state === "CHARGING" && a.chargeStartedAtMs !== null && a.chargeStartedAtMs <= beforeMs, limit);
  }
  async manualReview(limit: number): Promise<readonly AttemptRecord[]> {
    return this.attemptsWhere((a) => a.state === "MANUAL_REVIEW", limit);
  }
  async abandonedSca(beforeMs: number, limit: number): Promise<readonly AttemptRecord[]> {
    return this.attemptsWhere((a) => a.state === "REQUIRES_USER_ACTION" && a.updatedAtMs <= beforeMs, limit);
  }
  async expiredMandates(nowMs: number, limit: number): Promise<readonly MandateRecord[]> {
    return [...this.snapshot().mandates.values()].filter((m) => m.status === "ARMED" && m.expiresAtMs <= nowMs).slice(0, limit);
  }
  async armedForUserSku(userId: string, skuId: string): Promise<readonly MandateRecord[]> {
    return [...this.snapshot().mandates.values()].filter((m) => m.userId === userId && m.skuId === skuId && m.status === "ARMED");
  }
}

// ---- development and test fakes of ports owned by other modules ---------------------------------

export class FakeAutoBuyFlags implements AutoBuyFlagsPort {
  constructor(
    public rules = true,
    public charge = false,
  ) {}
  async rulesEnabled(): Promise<boolean> {
    return this.rules;
  }
  async chargeEnabled(): Promise<boolean> {
    return this.charge;
  }
}

export class FakeMemberEligibility implements MemberEligibilityPort {
  readonly byUser = new Map<string, { plusActive: boolean; ageOk: boolean }>();
  constructor(private readonly fallback = { plusActive: true, ageOk: true }) {}
  async eligibility(userId: string): Promise<{ plusActive: boolean; ageOk: boolean }> {
    return this.byUser.get(userId) ?? this.fallback;
  }
}

export class FakeCatalogQuote implements CatalogQuotePort {
  readonly skus = new Map<string, SkuQuote>();
  async quote(skuId: string, sizeLabel: string): Promise<SkuQuote | null> {
    const q = this.skus.get(skuId);
    if (q === undefined) return null;
    return sizeLabel.length === 0 ? { ...q, sizeKnown: false } : q;
  }
}

export class FakeDeliverability implements DeliverabilityPort {
  deliverable_ = true;
  async deliverable(): Promise<boolean> {
    return this.deliverable_;
  }
}

export class FakeRisk implements RiskPort {
  decision: RiskDecision = "allow";
  readonly calls: { stage: string }[] = [];
  async decide(input: { stage: "create" | "charge" }): Promise<RiskDecision> {
    this.calls.push({ stage: input.stage });
    return this.decision;
  }
}

export class FakeBudgetGate implements BudgetGatePort {
  decision: BudgetDecision = "within";
  async evaluate(): Promise<BudgetDecision> {
    return this.decision;
  }
}

export class FakeCardVault implements CardVaultPort {
  readonly tokens = new Map<string, TokenState>();
  async inspect(_userId: string, tokenRef: string): Promise<TokenState> {
    return this.tokens.get(tokenRef) ?? "not_found";
  }
}

export class FakeInventoryHold implements InventoryHoldPort {
  readonly held = new Set<string>();
  readonly released: string[] = [];
  available = true;
  throwOnRelease = false;
  async reserve(input: { holdKey: string }): Promise<"held" | "unavailable"> {
    if (!this.available) return "unavailable";
    this.held.add(input.holdKey);
    return "held";
  }
  async release(holdKey: string): Promise<void> {
    if (this.throwOnRelease) throw new Error("release failed");
    this.held.delete(holdKey);
    this.released.push(holdKey);
  }
}

/**
 * Fake merchant-initiated charge. Counts every call so tests can assert that NO call happens with
 * the charge switch off. Unscripted calls DECLINE: a fake never invents a successful payment.
 */
export class FakeMitCheckout implements MitCheckoutPort {
  readonly placeCalls: MitRequest[] = [];
  readonly lookupCalls: string[] = [];
  next: MitResult | "throw" = { kind: "declined", code: "fake_unconfigured" };
  readonly placed = new Map<string, string>();
  /** Scripted lookup answers per key (overrides `placed`): models an in-flight or failed saga. */
  readonly lookupAnswers = new Map<string, MitLookup>();
  /** Throws on lookup (PSP unreachable). */
  lookupThrows = false;
  async placeOrder(req: MitRequest): Promise<MitResult> {
    this.placeCalls.push(req);
    if (this.next === "throw") throw new Error("psp down");
    if (this.next.kind === "placed") this.placed.set(req.idempotencyKey, this.next.orderGroupId);
    return this.next;
  }
  async lookup(key: string): Promise<MitLookup> {
    this.lookupCalls.push(key);
    if (this.lookupThrows) throw new Error("psp unreachable");
    const scripted = this.lookupAnswers.get(key);
    if (scripted !== undefined) return scripted;
    const og = this.placed.get(key);
    return og === undefined ? { kind: "not_found" } : { kind: "placed", orderGroupId: og };
  }
}

export class FakeNotices implements NoticePort {
  readonly sent: Notice[] = [];
  result: "accepted" | "failed" | "throw" = "accepted";
  async send(n: Notice): Promise<"accepted" | "failed"> {
    if (this.result === "throw") throw new Error("notifications down");
    if (this.result === "accepted") this.sent.push(n);
    return this.result;
  }
}

/** Records operator audit entries (dev and tests). `failNext` models an audit outage: the action must not run. */
export class RecordingOpsAudit implements OpsAuditPort {
  readonly entries: Parameters<OpsAuditPort["append"]>[0][] = [];
  failNext = false;
  async append(entry: Parameters<OpsAuditPort["append"]>[0]): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("audit unavailable");
    }
    this.entries.push(entry);
  }
}
