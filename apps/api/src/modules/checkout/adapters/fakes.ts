import { z } from "zod";
import {
  money,
  promotions,
  reservationTtlSeconds,
  vatIncluded,
  type CheckoutMethod,
  type Money,
  type SubBalanceSpend,
  type SubBalanceState,
} from "../domain/bridge";
import {
  LedgerKeyConflictError,
  type AddressPort,
  type AddressResolution,
  type AgeGate,
  type AgePolicyPort,
  type AppAttestPort,
  type DropAdmissionPort,
  type BagSnapshot,
  type CartPort,
  type CodConfirmationPort,
  type ClaimResult,
  type CreateIntentResult,
  type HoldResult,
  type InventoryPort,
  type JournalEntryLike,
  type KillSwitchPort,
  type LedgerPort,
  type MetricsPort,
  type OrdersIntakePort,
  type PaymentProviderPort,
  type PaymentRegistry,
  type PlaceOrdersCommand,
  type PromotionsPort,
  type ReserveResult,
  type RiskDecision,
  type RiskPort,
  type CaptureResult,
  type StoreCreditPort,
  type TaxPort,
  type WebhookVerification,
} from "../domain/ports";
import type { Clock } from "../../../platform/ports";

// ---------------------------------------------------------------------------- read-side fakes

export class FakeCart implements CartPort {
  private readonly bags = new Map<string, BagSnapshot>();
  readonly removed: { userId: string; lineIds: readonly string[] }[] = [];
  set(userId: string, bag: BagSnapshot): void {
    this.bags.set(userId, bag);
  }
  async snapshot(userId: string): Promise<BagSnapshot> {
    return this.bags.get(userId) ?? { lines: [], stores: new Map(), plusMember: false };
  }
  async removePurchased(userId: string, lineIds: readonly string[]): Promise<void> {
    this.removed.push({ userId, lineIds });
  }
}

/** Runs the real, tested promotions evaluator over an in-memory pool. */
export class FakePromotions implements PromotionsPort {
  constructor(private readonly pool: readonly promotions.Promotion[] = []) {}
  async evaluate(input: Parameters<PromotionsPort["evaluate"]>[0]): Promise<promotions.EvaluationResult> {
    return promotions.evaluatePromotions({ ...input, usage: new Map() }, this.pool);
  }
}

export class FakeTax implements TaxPort {
  constructor(private readonly vatBps: bigint = 1_400n) {}
  async quote(input: Parameters<TaxPort["quote"]>[0]): ReturnType<TaxPort["quote"]> {
    return {
      vatBps: this.vatBps,
      lines: input.lines.map((l) => ({
        id: l.id,
        vat: vatIncluded(money(l.unitGross.amount * BigInt(l.qty)), this.vatBps),
      })),
    };
  }
}

export class FakeRisk implements RiskPort {
  decision: RiskDecision = { kind: "allow" };
  calls = 0;
  async assessCod(): Promise<RiskDecision> {
    this.calls += 1;
    return this.decision;
  }
}

export class FakeAgePolicy implements AgePolicyPort {
  readonly blocked = new Set<CheckoutMethod>();
  async checkMethod(_userId: string, method: CheckoutMethod): Promise<AgeGate> {
    return this.blocked.has(method) ? { allowed: false, minAge: 21, provider: "fake-bnpl" } : { allowed: true };
  }
}

export class FakeKillSwitch implements KillSwitchPort {
  readonly disabled = new Set<CheckoutMethod>();
  async disabledMethods(): Promise<ReadonlySet<CheckoutMethod>> {
    return new Set(this.disabled);
  }
}

export class FakeAddresses implements AddressPort {
  readonly covered = new Map<string, string>(); // addressId -> userId
  readonly uncovered = new Set<string>();
  add(userId: string, addressId: string): void {
    this.covered.set(addressId, userId);
  }
  async resolve(userId: string, addressId: string): Promise<AddressResolution> {
    if (this.covered.get(addressId) !== userId && !this.uncovered.has(addressId)) return { kind: "not_found" };
    if (this.uncovered.has(addressId)) return { kind: "not_covered" };
    return { kind: "ok", contact: { firstName: "Mona", phoneRelay: "+20100000099", governorateCode: "EG-C" } };
  }
}

export class FakeAppAttest implements AppAttestPort {
  /** Accepts only the assertion "valid-assertion". */
  async verify(input: { assertion: string | null }): Promise<boolean> {
    return input.assertion === "valid-assertion";
  }
}

/** Accepts the token "valid-admission-token-0001" once per user. */
export class FakeDropAdmission implements DropAdmissionPort {
  readonly used = new Set<string>();
  async redeem(i: { userId: string; token: string | null }): ReturnType<DropAdmissionPort["redeem"]> {
    if (i.token === null) return "required";
    if (i.token !== "valid-admission-token-0001") return "invalid";
    const k = `${i.userId}`;
    if (this.used.has(k)) return "already_used";
    this.used.add(k);
    return "ok";
  }
}

