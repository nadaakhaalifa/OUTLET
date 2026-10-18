import { planRefund, planVoid, refundedBaseOf, transitionCommission, type PayoutState } from "../domain/bridge";
import type {
  AffiliateLink,
  Attribution,
  ClaimResult,
  Clock,
  Commission,
  CreateAccountResult,
  CreatorAccount,
  CreatorApprovalsPort,
  CreatorCatalogPort,
  CreatorEvent,
  CreatorFlagsPort,
  CreatorIdentityPort,
  CreatorKycVaultPort,
  CreatorLedgerPort,
  CreatorLook,
  CreatorPayout,
  CreatorPayoutProviderPort,
  CreatorProfileView,
  CreatorReferralPort,
  CreatorStore,
  LinkInsert,
  LinkTargetView,
  PostingIntent,
  ProviderOutcome,
  RefundClaim,
  SealedKyc,
  TermsPort,
  TermsText,
} from "../domain/ports";
import type { ApprovalRecord, ClickFact, CreatorStatus, JournalEntry, LinkTargetType, PayoutPref } from "../domain/bridge";

interface Intent extends PostingIntent {
  postedAtMs: number | null;
}

/** Reference implementation of CreatorStore. The contract suite runs against this and Postgres. */
export class InMemoryCreatorStore implements CreatorStore {
  readonly events: CreatorEvent[] = [];
  readonly kyc = new Map<string, SealedKyc>();
  private readonly accounts = new Map<string, CreatorAccount>();
  private readonly links = new Map<string, AffiliateLink>();
  private readonly looks = new Map<string, CreatorLook>();
  private readonly clicks: (ClickFact & { ipHash: string })[] = [];
  private readonly attributions = new Map<string, Attribution>();
  private readonly commissions = new Map<string, Commission>();
  private readonly intents: Intent[] = [];
  private readonly inbox = new Set<string>();
  private readonly monthly = new Map<string, bigint>();
  private readonly payouts = new Map<string, CreatorPayout>();
  private readonly identityHashes = new Set<string>();
  private readonly termsTexts = new Map<string, string>();

  private push(events: readonly CreatorEvent[]): void {
    this.events.push(...events);
  }
  async emit(events: readonly CreatorEvent[]): Promise<void> {
    this.push(events);
  }

  // ---- accounts
  async getByUser(userId: string) {
    return [...this.accounts.values()].find((a) => a.userId === userId) ?? null;
  }
  async getById(id: string) {
    return this.accounts.get(id) ?? null;
  }
  async getByHandle(handle: string) {
    return [...this.accounts.values()].find((a) => a.handle === handle) ?? null;
  }
  async listByStatus(status: CreatorStatus, limit: number) {
    return [...this.accounts.values()].filter((a) => a.status === status).sort((a, b) => a.appliedAtMs - b.appliedAtMs).slice(0, limit);
  }
  async createAccount(account: CreatorAccount, kyc: SealedKyc, events: readonly CreatorEvent[]): Promise<CreateAccountResult> {
    if ([...this.accounts.values()].some((a) => a.userId === account.userId)) return { kind: "exists" };
    if ([...this.accounts.values()].some((a) => a.handle === account.handle)) return { kind: "handle_taken" };
    const hash = Buffer.from(kyc.nationalIdHash).toString("hex");
    if (this.identityHashes.has(hash)) return { kind: "identity_in_use" };
    this.identityHashes.add(hash);
    this.accounts.set(account.id, account);
    this.kyc.set(account.id, kyc);
    this.push(events);
    return { kind: "created" };
  }
  async decide(i: Parameters<CreatorStore["decide"]>[0]) {
    const a = this.accounts.get(i.creatorId);
    if (a === undefined) return null;
    const next: CreatorAccount = { ...a, status: i.status, kycState: i.kycState, statusReason: i.reason, decidedAtMs: i.nowMs };
    this.accounts.set(a.id, next);
    this.push(i.events);
    return next;
  }
  async setPayoutPref(creatorId: string, pref: PayoutPref, _nowMs: number) {
    const a = this.accounts.get(creatorId);
    if (a === undefined) return false;
    this.accounts.set(creatorId, { ...a, payoutPref: pref });
    return true;
  }

