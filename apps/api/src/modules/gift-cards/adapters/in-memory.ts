import type { admin } from "@outlet/domain";
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { REDEMPTION_THROTTLE, evaluateThrottle, next } from "../domain/bridge";
import { StoreCreditRejectedError } from "../domain/ports";
import type {
  AdmitAttempt,
  AgeGatePort,
  AttemptRecord,
  ConfirmApply,
  AuditPort,
  BeginRedemption,
  CardPatch,
  CardRecord,
  CasResult,
  ContributionRecord,
  DeliveryPort,
  FieldCipherPort,
  GiftCardFlagsPort,
  GiftCardStore,
  KeysetPos,
  OutboxDraft,
  PaymentIntentPort,
  PotRecord,
  RandomPort,
  RedemptionRecord,
  SecretPort,
  StoreCreditPort,
  VoidApprovalPort,
  PaymentCancelResult,
} from "../domain/ports";

const applyPatch = (c: CardRecord, p: CardPatch): CardRecord => ({ ...c, ...p, version: c.version + 1 });

/** Reference implementation of the store contract. Single process, so each method is trivially atomic. */
export class InMemoryGiftCardStore implements GiftCardStore {
  readonly cards = new Map<string, CardRecord>();
  readonly redemptions = new Map<string, RedemptionRecord>();
  readonly attempts: AttemptRecord[] = [];
  readonly pots = new Map<string, PotRecord>();
  readonly contributions = new Map<string, ContributionRecord>();
  readonly outbox: OutboxDraft[] = [];

  async insertCard(card: CardRecord, events: readonly OutboxDraft[]) {
    for (const c of this.cards.values()) {
      if (c.purchaserId === card.purchaserId && c.idempotencyKey === card.idempotencyKey) return { kind: "duplicate" as const, card: c };
    }
    this.cards.set(card.id, card);
    this.outbox.push(...events);
    return { kind: "created" as const, card };
  }

  async getCard(id: string) {
    return this.cards.get(id) ?? null;
  }

  async findByCodeHash(hash: string) {
    for (const c of this.cards.values()) if (c.codeHash === hash) return c;
    return null;
  }

  async listByPurchaser(userId: string, limit: number) {
    return [...this.cards.values()]
      .filter((c) => c.purchaserId === userId)
      .sort((a, b) => b.createdAtMs - a.createdAtMs || (a.id < b.id ? 1 : -1))
      .slice(0, limit);
  }

  async updateCard(id: string, expectedVersion: number, patch: CardPatch, events: readonly OutboxDraft[]): Promise<CasResult> {
    const c = this.cards.get(id);
    if (c === undefined) return { kind: "not_found" };
    if (c.version !== expectedVersion) return { kind: "conflict" };
    if (patch.codeHash !== undefined && patch.codeHash !== null) {
      for (const o of this.cards.values()) if (o.id !== id && o.codeHash === patch.codeHash) throw new Error("code_hash unique violation");
    }
    const n = applyPatch(c, patch);
    this.cards.set(id, n);
    this.outbox.push(...events);
    return { kind: "ok", card: n };
  }

  async listExpirable(nowMs: number, limit: number) {
    return [...this.cards.values()]
      .filter((c) => (c.status === "ISSUED" || c.status === "DELIVERED") && c.expiresAtMs !== null && c.expiresAtMs <= nowMs)
      .sort((a, b) => (a.expiresAtMs ?? 0) - (b.expiresAtMs ?? 0))
      .slice(0, limit)
      .map((c) => c.id);
  }

