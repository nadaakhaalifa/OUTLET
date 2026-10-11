import type { ElevationRecord, ApprovalRecord, KycState, SuspensionReview } from "../domain/bridge";
import type {
  AdminAuditEntry,
  AdminAuditPort,
  AdminStore,
  ApprovalFilter,
  FlagAdminBackend,
  FlagView,
  PiiField,
  PiiSourcePort,
  SellerKycPort,
  SellerKycView,
} from "../domain/ports";

/** DEVELOPMENT FIXTURE and contract reference. Not shared between processes. */
export class InMemoryAdminStore implements AdminStore {
  private readonly approvals = new Map<string, ApprovalRecord>();
  private readonly elevations = new Map<string, ElevationRecord>();
  private readonly reviews = new Map<string, SuspensionReview>();

  async insertApproval(r: ApprovalRecord): Promise<void> {
    if (this.approvals.has(r.id)) throw new Error("duplicate approval id");
    this.approvals.set(r.id, r);
  }
  async getApproval(id: string): Promise<ApprovalRecord | null> {
    return this.approvals.get(id) ?? null;
  }
  async saveApprovalDecision(r: ApprovalRecord): Promise<boolean> {
    const cur = this.approvals.get(r.id);
    if (cur === undefined || cur.state !== "REQUESTED") return false;
    this.approvals.set(r.id, r);
    return true;
  }
  async listApprovals(f: ApprovalFilter): Promise<readonly ApprovalRecord[]> {
    return [...this.approvals.values()]
      .filter((r) => f.states === undefined || f.states.includes(r.state))
      .filter((r) => f.kinds === undefined || f.kinds.includes(r.kind))
      .filter((r) => f.requesterId === undefined || r.requesterId === f.requesterId)
      .filter((r) => f.visibleTo === undefined || r.requesterId === f.visibleTo.actorId || f.visibleTo.kinds.includes(r.kind))
      .sort((a, b) => b.requestedAtMs - a.requestedAtMs || (a.id < b.id ? -1 : 1))
      .slice(0, f.limit);
  }

  async createElevationWithApproval(approval: ApprovalRecord, elevation: ElevationRecord): Promise<void> {
    if (this.approvals.has(approval.id) || this.elevations.has(elevation.id)) throw new Error("duplicate id");
    this.approvals.set(approval.id, approval);
    this.elevations.set(elevation.id, elevation);
  }
  async getElevation(id: string): Promise<ElevationRecord | null> {
    return this.elevations.get(id) ?? null;
  }
  async saveElevation(e: ElevationRecord, expected: ElevationRecord["state"]): Promise<boolean> {
    const cur = this.elevations.get(e.id);
    if (cur === undefined || cur.state !== expected) return false;
    this.elevations.set(e.id, e);
    return true;
  }
  async liveElevations(userId: string, nowMs: number): Promise<readonly ElevationRecord[]> {
    return [...this.elevations.values()].filter(
      (e) => e.userId === userId && e.state === "ACTIVE" && e.expiresAtMs !== null && nowMs < e.expiresAtMs,
    );
  }
  async listElevations(f: { userId?: string; activeAtMs?: number; limit: number }): Promise<readonly ElevationRecord[]> {
    return [...this.elevations.values()]
      .filter((e) => f.userId === undefined || e.userId === f.userId)
      .filter(
        (e) =>
          f.activeAtMs === undefined ||
          (e.state === "ACTIVE" && e.expiresAtMs !== null && f.activeAtMs < e.expiresAtMs),
      )
      .sort((a, b) => b.requestedAtMs - a.requestedAtMs || (a.id < b.id ? -1 : 1))
      .slice(0, f.limit);
  }

  async insertReview(r: SuspensionReview): Promise<boolean> {
    if (r.state === "OPEN" && [...this.reviews.values()].some((x) => x.sellerId === r.sellerId && x.state === "OPEN")) {
      return false;
    }
    this.reviews.set(r.id, r);
    return true;
  }
  async getReview(id: string): Promise<SuspensionReview | null> {
    return this.reviews.get(id) ?? null;
  }
  async findOpenReviewBySeller(sellerId: string): Promise<SuspensionReview | null> {
    return [...this.reviews.values()].find((r) => r.sellerId === sellerId && r.state === "OPEN") ?? null;
  }
  async saveReview(r: SuspensionReview): Promise<boolean> {
    const cur = this.reviews.get(r.id);
    if (cur === undefined || cur.state !== "OPEN") return false;
    this.reviews.set(r.id, r);
    return true;
  }
  async listReviews(f: { state?: SuspensionReview["state"]; limit: number }): Promise<readonly SuspensionReview[]> {
    return [...this.reviews.values()]
      .filter((r) => f.state === undefined || r.state === f.state)
      .sort((a, b) => a.dueAtMs - b.dueAtMs || (a.id < b.id ? -1 : 1))
      .slice(0, f.limit);
  }
}

