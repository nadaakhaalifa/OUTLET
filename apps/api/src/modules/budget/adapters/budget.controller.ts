import { Body, Controller, Delete, Get, HttpCode, Inject, Post, Put, Query, Req, Res } from "@nestjs/common";
import { MoneySchema, moneyToWire, type MoneyWire } from "@outlet/validation";
import { z } from "zod";
import { AuthenticatedSelf, Idempotent, RateLimit } from "../../../platform/decorators";
import type { ApiRequest, ApiResponse } from "../../../platform/http-types";
import { ProblemError, Problems } from "../../../platform/problem";
import { ZodPipe } from "../../../platform/zod.pipe";
import type { AffordabilityFilter, PlanMyPurchases } from "../application/affordability";
import type { DeleteBudget, GetSummary, SetBudget, SummaryView } from "../application/budget";
import { CipherUnavailableError } from "../application/codec";
import type { RequestCapUnlock } from "../application/caps";
import { AFFORDABILITY_CONTEXTS, CAP_MODES, PLAN_PRIORITIES, type Plan } from "../domain/bridge";
import {
  AFFORDABILITY_FILTER,
  DELETE_BUDGET,
  GET_SUMMARY,
  PLAN_MY_PURCHASES,
  REQUEST_CAP_UNLOCK,
  SET_BUDGET,
} from "./tokens";

const egp = (amount: bigint): MoneyWire => moneyToWire({ amount, currency: "EGP" });
const iso = (ms: number): string => new Date(ms).toISOString();

const PutBody = z
  .object({
    amount: MoneySchema,
    per_category: z.record(z.string().min(1).max(64), MoneySchema).optional(),
    payday: z.number().int().min(1).max(31),
    cap_mode: z.enum(CAP_MODES),
    installments: z
      .array(
        z
          .object({
            provider: z.string().min(1).max(40),
            monthly: MoneySchema,
            starts_at: z.iso.datetime({ offset: true }),
            ends_at: z.iso.datetime({ offset: true }),
          })
          .strict(),
      )
      .max(20)
      .optional(),
  })
  .strict();
const SummaryQuery = z.object({ include_bag: z.enum(["true", "false"]).default("false") }).strict();
const AffordabilityQuery = z
  .object({ context: z.enum(AFFORDABILITY_CONTEXTS), include_bag: z.enum(["true", "false"]).default("false") })
  .strict();
const PlanBody = z.object({ wishlist_id: z.uuid().optional(), horizon_cycles: z.number().int().min(1).max(6).default(3) }).strict();

const principalOf = (req: ApiRequest) => {
  const p = req.principal;
  if (p === null || p === undefined) throw Problems.unauthenticated();
  return p;
};

const consentRequired = (): ProblemError =>
  new ProblemError(403, "consent-required", "The budget_insights consent is required", { code: "consent_required" });

/** The KMS being down is a 503 for the shopper, never a 500 and never plaintext fallback. */
async function sealed<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof CipherUnavailableError) throw Problems.unavailable("encryption_unavailable");
    throw e;
  }
}

const noStore = (res: ApiResponse): void => {
  res.setHeader("Cache-Control", "no-store");
};

function summaryWire(v: SummaryView) {
  return {
    state: "active" as const,
    cycle: { start_date: v.cycle.startDate, end_date: v.cycle.endDate },
    payday: v.settings.payday,
    budget: egp(v.settings.amount),
    spent: egp(v.remaining.spent),
    remaining: egp(v.remaining.remainingDisplay),
    over_by: egp(v.remaining.overBy),
    bag: v.includeBag ? egp(v.remaining.bag) : null,
    installments: {
      label: "estimate" as const,
      total: egp(v.remaining.installments),
      items: v.installments.map((i) => ({ provider: i.provider, monthly: egp(i.monthly), source: i.source, label: i.label })),
    },
    per_category: v.byCategory.map((c) => ({ category_id: c.id, spent: egp(c.amount), limit: c.limit === null ? null : egp(c.limit) })),
    top_stores: v.topStores.map((s) => ({ store_id: s.id, spent: egp(s.amount) })),
    month_over_month: { current_net: egp(v.netSpent), previous_net: egp(v.previousNetSpent) },
    verified_savings: egp(v.verifiedSavings),
    plus_savings: egp(v.plusSavings),
    cap: { mode: v.settings.capMode, unlock_at: v.hardCapUnlockAtMs === null ? null : iso(v.hardCapUnlockAtMs) },
    notice: "not_financial_advice" as const,
  };
}

function planWire(plan: Plan, cycles: readonly { index: number; startMs: number; endMs: number; capacity: bigint }[]) {
  return {
    cycles: cycles.map((c, i) => ({
      index: c.index,
      starts_at: iso(c.startMs),
      ends_at: iso(c.endMs),
      capacity: egp(c.capacity),
      planned: egp(plan.usedByCycle[i] ?? 0n),
    })),
    planned: plan.planned.map((p) => ({
      item_id: p.id,
      priority: p.priority,
      price: egp(p.price),
      cycle_index: p.cycleIndex,
      affordable_now: p.cycleIndex === 0,
      misses_date: p.missesDate,
      watch_price_drop: p.watchPriceDrop,
    })),
    unplanned: plan.unplanned.map((u) => ({ item_id: u.id, reason: u.reason })),
    priorities: PLAN_PRIORITIES,
    notice: "not_financial_advice" as const,
  };
}