  async beginRedemption(input: {
    cardId: string;
    userId: string;
    requested: bigint | null;
    redemptionId: string;
    nowMs: number;
  }): Promise<BeginRedemption> {
    const c = this.cards.get(input.cardId);
    if (c === undefined || c.codeHash === null) return { kind: "not_found" };
    if (c.status === "REDEEMED") return { kind: "empty" };
    if (c.status !== "ISSUED" && c.status !== "DELIVERED") return { kind: "unavailable", status: c.status };
    if (c.expiresAtMs !== null && input.nowMs >= c.expiresAtMs) return { kind: "unavailable", status: "EXPIRED" };
    if (c.remaining <= 0n) return { kind: "empty" };
    const amount = input.requested ?? c.remaining;
    if (amount <= 0n) return { kind: "empty" };
    if (amount > c.remaining) return { kind: "exceeds_balance", remaining: c.remaining };
    const remaining = c.remaining - amount;
    const full = remaining === 0n;
    const status = full ? next(c.status, "REDEEM", { nowMs: input.nowMs, expiresAtMs: c.expiresAtMs }) : c.status;
    const card = applyPatch(c, { remaining, status });
    this.cards.set(c.id, card);
    const redemption: RedemptionRecord = {
      id: input.redemptionId,
      cardId: c.id,
      userId: input.userId,
      amount,
      status: "pending",
      statusBefore: c.status,
      journalEntryId: null,
      createdAtMs: input.nowMs,
    };
    this.redemptions.set(redemption.id, redemption);
    return { kind: "ok", redemption, card, full };
  }

  async completeRedemption(redemptionId: string, journalEntryId: string, _nowMs: number, events: readonly OutboxDraft[]) {
    const r = this.redemptions.get(redemptionId);
    if (r === undefined || r.status !== "pending") return;
    this.redemptions.set(redemptionId, { ...r, status: "completed", journalEntryId });
    this.outbox.push(...events);
  }

  async reverseRedemption(redemptionId: string) {
    const r = this.redemptions.get(redemptionId);
    if (r === undefined || r.status !== "pending") return;
    const c = this.cards.get(r.cardId);
    if (c !== undefined) this.cards.set(c.id, applyPatch(c, { remaining: c.remaining + r.amount, status: r.statusBefore }));
    this.redemptions.set(redemptionId, { ...r, status: "reversed" });
  }

  async listPendingRedemptions(olderThanMs: number, limit: number) {
    return [...this.redemptions.values()]
      .filter((r) => r.status === "pending" && r.createdAtMs <= olderThanMs)
      .sort((a, b) => a.createdAtMs - b.createdAtMs)
      .slice(0, limit);
  }

  async listRedemptions(cardId: string) {
    return [...this.redemptions.values()].filter((r) => r.cardId === cardId);
  }

  async recordAttempt(a: AttemptRecord) {
    this.attempts.push(a);
  }

  /** Single-process, so check and record are one uninterrupted step (the Kysely store takes advisory locks). */
  async admitAttempt(a: Omit<AttemptRecord, "outcome">): Promise<AdmitAttempt> {
    const t = REDEMPTION_THROTTLE;
    // no await between the reads and the push: the check-and-record is one synchronous step
    const verdict = evaluateThrottle({
      nowMs: a.atMs,
      accountFailuresMs: this.failures({ accountId: a.accountId }, a.atMs - t.accountWindowMs),
      deviceFailuresMs: this.failures({ deviceHash: a.deviceHash }, a.atMs - t.deviceWindowMs),
      ipFailuresMs: this.failures({ ipHash: a.ipHash }, a.atMs - t.ipWindowMs),
    });
    this.attempts.push({ ...a, outcome: verdict.allowed ? "pending" : "throttled" });
    return verdict.allowed ? { allowed: true } : { allowed: false, scope: verdict.scope, retryAfterMs: verdict.retryAfterMs };
  }

  async finalizeAttempt(id: string, outcome: "ok" | "wrong") {
    const i = this.attempts.findIndex((x) => x.id === id && x.outcome === "pending");
    const cur = this.attempts[i];
    if (cur !== undefined) this.attempts[i] = { ...cur, outcome };
  }

  async failureTimes(scope: { accountId: string } | { deviceHash: string } | { ipHash: string }, sinceMs: number) {
    return this.failures(scope, sinceMs);
  }

  private failures(scope: { accountId: string } | { deviceHash: string } | { ipHash: string }, sinceMs: number): number[] {
    return this.attempts
      .filter((a) => (a.outcome === "wrong" || a.outcome === "pending") && a.atMs > sinceMs)
      .filter((a) =>
        "accountId" in scope ? a.accountId === scope.accountId : "deviceHash" in scope ? a.deviceHash === scope.deviceHash : a.ipHash === scope.ipHash,
      )
      .map((a) => a.atMs);
  }

  async purgeAttemptsBefore(cutoffMs: number) {
    const before = this.attempts.length;
    const keep = this.attempts.filter((a) => a.atMs >= cutoffMs);
    this.attempts.length = 0;
    this.attempts.push(...keep);
    return before - keep.length;
  }