  // ---- links
  async insertLink(link: AffiliateLink, events: readonly CreatorEvent[]): Promise<LinkInsert> {
    const all = [...this.links.values()];
    if (all.some((l) => l.slug === link.slug)) return { kind: "slug_taken" };
    const dup = all.find(
      (l) => l.creatorId === link.creatorId && l.targetType === link.targetType && l.targetId === link.targetId && l.status === "ACTIVE",
    );
    if (dup !== undefined) return { kind: "exists", link: dup };
    this.links.set(link.id, link);
    this.push(events);
    return { kind: "created", link };
  }
  async listLinks(creatorId: string) {
    return [...this.links.values()].filter((l) => l.creatorId === creatorId).sort((a, b) => b.createdAtMs - a.createdAtMs);
  }
  async getLink(id: string) {
    return this.links.get(id) ?? null;
  }
  async findLinkBySlug(slug: string) {
    return [...this.links.values()].find((l) => l.slug === slug) ?? null;
  }
  async disableLink(creatorId: string, linkId: string) {
    const l = this.links.get(linkId);
    if (l === undefined || l.creatorId !== creatorId || l.status !== "ACTIVE") return false;
    this.links.set(linkId, { ...l, status: "DISABLED" });
    return true;
  }
  async disableLinksOf(creatorId: string) {
    let n = 0;
    for (const l of this.links.values()) {
      if (l.creatorId === creatorId && l.status === "ACTIVE") {
        this.links.set(l.id, { ...l, status: "DISABLED" });
        n += 1;
      }
    }
    return n;
  }

  // ---- looks
  async insertLook(look: CreatorLook) {
    this.looks.set(look.id, look);
  }
  async listLooks(creatorId: string) {
    return [...this.looks.values()].filter((l) => l.creatorId === creatorId).sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  }
  async getLook(id: string) {
    return this.looks.get(id) ?? null;
  }
  async updateLook(look: CreatorLook) {
    this.looks.set(look.id, look);
  }

