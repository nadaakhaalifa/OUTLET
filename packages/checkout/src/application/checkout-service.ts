import { withDbContext } from "@outlet/db";
import type { Queryable } from "@outlet/db";
import type { ClaimResult } from "@outlet/inventory";
import { compare, money, sub } from "@outlet/money";
import type { Currency, Money } from "@outlet/money";
import { taxSnapshotForLine } from "@outlet/tax";
import { CheckoutError } from "../domain/errors.js";
import { compareLock } from "../domain/price-lock.js";
import { KILL_SWITCH_OF, holdSecondsOf, holdWindowOf, isExternal, secondsToMs } from "../domain/methods.js";
import { canonical, canonicalQuote, quote as buildQuote } from "../domain/quote.js";
import { sellerAmounts, splitInstructions } from "../domain/split.js";
import type { Quote, QuoteLineInput } from "../domain/types.js";
import { PAYMENT_METHODS } from "../ports.js";
import type { ClientAction, ExternalMethod, PaymentMethod, RiskDecision } from "../ports.js";
import { eachStoreContext } from "./context.js";
import { makeEnv } from "./env.js";
import type { CheckoutDeps, Env } from "./env.js";
import { sha256Hex } from "./hash.js";
import { emit, lockGroup, lockIntentOfGroup, loadSellerAmounts, moveGroup, moveIntent } from "./order-ops.js";
import type { GroupRow } from "./order-ops.js";
import { compensate, recordCodConfirmed, recordPaid } from "./settlement.js";

export interface QuoteRequest {
  readonly addressRef: string;
  readonly method: PaymentMethod;
  /** Store credit the shopper wants to apply (split tender). Ignored for method store_credit (spends as much as the total needs). */
  readonly creditRequested?: Money;
  readonly bnplProvider?: string;
}

export interface QuoteResult {
  readonly quote: Quote;
  /** HMAC-signed token over the quote hash, method and user (10 min). The client echoes quote + token at placement. */
  readonly token: string;
  readonly expiresAt: Date;
  /** Bag lines that could not be quoted (unlisted, store suspended, out of stock, no delivery coverage). */
  readonly unavailableSkus: readonly string[];
}

export interface PlaceInput extends QuoteRequest {
  /** Client-generated UUIDv7 (Idempotency-Key header). */
  readonly idempotencyKey: string;
  readonly quoteToken: string;
  /** The quote the shopper saw. Trusted only if its canonical hash equals the token's quote hash. */
  readonly quote: Quote;
}

export interface PlaceResult {
  readonly orderGroupId: string;
  readonly status: string;
  readonly clientAction: ClientAction;
  readonly replayed: boolean;
}

export interface OrderGroupView {
  readonly id: string;
  readonly status: string;
  readonly paymentMethod: PaymentMethod;
  readonly total: Money;
  readonly storeCredit: Money;
  readonly clientAction: ClientAction | null;
  readonly intentStatus: string | null;
  readonly sellerOrders: readonly { readonly id: string; readonly storeId: string; readonly status: string; readonly total: Money }[];
}

interface CartRow {
  cart_line_id: string; sku_id: string; product_id: string; store_id: string; qty: number; title_ar: string | null; title_en: string | null;
  condition_grade_code: string | null; price_minor: string | null; store_active: boolean;
}
interface LineMeta { readonly productId: string; readonly titleAr: string; readonly titleEn: string | null; readonly conditionGrade: string; readonly locationId: string; readonly evidenceIds: readonly string[] }
interface Built { readonly quote: Quote; readonly meta: ReadonlyMap<string, LineMeta>; readonly unavailable: readonly string[] }

const CART_SQL = `
  SELECT cl.id AS cart_line_id, cl.sku_id, cl.product_id, cl.store_ref AS store_id, cl.qty, l.title_ar, l.title_en, l.condition_grade_code,
         (SELECT v ->> 'price_minor' FROM jsonb_array_elements(l.variants) v WHERE v ->> 'sku_id' = cl.sku_id::text LIMIT 1) AS price_minor,
         (s.id IS NOT NULL) AS store_active
    FROM carts c JOIN cart_lines cl ON cl.cart_id = c.id
    LEFT JOIN catalog_public_listings l ON l.id = cl.product_id AND l.status = 'PUBLISHED' AND l.market_id = $2
    LEFT JOIN catalog_public_stores s ON s.id = cl.store_ref AND s.status = 'ACTIVE' AND s.market_id = $2
   WHERE c.user_id = $1 AND c.market_id = $2 AND c.status = 'active' ORDER BY cl.sku_id`;