  async listThrottledAttempts(after: KeysetPos | null, limit: number) {
    return this.attempts
      .filter((a) => a.outcome === "throttled")
      .filter((a) => after === null || a.atMs < after.ms || (a.atMs === after.ms && a.id < after.id))
      .sort((x, y) => y.atMs - x.atMs || (x.id < y.id ? 1 : -1))
      .slice(0, limit);
  }

  async listPotsPage(after: KeysetPos | null, limit: number) {
    return [...this.pots.values()]
      .filter((p) => after === null || p.createdAtMs < after.ms || (p.createdAtMs === after.ms && p.id < after.id))
      .sort((x, y) => y.createdAtMs - x.createdAtMs || (x.id < y.id ? 1 : -1))
      .slice(0, limit);
  }

  async insertPot(pot: PotRecord, card: CardRecord, events: readonly OutboxDraft[]) {
    for (const c of this.cards.values()) {
      if (c.purchaserId === card.purchaserId && c.idempotencyKey === card.idempotencyKey) {
        const existing = c.potId === null ? null : (this.pots.get(c.potId) ?? null);
        if (existing !== null) return { kind: "duplicate" as const, pot: existing, card: c };
      }
    }
    this.pots.set(pot.id, pot);
    this.cards.set(card.id, card);
    this.outbox.push(...events);
    return { kind: "created" as const, pot, card };
  }

  async getPot(id: string) {
    return this.pots.get(id) ?? null;
  }

  async getPotByTokenHash(hash: string) {
    for (const p of this.pots.values()) if (p.shareTokenHash === hash) return p;
    return null;
  }

  async updatePot(
    id: string,
    expectedVersion: number,
    patch: { status: PotRecord["status"]; closedAtMs?: number },
    cardPatch: { patch: CardPatch; events: readonly OutboxDraft[] } | null,
    events: readonly OutboxDraft[],
  ) {
    const p = this.pots.get(id);
    if (p === undefined) return { kind: "not_found" as const };
    if (p.version !== expectedVersion) return { kind: "conflict" as const };
    const n: PotRecord = { ...p, status: patch.status, closedAtMs: patch.closedAtMs ?? p.closedAtMs, version: p.version + 1 };
    this.pots.set(id, n);
    if (cardPatch !== null) {
      const c = this.cards.get(p.cardId);
      if (c !== undefined) this.cards.set(c.id, applyPatch(c, cardPatch.patch));
      this.outbox.push(...cardPatch.events);
    }
    this.outbox.push(...events);
    return { kind: "ok" as const, pot: n };
  }

  async listDuePots(nowMs: number, limit: number) {
    return [...this.pots.values()]
      .filter((p) => p.status === "OPEN" && p.closesAtMs <= nowMs)
      .slice(0, limit)
      .map((p) => p.id);
  }

  async listPotsInState(state: PotRecord["status"], limit: number) {
    return [...this.pots.values()].filter((p) => p.status === state).slice(0, limit).map((p) => p.id);
  }

  async insertContribution(c: ContributionRecord) {
    for (const o of this.contributions.values()) {
      if (o.userId === c.userId && o.idempotencyKey === c.idempotencyKey) return { kind: "duplicate" as const, contribution: o };
    }
    this.contributions.set(c.id, c);
    return { kind: "created" as const, contribution: c };
  }

  async getContribution(id: string) {
    return this.contributions.get(id) ?? null;
  }

  async updateContribution(
    id: string,
    patch: { status: ContributionRecord["status"]; paymentIntentId?: string },
    onlyFrom?: readonly ContributionRecord["status"][],
  ) {
    const c = this.contributions.get(id);
    if (c === undefined) return null;
    if (onlyFrom !== undefined && !onlyFrom.includes(c.status)) return null;
    const n: ContributionRecord = { ...c, status: patch.status, paymentIntentId: patch.paymentIntentId ?? c.paymentIntentId };
    this.contributions.set(id, n);
    return n;
  }