  // ---- clicks
  async countedClicksSince(creatorId: string, ipHash: string, sinceMs: number) {
    return this.clicks.filter((c) => c.creatorId === creatorId && c.ipHash === ipHash && c.counted && c.atMs >= sinceMs).length;
  }
  async clickCountsSince(i: Parameters<CreatorStore["clickCountsSince"]>[0]) {
    const inHour = this.clicks.filter((c) => c.atMs >= i.hourSinceMs && c.counted);
    return {
      ip: inHour.filter((c) => c.creatorId === i.creatorId && c.ipHash === i.ipHash).length,
      device: inHour.filter((c) => c.deviceHash === i.deviceHash).length,
      link: inHour.filter((c) => c.linkId === i.linkId).length,
      duplicate: this.clicks.some((c) => c.linkId === i.linkId && c.deviceHash === i.deviceHash && c.atMs >= i.dedupeSinceMs),
      creatorThisMinute: this.clicks.filter((c) => c.creatorId === i.creatorId && c.atMs >= i.minuteSinceMs).length,
    };
  }
  async maintainClickPartitions(i: { readonly nowMs: number; readonly monthsAhead: number; readonly retainMonths: number }) {
    const d = new Date(i.nowMs);
    const cutoff = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i.retainMonths, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes());
    const before = this.clicks.length;
    for (let k = this.clicks.length - 1; k >= 0; k -= 1) if ((this.clicks[k]?.atMs ?? 0) < cutoff) this.clicks.splice(k, 1);
    return { created: 0, dropped: 0, deletedRows: before - this.clicks.length };
  }
  async insertClick(click: ClickFact & { ipHash: string }, events: readonly CreatorEvent[]) {
    this.clicks.push(click);
    this.push(events);
  }
  async clicksForDevices(deviceHashes: readonly string[], sinceMs: number, untilMs: number) {
    const set = new Set(deviceHashes);
    return this.clicks
      .filter((c) => set.has(c.deviceHash) && c.atMs >= sinceMs && c.atMs <= untilMs)
      .sort((a, b) => (a.atMs !== b.atMs ? b.atMs - a.atMs : a.id < b.id ? 1 : -1))
      .slice(0, 500)
      .map((c): ClickFact => ({
        id: c.id,
        linkId: c.linkId,
        creatorId: c.creatorId,
        atMs: c.atMs,
        deviceHash: c.deviceHash,
        counted: c.counted,
        uaClass: c.uaClass,
      }));
  }
  async clickStats(creatorId: string, sinceMs: number) {
    const mine = this.clicks.filter((c) => c.creatorId === creatorId && c.atMs >= sinceMs);
    return { total: mine.length, counted: mine.filter((c) => c.counted).length };
  }

  // ---- attribution
  async getAttribution(orderGroupId: string) {
    return this.attributions.get(orderGroupId) ?? null;
  }
  async insertAttribution(a: Attribution, events: readonly CreatorEvent[]) {
    if (this.attributions.has(a.orderGroupId)) return "exists" as const;
    this.attributions.set(a.orderGroupId, a);
    this.push(events);
    return "inserted" as const;
  }
  async voidAttribution(orderGroupId: string, reason: NonNullable<Attribution["voidReason"]>, events: readonly CreatorEvent[]) {
    const a = this.attributions.get(orderGroupId);
    if (a === undefined) return;
    this.attributions.set(orderGroupId, { ...a, status: "VOIDED", voidReason: reason as Attribution["voidReason"] });
    this.push(events);
  }
  async resolveHeldAttribution(a: Attribution, events: readonly CreatorEvent[]) {
    const cur = this.attributions.get(a.orderGroupId);
    if (cur === undefined || cur.status !== "HELD") return false;
    this.attributions.set(a.orderGroupId, { ...a, createdAtMs: cur.createdAtMs });
    this.push(events);
    return true;
  }
  async voidOrderGroup(i: Parameters<CreatorStore["voidOrderGroup"]>[0]) {
    const a = this.attributions.get(i.orderGroupId);
    if (a === undefined) return { kind: "not_found" as const };
    if (a.status === "VOIDED") return { kind: "already_voided" as const };
    this.attributions.set(i.orderGroupId, { ...a, status: "VOIDED", voidReason: i.reason, holdReason: null });
    this.push(i.events);
    const ids: string[] = [];
    let clawedBack = 0n;
    for (const c of [...this.commissions.values()].filter((x) => x.orderGroupId === i.orderGroupId)) {
      const plan = planVoid(c);
      if (plan.kind === "shrink_held") {
        this.commissions.set(c.id, {
          ...c,
          refundedBase: plan.refundedBase,
          amount: plan.amount,
          state: transitionCommission("ACCRUING", "VOID"),
          holdReason: null,
          voidReason: i.reason,
        });
      } else if (plan.kind === "clawback") {
        const next: Commission = {
          ...c,
          refundedBase: plan.refundedBase,
          clawedBack: plan.clawedBack,
          state: plan.full ? transitionCommission(c.state, "CLAWBACK_ALL") : c.state,
        };
        this.commissions.set(c.id, next);
        this.addIntent(next, this.nextSeq(c.id), "clawback", plan.delta);
        this.push([{ type: "commission.clawed_back", creatorId: c.creatorId, commissionId: c.id, amount: plan.delta }]);
        ids.push(c.id);
        clawedBack += plan.delta;
      }
    }
    return { kind: "voided" as const, commissionIds: ids, clawedBack };
  }
  async ensureTerms(version: number, texts: readonly TermsText[]) {
    for (const t of texts) {
      const k = `${version}:${t.locale}`;
      const have = this.termsTexts.get(k);
      if (have === undefined) this.termsTexts.set(k, t.sha256);
      else if (have !== t.sha256) return "mismatch" as const;
    }
    return "ok" as const;
  }
  async attributedBuyers(creatorId: string, limit: number) {
    return [...this.attributions.values()]
      .filter((a) => a.creatorId === creatorId && a.status === "ACTIVE")
      .slice(0, limit)
      .map((a) => a.buyerUserId);
  }

  // ---- commissions
  private creatorUser(creatorId: string): string {
    return this.accounts.get(creatorId)?.userId ?? creatorId;
  }
  private addIntent(c: Commission, seq: number, kind: "accrual" | "clawback", amount: bigint): void {
    if (amount <= 0n) return;
    this.intents.push({
      commissionId: c.id,
      seq,
      kind,
      amount,
      creatorUserId: this.creatorUser(c.creatorId),
      orderGroupId: c.orderGroupId,
      postedAtMs: null,
    });
  }
  private nextSeq(commissionId: string): number {
    return this.intents.filter((i) => i.commissionId === commissionId).length;
  }

  async recordInbox(consumer: string, messageId: string) {
    const k = `${consumer}:${messageId}`;
    if (this.inbox.has(k)) return "duplicate" as const;
    this.inbox.add(k);
    return "recorded" as const;
  }

  async claimAccrual(i: Parameters<CreatorStore["claimAccrual"]>[0]): Promise<ClaimResult> {
    if ((await this.recordInbox(i.consumer, i.messageId)) === "duplicate") return { kind: "duplicate" };
    const n = i.commission;
    const att = this.attributions.get(n.orderGroupId);
    if (att !== undefined && att.status !== "ACTIVE") return { kind: "attribution_inactive" };
    const existing = [...this.commissions.values()].find((c) => c.orderLineId === n.orderLineId && c.creatorId === n.creatorId);
    if (existing !== undefined) return { kind: "exists", commission: existing };
    const key = `${n.creatorId}:${n.monthKey}`;
    const used = this.monthly.get(key) ?? 0n;
    let state: Commission["state"] = "ACCRUED";
    let hold: Commission["holdReason"] = null;
    if (!n.creatorActive) {
      state = "ACCRUING";
      hold = "creator_not_active";
    } else if (used + n.amount > n.monthlyCap) {
      state = "ACCRUING";
      hold = "monthly_cap";
    } else {
      this.monthly.set(key, used + n.amount);
    }
    const c: Commission = {
      id: n.id,
      creatorId: n.creatorId,
      orderGroupId: n.orderGroupId,
      orderLineId: n.orderLineId,
      base: n.base,
      rateBps: n.rateBps,
      amount: n.amount,
      clawedBack: 0n,
      refundedBase: n.refundedBase,
      state,
      holdReason: hold,
      voidReason: null,
      monthKey: n.monthKey,
      closedAtMs: n.closedAtMs,
      accruedAtMs: state === "ACCRUED" ? n.closedAtMs : null,
      payoutId: null,
    };
    this.commissions.set(c.id, c);
    if (state === "ACCRUED") this.addIntent(c, 0, "accrual", c.amount);
    this.push([
      state === "ACCRUED"
        ? { type: "commission.accrued", creatorId: c.creatorId, commissionId: c.id, amount: c.amount }
        : { type: "commission.held", creatorId: c.creatorId, commissionId: c.id, reason: hold ?? "unknown" },
    ]);
    return { kind: "claimed", commission: c };
  }

  async claimRefund(i: Parameters<CreatorStore["claimRefund"]>[0]): Promise<RefundClaim> {
    if ((await this.recordInbox(i.consumer, i.messageId)) === "duplicate") return { kind: "duplicate" };
    const c = [...this.commissions.values()].find((x) => x.orderLineId === i.orderLineId);
    if (c === undefined) return { kind: "no_commission" };
    const plan = planRefund(c, refundedBaseOf(c.base, i.lineGross, i.refundedGross));
    let next: Commission = { ...c, refundedBase: plan.refundedBase };
    if (plan.kind === "shrink_held") {
      next = { ...next, amount: plan.amount };
      if (plan.void) next = { ...next, state: transitionCommission("ACCRUING", "VOID"), holdReason: null, voidReason: "fully_refunded" };
    } else if (plan.kind === "clawback") {
      next = { ...next, clawedBack: plan.clawedBack };
      if (plan.full) next = { ...next, state: transitionCommission(c.state, "CLAWBACK_ALL") };
      this.addIntent(next, this.nextSeq(c.id), "clawback", plan.delta);
      this.push([{ type: "commission.clawed_back", creatorId: c.creatorId, commissionId: c.id, amount: plan.delta }]);
    }
    this.commissions.set(c.id, next);
    return { kind: "applied", commission: next, plan };
  }

  async intentsFor(commissionId: string) {
    return this.intents
      .filter((x) => x.commissionId === commissionId && x.postedAtMs === null)
      .map(({ postedAtMs: _p, ...r }): PostingIntent => r);
  }
  async listUnpostedIntents(limit: number) {
    return this.intents
      .filter((x) => x.postedAtMs === null)
      .slice(0, limit)
      .map(({ postedAtMs: _p, ...r }): PostingIntent => r);
  }
  async markPosted(commissionId: string, seq: number, nowMs: number) {
    const it = this.intents.find((x) => x.commissionId === commissionId && x.seq === seq);
    if (it === undefined || it.postedAtMs !== null) return false;
    it.postedAtMs = nowMs;
    return true;
  }
  async listHeld(limit: number) {
    return [...this.commissions.values()].filter((c) => c.state === "ACCRUING").slice(0, limit);
  }
  async releaseHeld(commissionId: string, monthKey: string, monthlyCap: bigint) {
    const c = this.commissions.get(commissionId);
    if (c === undefined || c.state !== "ACCRUING") return null;
    const key = `${c.creatorId}:${monthKey}`;
    const used = this.monthly.get(key) ?? 0n;
    if (used + c.amount > monthlyCap) return null;
    this.monthly.set(key, used + c.amount);
    const next: Commission = {
      ...c,
      state: transitionCommission("ACCRUING", "ACCRUE"),
      holdReason: null,
      monthKey,
      accruedAtMs: c.closedAtMs,
    };
    this.commissions.set(c.id, next);
    this.addIntent(next, 0, "accrual", next.amount);
    this.push([{ type: "commission.accrued", creatorId: c.creatorId, commissionId: c.id, amount: c.amount }]);
    return next;
  }
  async getCommission(id: string) {
    return this.commissions.get(id) ?? null;
  }
  async listCommissions(creatorId: string, limit: number, beforeMs: number | null) {
    return [...this.commissions.values()]
      .filter((c) => c.creatorId === creatorId && c.state !== "VOIDED" && (beforeMs === null || c.closedAtMs < beforeMs))
      .sort((a, b) => b.closedAtMs - a.closedAtMs)
      .slice(0, limit);
  }
  async monthAccrued(creatorId: string, monthKey: string) {
    return this.monthly.get(`${creatorId}:${monthKey}`) ?? 0n;
  }
  async commissionTotals(creatorId: string) {
    let pending = 0n;
    let accrued = 0n;
    let clawedBack = 0n;
    let paid = 0n;
    let held = 0n;
    for (const c of this.commissions.values()) {
      if (c.creatorId !== creatorId) continue;
      if (c.state === "ACCRUING") held += c.amount;
      if (c.state === "ACCRUED") pending += c.amount - c.clawedBack;
      if (c.state === "PAID") paid += c.amount - c.clawedBack;
      if (c.state !== "ACCRUING" && c.state !== "VOIDED") {
        accrued += c.amount;
        clawedBack += c.clawedBack;
      }
    }
    return { pending, accrued, clawedBack, paid, held };
  }

  // ---- payouts
  async reservableTotal(creatorId: string) {
    let t = 0n;
    for (const c of this.commissions.values()) {
      if (c.creatorId === creatorId && c.state === "ACCRUED" && c.payoutId === null) t += c.amount - c.clawedBack;
    }
    return t;
  }
  async createPayout(i: Parameters<CreatorStore["createPayout"]>[0]) {
    const open: PayoutState[] = ["SCHEDULED", "ON_HOLD", "APPROVED", "SENT", "FAILED"];
    if ([...this.payouts.values()].some((p) => p.creatorId === i.payout.creatorId && open.includes(p.state))) return "open_exists" as const;
    this.payouts.set(i.payout.id, i.payout);
    for (const c of this.commissions.values()) {
      if (c.creatorId === i.payout.creatorId && c.state === "ACCRUED" && c.payoutId === null) {
        this.commissions.set(c.id, { ...c, payoutId: i.payout.id });
      }
    }
    this.push(i.events);
    return "created" as const;
  }
  async getPayout(id: string) {
    return this.payouts.get(id) ?? null;
  }
  async listPayouts(f: { creatorId?: string; state?: PayoutState; limit: number }) {
    return [...this.payouts.values()]
      .filter((p) => (f.creatorId === undefined || p.creatorId === f.creatorId) && (f.state === undefined || p.state === f.state))
      .sort((a, b) => b.createdAtMs - a.createdAtMs)
      .slice(0, f.limit);
  }
  async transitionPayout(i: Parameters<CreatorStore["transitionPayout"]>[0]) {
    const p = this.payouts.get(i.id);
    if (p === undefined || p.state !== i.from) return null;
    const next: CreatorPayout = {
      ...p,
      state: i.to,
      holdReason: i.holdReason === undefined ? p.holdReason : i.holdReason,
      attempt: i.attempt ?? p.attempt,
      providerRef: i.providerRef === undefined ? p.providerRef : i.providerRef,
      failureReason: i.failureReason === undefined ? p.failureReason : i.failureReason,
      updatedAtMs: i.nowMs,
    };
    this.payouts.set(p.id, next);
    for (const c of this.commissions.values()) {
      if (c.payoutId !== p.id) continue;
      if (i.to === "SETTLED" && c.state === "ACCRUED") {
        this.commissions.set(c.id, { ...c, state: transitionCommission("ACCRUED", "PAY") });
      } else if (i.to === "CANCELLED") {
        this.commissions.set(c.id, { ...c, payoutId: null });
      }
    }
    this.push(i.events);
    return next;
  }
}