export class FakeMetrics implements MetricsPort {
  readonly counters = new Map<string, number>();
  increment(name: string): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + 1);
  }
  count(name: string): number {
    return this.counters.get(name) ?? 0;
  }
}

// ---------------------------------------------------------------------------- inventory

interface FakeReservation {
  readonly units: Map<string, number>;
  expiresAtMs: number;
  state: "active" | "released" | "claimed";
}

/** Row-per-unit semantics in miniature: reserve, claim (also after expiry if stock remains), release. */
export class FakeInventory implements InventoryPort {
  private readonly onHand = new Map<string, number>();
  private readonly reservations = new Map<string, FakeReservation>();
  constructor(private readonly clock: Clock) {}

  setStock(skuId: string, qty: number): void {
    this.onHand.set(skuId, qty);
  }
  private committed(skuId: string): number {
    let n = 0;
    for (const r of this.reservations.values()) if (r.state === "claimed") n += r.units.get(skuId) ?? 0;
    return n;
  }
  private reserved(skuId: string): number {
    const now = this.clock.nowMs();
    let n = 0;
    for (const r of this.reservations.values()) {
      if (r.state === "active" && r.expiresAtMs > now) n += r.units.get(skuId) ?? 0;
    }
    return n;
  }
  available(skuId: string): number {
    return (this.onHand.get(skuId) ?? 0) - this.committed(skuId) - this.reserved(skuId);
  }
  /** Units claimed beyond on-hand stock: must always be false. */
  oversold(): boolean {
    return [...this.onHand.keys()].some((sku) => this.committed(sku) > (this.onHand.get(sku) ?? 0));
  }
  activeReservations(): number {
    return [...this.reservations.values()].filter((r) => r.state === "active").length;
  }
  claimedGroups(): number {
    return [...this.reservations.values()].filter((r) => r.state === "claimed").length;
  }
  /** Test hook: stock vanished to another buyer. */
  takeStock(skuId: string, qty: number): void {
    this.onHand.set(skuId, Math.max(0, (this.onHand.get(skuId) ?? 0) - qty));
  }

  async reserve(input: Parameters<InventoryPort["reserve"]>[0]): Promise<ReserveResult> {
    const existing = this.reservations.get(input.orderGroupId);
    if (existing !== undefined && existing.state === "active") {
      return { kind: "reserved", reservationId: `res:${input.orderGroupId}`, expiresAtMs: existing.expiresAtMs };
    }
    const shortfalls = input.lines
      .map((l) => ({ skuId: l.skuId, requested: l.qty, available: Math.max(0, this.available(l.skuId)) }))
      .filter((s) => s.available < s.requested);
    if (shortfalls.length > 0) return { kind: "insufficient", shortfalls };
    const expiresAtMs = this.clock.nowMs() + reservationTtlSeconds(input.method) * 1000;
    this.reservations.set(input.orderGroupId, {
      units: new Map(input.lines.map((l) => [l.skuId, l.qty])),
      expiresAtMs,
      state: "active",
    });
    return { kind: "reserved", reservationId: `res:${input.orderGroupId}`, expiresAtMs };
  }

  async claim(orderGroupId: string): Promise<ClaimResult> {
    const r = this.reservations.get(orderGroupId);
    if (r === undefined) return { kind: "not_found" };
    if (r.state === "claimed") return { kind: "already_claimed" };
    const live = r.state === "active" && r.expiresAtMs > this.clock.nowMs();
    if (live) {
      r.state = "claimed";
      return { kind: "claimed" };
    }
    // Expired or released: claim late only if every unit is still free.
    r.state = "released";
    const ok = [...r.units].every(([sku, qty]) => this.available(sku) >= qty);
    if (!ok) return { kind: "unavailable" };
    r.state = "claimed";
    return { kind: "claimed_late" };
  }

  async release(orderGroupId: string): Promise<void> {
    const r = this.reservations.get(orderGroupId);
    // Mirrors the real store: release only acts on an ACTIVE reservation (a claimed one is a noop).
    if (r === undefined || r.state !== "active") return;
    r.state = "released";
  }

  async unclaim(orderGroupId: string): Promise<void> {
    const r = this.reservations.get(orderGroupId);
    if (r === undefined || r.state !== "claimed") return;
    r.state = "released";
  }
}

// ---------------------------------------------------------------------------- store credit