const STOCK_SQL = "SELECT sku_id, location_id, (on_hand - committed) AS free FROM inventory_levels WHERE sku_id = ANY($1::uuid[]) ORDER BY free DESC, location_id";

const BIG = 2n ** 62n;
const MAX_QTY = 10;
const isUnique = (e: unknown): boolean => typeof e === "object" && e !== null && "code" in e && e.code === "23505";
const iso = (d: Date): string => d.toISOString();

export class CheckoutService {
  private readonly env: Env;
  private readonly d: CheckoutDeps;
  constructor(deps: CheckoutDeps) {
    this.d = deps;
    this.env = makeEnv(deps);
  }

  private inUserTx<T>(userId: string, fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return withDbContext(this.d.client, { kind: "user", marketId: this.env.marketId, userId }, fn);
  }

  // ------------------------------------------------------------------ quote (pure: no writes)
  async quote(userId: string, req: QuoteRequest): Promise<QuoteResult> {
    return this.inUserTx(userId, async (tx) => {
      const built = await this.build(tx, userId, req);
      if (!built.quote.payableByMethod.has(req.method)) throw new CheckoutError("method-unavailable", "payment method is not available");
      const expiresAt = new Date(this.env.now().getTime() + secondsToMs(this.env.config.priceLockSec));
      const token = this.env.tokens.sign({ jti: this.env.newId(), userId, marketId: this.env.marketId, quoteHash: built.quote.hash, method: req.method, expiresAt });
      return { quote: built.quote, token, expiresAt, unavailableSkus: built.unavailable };
    });
  }