// ---- fakes -------------------------------------------------------------------------------------------

export class FixedClock implements Clock {
  constructor(public ms: number) {}
  nowMs(): number {
    return this.ms;
  }
}

export class StaticCreatorFlags implements CreatorFlagsPort {
  constructor(
    public program = true,
    public payouts = false,
  ) {}
  programEnabled(): boolean {
    return this.program;
  }
  payoutsEnabled(): boolean {
    return this.payouts;
  }
}

export class InMemoryCreatorIdentity implements CreatorIdentityPort {
  readonly profiles = new Map<string, CreatorProfileView>();
  async profile(userId: string) {
    return this.profiles.get(userId) ?? null;
  }
}

/** Test double: order groups that carry a referral reward. */
export class InMemoryCreatorReferrals implements CreatorReferralPort {
  readonly rewarded = new Set<string>();
  failNext = false;
  async rewardAppliesTo(i: { orderGroupId: string }) {
    if (this.failNext) throw new Error("referrals unavailable");
    return this.rewarded.has(i.orderGroupId);
  }
}

export class InMemoryCreatorCatalog implements CreatorCatalogPort {
  readonly targets = new Map<string, LinkTargetView>();
  readonly products = new Set<string>();
  async resolveTarget(type: LinkTargetType, id: string): Promise<LinkTargetView> {
    return this.targets.get(`${type}:${id}`) ?? { exists: false, storeId: null };
  }
  async existingProducts(ids: readonly string[]) {
    return new Set(ids.filter((i) => this.products.has(i)));
  }
}

