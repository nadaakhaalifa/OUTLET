import { withDbContext } from "@outlet/db";
import type { Queryable } from "@outlet/db";
import { uuidv7 } from "@outlet/ids";
import { authorize } from "@outlet/policy";
import type { Principal } from "@outlet/policy";
import type { Currency } from "@outlet/money";
import { PromotionError } from "../domain/errors.js";
import { parseRules, validateDraft } from "../domain/rules.js";
import type { OwnerType, PromotionStatus, PromotionType, Rules, StackingClass } from "../domain/rules.js";
import { assertTransition, isEditable } from "../domain/state.js";
import type { PromotionsDeps } from "./ports.js";
import { PROMOTION_COLS, toCandidate } from "./rows.js";
import type { PromotionRow } from "./rows.js";
import type { PromotionCandidate } from "../domain/types.js";

export interface PromotionInput {
  readonly ownerType: OwnerType;
  readonly storeId: string | null;
  readonly type: PromotionType;
  readonly nameAr: string;
  readonly nameEn?: string;
  readonly rules: unknown;
  readonly stackingClass: StackingClass;
  readonly fundingPlatformBp: number;
  readonly fundingSellerBp: number;
  readonly perUserLimit?: number;
  readonly totalLimit?: number;
  readonly minOrderMinor?: bigint;
  readonly maxDiscountMinor?: bigint;
  readonly budgetMinor?: bigint;
  readonly currency: Currency;
  /** instants; build them from Cairo calendar dates with cairoDateWindow */
  readonly startsAt: Date;
  readonly endsAt: Date;
}
export type PromotionPatch = Partial<Omit<PromotionInput, "ownerType" | "storeId" | "currency">>;

export class PromotionService {
  private readonly now: () => Date;
  private readonly newId: () => string;
  constructor(private readonly deps: PromotionsDeps) {
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? (() => uuidv7());
  }

  private ctxFor<T>(actor: Principal, storeId: string | null, fn: (tx: Queryable) => Promise<T>): Promise<T> {
    const userId = actor.userId === undefined ? {} : { userId: actor.userId };
    return withDbContext(
      this.deps.client,
      storeId === null ? { kind: "user", marketId: this.deps.marketId, ...userId } : { kind: "store", marketId: this.deps.marketId, storeId, ...userId },
      fn,
    );
  }

  /** Seller staff manage seller-funded promotions of their own store; marketing admins manage platform and co-funded ones. */
  private authorizeWrite(actor: Principal, ownerType: OwnerType, storeId: string | null): void {
    const wantsAdmin = ownerType !== "store";
    if (wantsAdmin !== (actor.kind === "admin")) throw new PromotionError("FORBIDDEN", "forbidden");
    const d = authorize(actor, "promotion.write", { type: "promotion", marketId: this.deps.marketId, ...(storeId === null ? {} : { storeId }) });
    if (d.effect === "deny") throw new PromotionError(d.reason === "not_found" ? "NOT_FOUND" : "FORBIDDEN", d.reason);
    if (actor.kind === "admin" && this.deps.audit === undefined) throw new PromotionError("NO_AUDIT", "audit port not configured");
  }

  private async audit(actor: Principal, action: string, id: string, before: unknown, after: unknown): Promise<void> {
    if (this.deps.audit === undefined) return;
    await this.deps.audit.append({
      marketId: this.deps.marketId, actorType: actor.kind === "admin" ? "staff" : "seller", actorId: actor.userId ?? null, action, targetType: "promotion", targetId: id,
      diff: { before, after }, ipHash: null, deviceId: null, requestId: null,
    });
  }

  async create(actor: Principal, input: PromotionInput): Promise<{ id: string; version: number }> {
    this.authorizeWrite(actor, input.ownerType, input.storeId);
    const rules = parseRules(input.rules);
    validateDraft({ ownerType: input.ownerType, storeId: input.storeId, type: input.type, stackingClass: input.stackingClass, rules, fundingPlatformBp: input.fundingPlatformBp, fundingSellerBp: input.fundingSellerBp });
    if (input.endsAt <= input.startsAt) throw new PromotionError("INVALID_PROMOTION", "ends_at must be after starts_at");
    const id = this.newId();
    const now = this.now().toISOString();
    await this.ctxFor(actor, input.storeId, async (tx) => {
      await tx.query(
        `INSERT INTO promotions (id, market_id, owner_type, store_id, type, name_ar, name_en, rules, stacking_class, funding_platform_bp, funding_seller_bp, per_user_limit, total_limit,
           min_order_minor, max_discount_minor, budget_minor, currency, starts_at, ends_at, status, version, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'DRAFT',1,$20,$21,$21)`,
        [id, this.deps.marketId, input.ownerType, input.storeId, input.type, input.nameAr, input.nameEn ?? null, JSON.stringify(rules), input.stackingClass, input.fundingPlatformBp, input.fundingSellerBp,
          input.perUserLimit ?? null, input.totalLimit ?? null, input.minOrderMinor?.toString() ?? null, input.maxDiscountMinor?.toString() ?? null, input.budgetMinor?.toString() ?? null,
          input.currency, input.startsAt.toISOString(), input.endsAt.toISOString(), actor.userId ?? null, now],
      );
      await tx.query("INSERT INTO promotion_usage (promotion_id, store_id, market_id, currency) VALUES ($1,$2,$3,$4)", [id, input.storeId, this.deps.marketId, input.currency]);
      await this.snapshot(tx, id, input.storeId, 1, actor, { ...input, rules, minOrderMinor: input.minOrderMinor?.toString(), maxDiscountMinor: input.maxDiscountMinor?.toString(), budgetMinor: input.budgetMinor?.toString() });
      await this.audit(actor, "promotion.create", id, null, { type: input.type, ownerType: input.ownerType, storeId: input.storeId, version: 1 });
    });
    return { id, version: 1 };
  }