  /** Recomputes everything from the database and the ports; the client's numbers are never read. */
  private async build(tx: Queryable, userId: string, req: QuoteRequest): Promise<Built> {
    const env = this.env;
    const cur = env.currency;
    const zero = money(0n, cur);
    const addr = await env.address.resolve(userId, req.addressRef);
    if (addr === null) throw new CheckoutError("address-not-found", "address not found");
    if (req.method === "cod" && req.creditRequested !== undefined && req.creditRequested.amountMinor > 0n) throw new CheckoutError("cod-credit-unsupported", "store credit cannot be combined with cash on delivery");

    const rows = (await tx.query<CartRow>(CART_SQL, [userId, env.marketId])).rows;
    // C10: the order_lines CHECK (qty 1..10) would surface as a raw 500; refuse the bag with a typed 422 first
    if (rows.some((r) => !Number.isInteger(r.qty) || r.qty < 1 || r.qty > MAX_QTY)) throw new CheckoutError("invalid-quantity", `each bag line must have a quantity from 1 to ${String(MAX_QTY)}`);
    const unavailable = new Set<string>();
    const listed = rows.filter((r) => {
      const ok = r.price_minor !== null && r.title_ar !== null && r.store_active;
      if (!ok) unavailable.add(r.sku_id);
      return ok;
    });
    const storeIds = [...new Set(listed.map((r) => r.store_id))].sort();
    const stock = await eachStoreContext(tx, env.marketId, storeIds, async (storeId) => {
      const skus = listed.filter((r) => r.store_id === storeId).map((r) => r.sku_id);
      return (await tx.query<{ sku_id: string; location_id: string; free: number }>(STOCK_SQL, [skus])).rows;
    });
    const located = new Map<string, string>();
    const inStock = listed.filter((r) => {
      const best = stock.get(r.store_id)?.find((s) => s.sku_id === r.sku_id && s.free >= r.qty);
      if (best === undefined) {
        unavailable.add(r.sku_id);
        return false;
      }
      located.set(r.sku_id, best.location_id);
      return true;
    });

    // shipping per store (a store we cannot deliver from drops out of the quote)
    const shipping = new Map<string, { fee: Money; quoteRef: string; etaDaysMin: number; etaDaysMax: number }>();
    for (const storeId of [...new Set(inStock.map((r) => r.store_id))].sort()) {
      const lines = inStock.filter((r) => r.store_id === storeId);
      const items = lines.reduce((a, r) => a + BigInt(r.price_minor ?? "0") * BigInt(r.qty), 0n);
      const s = await env.shipping.quote({ marketId: env.marketId, storeId, addressRef: req.addressRef, itemsSubtotal: money(items, cur), parcels: lines.map((r) => ({ skuId: r.sku_id, qty: r.qty })) });
      if ("unavailable" in s) for (const r of lines) unavailable.add(r.sku_id);
      else shipping.set(storeId, { fee: s.fee, quoteRef: s.quoteRef, etaDaysMin: s.etaDaysMin, etaDaysMax: s.etaDaysMax });
    }
    const quotable = inStock.filter((r) => shipping.has(r.store_id));
    if (quotable.length === 0) throw new CheckoutError("empty-bag", "nothing in the bag can be bought");

    const skuIds = quotable.map((r) => r.sku_id);
    const categories = await env.taxCategories.categoriesFor(skuIds);
    const taxMarket = env.marketId.toLowerCase();
    const now = env.now();
    const meta = new Map<string, LineMeta>();
    const lines: QuoteLineInput[] = [];
    for (const r of quotable) {
      const snap = await env.prices.snapshotForOrderLine(r.sku_id);
      const category = categories.get(r.sku_id) ?? "standard";
      const tax = taxSnapshotForLine({ marketId: taxMarket, taxCategory: category }, now, env.taxRates);
      lines.push({
        cartLineId: r.cart_line_id, skuId: r.sku_id, productId: r.product_id, storeId: r.store_id, qty: r.qty, unitPrice: money(BigInt(r.price_minor ?? "0"), cur),
        titleAr: r.title_ar ?? "", titleEn: r.title_en, conditionGrade: r.condition_grade_code ?? "", defectCardId: null, vrp: snap.vrp, claimType: snap.claimType,
        evidenceIds: snap.evidenceIds, taxCategory: category, vatBp: tax.bps,
      });
      meta.set(r.sku_id, { productId: r.product_id, titleAr: r.title_ar ?? "", titleEn: r.title_en, conditionGrade: r.condition_grade_code ?? "", locationId: located.get(r.sku_id) ?? "", evidenceIds: snap.evidenceIds });
    }

    // methods: kill switches fail closed (an engaged switch removes the method from the quote)
    const methods = new Map<PaymentMethod, { fee: Money }>();
    for (const m of PAYMENT_METHODS) {
      if (await env.killSwitches.isEngaged(KILL_SWITCH_OF[m])) continue;
      if (isExternal(m) && !env.provider.supports(m)) continue;
      // C8: the ledger cannot book a payment-method fee yet (no payment_fee_revenue account), so a fee-bearing method is excluded here
      // instead of being shown and then refused at placement. Revisit when the ledger owner adds the account (README section 12).
      if (env.config.methodFee[m].amountMinor > 0n) continue;
      methods.set(m, { fee: env.config.methodFee[m] });
    }
    const creditOn = !(await env.killSwitches.isEngaged(KILL_SWITCH_OF.store_credit));
    const creditAvailable = creditOn && req.method !== "cod" ? await env.credit.available(tx, userId, env.marketId) : zero;
    const creditRequested = req.method === "store_credit" ? money(BIG, cur) : (req.creditRequested ?? zero);
    const quote = buildQuote(
      { marketId: env.marketId, currency: cur, lines, shipping, methods, creditAvailable, creditRequested, shippingTaxBp: env.config.shippingTaxBp, discount: zero },
      sha256Hex,
    );
    return { quote, meta, unavailable: [...unavailable].sort() };
  }

  // ------------------------------------------------------------------ place
  async place(userId: string, input: PlaceInput): Promise<PlaceResult> {
    const tok = this.env.tokens.verify(input.quoteToken);
    if (tok?.userId !== userId || tok.marketId !== this.env.marketId) throw new CheckoutError("quote-token-invalid", "quote token is not valid");
    let placed: { groupId: string; resume: boolean; claim: ClaimResult | null } | undefined;
    for (let attempt = 0; placed === undefined; attempt += 1) {
      try {
        placed = await this.inUserTx(userId, (tx) => this.placeIn(tx, userId, input, tok));
      } catch (e) {
        // two taps raced past the key lookup: the unique index lets one win, the loser replays
        if (!isUnique(e)) throw e;
        // C7: the second unique violation is not a key race (the replay would have found the group): the same quote token (session id) was
        // used with another Idempotency-Key. A typed 409, never the raw database error.
        if (attempt > 0) throw new CheckoutError("quote-token-invalid", "this quote was already used to place an order; request a new quote", {}, 409);
      }
    }
    if (placed.claim !== null) await this.env.reservations.publish(placed.claim);
    return this.afterPlace(userId, placed.groupId, placed.resume);
  }