/** In-memory ledger: stores entries by idempotency key; replays are no-ops. */
export class InMemoryCreatorLedger implements CreatorLedgerPort {
  readonly entries = new Map<string, JournalEntry>();
  failNext = 0;
  async post(entry: JournalEntry) {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error("ledger unavailable");
    }
    if (this.entries.has(entry.idempotencyKey)) return { kind: "replayed" as const };
    this.entries.set(entry.idempotencyKey, entry);
    return { kind: "posted" as const };
  }
  async hasEntry(idempotencyKey: string) {
    return this.entries.has(idempotencyKey);
  }
  async payableBalance(userId: string) {
    let credit = 0n;
    for (const e of this.entries.values()) {
      for (const p of e.postings) if (p.account === `creator_payable:${userId}`) credit -= p.amount.amount;
    }
    return credit;
  }
  trialBalance(): bigint {
    let t = 0n;
    for (const e of this.entries.values()) for (const p of e.postings) t += p.amount.amount;
    return t;
  }
}

export class FakeKycVault implements CreatorKycVaultPort {
  matched = true;
  async payoutIdentityMatched(): Promise<boolean> {
    return this.matched;
  }
  async seal(i: Parameters<CreatorKycVaultPort["seal"]>[0]): Promise<SealedKyc> {
    const enc = (s: string | null) => (s === null ? null : new TextEncoder().encode(`sealed:${s}`));
    const idHash = new Uint8Array(32);
    const bytes = new TextEncoder().encode(i.nationalId);
    for (let k = 0; k < bytes.length; k += 1) idHash[k % 32] = ((idHash[k % 32] ?? 0) * 31 + (bytes[k] ?? 0)) & 0xff;
    return {
      keyId: "test-key",
      legalNameEnc: enc(i.legalName) ?? new Uint8Array(),
      nationalIdEnc: enc(i.nationalId) ?? new Uint8Array(),
      nationalIdHash: idHash,
      payoutIbanEnc: enc(i.payoutIban),
      payoutNameEnc: enc(i.payoutName),
      taxIdEnc: enc(i.taxId),
      taxFormEnc: enc(i.taxForm),
    };
  }
}