export class InMemorySellerKyc implements SellerKycPort {
  private readonly rows = new Map<string, SellerKycView>();

  seed(v: SellerKycView): void {
    this.rows.set(v.sellerId, v);
  }
  async list(f: { states?: readonly KycState[]; limit: number }): Promise<readonly SellerKycView[]> {
    return [...this.rows.values()]
      .filter((r) => f.states === undefined || f.states.includes(r.state))
      .sort((a, b) => a.updatedAtMs - b.updatedAtMs || (a.sellerId < b.sellerId ? -1 : 1))
      .slice(0, f.limit);
  }
  async get(sellerId: string): Promise<SellerKycView | null> {
    return this.rows.get(sellerId) ?? null;
  }
  async setState(sellerId: string, from: KycState, to: KycState, nowMs: number): Promise<boolean> {
    const cur = this.rows.get(sellerId);
    if (cur === undefined || cur.state !== from) return false;
    this.rows.set(sellerId, { ...cur, state: to, updatedAtMs: nowMs });
    return true;
  }
}

export class InMemoryAdminAudit implements AdminAuditPort {
  readonly entries: AdminAuditEntry[] = [];
  /** Test hook: makes append reject, to prove that actions fail closed. */
  failNext = false;
  async append(e: AdminAuditEntry): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("audit unavailable");
    }
    this.entries.push(e);
  }
}

export class InMemoryPiiSource implements PiiSourcePort {
  private readonly subjects = new Map<string, Partial<Record<PiiField, string>>>();
  seed(userId: string, v: Partial<Record<PiiField, string>>): void {
    this.subjects.set(userId, v);
  }
  async fetch(userId: string, fields: readonly PiiField[]): Promise<Partial<Record<PiiField, string>> | null> {
    const s = this.subjects.get(userId);
    if (s === undefined) return null;
    const out: Partial<Record<PiiField, string>> = {};
    for (const f of fields) {
      const v = s[f];
      if (v !== undefined) out[f] = v;
    }
    return out;
  }
}

export interface FlagDefinitionInput {
  readonly key: string;
  readonly kind: FlagView["kind"];
  readonly description: string;
}

/**
 * DEVELOPMENT FIXTURE. Definitions come from the caller (production passes FLAG_REGISTRY of
 * packages/feature-flags). Everything starts at the fail-closed default: disabled.
 */
export class InMemoryFlagBackend implements FlagAdminBackend {
  private readonly defs: ReadonlyMap<string, FlagDefinitionInput>;
  private readonly values = new Map<string, boolean>();

  constructor(defs: readonly FlagDefinitionInput[]) {
    this.defs = new Map(defs.map((d) => [d.key, d] as const));
  }
  private view(key: string): FlagView | null {
    const d = this.defs.get(key);
    if (d === undefined) return null;
    const v = this.values.get(key);
    return { key, kind: d.kind, description: d.description, enabled: v ?? false, isDefault: v === undefined };
  }
  async list(): Promise<readonly FlagView[]> {
    return [...this.defs.keys()].sort().flatMap((k) => this.view(k) ?? []);
  }
  async get(key: string): Promise<FlagView | null> {
    return this.view(key);
  }
  async set(key: string, enabled: boolean): Promise<FlagView | null> {
    if (!this.defs.has(key)) return null;
    this.values.set(key, enabled);
    return this.view(key);
  }
}

/** The 14 kill switches of spec A2.12 plus release flags, mirroring packages/feature-flags KILL_SWITCHES. */
export const SPEC_KILL_SWITCH_KEYS = [
  "kill.payment.card",
  "kill.payment.apple_pay",
  "kill.payment.mobile_wallet",
  "kill.payment.instapay",
  "kill.payment.fawry",
  "kill.payment.cod",
  "kill.payment.bnpl",
  "kill.drops",
  "kill.games",
  "kill.stylist_llm",
  "kill.ml_ranking",
  "kill.crawlers",
  "kill.referral_payouts",
  "kill.gift_card_sales",
] as const;