  private async snapshot(tx: Queryable, id: string, storeId: string | null, version: number, actor: Principal, snap: unknown): Promise<void> {
    await tx.query("INSERT INTO promotion_versions (promotion_id, version, store_id, market_id, snapshot, changed_by) VALUES ($1,$2,$3,$4,$5::jsonb,$6)", [
      id, version, storeId, this.deps.marketId, JSON.stringify(snap, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)), actor.userId ?? null,
    ]);
  }

  private async load(tx: Queryable, id: string): Promise<PromotionRow> {
    const r = await tx.query<PromotionRow>(`SELECT ${PROMOTION_COLS} FROM promotions WHERE id = $1 AND market_id = $2`, [id, this.deps.marketId]);
    const row = r.rows[0];
    if (row === undefined) throw new PromotionError("NOT_FOUND", "not found");
    return row;
  }

  /** Reads one promotion. Under a store context a foreign store's promotion is simply not there (404). */
  private async findScope(actor: Principal, id: string, storeId: string | null): Promise<PromotionRow> {
    const d = authorize(actor, "promotion.write", { type: "promotion", marketId: this.deps.marketId, ...(storeId === null ? {} : { storeId }) });
    if (d.effect === "deny") throw new PromotionError(d.reason === "not_found" ? "NOT_FOUND" : "FORBIDDEN", d.reason);
    return this.ctxFor(actor, storeId, (tx) => this.load(tx, id));
  }

  async get(actor: Principal, id: string, storeId: string | null): Promise<PromotionCandidate> {
    const row = await this.findScope(actor, id, storeId);
    this.authorizeWrite(actor, row.owner_type, row.store_id);
    return toCandidate(row);
  }

  async update(actor: Principal, id: string, storeId: string | null, expectedVersion: number, patch: PromotionPatch): Promise<{ version: number }> {
    const row = await this.findScope(actor, id, storeId);
    this.authorizeWrite(actor, row.owner_type, row.store_id);
    if (row.version !== expectedVersion) throw new PromotionError("VERSION_CONFLICT", "stale version");
    if (!isEditable(row.status)) throw new PromotionError("NOT_EDITABLE", `promotion is ${row.status}; pause it first`);
    const cur = toCandidate(row);
    const rules: Rules = patch.rules === undefined ? cur.rules : parseRules(patch.rules);
    const next = {
      type: patch.type ?? cur.type, stackingClass: patch.stackingClass ?? cur.stackingClass, fundingPlatformBp: patch.fundingPlatformBp ?? cur.fundingPlatformBp,
      fundingSellerBp: patch.fundingSellerBp ?? cur.fundingSellerBp,
    };
    validateDraft({ ownerType: cur.ownerType, storeId: cur.storeId, rules, ...next });
    const startsAt = patch.startsAt ?? cur.startsAt;
    const endsAt = patch.endsAt ?? cur.endsAt;
    if (endsAt <= startsAt) throw new PromotionError("INVALID_PROMOTION", "ends_at must be after starts_at");
    const version = row.version + 1;
    await this.ctxFor(actor, row.store_id, async (tx) => {
      const r = await tx.query(
        `UPDATE promotions SET type=$3, name_ar=$4, name_en=$5, rules=$6::jsonb, stacking_class=$7, funding_platform_bp=$8, funding_seller_bp=$9, per_user_limit=$10, total_limit=$11,
           min_order_minor=$12, max_discount_minor=$13, budget_minor=$14, starts_at=$15, ends_at=$16, version=$17, updated_at=$18
         WHERE id=$1 AND version=$2 RETURNING id`,
        [id, expectedVersion, next.type, patch.nameAr ?? row.name_ar, patch.nameEn ?? row.name_en, JSON.stringify(rules), next.stackingClass, next.fundingPlatformBp, next.fundingSellerBp,
          patch.perUserLimit ?? row.per_user_limit, patch.totalLimit ?? row.total_limit, (patch.minOrderMinor ?? cur.minOrderMinor)?.toString() ?? null,
          (patch.maxDiscountMinor ?? cur.maxDiscountMinor)?.toString() ?? null, (patch.budgetMinor ?? cur.budgetMinor)?.toString() ?? null, startsAt.toISOString(), endsAt.toISOString(), version, this.now().toISOString()],
      );
      if (r.rows.length === 0) throw new PromotionError("VERSION_CONFLICT", "stale version");
      await this.snapshot(tx, id, row.store_id, version, actor, { ...patch, rules });
      await this.audit(actor, "promotion.update", id, { version: row.version }, { version, fields: Object.keys(patch) });
    });
    return { version };
  }

  async transition(actor: Principal, id: string, storeId: string | null, to: PromotionStatus): Promise<void> {
    const row = await this.findScope(actor, id, storeId);
    this.authorizeWrite(actor, row.owner_type, row.store_id);
    assertTransition(row.status, to);
    await this.ctxFor(actor, row.store_id, async (tx) => {
      const r = await tx.query("UPDATE promotions SET status=$3, updated_at=$4 WHERE id=$1 AND status=$2 RETURNING id", [id, row.status, to, this.now().toISOString()]);
      if (r.rows.length === 0) throw new PromotionError("INVALID_TRANSITION", "status changed concurrently");
      await this.audit(actor, "promotion.transition", id, { status: row.status }, { status: to });
    });
  }
}