  async confirmContribution(contributionId: string, paymentIntentId: string): Promise<ConfirmApply> {
    const c = this.contributions.get(contributionId);
    if (c === undefined) return { kind: "not_found" };
    if (c.status !== "pending" && c.status !== "pending_void" && c.status !== "cancelled") return { kind: "replayed" };
    const pot = this.pots.get(c.potId);
    if (pot === undefined) return { kind: "not_found" };
    const paid = [...this.contributions.values()].filter((x) => x.potId === pot.id && x.status === "paid").reduce((s, x) => s + x.amount, 0n);
    const reason = pot.status !== "OPEN" ? ("pot_closed" as const) : paid + c.amount > pot.target ? ("overshoot" as const) : null;
    if (reason !== null) return { kind: "excess", reason, contribution: { ...c, paymentIntentId } };
    this.contributions.set(c.id, { ...c, status: "paid", paymentIntentId });
    return { kind: "applied" };
  }

  async listContributionsInStatus(status: ContributionRecord["status"], limit: number) {
    return [...this.contributions.values()].filter((c) => c.status === status).slice(0, limit);
  }

  async listContributions(potId: string) {
    return [...this.contributions.values()].filter((c) => c.potId === potId).sort((a, b) => a.createdAtMs - b.createdAtMs);
  }
}

// ---- fakes for ports owned by other modules ---------------------------------------------------

export class FakeSecret implements SecretPort {
  private readonly keys = new Map<number, Buffer>([[1, Buffer.from("fake-gift-card-hmac-key-v1-000000000000")]]);
  private current = 1;
  rotate(): number {
    this.current += 1;
    this.keys.set(this.current, Buffer.from(`fake-gift-card-hmac-key-v${this.current}-000000000000`));
    return this.current;
  }
  async currentVersion() {
    return this.current;
  }
  async activeVersions() {
    return [...this.keys.keys()].sort((a, b) => b - a);
  }
  async hmac(version: number, data: string) {
    const k = this.keys.get(version);
    if (k === undefined) throw new Error(`unknown key version ${version}`);
    return createHmac("sha256", k).update(data).digest("hex");
  }
}

export class NodeRandom implements RandomPort {
  bytes(n: number): Uint8Array {
    return new Uint8Array(randomBytes(n));
  }
}

/** Deterministic bytes from a counter, for tests that need to know the code. */
export class SequenceRandom implements RandomPort {
  private n = 0;
  bytes(len: number): Uint8Array {
    this.n += 1;
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i += 1) out[i] = (this.n * 37 + i * 91 + (i % 3) * this.n) & 0xff;
    out[0] = this.n & 0xff;
    out[1] = (this.n >> 8) & 0xff;
    return out;
  }
}

export class DevAesGcmFieldCipher implements FieldCipherPort {
  constructor(private readonly key: Buffer = randomBytes(32)) {}
  async encrypt(plaintext: Uint8Array, aad: string): Promise<Uint8Array> {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    c.setAAD(Buffer.from(aad, "utf8"));
    const body = Buffer.concat([c.update(plaintext), c.final()]);
    return new Uint8Array(Buffer.concat([iv, c.getAuthTag(), body]));
  }
  async decrypt(ciphertext: Uint8Array, aad: string): Promise<Uint8Array> {
    const buf = Buffer.from(ciphertext);
    const d = createDecipheriv("aes-256-gcm", this.key, buf.subarray(0, 12));
    d.setAAD(Buffer.from(aad, "utf8"));
    d.setAuthTag(buf.subarray(12, 28));
    return new Uint8Array(Buffer.concat([d.update(buf.subarray(28)), d.final()]));
  }
}

export class FakeStoreCredit implements StoreCreditPort {
  readonly postings: { userId: string; cardId: string; amount: bigint; key: string; journalEntryId: string }[] = [];
  /** Throws an unknown error BEFORE committing (nothing credited). */
  failing = false;
  /** Commits the credit, then throws an unknown error (timeout after commit). */
  failAfterCommit = false;
  /** Throws a typed definite rejection. */
  rejecting = false;
  async creditGiftCard(input: Parameters<StoreCreditPort["creditGiftCard"]>[0]) {
    // an idempotent replay returns the committed entry regardless of the current rejection mode
    const prior = this.postings.find((p) => p.key === input.idempotencyKey);
    if (prior !== undefined) {
      if (this.failAfterCommit) throw new Error("timeout after commit");
      return { journalEntryId: prior.journalEntryId };
    }
    if (this.rejecting) throw new StoreCreditRejectedError("kill_switch");
    if (this.failing) throw new Error("ledger unavailable");
    const journalEntryId = `00000000-0000-4000-9000-${String(this.postings.length + 1).padStart(12, "0")}`;
    this.postings.push({ userId: input.userId, cardId: input.cardId, amount: input.amount, key: input.idempotencyKey, journalEntryId });
    if (this.failAfterCommit) throw new Error("timeout after commit");
    return { journalEntryId };
  }
  total(cardId: string): bigint {
    return this.postings.filter((p) => p.cardId === cardId).reduce((s, p) => s + p.amount, 0n);
  }
}

