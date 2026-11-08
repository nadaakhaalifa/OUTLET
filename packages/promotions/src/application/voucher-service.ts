import { withDbContext } from "@outlet/db";
import type { Queryable } from "@outlet/db";
import { uuidv7 } from "@outlet/ids";
import { authorize } from "@outlet/policy";
import type { Principal } from "@outlet/policy";
import { PromotionError } from "../domain/errors.js";
import { requiresCode } from "../domain/rules.js";
import type { AppliedPromotion } from "../domain/types.js";
import { generateCode, hashCode, normaliseCode, last4 } from "./codes.js";
import type { PromotionsDeps } from "./ports.js";
import { PROMOTION_COLS } from "./rows.js";
import type { PromotionRow } from "./rows.js";

export interface IssueInput {
  readonly promotionId: string;
  readonly storeId: string | null;
  readonly kind: "public_code" | "unique_code";
  /** public_code only, e.g. EID50 */
  readonly codeDisplay?: string;
  readonly assignedUserId?: string;
  readonly maxUses?: number;
}

const ACTIVE_RESERVATION = `r.kind = 'reserved' AND NOT EXISTS (SELECT 1 FROM voucher_redemptions x WHERE x.ref_id = r.id AND x.kind IN ('released', 'reinstated'))`;

interface ResRow { id: string; promotion_id: string; amount_minor: string | bigint; voucher_id: string | null; currency: string }

export class VoucherService {
  private readonly now: () => Date;
  private readonly newId: () => string;
  constructor(private readonly deps: PromotionsDeps) {
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? (() => uuidv7());
  }

  private asUser<T>(userId: string, fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return withDbContext(this.deps.client, { kind: "user", marketId: this.deps.marketId, userId }, fn);
  }

  /** Seller staff issue vouchers for their own store's promotions; marketing admins for platform and co-funded ones. Plaintext is returned once. */
  async issue(actor: Principal, input: IssueInput): Promise<{ voucherId: string; code: string }> {
    const d = authorize(actor, "promotion.write", { type: "voucher", marketId: this.deps.marketId, ...(input.storeId === null ? {} : { storeId: input.storeId }) });
    if (d.effect === "deny") throw new PromotionError(d.reason === "not_found" ? "NOT_FOUND" : "FORBIDDEN", d.reason);
    if (input.kind === "unique_code" && this.deps.hmacKey === undefined) throw new PromotionError("CODE_INVALID", "hmac key not configured");
    let code: string;
    let hash: Buffer | null = null;
    let tail: string | null = null;
    if (input.kind === "public_code") {
      code = (input.codeDisplay ?? "").trim().toUpperCase();
      if (!/^[A-Z0-9]{8,32}$/.test(code)) throw new PromotionError("CODE_INVALID", "public code must be 8-32 letters or digits");
    } else {
      code = generateCode();
      hash = hashCode(this.deps.hmacKey ?? new Uint8Array(), code);
      tail = last4(code);
    }
    const id = this.newId();
    const ctx = input.storeId === null
      ? ({ kind: "user", marketId: this.deps.marketId, ...(actor.userId === undefined ? {} : { userId: actor.userId }) } as const)
      : ({ kind: "store", marketId: this.deps.marketId, storeId: input.storeId, ...(actor.userId === undefined ? {} : { userId: actor.userId }) } as const);
    await withDbContext(this.deps.client, ctx, async (tx) => {
      const p = await tx.query<{ store_id: string | null; stacking_class: string; owner_type: string }>("SELECT store_id, stacking_class, owner_type FROM promotions WHERE id = $1 AND market_id = $2", [input.promotionId, this.deps.marketId]);
      const prom = p.rows[0];
      if (prom?.store_id !== input.storeId) throw new PromotionError("NOT_FOUND", "not found");
      if ((prom.owner_type === "store") !== (actor.kind === "seller_staff")) throw new PromotionError("FORBIDDEN", "forbidden");
      if (!requiresCode(prom.stacking_class as "auto")) throw new PromotionError("CODE_INVALID", "only code promotions take vouchers");
      await tx.query(
        `INSERT INTO vouchers (id, market_id, promotion_id, store_id, kind, code_display, code_hash, last4, assigned_user_id, max_uses, status, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active',$11)`,
        [id, this.deps.marketId, input.promotionId, input.storeId, input.kind, input.kind === "public_code" ? code : null, hash, tail, input.assignedUserId ?? null, input.maxUses ?? null, this.now().toISOString()],
      );
    });
    return { voucherId: id, code };
  }