  private async placeIn(tx: Queryable, userId: string, input: PlaceInput, tok: NonNullable<ReturnType<Env["tokens"]["verify"]>>): Promise<{ groupId: string; resume: boolean; claim: ClaimResult | null }> {
    const env = this.env;
    const existing = (await tx.query<{ id: string; checkout_session_id: string }>("SELECT id, checkout_session_id FROM order_groups WHERE user_id = $1 AND idempotency_key = $2", [userId, input.idempotencyKey])).rows[0];
    if (existing !== undefined) {
      if (existing.checkout_session_id !== tok.jti) throw new CheckoutError("idempotency-conflict", "Idempotency-Key was used with a different request");
      return { groupId: existing.id, resume: true, claim: null };
    }
    const built = await this.build(tx, userId, input);
    const q = built.quote;
    const method = input.method;
    if (tok.method !== method) throw new CheckoutError("quote-token-invalid", "quote token was issued for another payment method");
    if (!q.payableByMethod.has(method)) throw new CheckoutError("method-unavailable", "payment method is not available");
    if (tok.expiresAt.getTime() <= env.now().getTime()) throw new CheckoutError("quote-expired", "the quote has expired", { fresh: q });
    if (sha256Hex(canonicalQuote(input.quote)) !== tok.quoteHash) throw new CheckoutError("quote-token-invalid", "the echoed quote does not match the signed token");
    const deltas = compareLock(input.quote, q, method);
    if (deltas.length > 0) throw new CheckoutError("price-changed", "prices or fees changed since the quote", { deltas, fresh: q });

    const fee = env.config.methodFee[method];
    if (fee.amountMinor > 0n) throw new CheckoutError("method-unavailable", "a non-zero payment-method fee is not supported by the ledger yet");
    const total = q.total;
    const credit = q.storeCredit;
    const external = sub(total, credit);
    if (method === "store_credit" && external.amountMinor > 0n) throw new CheckoutError("credit-insufficient", "store credit does not cover the total");
    if (method !== "store_credit" && method !== "cod" && input.creditRequested !== undefined && compare(credit, input.creditRequested) < 0) throw new CheckoutError("credit-insufficient", "store credit balance is lower than requested");
    const externalPay = method !== "cod" && method !== "store_credit";

    let risk: RiskDecision | null = null;
    if (method === "cod") {
      // C6: the first-order cap is a floor that holds even if the risk adapter is missing, wrong or says allow (master prompt 20.7)
      if (compare(total, env.config.codMaxFirstOrder) > 0) throw new CheckoutError("cod-not-allowed", "cash on delivery is not available above the first-order limit", { riskDecision: "limit_value" });
      const r = await env.risk.assessCod({ userId, marketId: env.marketId, total, addressRef: input.addressRef, storeCount: q.stores.length });
      risk = r.decision;
      if (r.decision !== "allow" && r.decision !== "require_confirmation") throw new CheckoutError("cod-not-allowed", "cash on delivery is not available for this order", { riskDecision: r.decision });
    }

    // seller amounts and (model A) sub-merchant refs: a store that cannot be paid out through the PSP fails closed
    const now = env.now();
    const amounts = [];
    const subMerchants = new Map<string, string | null>();
    const commissionPlans = new Map<string, string | null>();
    for (const s of q.stores) {
      const rate = await env.commission.rateFor(s.storeId, now);
      commissionPlans.set(s.storeId, rate.planId);
      amounts.push(sellerAmounts(s, rate.bp, env.config.commissionVatBp));
      const ref = await env.subMerchants.refFor(s.storeId);
      if (externalPay && ref === null) throw new CheckoutError("store-not-onboarded", "a store in this order is not set up for payments");
      subMerchants.set(s.storeId, ref);
    }

    const groupId = env.newId();
    const window = holdWindowOf(env.config, method);
    const ttlSec = holdSecondsOf(env.config, method);
    const reserve = await env.reservations.reserveIn(tx, {
      orderGroupRef: groupId, userId, ttlSec, ttlPolicy: window,
      items: q.stores.flatMap((s) => s.lines.map((l) => ({ skuId: l.skuId, locationId: built.meta.get(l.skuId)?.locationId ?? "", storeId: s.storeId, qty: l.qty }))),
    });
    if (!reserve.ok) throw new CheckoutError("stock-shortfall", "some items are no longer available in the requested quantity", { shortfalls: reserve.shortfalls });
    const expiresAt = new Date(reserve.expiresAt);

    const sessionId = tok.jti;
    await tx.query(
      `INSERT INTO checkout_sessions (id, user_id, market_id, currency, quote, quote_hash, payment_method, address_ref, price_lock_expires_at, reservation_id, status)
       VALUES ($1,$2,$3,$4,$5::jsonb,decode($6,'hex'),$7,$8,$9,$10,'submitted')`,
      [sessionId, userId, env.marketId, env.currency, canonical(Object.fromEntries(Object.entries(q).filter(([k]) => k !== "hash"))), q.hash, method, input.addressRef, iso(tok.expiresAt), reserve.reservationId],
    );
    await tx.query(
      `INSERT INTO order_groups (id, user_id, market_id, currency, status, funds_flow, checkout_session_id, idempotency_key, payment_method, items_subtotal_minor, discount_minor,
         shipping_minor, shipping_vat_minor, vat_minor, store_credit_minor, total_minor, risk_decision, reservation_id, payment_expires_at, placed_at)
       VALUES ($1,$2,$3,$4,'PENDING_PAYMENT',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [
        groupId, userId, env.marketId, env.currency, env.config.fundsFlow, sessionId, input.idempotencyKey, method, q.itemsSubtotal.amountMinor.toString(), q.discount.amountMinor.toString(),
        q.shipping.amountMinor.toString(), amounts.reduce((a, s) => a + s.shippingVat.amountMinor, 0n).toString(), q.vat.amountMinor.toString(), credit.amountMinor.toString(), total.amountMinor.toString(),
        risk, reserve.reservationId, iso(expiresAt), iso(now),
      ],
    );
    await tx.query("UPDATE checkout_sessions SET order_group_id = $2 WHERE id = $1", [sessionId, groupId]);
    for (const s of q.stores) {
      const a = amounts.find((x) => x.storeId === s.storeId);
      if (a === undefined) throw new Error("seller amounts missing");
      const soId = env.newId();
      await tx.query(
        `INSERT INTO seller_orders (id, order_group_id, store_id, user_id, market_id, currency, status, funds_flow, items_subtotal_minor, shipping_minor, shipping_vat_minor, vat_minor,
           total_minor, commission_bp_snapshot, commission_minor, commission_vat_minor, seller_net_minor, plan_id_snapshot, shipping_quote_ref)
         VALUES ($1,$2,$3,$4,$5,$6,'PENDING_PAYMENT',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb)`,
        [
          soId, groupId, s.storeId, userId, env.marketId, env.currency, env.config.fundsFlow, s.itemsSubtotal.amountMinor.toString(), s.shipping.gross.amountMinor.toString(),
          s.shipping.vat.amountMinor.toString(), s.vat.amountMinor.toString(), s.total.amountMinor.toString(), a.commissionBp, a.commission.amountMinor.toString(),
          a.commissionVat.amountMinor.toString(), a.net.amountMinor.toString(), commissionPlans.get(s.storeId) ?? null,
          JSON.stringify({ quote_ref: s.shipping.quoteRef, eta_days_min: s.shipping.etaDaysMin, eta_days_max: s.shipping.etaDaysMax }),
        ],
      );
      for (const l of s.lines) {
        const m = built.meta.get(l.skuId);
        if (m === undefined) throw new Error("line meta missing");
        const verified = l.verifiedSaving.amountMinor > 0n;
        await tx.query(
          `INSERT INTO order_lines (id, seller_order_id, order_group_id, store_id, user_id, market_id, sku_id, product_id, title_ar_snapshot, title_en_snapshot, condition_grade_snapshot,
             qty, unit_price_minor, currency, tax_category, vat_rate_bp, vat_minor, vrp_minor_snapshot, claim_type_snapshot, evidence_ids_snapshot)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::uuid[])`,
          [
            env.newId(), soId, groupId, s.storeId, userId, env.marketId, l.skuId, m.productId, m.titleAr, m.titleEn, m.conditionGrade, l.qty, l.unitPrice.amountMinor.toString(), env.currency,
            l.taxCategory, l.vatBp, l.vat.amountMinor.toString(), verified || (l.claimType === "lowest_30d" && l.vrp !== null) ? (l.vrp?.amountMinor.toString() ?? null) : null,
            l.claimType === "verified_discount" && !verified ? "plain" : l.claimType, verified ? m.evidenceIds : [],
          ],
        );
      }
    }
    if (credit.amountMinor > 0n) await env.credit.hold(tx, { userId, marketId: env.marketId, orderGroupId: groupId, amount: credit, expiresAt });
    await tx.query(
      `INSERT INTO payment_intents (id, order_group_id, user_id, market_id, provider, method, bnpl_provider, amount_minor, currency, status, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'CREATED',$10)`,
      [env.newId(), groupId, userId, env.marketId, externalPay ? env.config.provider : "none", method, input.bnplProvider ?? null, external.amountMinor.toString(), env.currency, iso(expiresAt)],
    );
    await emit(env, tx, "order_group.placed", groupId, { total_minor: total.amountMinor.toString(), currency: env.currency, payment_method: method, store_count: q.stores.length });

    if (externalPay) return { groupId, resume: false, claim: null };
    const g = await lockGroup(tx, groupId);
    const intent = await lockIntentOfGroup(tx, groupId);
    if (method === "cod" && risk === "require_confirmation") {
      await moveIntent(env, tx, intent, "not_required");
      await moveGroup(env, tx, g, "cod_requires_confirmation");
      await tx.query("UPDATE payment_intents SET client_action = $2::jsonb WHERE id = $1", [intent.id, JSON.stringify({ kind: "cod_confirmation", channel: "whatsapp", expiresAt: iso(expiresAt) })]);
      return { groupId, resume: false, claim: null };
    }
    const claim = await env.reservations.claimIn(tx, reserve.reservationId);
    if (claim.outcome === "unavailable") throw new CheckoutError("stock-shortfall", "some items are no longer available", { shortfalls: claim.shortfalls });
    if (method === "cod") {
      await moveIntent(env, tx, intent, "not_required");
      await recordCodConfirmed(env, tx, g);
    } else {
      await recordPaid(env, tx, g, { ...intent, status: "NOT_REQUIRED" }, { late: false });
      await moveIntent(env, tx, intent, "not_required");
    }
    return { groupId, resume: false, claim };
  }

  /** External tender: the PSP call is never inside a database transaction (README section 2). Same Idempotency-Key resumes a half-placed group. */
  private async afterPlace(userId: string, groupId: string, resume: boolean): Promise<PlaceResult> {
    const env = this.env;
    const state = await this.inUserTx(userId, async (tx) => {
      const g = await lockGroup(tx, groupId);
      const i = await lockIntentOfGroup(tx, groupId);
      return { g, i };
    });
    const needsPsp = state.i.status === "CREATED" && state.g.status === "PENDING_PAYMENT" && state.i.method !== "cod" && state.i.method !== "store_credit";
    if (needsPsp) {
      const method = state.i.method as ExternalMethod;
      const plan = await this.inUserTx(userId, async (tx) => {
        const { sellers, sellerOrderIds } = await loadSellerAmounts(tx, groupId, state.g.currency);
        return { sellers, sellerOrderIds };
      });
      const subs = new Map<string, string | null>();
      for (const s of plan.sellers) subs.set(s.storeId, await env.subMerchants.refFor(s.storeId));
      if ([...subs.values()].some((v) => v === null)) throw new CheckoutError("store-not-onboarded", "a store in this order is not set up for payments");
      const expiresAt = new Date(state.g.payment_expires_at ?? env.now());
      const amount = money(BigInt(state.i.amount_minor), state.g.currency);
      const res = await env.provider.createIntent(
        {
          paymentIntentId: state.i.id, orderGroupId: groupId, marketId: env.marketId, method, ...(state.i.bnpl_provider === null ? {} : { bnplProvider: state.i.bnpl_provider }), amount,
          split: splitInstructions(plan.sellers, amount, plan.sellerOrderIds, subs), billing: await env.billing.billingFor(userId), locale: "ar", returnUrl: `outlet://orders/${groupId}`, expiresAt,
        },
        groupId,
      );
      if (!res.ok) {
        if (res.retryable) throw new CheckoutError("psp-unavailable", "the payment provider did not answer; retry with the same Idempotency-Key");
        await this.inUserTx(userId, async (tx) => {
          const g = await lockGroup(tx, groupId);
          const i = await lockIntentOfGroup(tx, groupId);
          await compensate(env, tx, g, i, "failed", res.code);
        });
        throw new CheckoutError("payment-declined", "the payment was declined");
      }
      await this.inUserTx(userId, async (tx) => {
        const i = await lockIntentOfGroup(tx, groupId);
        await tx.query("UPDATE payment_intents SET provider_ref = COALESCE(provider_ref, $2), client_action = $3::jsonb, updated_at = $4::timestamptz WHERE id = $1", [i.id, res.providerRef, JSON.stringify(res.clientAction), iso(env.now())]);
        // the webhook may have landed first (capture / failure): then the status is already past CREATED and stays
        if (i.status === "CREATED") await moveIntent(env, tx, i, res.status === "authorized" ? "authorize" : "provider_created");
      });
    }
    const view = await this.getOrderGroup(userId, groupId);
    return { orderGroupId: groupId, status: view.status, clientAction: view.clientAction ?? { kind: "none" }, replayed: resume };
  }

  /** COD confirmation (WhatsApp / SMS / IVR): claim immediately, then CONFIRMED_COD. */
  async confirmCod(userId: string, orderGroupId: string): Promise<{ status: string }> {
    const claim = await this.inUserTx(userId, async (tx) => {
      const g = await lockGroup(tx, orderGroupId);
      if (g.status !== "AWAITING_COD_CONFIRMATION" || g.reservation_id === null) throw new CheckoutError("invalid-state", "order is not waiting for COD confirmation");
      const c = await this.env.reservations.claimIn(tx, g.reservation_id);
      if (c.outcome === "unavailable") throw new CheckoutError("stock-shortfall", "items are no longer available", { shortfalls: c.shortfalls });
      await recordCodConfirmed(this.env, tx, g);
      return c;
    });
    await this.env.reservations.publish(claim);
    return { status: "CONFIRMED_COD" };
  }

  // ------------------------------------------------------------------ reads (RLS is the tenant boundary: foreign ids are not_found)
  async getOrderGroup(userId: string, orderGroupId: string): Promise<OrderGroupView> {
    return this.inUserTx(userId, async (tx) => {
      const g = (await tx.query<GroupRow>("SELECT id, user_id, status, currency, payment_method, total_minor, store_credit_minor, reservation_id, payment_expires_at, checkout_session_id FROM order_groups WHERE id = $1", [orderGroupId])).rows[0];
      if (g === undefined) throw new CheckoutError("not-found", "order group not found");
      const i = (await tx.query<{ status: string; client_action: ClientAction | null }>("SELECT status, client_action FROM payment_intents WHERE order_group_id = $1", [orderGroupId])).rows[0];
      const so = (await tx.query<{ id: string; store_id: string; status: string; total_minor: string | bigint }>("SELECT id, store_id, status, total_minor FROM seller_orders WHERE order_group_id = $1 ORDER BY store_id", [orderGroupId])).rows;
      const c: Currency = g.currency;
      return {
        id: g.id, status: g.status, paymentMethod: g.payment_method, total: money(BigInt(g.total_minor), c), storeCredit: money(BigInt(g.store_credit_minor), c),
        clientAction: i?.client_action ?? null, intentStatus: i?.status ?? null, sellerOrders: so.map((r) => ({ id: r.id, storeId: r.store_id, status: r.status, total: money(BigInt(r.total_minor), c) })),
      };
    });
  }

  /** Seller Center read: store context, so another store's seller order (or one in this store's group of another store) is not_found. */
  async getSellerOrder(storeId: string, sellerOrderId: string): Promise<{ id: string; status: string; storeId: string; total: Money }> {
    return withDbContext(this.d.client, { kind: "store", marketId: this.env.marketId, storeId }, async (tx) => {
      const r = (await tx.query<{ id: string; status: string; store_id: string; total_minor: string | bigint; currency: Currency }>("SELECT id, status, store_id, total_minor, currency FROM seller_orders WHERE id = $1", [sellerOrderId])).rows[0];
      if (r === undefined) throw new CheckoutError("not-found", "seller order not found");
      return { id: r.id, status: r.status, storeId: r.store_id, total: money(BigInt(r.total_minor), r.currency) };
    });
  }
}