/**
 * All routes are owner-only by construction: the subject is always the authenticated user and no
 * route takes a user or budget id (BOLA is structurally impossible). Responses are `no-store`.
 */
@Controller()
export class BudgetController {
  constructor(
    @Inject(SET_BUDGET) private readonly setBudget: SetBudget,
    @Inject(GET_SUMMARY) private readonly summary: GetSummary,
    @Inject(DELETE_BUDGET) private readonly remove: DeleteBudget,
    @Inject(AFFORDABILITY_FILTER) private readonly filter: AffordabilityFilter,
    @Inject(PLAN_MY_PURCHASES) private readonly plan: PlanMyPurchases,
    @Inject(REQUEST_CAP_UNLOCK) private readonly unlock: RequestCapUnlock,
  ) {}

  @Put("me/budget")
  @AuthenticatedSelf()
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 20, windowSeconds: 3600 }])
  async put(@Req() req: ApiRequest, @Res({ passthrough: true }) res: ApiResponse, @Body(new ZodPipe(PutBody)) b: z.infer<typeof PutBody>) {
    noStore(res);
    const r = await sealed(() => this.setBudget.execute({
      userId: principalOf(req).actor.id,
      amount: b.amount.amount,
      perCategory: Object.fromEntries(Object.entries(b.per_category ?? {}).map(([k, v]) => [k, v.amount])),
      payday: b.payday,
      capMode: b.cap_mode,
      installments: (b.installments ?? []).map((i) => ({
        provider: i.provider,
        monthly: i.monthly.amount,
        startsAtMs: Date.parse(i.starts_at),
        endsAtMs: Date.parse(i.ends_at),
      })),
    }));
    switch (r.kind) {
      case "ok":
        return { status: "saved", created: r.created };
      case "consent_required":
        throw consentRequired();
      case "disabled":
        throw Problems.notFound();
      case "invalid":
        throw Problems.validation(r.errors.map((e) => ({ pointer: `/body/${e.field}`, code: e.code })));
    }
  }

  @Get("me/budget/summary")
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async getSummary(
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: ApiResponse,
    @Query(new ZodPipe(SummaryQuery, "/query")) q: z.infer<typeof SummaryQuery>,
  ) {
    noStore(res);
    const r = await sealed(() => this.summary.execute(principalOf(req).actor.id, q.include_bag === "true"));
    switch (r.kind) {
      case "ok":
        return summaryWire(r.view);
      case "empty":
        return { state: "empty" as const };
      case "consent_required":
        throw consentRequired();
      case "disabled":
        throw Problems.notFound();
    }
  }

  @Get("me/affordability")
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async affordability(
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: ApiResponse,
    @Query(new ZodPipe(AffordabilityQuery, "/query")) q: z.infer<typeof AffordabilityQuery>,
  ) {
    noStore(res);
    const r = await this.filter.detail(principalOf(req).actor.id, q.include_bag === "true");
    if (r.kind === "none") return { context: q.context, applies: false as const, price_ceiling: null };
    return {
      context: q.context,
      applies: true as const,
      price_ceiling: r.ceiling === null ? null : egp(r.ceiling),
      remaining: egp(r.remaining),
      over_by: egp(r.overBy),
      label: "estimate" as const,
    };
  }

  @Post("me/budget/plan")
  @HttpCode(200)
  @AuthenticatedSelf()
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 10, windowSeconds: 3600 }])
  async planPurchases(@Req() req: ApiRequest, @Res({ passthrough: true }) res: ApiResponse, @Body(new ZodPipe(PlanBody)) b: z.infer<typeof PlanBody>) {
    noStore(res);
    const r = await sealed(() => this.plan.execute(principalOf(req).actor.id, b.wishlist_id ?? null, b.horizon_cycles));
    switch (r.kind) {
      case "ok":
        return planWire(r.plan, r.cycles);
      case "empty":
        return { state: "empty" as const };
      case "not_found":
        throw Problems.notFound();
      case "consent_required":
        throw consentRequired();
      case "disabled":
        throw Problems.notFound();
    }
  }

  @Post("me/budget/cap-unlock")
  @HttpCode(200)
  @AuthenticatedSelf()
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 5, windowSeconds: 86_400 }])
  async capUnlock(@Req() req: ApiRequest, @Res({ passthrough: true }) res: ApiResponse) {
    noStore(res);
    const r = await sealed(() => this.unlock.execute(principalOf(req).actor.id));
    switch (r.kind) {
      case "requested":
      case "already_requested":
        return { status: r.kind, unlock_at: iso(r.unlockAtMs) };
      case "not_applicable":
        throw new ProblemError(409, "cap-not-hard", "No hard spending cap is active", { code: "cap_not_hard" });
      case "consent_required":
        throw consentRequired();
      case "disabled":
        throw Problems.notFound();
    }
  }

  @Delete("me/budget")
  @HttpCode(200)
  @AuthenticatedSelf()
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 5, windowSeconds: 86_400 }])
  async del(@Req() req: ApiRequest, @Res({ passthrough: true }) res: ApiResponse) {
    noStore(res);
    return sealed(() => this.remove.execute(principalOf(req).actor.id));
  }
}