export class FakeStoreCredit implements StoreCreditPort {
  private balancesByUser = new Map<string, SubBalanceState[]>();
  private readonly holds = new Map<string, { userId: string; plan: readonly SubBalanceSpend[]; state: "held" | "captured" | "released"; ttlSeconds: number }>();
  /** Every hold ever placed, by id, with the TTL the saga asked for. */
  readonly ttlSecondsOf = (holdId: string): number | undefined => this.holds.get(holdId)?.ttlSeconds;
  readonly holdIds = (): string[] => [...this.holds.keys()];
  /** Simulates the TTL sweeper (or any other path) losing a hold. */
  forceRelease(holdId: string): void {
    const h = this.holds.get(holdId);
    if (h !== undefined && h.state === "held") h.state = "released";
  }
  /** Simulates a store that can no longer plan the credit (balance spent elsewhere). */
  denyNewHolds = false;
  setBalances(userId: string, balances: SubBalanceState[]): void {
    this.balancesByUser.set(userId, balances);
  }
  async balances(userId: string): Promise<readonly SubBalanceState[]> {
    return this.balancesByUser.get(userId) ?? [];
  }
  async hold(input: Parameters<StoreCreditPort["hold"]>[0]): Promise<HoldResult> {
    const prior = this.holds.get(input.holdId);
    if (prior !== undefined) return prior.state === "released" ? { kind: "insufficient" } : { kind: "held", holdId: input.holdId };
    if (this.denyNewHolds) return { kind: "insufficient" };
    const have = new Map((this.balancesByUser.get(input.userId) ?? []).map((b) => [JSON.stringify(b.sub), b.balance.amount]));
    for (const p of input.plan) {
      if ((have.get(JSON.stringify(p.sub)) ?? 0n) < p.amount.amount) return { kind: "insufficient" };
    }
    this.holds.set(input.holdId, { userId: input.userId, plan: input.plan, state: "held", ttlSeconds: input.ttlSeconds });
    return { kind: "held", holdId: input.holdId };
  }
  async capture(input: { holdId: string; userId: string; orderEntryKey: string }): Promise<CaptureResult> {
    const h = this.holds.get(input.holdId);
    if (h === undefined) return { kind: "not_found" };
    if (h.state === "captured") return { kind: "captured" };
    if (h.state !== "held") return { kind: "not_held" };
    h.state = "captured";
    return { kind: "captured" };
  }
  async release(input: { holdId: string; userId: string }): Promise<void> {
    const h = this.holds.get(input.holdId);
    if (h !== undefined && h.state === "held") h.state = "released";
  }
  states(): readonly ("held" | "captured" | "released")[] {
    return [...this.holds.values()].map((h) => h.state);
  }
  leaked(): number {
    return this.states().filter((s) => s === "held").length;
  }
  captured(): number {
    return this.states().filter((s) => s === "captured").length;
  }
}

// ---------------------------------------------------------------------------- payments

const FakeEvent = z
  .object({
    event_id: z.string().min(1).max(128),
    intent_id: z.string().min(1).max(128),
    order_group_id: z.string().min(1).max(64),
    kind: z.enum(["succeeded", "failed"]),
    amount: z.string().regex(/^\d+$/),
    ts: z.number().int(),
  })
  .strict();

/** In-repo PSP double. The signature is the literal header `x-fake-signature: ok`. NOT a model of Paymob. */
export class FakePaymentProvider implements PaymentProviderPort {
  readonly intents = new Map<string, { key: string; amount: bigint; state: "open" | "succeeded" | "voided" }>();
  readonly refunds = new Map<string, bigint>();
  createIntentCalls = 0;
  failCreate: "none" | "reject" = "none";
  constructor(
    readonly provider = "fake-psp",
    private readonly clock: Clock = { nowMs: () => Date.now() },
  ) {}

  async createIntent(input: Parameters<PaymentProviderPort["createIntent"]>[0]): Promise<CreateIntentResult> {
    this.createIntentCalls += 1;
    if (this.failCreate === "reject") return { kind: "rejected", code: "declined" };
    const intentId = `pi_${input.idempotencyKey}`;
    if (!this.intents.has(intentId)) {
      this.intents.set(intentId, { key: input.idempotencyKey, amount: input.amount.amount, state: "open" });
    }
    const clientAction =
      input.method === "fawry"
        ? { type: "fawry_reference" as const, reference: `FWR-${input.idempotencyKey.slice(0, 8)}`, expiresAtMs: this.clock.nowMs() + 86_400_000 }
        : { type: "redirect" as const, url: `https://pay.fake.invalid/${intentId}` };
    return { kind: "created", intentId, provider: this.provider, clientAction };
  }

  async voidIntent(intentId: string): Promise<{ kind: "voided" | "already_voided" } | { kind: "not_voidable_succeeded" }> {
    const i = this.intents.get(intentId);
    if (i === undefined) return { kind: "already_voided" };
    if (i.state === "succeeded") return { kind: "not_voidable_succeeded" };
    const was = i.state;
    i.state = "voided";
    return { kind: was === "voided" ? "already_voided" : "voided" };
  }