export class InMemoryCreatorApprovals implements CreatorApprovalsPort {
  readonly records = new Map<string, ApprovalRecord[]>();
  async forPayout(payoutId: string) {
    return this.records.get(payoutId) ?? [];
  }
}

export class StaticTerms implements TermsPort {
  constructor(public version: number | null = 1) {}
  async currentVersion() {
    return this.version;
  }
  /** Test text. The hash is not a real digest: production binds a port that hashes the published text. */
  async texts(version: number): Promise<readonly TermsText[]> {
    const body = `Creator terms version ${version}. Placeholder text for development.`;
    const sha = Array.from(body)
      .reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7)
      .toString(16)
      .padStart(64, "0");
    return [{ locale: "en", body, sha256: sha }];
  }
}

/** Default rail: refuses to move money. Production stays on this until VR-P3-03 is Verified. */
export class UnconfiguredCreatorPayoutProvider implements CreatorPayoutProviderPort {
  readonly configured = false;
  async send(): Promise<ProviderOutcome> {
    return { kind: "unavailable" };
  }
}

/** Test rail with scripted outcomes. */
export class FakeCreatorPayoutProvider implements CreatorPayoutProviderPort {
  readonly configured = true;
  readonly sent: { idempotencyKey: string; amount: bigint }[] = [];
  next: ProviderOutcome = { kind: "settled", providerRef: "fake-ref" };
  async send(i: { idempotencyKey: string; amount: bigint }): Promise<ProviderOutcome> {
    this.sent.push({ idempotencyKey: i.idempotencyKey, amount: i.amount });
    return this.next;
  }
}