  /** Resolves an entered code to (voucher, promotion row) for this shopper. Unknown, void, assigned-to-someone-else and exhausted all read as null. */
  async resolveCode(tx: Queryable, userId: string, raw: string, opts: { deviceId?: string } = {}): Promise<{ voucherId: string; promotion: PromotionRow } | null> {
    if (this.deps.codeBudget !== undefined && !(await this.deps.codeBudget.consume({ userId, deviceId: opts.deviceId ?? null }))) throw new PromotionError("ABUSE_BLOCKED", "too many code attempts");
    const display = raw.trim().toUpperCase();
    const hash = this.deps.hmacKey === undefined ? null : hashCode(this.deps.hmacKey, normaliseCode(raw));
    const v = await tx.query<{ id: string; promotion_id: string; max_uses: number | null; uses: number; assigned_user_id: string | null; status: string }>(
      "SELECT id, promotion_id, max_uses, uses, assigned_user_id, status FROM vouchers WHERE market_id = $1 AND (code_display = $2 OR ($3::bytea IS NOT NULL AND code_hash = $3::bytea))",
      [this.deps.marketId, display, hash],
    );
    const row = v.rows[0];
    if (row?.status !== "active" || (row.assigned_user_id !== null && row.assigned_user_id !== userId)) return null;
    if (row.max_uses !== null && row.uses >= row.max_uses) return null;
    const p = await tx.query<PromotionRow>(`SELECT ${PROMOTION_COLS} FROM promotions WHERE id = $1 AND market_id = $2`, [row.promotion_id, this.deps.marketId]);
    const promotion = p.rows[0];
    return promotion === undefined ? null : { voucherId: row.id, promotion };
  }

  private async assertEnabled(): Promise<void> {
    if (!(await this.deps.kill.isEnabled())) throw new PromotionError("DISABLED", "promotions are switched off");
  }