  async refund(input: { intentId: string; amount: Money; idempotencyKey: string }): Promise<void> {
    if (!this.refunds.has(input.idempotencyKey)) this.refunds.set(input.idempotencyKey, input.amount.amount);
  }

  /** Test hook: the shopper completed payment at the PSP. */
  markSucceeded(intentId: string): void {
    const i = this.intents.get(intentId);
    if (i !== undefined && i.state === "open") i.state = "succeeded";
  }
  /** Test hook: the payment completed at the PSP in a race with our void (money arrived after expiry). */
  forceSucceeded(intentId: string): void {
    const i = this.intents.get(intentId);
    if (i !== undefined) i.state = "succeeded";
  }
  netCharged(): bigint {
    let net = 0n;
    for (const i of this.intents.values()) if (i.state === "succeeded") net += i.amount;
    for (const r of this.refunds.values()) net -= r;
    return net;
  }
  succeededCount(): number {
    return [...this.intents.values()].filter((i) => i.state === "succeeded").length;
  }

  webhook(e: { eventId: string; intentId: string; orderGroupId: string; kind: "succeeded" | "failed"; amount: bigint; ts?: number }) {
    return {
      rawBody: JSON.stringify({
        event_id: e.eventId,
        intent_id: e.intentId,
        order_group_id: e.orderGroupId,
        kind: e.kind,
        amount: e.amount.toString(),
        ts: e.ts ?? this.clock.nowMs(),
      }),
      headers: { "x-fake-signature": "ok" } as Record<string, string>,
    };
  }

  verifyWebhook(rawBody: string, headers: Readonly<Record<string, string | undefined>>, nowMs: number): WebhookVerification {
    if (headers["x-fake-signature"] !== "ok") return { ok: false, reason: "bad_signature" };
    let parsed: z.infer<typeof FakeEvent>;
    try {
      parsed = FakeEvent.parse(JSON.parse(rawBody));
    } catch {
      return { ok: false, reason: "malformed" };
    }
    if (Math.abs(nowMs - parsed.ts) > 5 * 60 * 1000) return { ok: false, reason: "stale_timestamp" };
    return {
      ok: true,
      event: {
        eventId: parsed.event_id,
        provider: this.provider,
        intentId: parsed.intent_id,
        orderGroupId: parsed.order_group_id,
        kind: parsed.kind,
        amount: money(BigInt(parsed.amount)),
        occurredAtMs: parsed.ts,
      },
    };
  }
}

export class StaticPaymentRegistry implements PaymentRegistry {
  constructor(private readonly providers: readonly PaymentProviderPort[]) {}
  forMethod(): PaymentProviderPort | null {
    return this.providers[0] ?? null;
  }
  byName(name: string): PaymentProviderPort | null {
    return this.providers.find((p) => p.provider === name) ?? null;
  }
}

// ---------------------------------------------------------------------------- ledger and orders

export class FakeLedger implements LedgerPort {
  readonly entries = new Map<string, JournalEntryLike>();
  async post(entry: JournalEntryLike): Promise<{ kind: "posted" | "duplicate" }> {
    const prior = this.entries.get(entry.idempotencyKey);
    if (prior !== undefined) {
      const same = JSON.stringify(prior.postings.map((p) => [p.account, p.amount.amount.toString()])) ===
        JSON.stringify(entry.postings.map((p) => [p.account, p.amount.amount.toString()]));
      if (!same) throw new LedgerKeyConflictError(entry.idempotencyKey);
      return { kind: "duplicate" };
    }
    this.entries.set(entry.idempotencyKey, entry);
    return { kind: "posted" };
  }
  async find(key: string): Promise<JournalEntryLike | null> {
    return this.entries.get(key) ?? null;
  }
  trialBalance(): bigint {
    let t = 0n;
    for (const e of this.entries.values()) for (const p of e.postings) t += p.amount.amount;
    return t;
  }
  balance(account: string): bigint {
    let t = 0n;
    for (const e of this.entries.values()) for (const p of e.postings) if (p.account === account) t += p.amount.amount;
    return t;
  }
}

export class FakeOrdersIntake implements OrdersIntakePort {
  readonly placed = new Map<string, PlaceOrdersCommand>();
  private readonly keys = new Map<string, string>();
  async place(cmd: PlaceOrdersCommand): Promise<{ kind: "created" | "duplicate"; groupId: string }> {
    if (this.keys.has(cmd.idempotencyKey)) return { kind: "duplicate", groupId: cmd.groupId };
    this.keys.set(cmd.idempotencyKey, cmd.groupId);
    this.placed.set(cmd.groupId, cmd);
    return { kind: "created", groupId: cmd.groupId };
  }
}

export class FakeCodConfirmation implements CodConfirmationPort {
  /** Accepts only the code "123456". */
  async verify(input: { code: string }): Promise<boolean> {
    return input.code === "123456";
  }
}