export class FakeVoidApprovals implements VoidApprovalPort {
  readonly records = new Map<string, admin.ApprovalRecord>();
  readonly consumed = new Set<string>();
  async find(id: string) {
    return this.records.get(id) ?? null;
  }
  async consume(id: string) {
    if (this.consumed.has(id)) return false;
    this.consumed.add(id);
    return true;
  }
}

/** Fail closed: with no admin approval port wired, voids at or above the threshold are refused. */
export class DenyVoidApprovals implements VoidApprovalPort {
  async find() {
    return null;
  }
  async consume() {
    return false;
  }
}

export class FakeAudit implements AuditPort {
  readonly entries: Parameters<AuditPort["record"]>[0][] = [];
  async record(entry: Parameters<AuditPort["record"]>[0]) {
    this.entries.push(entry);
  }
}

/** Default OFF, as shipped (spec: code-complete behind kill switches until VR-03, VR-09, VR-F1-04). */
export class FakeFlags implements GiftCardFlagsPort {
  sales = false;
  redemption = false;
  async salesEnabled() {
    return this.sales;
  }
  async redemptionEnabled() {
    return this.redemption;
  }
}

export class FakeAgeGate implements AgeGatePort {
  readonly over21 = new Set<string>();
  async meetsMinimumAge(userId: string, minimumAge: 18 | 21) {
    return minimumAge === 18 ? true : this.over21.has(userId);
  }
}

export class FakePayments implements PaymentIntentPort {
  readonly intents: { id: string; referenceId: string; amount: bigint; method: string; requireThreeDs: boolean }[] = [];
  readonly refunds: { paymentIntentId: string; amount: bigint; key: string }[] = [];
  readonly cancelled: string[] = [];
  /** Per-intent cancel results; default `cancelled`. `throw` simulates a PSP timeout. */
  cancelResult = new Map<string, PaymentCancelResult | "throw">();
  failRefundFor = new Set<string>();
  async create(input: Parameters<PaymentIntentPort["create"]>[0]) {
    const prior = this.intents.find((i) => i.referenceId === input.referenceId);
    const id = prior?.id ?? `pi_${this.intents.length + 1}`;
    if (prior === undefined) {
      this.intents.push({ id, referenceId: input.referenceId, amount: input.amount, method: input.method, requireThreeDs: input.requireThreeDs });
    }
    return { paymentIntentId: id, clientAction: input.requireThreeDs ? ("redirect" as const) : ("native_sheet" as const) };
  }
  async refund(input: { paymentIntentId: string; amount: bigint; idempotencyKey: string }) {
    if (this.failRefundFor.has(input.paymentIntentId)) return { ok: false };
    if (!this.refunds.some((r) => r.key === input.idempotencyKey)) {
      this.refunds.push({ paymentIntentId: input.paymentIntentId, amount: input.amount, key: input.idempotencyKey });
    }
    return { ok: true };
  }
  async cancel(paymentIntentId: string): Promise<PaymentCancelResult> {
    const r = this.cancelResult.get(paymentIntentId) ?? "cancelled";
    if (r === "throw") throw new Error("psp timeout");
    if (r === "cancelled") this.cancelled.push(paymentIntentId);
    return r;
  }
}

export class FakeDelivery implements DeliveryPort {
  readonly sent: Parameters<DeliveryPort["deliver"]>[0][] = [];
  failing = false;
  async deliver(input: Parameters<DeliveryPort["deliver"]>[0]) {
    if (this.failing) return { ok: false };
    this.sent.push(input);
    return { ok: true };
  }
}