  /**
   * Place-time reservation, one transaction for every applied promotion of the order group. Idempotent by (order group, promotion):
   * a replay inserts nothing and counts nothing. Enforces per-user, total and budget caps (atomic conditional UPDATE), voucher max uses,
   * velocity and the abuse port. Any failure rolls the whole group back.
   */
  async reserve(userId: string, orderGroupId: string, applied: readonly AppliedPromotion[], opts: { deviceId?: string } = {}): Promise<{ reserved: number; replayed: number }> {
    await this.assertEnabled();
    const velocity = this.deps.velocityPerHour ?? 5;
    return this.asUser(userId, async (tx) => {
      let reserved = 0;
      let replayed = 0;
      // Serialise this shopper's reservations (velocity) and then each (shopper, promotion) pair (per-user limit), always in the same order, so
      // concurrent order groups cannot both read "under the limit" and both insert. Released automatically at commit/rollback.
      await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`velocity:${userId}`]);
      const sorted = [...applied].sort((a, b) => (a.promotionId < b.promotionId ? -1 : 1));
      for (const a of sorted) {
        await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${userId}${a.promotionId}`]);
        const existing = await tx.query("SELECT 1 FROM voucher_redemptions WHERE order_group_id = $1 AND promotion_id = $2 AND kind = 'reserved'", [orderGroupId, a.promotionId]);
        if (existing.rows.length > 0) { replayed++; continue; }
        const p = await tx.query<PromotionRow>(`SELECT ${PROMOTION_COLS} FROM promotions WHERE id = $1 AND market_id = $2`, [a.promotionId, this.deps.marketId]);
        const prom = p.rows[0];
        if (prom?.status !== "ACTIVE" || prom.version !== a.version) throw new PromotionError("CAP_EXCEEDED", `promotion ${a.promotionId} is no longer active at version ${String(a.version)}`);
        // Trust nothing from the caller: the voucher must belong to this promotion and the discount cannot exceed max_discount.
        if (a.voucherId !== null) {
          const vr = await tx.query<{ status: string; promotion_id: string }>("SELECT status, promotion_id FROM vouchers WHERE id = $1", [a.voucherId]);
          const v = vr.rows[0];
          if (v?.status !== "active") throw new PromotionError("CODE_INVALID", "voucher is not usable");
          if (v.promotion_id !== a.promotionId) throw new PromotionError("CODE_INVALID", "voucher does not belong to this promotion");
        }
        if (prom.max_discount_minor !== null && a.total.amountMinor > BigInt(prom.max_discount_minor)) throw new PromotionError("CAP_EXCEEDED", "discount exceeds max_discount");
        if (prom.per_user_limit !== null) {
          const n = await tx.query<{ n: string | number }>(`SELECT count(*) AS n FROM voucher_redemptions r WHERE r.promotion_id = $1 AND r.user_id = $2 AND ${ACTIVE_RESERVATION}`, [a.promotionId, userId]);
          if (Number(n.rows[0]?.n ?? 0) >= prom.per_user_limit) throw new PromotionError("CAP_EXCEEDED", "per-user limit reached");
        }
        const vel = await tx.query<{ n: string | number }>(`SELECT count(*) AS n FROM voucher_redemptions r WHERE r.user_id = $1 AND r.kind = 'reserved' AND r.created_at > $2`, [userId, new Date(this.now().getTime() - 3_600_000).toISOString()]);
        if (Number(vel.rows[0]?.n ?? 0) >= velocity) throw new PromotionError("ABUSE_BLOCKED", "velocity");
        if (this.deps.abuse !== undefined) {
          const verdict = await this.deps.abuse.assess({ userId, deviceId: opts.deviceId ?? null, promotionId: a.promotionId });
          if (!verdict.allow) throw new PromotionError("ABUSE_BLOCKED", verdict.reason);
        }
        const rid = this.newId();
        const ins = await tx.query(
          `INSERT INTO voucher_redemptions (id, voucher_id, promotion_id, promotion_version, user_id, market_id, order_group_id, kind, ref_id, amount_minor, platform_funded_minor, seller_funded_minor, currency, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'reserved',NULL,$8,$9,$10,$11,$12) ON CONFLICT (order_group_id, promotion_id, kind) DO NOTHING RETURNING id`,
          [rid, a.voucherId, a.promotionId, a.version, userId, this.deps.marketId, orderGroupId, a.total.amountMinor.toString(), a.platform.amountMinor.toString(), a.seller.amountMinor.toString(), a.total.currency, this.now().toISOString()],
        );
        if (ins.rows.length === 0) { replayed++; continue; }
        const bump = await tx.query<{ r: string }>("SELECT promotion_usage_bump($1, $2, $3) AS r", [a.promotionId, a.total.amountMinor.toString(), a.voucherId]);
        const outcome = bump.rows[0]?.r;
        if (outcome === "voucher_cap") throw new PromotionError("CAP_EXCEEDED", "voucher already used");
        if (outcome !== "ok") throw new PromotionError("CAP_EXCEEDED", `budget, total limit or max discount reached (${String(outcome)})`);
        reserved++;
      }
      return { reserved, replayed };
    });
  }

  private async groupRows(tx: Queryable, orderGroupId: string): Promise<(ResRow & { state: string })[]> {
    const r = await tx.query<ResRow & { state: string }>(
      `SELECT r.id, r.promotion_id, r.amount_minor, r.voucher_id, r.currency,
              CASE WHEN EXISTS (SELECT 1 FROM voucher_redemptions x WHERE x.ref_id = r.id AND x.kind = 'reinstated') THEN 'reinstated'
                   WHEN EXISTS (SELECT 1 FROM voucher_redemptions x WHERE x.ref_id = r.id AND x.kind = 'released') THEN 'released'
                   WHEN EXISTS (SELECT 1 FROM voucher_redemptions x WHERE x.ref_id = r.id AND x.kind = 'confirmed') THEN 'confirmed' ELSE 'reserved' END AS state
         FROM voucher_redemptions r WHERE r.order_group_id = $1 AND r.kind = 'reserved' ORDER BY r.promotion_id`,
      [orderGroupId],
    );
    return r.rows;
  }

  private async append(tx: Queryable, userId: string, orderGroupId: string, row: ResRow, kind: "confirmed" | "released" | "reinstated"): Promise<boolean> {
    const base = await tx.query<{ promotion_version: number; platform_funded_minor: string | bigint; seller_funded_minor: string | bigint }>(
      "SELECT promotion_version, platform_funded_minor, seller_funded_minor FROM voucher_redemptions WHERE id = $1", [row.id]);
    const b = base.rows[0];
    if (b === undefined) return false;
    const ins = await tx.query(
      `INSERT INTO voucher_redemptions (id, voucher_id, promotion_id, promotion_version, user_id, market_id, order_group_id, kind, ref_id, amount_minor, platform_funded_minor, seller_funded_minor, currency, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT (order_group_id, promotion_id, kind) DO NOTHING RETURNING id`,
      [this.newId(), row.voucher_id, row.promotion_id, b.promotion_version, userId, this.deps.marketId, orderGroupId, kind, row.id, row.amount_minor.toString(), b.platform_funded_minor.toString(), b.seller_funded_minor.toString(), row.currency, this.now().toISOString()],
    );
    return ins.rows.length > 0;
  }

  private async giveBack(tx: Queryable, row: ResRow): Promise<void> {
    await tx.query("SELECT promotion_usage_giveback($1, $2, $3)", [row.promotion_id, row.amount_minor.toString(), row.voucher_id]);
  }

  /** Payment succeeded: marks every live reservation of the group confirmed (idempotent). */
  async confirm(userId: string, orderGroupId: string): Promise<number> {
    return this.asUser(userId, async (tx) => {
      let n = 0;
      for (const r of await this.groupRows(tx, orderGroupId)) if (r.state === "reserved" && (await this.append(tx, userId, orderGroupId, r, "confirmed"))) n++;
      return n;
    });
  }

  /** Checkout failed or expired before payment: gives the caps back. Confirmed redemptions cannot be released (use reinstate). */
  async release(userId: string, orderGroupId: string): Promise<number> {
    return this.asUser(userId, async (tx) => {
      let n = 0;
      for (const r of await this.groupRows(tx, orderGroupId)) {
        if (r.state !== "reserved") continue;
        if (await this.append(tx, userId, orderGroupId, r, "released")) { await this.giveBack(tx, r); n++; }
      }
      return n;
    });
  }

  /**
   * Refund-then-reuse block: a paid voucher comes back ONLY when the whole order group was cancelled before shipping (OrderFactsPort).
   * A return or a partial refund never reinstates it.
   */
  async reinstate(userId: string, orderGroupId: string): Promise<number> {
    if (this.deps.orderFacts === undefined || !(await this.deps.orderFacts.wholeOrderCancelledBeforeShipping(orderGroupId))) {
      throw new PromotionError("REINSTATE_NOT_ALLOWED", "only a whole order cancelled before shipping reinstates a voucher");
    }
    return this.asUser(userId, async (tx) => {
      let n = 0;
      for (const r of await this.groupRows(tx, orderGroupId)) {
        if (r.state !== "confirmed") continue;
        if (await this.append(tx, userId, orderGroupId, r, "reinstated")) { await this.giveBack(tx, r); n++; }
      }
      return n;
    });
  }
}
