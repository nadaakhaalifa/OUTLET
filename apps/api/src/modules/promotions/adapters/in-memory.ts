/**
 * DEVELOPMENT FIXTURES: per-process repository and event sink. Not safe for production
 * (the module refuses to start with real adapters configured and no repository).
 */
import { timingSafeEqual } from "node:crypto";
import { type promotions } from "../domain/bridge";
import type {
  OwnerFilter,
  PromotionEvent,
  PromotionEventPublisher,
  PromotionPatch,
  PromotionRecord,
  PromotionRepository,
  RedemptionInput,
  RedemptionOutcome,
  ServiceAuthenticator,
} from "../domain/ports";

interface StoredRedemption extends RedemptionInput {
  status: "APPLIED" | "REINSTATED";
}

const ownerMatches = (p: PromotionRecord, o: OwnerFilter): boolean =>
  o.kind === "platform" ? p.owner.kind === "platform" : p.owner.kind === "store" && p.owner.storeId === o.storeId;

export class InMemoryPromotionRepository implements PromotionRepository {
  private readonly byId = new Map<string, PromotionRecord>();
  private readonly redemptions: StoredRedemption[] = [];
  /** Test hook: make every call fail like a store outage. */
  failing = false;

  private check(): void {
    if (this.failing) throw new Error("store down");
  }

  async insert(record: PromotionRecord): Promise<"created" | "code_taken"> {
    this.check();
    if (record.code !== null) {
      for (const p of this.byId.values()) if (p.code === record.code) return "code_taken";
    }
    this.byId.set(record.id, record);
    return "created";
  }

  async get(id: string): Promise<PromotionRecord | null> {
    this.check();
    return this.byId.get(id) ?? null;
  }

  async list(q: { owner: OwnerFilter; afterId: string | null; limit: number }): Promise<readonly PromotionRecord[]> {
    this.check();
    return [...this.byId.values()]
      .filter((p) => ownerMatches(p, q.owner) && (q.afterId === null || p.id > q.afterId))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, q.limit);
  }

  async update(id: string, expectedVersion: number, patch: PromotionPatch, nowMs: number): Promise<PromotionRecord | "stale" | null> {
    this.check();
    const cur = this.byId.get(id);
    if (cur === undefined) return null;
    if (cur.version !== expectedVersion) return "stale";
    const next: PromotionRecord = {
      ...cur,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.endsAtMs !== undefined ? { endsAtMs: patch.endsAtMs } : {}),
      ...(patch.totalBudget !== undefined ? { totalBudget: patch.totalBudget } : {}),
      ...(patch.maxDiscount !== undefined ? { maxDiscount: patch.maxDiscount } : {}),
      version: cur.version + 1,
      updatedAtMs: nowMs,
    };
    this.byId.set(id, next);
    return next;
  }

  async candidates(q: { atMs: number; storeIds: readonly string[]; codes: readonly string[] }): Promise<readonly PromotionRecord[]> {
    this.check();
    return [...this.byId.values()].filter((p) => {
      if (p.status !== "active" || p.startsAtMs > q.atMs || p.endsAtMs <= q.atMs) return false;
      const auto = p.autoApply && (p.owner.kind === "platform" || q.storeIds.includes(p.owner.storeId));
      return auto || (p.code !== null && q.codes.includes(p.code));
    });
  }

  private live(promotionId: string): StoredRedemption[] {
    return this.redemptions.filter((r) => r.promotionId === promotionId && r.status === "APPLIED");
  }

  async usage(ids: readonly string[], userId: string, dayKey: string): Promise<ReadonlyMap<string, promotions.Usage>> {
    this.check();
    const out = new Map<string, promotions.Usage>();
    for (const id of ids) {
      const rows = this.live(id);
      out.set(id, {
        userRedemptions: rows.filter((r) => r.userId === userId).length,
        dayRedemptions: rows.filter((r) => r.dayKey === dayKey).length,
        spent: rows.reduce((s, r) => s + r.amount, 0n),
      });
    }
    return out;
  }

  async recordRedemptions(inputs: readonly RedemptionInput[]): Promise<RedemptionOutcome> {
    this.check();
    const fresh: RedemptionInput[] = [];
    let existing = 0;
    for (const r of inputs) {
      const p = this.byId.get(r.promotionId);
      if (p === undefined) return { kind: "rejected", promotionId: r.promotionId, reason: "not_found" };
      if (this.redemptions.some((x) => x.promotionId === r.promotionId && x.orderGroupId === r.orderGroupId)) {
        existing += 1;
        continue;
      }
      const rows = this.live(r.promotionId);
      if (p.perUserCap !== null && rows.filter((x) => x.userId === r.userId).length >= p.perUserCap) {
        return { kind: "rejected", promotionId: r.promotionId, reason: "cap_reached" };
      }
      if (p.perDayCap !== null && rows.filter((x) => x.dayKey === r.dayKey).length >= p.perDayCap) {
        return { kind: "rejected", promotionId: r.promotionId, reason: "cap_reached" };
      }
      if (p.totalBudget !== null && rows.reduce((s, x) => s + x.amount, 0n) + r.amount > p.totalBudget.amount) {
        return { kind: "rejected", promotionId: r.promotionId, reason: "budget_exhausted" };
      }
      fresh.push(r);
    }
    for (const r of fresh) this.redemptions.push({ ...r, status: "APPLIED" });
    return { kind: "recorded", recorded: fresh.length, existing };
  }

  async reinstate(orderGroupId: string, _nowMs: number): Promise<number> {
    this.check();
    let n = 0;
    for (const r of this.redemptions) {
      if (r.orderGroupId === orderGroupId && r.status === "APPLIED") {
        r.status = "REINSTATED";
        n += 1;
      }
    }
    return n;
  }
}

export class InMemoryPromotionEventPublisher implements PromotionEventPublisher {
  readonly events: PromotionEvent[] = [];
  async publish(event: PromotionEvent): Promise<void> {
    this.events.push(event);
  }
}

/** Compares the presented bearer token to one configured secret in constant time. */
export class StaticServiceTokenAuthenticator implements ServiceAuthenticator {
  private readonly expected: Buffer;
  constructor(token: string) {
    if (token.length < 24) throw new Error("service token must be at least 24 characters");
    this.expected = Buffer.from(`Bearer ${token}`, "utf8");
  }
  verify(header: string | undefined): boolean {
    if (header === undefined) return false;
    const got = Buffer.from(header, "utf8");
    return got.length === this.expected.length && timingSafeEqual(got, this.expected);
  }
}

/** Default in test mode: nobody is a service. Evaluate answers 401 until a real authenticator is wired. */
export class DenyAllServiceAuthenticator implements ServiceAuthenticator {
  verify(): boolean {
    return false;
  }
}
