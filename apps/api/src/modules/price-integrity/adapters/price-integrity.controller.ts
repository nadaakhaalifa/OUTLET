import { Controller, Get, Headers, Inject, Injectable, Param, Req, Res } from "@nestjs/common";
import { decide, type Action, type Actor, type Rule } from "@outlet/policy";
import { UuidSchema, moneyToWire } from "@outlet/validation";
import { AuthenticatedSelf, RateLimit } from "../../../platform/decorators";
import type { ApiRequest, ApiResponse } from "../../../platform/http-types";
import { ProblemError, Problems } from "../../../platform/problem";
import type { AuditSink, Clock } from "../../../platform/ports";
import { AUDIT_SINK, CLOCK, POLICY_RULES } from "../../../platform/tokens";
import { ZodPipe } from "../../../platform/zod.pipe";
import type { PriceIntegrityService, ProductEvidenceView, SkuEvidenceView, StoreTrustView } from "../application/service";
import { WINDOW_DAYS } from "../domain/domain";
import { PRICE_INTEGRITY_SERVICE } from "./tokens";

const ProductIdPipe = new ZodPipe(UuidSchema, "/params");
const iso = (ms: number): string => new Date(ms).toISOString();

function actorOf(req: ApiRequest): Actor {
  const a = req.principal?.actor;
  if (a === undefined) throw Problems.unauthenticated();
  return a;
}

function skuWire(s: SkuEvidenceView) {
  const r = s.result;
  return {
    sku_id: s.skuId,
    badge: s.block.badge,
    ...(r.priceAmount !== null ? { price: moneyToWire({ amount: r.priceAmount, currency: "EGP" }) } : {}),
    reference_price: s.block.referencePrice === null ? null : moneyToWire(s.block.referencePrice),
    discount_pct: s.block.discountPct,
    claim_id: s.block.claimId,
    // Why a percentage is absent is shown to the shopper's client, never a seller-typed value.
    reason: r.reason,
    window_days: WINDOW_DAYS,
    lowest_30d: s.lowest30dAmount === null ? null : moneyToWire({ amount: s.lowest30dAmount, currency: "EGP" }),
    evidence_ids: r.evidence.map((e) => e.id),
    price_history: s.history.map((h) => ({ price: moneyToWire({ amount: h.priceAmount, currency: "EGP" }), valid_from: iso(h.validFromMs) })),
  };
}

function evidenceWire(v: ProductEvidenceView) {
  return { product_id: v.productId, computed_at: iso(v.computedAtMs), skus: v.skus.map(skuWire) };
}

function trustWire(v: StoreTrustView) {
  return {
    store_id: v.storeId,
    score: v.score,
    band: v.band,
    window_days: v.windowDays,
    violations: v.violations,
    open_cross_channel_findings: v.openCrossChannelFindings,
    claims_evaluated: v.claimsEvaluated,
    claims_verified: v.claimsVerified,
    claims_auto_corrected: v.claimsAutoCorrected,
    recent_actions: v.recent.map((r) => ({
      id: r.id,
      kind: r.kind,
      ...(r.skuId !== null ? { sku_id: r.skuId } : {}),
      actions: r.actions.map((a) => a.kind),
      opened_at: iso(r.openedAtMs),
      resolved_at: r.resolvedAtMs === null ? null : iso(r.resolvedAtMs),
    })),
  };
}

/**
 * Picks the store a collection route reads. The store comes only from the actor's own brand
 * grants; `X-Store-Id` may select among stores they staff, and naming any other is a 403.
 * Every candidate passes the same `decide()` rules the guard uses.
 */
@Injectable()
export class PriceTrustAccess {
  constructor(
    @Inject(POLICY_RULES) private readonly rules: readonly Rule[],
    @Inject(AUDIT_SINK) private readonly audit: AuditSink,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async resolve(actor: Actor, action: Action, header: string | undefined): Promise<string> {
    const staffed = [...new Set(actor.grants.flatMap((g) => (g.kind === "brand" ? [g.storeId] : [])))];
    if (header !== undefined && !staffed.includes(header)) throw Problems.forbidden();
    const candidates = header !== undefined ? [header] : staffed;
    const allowed: string[] = [];
    for (const storeId of candidates) {
      const decision = decide(
        {
          actor,
          action,
          resourceType: "store_product",
          resource: { type: "store_product", id: "price-trust", storeId, state: "active" },
          nowMs: this.clock.nowMs(),
        },
        this.rules,
      );
      try {
        await this.audit.record(decision.audit);
      } catch {
        if (decision.effect === "allow") throw Problems.unavailable("audit_unavailable");
      }
      if (decision.effect === "allow") allowed.push(storeId);
    }
    const only = allowed[0];
    if (allowed.length === 0 || only === undefined) throw Problems.forbidden();
    if (allowed.length > 1) {
      throw new ProblemError(422, "store-selection-required", "Select a store with X-Store-Id", { code: "store_selection_required" });
    }
    return only;
  }
}

@Controller("products")
export class ProductPriceEvidenceController {
  constructor(@Inject(PRICE_INTEGRITY_SERVICE) private readonly service: PriceIntegrityService) {}

  /** Public summary of why a product shows (or does not show) a discount. Computed live, never cached. */
  @Get(":productId/price-evidence")
  @AuthenticatedSelf("buyer_api")
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async read(
    @Param("productId", ProductIdPipe) productId: string,
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: ApiResponse,
  ) {
    actorOf(req);
    const view = await this.service.evidenceForProduct(productId);
    if (view === null) throw Problems.notFound();
    res.setHeader("Cache-Control", "private, no-cache");
    return evidenceWire(view);
  }
}

@Controller("seller")
export class SellerPriceTrustController {
  constructor(
    @Inject(PriceTrustAccess) private readonly access: PriceTrustAccess,
    @Inject(PRICE_INTEGRITY_SERVICE) private readonly service: PriceIntegrityService,
  ) {}

  @Get("price-trust")
  @AuthenticatedSelf("seller_api")
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async trust(@Req() req: ApiRequest, @Headers("x-store-id") storeHeader: string | undefined) {
    const storeId = await this.access.resolve(actorOf(req), "read", storeHeader);
    return trustWire(await this.service.trustForStore(storeId));
  }
}
