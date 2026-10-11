import type {
  AppAttestPort,
  CodeInsert,
  PartyProfileView,
  Referral,
  ReferralCodeRecord,
  ReferralEvent,
  ReferralIdentityPort,
  ReferralStore,
  SettleInput,
  SettleResult,
} from "../domain/ports";

/** DEVELOPMENT FIXTURE. The production adapter is KyselyReferralStore + outbox. */
export class InMemoryReferralStore implements ReferralStore {
  private readonly codesByOwner = new Map<string, ReferralCodeRecord>();
  private readonly codesByCode = new Map<string, ReferralCodeRecord>();
  private readonly byReferee = new Map<string, Referral>();
  private readonly inbox = new Set<string>();
  readonly events: ReferralEvent[] = [];

  async ensureCode(input: { id: string; ownerUserId: string; code: string; nowMs: number }): Promise<CodeInsert> {
    const existing = this.codesByOwner.get(input.ownerUserId);
    if (existing !== undefined) return { kind: "existing", record: existing };
    if (this.codesByCode.has(input.code)) return { kind: "code_taken" };
    const record: ReferralCodeRecord = {
      id: input.id,
      ownerUserId: input.ownerUserId,
      code: input.code,
      createdAtMs: input.nowMs,
    };
    this.codesByOwner.set(record.ownerUserId, record);
    this.codesByCode.set(record.code, record);
    return { kind: "created", record };
  }

  async findCode(code: string): Promise<ReferralCodeRecord | null> {
    return this.codesByCode.get(code) ?? null;
  }

  async getByReferee(refereeId: string): Promise<Referral | null> {
    return this.byReferee.get(refereeId) ?? null;
  }

  async listByReferrer(referrerId: string): Promise<readonly Referral[]> {
    return [...this.byReferee.values()]
      .filter((r) => r.referrerId === referrerId)
      .sort((a, b) => a.attributedAtMs - b.attributedAtMs || (a.id < b.id ? -1 : 1));
  }

  async countRewarded(referrerId: string, sinceMs: number | null): Promise<number> {
    return [...this.byReferee.values()].filter(
      (r) =>
        r.referrerId === referrerId &&
        r.status === "rewarded" &&
        (sinceMs === null || (r.settledAtMs !== null && r.settledAtMs >= sinceMs)),
    ).length;
  }

  async insertAttribution(referral: Referral, events: readonly ReferralEvent[]): Promise<"inserted" | "exists"> {
    if (this.byReferee.has(referral.refereeId)) return "exists";
    this.byReferee.set(referral.refereeId, referral);
    this.events.push(...events);
    return "inserted";
  }

  /** Single synchronous section (no await): atomic per process, which serialises per referrer. */
  async settle(input: {
    consumer: string;
    messageId: string;
    change: SettleInput | null;
    events: readonly ReferralEvent[];
  }): Promise<SettleResult> {
    const key = `${input.consumer}:${input.messageId}`;
    if (this.inbox.has(key)) return { kind: "duplicate" };
    this.inbox.add(key);
    const c = input.change;
    if (c === null) return { kind: "applied", outcome: "recorded", plusMonths: 0 };
    for (const [k, r] of this.byReferee) {
      if (r.id !== c.referralId) continue;
      if (r.status !== "attributed") break;
      let status = c.status;
      let reason = c.rejectReason;
      let amount = c.rewardAmount;
      let events: ReferralEvent[] = [...input.events];
      let plusMonths = 0;
      let outcome: "rewarded" | "capped" | "recorded" = c.status === "rewarded" ? "rewarded" : "recorded";
      const g = c.guard;
      if (c.status === "rewarded" && g !== undefined) {
        let inWindow = 0;
        let total = 0;
        for (const x of this.byReferee.values()) {
          if (x.referrerId !== g.referrerId || x.status !== "rewarded") continue;
          total += 1;
          if (x.settledAtMs !== null && x.settledAtMs >= g.windowStartMs) inWindow += 1;
        }
        if (inWindow >= g.maxInWindow) {
          status = "rejected";
          reason = "cap_reached";
          amount = null;
          outcome = "capped";
          events = [{ type: "referral.rejected", referralId: r.id, referrerId: g.referrerId, reason: "cap_reached" }];
        } else if ((total + 1) % g.milestoneEvery === 0 && g.milestonePlusMonths > 0) {
          plusMonths = g.milestonePlusMonths;
          events.push({
            type: "referral.plus_month_earned",
            referralId: r.id,
            beneficiaryUserId: g.referrerId,
            months: plusMonths,
            idempotencyKey: `referral:${r.id}:plus`,
          });
        }
      }
      this.byReferee.set(k, {
        ...r,
        status,
        rejectReason: reason,
        orderId: c.orderId,
        paymentFingerprintHash: c.paymentFingerprintHash,
        rewardAmount: amount,
        settledAtMs: c.settledAtMs,
      });
      this.events.push(...events);
      return { kind: "applied", outcome, plusMonths };
    }
    return { kind: "applied", outcome: "already_settled", plusMonths: 0 };
  }
}

export class InMemoryReferralIdentity implements ReferralIdentityPort {
  private readonly profiles = new Map<string, PartyProfileView>();

  seed(userId: string, p: Partial<PartyProfileView> = {}): void {
    this.profiles.set(userId, {
      ageYears: 25,
      phoneIsNew: true,
      priorOrderCount: 0,
      deviceHashes: [],
      paymentFingerprintHashes: [],
      deliveredOrderCount: 0,
      active: true,
      ...p,
    });
  }

  async profile(userId: string): Promise<PartyProfileView | null> {
    return this.profiles.get(userId) ?? null;
  }
}

/** Accepts assertions that start with "ok:" (development fixture only). */
export class InMemoryAppAttest implements AppAttestPort {
  async verify(input: { userId: string; assertion: string | null }): Promise<boolean> {
    return input.assertion !== null && input.assertion.startsWith("ok:");
  }
}
