import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req, Res } from "@nestjs/common";
import { sha256Hex } from "@outlet/idempotency";
import { z } from "zod";
import { Authorize, AuthenticatedSelf, Idempotent, RateLimit } from "../../../platform/decorators";
import { headerValue, type ApiRequest, type ApiResponse } from "../../../platform/http-types";
import { ProblemError, Problems } from "../../../platform/problem";
import { ZodPipe } from "../../../platform/zod.pipe";
import { PAYOUT_STATES } from "../domain/bridge";
import type { CommandResult, PayoutCommands } from "../application/commands";
import type { GetPayout, ListPayouts, SellerStatements } from "../application/queries";
import type { PayoutScope } from "../domain/ports";
import { FinanceAccess, PayoutStoreAccess } from "./access";
import {
  ADMIN_PAYOUT_RESOLVER,
  GET_PAYOUT,
  LIST_PAYOUTS,
  PAYOUTS_NOW,
  PAYOUT_COMMANDS,
  SELLER_STATEMENTS,
  STORE_PARAM_RESOLVER,
  STORE_PAYOUT_RESOLVER,
} from "./tokens";
import { adminPayoutWire, sellerPayoutWire, statementViewWire } from "./wire";

const IdParam = z.object({ id: z.uuid() }).strict();
const ListQuery = z
  .object({
    status: z.enum(PAYOUT_STATES).optional(),
    cycle_key: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    store_id: z.uuid().optional(),
    cursor: z.string().max(512).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();
const StatementQuery = z
  .object({
    from: z.iso.datetime(),
    to: z.iso.datetime(),
  })
  .strict();
const CursorBody = z.object({ c: z.number().int().nonnegative().max(8.64e15), i: z.uuid() }).strict();
const MAX_STATEMENT_DAYS = 400;

const etagOf = (wire: unknown): string => `"${sha256Hex(JSON.stringify(wire)).slice(0, 32)}"`;
const matches = (header: string | undefined, etag: string): boolean =>
  header !== undefined && header.split(",").map((t) => t.trim()).some((t) => t === etag || t === `W/${etag}` || t === "*");

function principalOf(req: ApiRequest) {
  const p = req.principal;
  if (p === null || p === undefined) throw Problems.unauthenticated();
  return p;
}
function requireKey(req: ApiRequest): string {
  const k = headerValue(req, "idempotency-key");
  if (k === undefined) throw Problems.invalidIdempotencyKey();
  return k;
}
const conflict = (slug: string, title: string, code: string, extensions?: Record<string, string>) =>
  new ProblemError(409, slug, title, { code, ...(extensions !== undefined ? { extensions } : {}) });

function unwrap(r: CommandResult) {
  switch (r.kind) {
    case "ok":
    case "replayed":
      return r.payout;
    case "not_found":
      throw Problems.notFound();
    case "conflict":
      throw conflict("payout-conflict", "The payout changed; reload and retry", "payout_conflict");
    case "invalid_transition":
      throw conflict("invalid-transition", "That action is not possible for this payout's status", "invalid_transition", {
        status: r.status,
      });
    case "approval_required":
      throw new ProblemError(403, "dual-approval-required", "A different approver must approve this amount first", {
        code: "dual_approval_required",
        extensions: { approval: r.approval },
      });
    case "open_dispute":
      throw conflict("open-dispute", "A seller order in this payout has an open dispute", "open_dispute");
    case "hold_not_cleared":
      throw conflict("hold-not-cleared", "The reason this payout is on hold still applies", "hold_not_cleared", {
        reason: r.reason,
      });
  }
}

function decodeCursor(raw: string | undefined): { createdAtMs: number; id: string } | null {
  if (raw === undefined) return null;
  try {
    const p = CursorBody.parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    return { createdAtMs: p.c, id: p.i };
  } catch {
    throw Problems.validation([{ pointer: "/query/cursor", code: "invalid_cursor" }]);
  }
}
const encodeCursor = (c: { createdAtMs: number; id: string }): string =>
  Buffer.from(JSON.stringify({ c: c.createdAtMs, i: c.id })).toString("base64url");

// --------------------------------------------------------------------------- seller

@Controller("seller")
export class SellerPayoutsController {
  constructor(
    @Inject(PayoutStoreAccess) private readonly access: PayoutStoreAccess,
    @Inject(LIST_PAYOUTS) private readonly list: ListPayouts,
    @Inject(GET_PAYOUT) private readonly getPayout: GetPayout,
    @Inject(SELLER_STATEMENTS) private readonly statements: SellerStatements,
  ) {}

  private scopeOf(req: ApiRequest, storeIds: readonly string[]): PayoutScope {
    return { kind: "seller", userId: principalOf(req).actor.id, storeIds };
  }

  @Get("payouts")
  @AuthenticatedSelf("seller_api")
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async index(@Req() req: ApiRequest, @Query(new ZodPipe(ListQuery, "/query")) q: z.output<typeof ListQuery>) {
    const actor = principalOf(req).actor;
    const readable = await this.access.readableStores(actor);
    // A store filter outside the caller's stores is a 404-equivalent: an empty page would hint at tenancy.
    if (q.store_id !== undefined && !readable.includes(q.store_id)) throw Problems.notFound();
    const page = await this.list.execute({
      scope: this.scopeOf(req, readable),
      ...(q.store_id !== undefined ? { storeId: q.store_id } : {}),
      ...(q.status !== undefined ? { status: q.status } : {}),
      ...(q.cycle_key !== undefined ? { cycleKey: q.cycle_key } : {}),
      after: decodeCursor(q.cursor),
      limit: q.limit,
    });
    return {
      items: page.items.map(sellerPayoutWire),
      page: { next_cursor: page.next === null ? null : encodeCursor(page.next), has_more: page.next !== null },
    };
  }

  @Get("payouts/:id")
  @Authorize({ audience: "seller_api", action: "read", resourceType: "store_payout", resolver: STORE_PAYOUT_RESOLVER, idParam: "id" })
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async one(
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: ApiResponse,
    @Param(new ZodPipe(IdParam, "/params")) params: z.infer<typeof IdParam>,
  ) {
    const storeIds = [...new Set(principalOf(req).actor.grants.flatMap((g) => (g.kind === "brand" ? [g.storeId] : [])))];
    const p = await this.getPayout.execute({ scope: this.scopeOf(req, storeIds), payoutId: params.id });
    if (p === null) throw Problems.notFound();
    const wire = sellerPayoutWire(p);
    const etag = etagOf(wire);
    res.setHeader("ETag", etag);
    res.setHeader("Cache-Control", "private, no-cache");
    if (matches(headerValue(req, "if-none-match"), etag)) throw new ProblemError(304, "not-modified", "Not modified");
    return wire;
  }

  @Get("stores/:id/statements")
  @Authorize({ audience: "seller_api", action: "read", resourceType: "store_payout", resolver: STORE_PARAM_RESOLVER, idParam: "id" })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async statement(
    @Req() req: ApiRequest,
    @Param(new ZodPipe(IdParam, "/params")) params: z.infer<typeof IdParam>,
    @Query(new ZodPipe(StatementQuery, "/query")) q: z.output<typeof StatementQuery>,
  ) {
    const fromMs = Date.parse(q.from);
    const toMs = Date.parse(q.to);
    if (!(fromMs < toMs) || toMs - fromMs > MAX_STATEMENT_DAYS * 86_400_000) {
      throw Problems.validation([{ pointer: "/query/to", code: "invalid_period" }]);
    }
    const view = await this.statements.execute({
      scope: this.scopeOf(req, [params.id]),
      storeId: params.id,
      fromMs,
      toMs,
    });
    return statementViewWire(view);
  }
}

// --------------------------------------------------------------------------- admin finance

@Controller("admin/finance/payouts")
export class FinancePayoutsController {
  constructor(
    @Inject(FinanceAccess) private readonly access: FinanceAccess,
    @Inject(LIST_PAYOUTS) private readonly list: ListPayouts,
    @Inject(GET_PAYOUT) private readonly getPayout: GetPayout,
    @Inject(PAYOUT_COMMANDS) private readonly commands: PayoutCommands,
    @Inject(PAYOUTS_NOW) private readonly now: () => number,
  ) {}

  private scope(req: ApiRequest): PayoutScope {
    const actor = principalOf(req).actor;
    const finance = FinanceAccess.isFinance(actor, this.now());
    return { kind: "staff", userId: actor.id, role: finance ? "finance" : "ops" };
  }

  private requireFinance(req: ApiRequest): { id: string } {
    const actor = principalOf(req).actor;
    if (!FinanceAccess.isFinance(actor, this.now())) throw Problems.forbidden("finance_role_required");
    return { id: actor.id };
  }

  @Get()
  @AuthenticatedSelf("admin_api")
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async index(@Req() req: ApiRequest, @Query(new ZodPipe(ListQuery, "/query")) q: z.output<typeof ListQuery>) {
    await this.access.require(principalOf(req).actor);
    const page = await this.list.execute({
      scope: this.scope(req),
      ...(q.store_id !== undefined ? { storeId: q.store_id } : {}),
      ...(q.status !== undefined ? { status: q.status } : {}),
      ...(q.cycle_key !== undefined ? { cycleKey: q.cycle_key } : {}),
      after: decodeCursor(q.cursor),
      limit: q.limit,
    });
    return {
      items: page.items.map(adminPayoutWire),
      page: { next_cursor: page.next === null ? null : encodeCursor(page.next), has_more: page.next !== null },
    };
  }

  @Get(":id")
  @Authorize({ audience: "admin_api", action: "read", resourceType: "payout", resolver: ADMIN_PAYOUT_RESOLVER, idParam: "id" })
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async one(@Req() req: ApiRequest, @Param(new ZodPipe(IdParam, "/params")) params: z.infer<typeof IdParam>) {
    const p = await this.getPayout.execute({ scope: this.scope(req), payoutId: params.id });
    if (p === null) throw Problems.notFound();
    return adminPayoutWire(p);
  }

  @Post(":id/approve")
  @HttpCode(200)
  @Authorize({ audience: "admin_api", action: "read", resourceType: "payout", resolver: ADMIN_PAYOUT_RESOLVER, idParam: "id" })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 30, windowSeconds: 60 }])
  async approve(@Req() req: ApiRequest, @Param(new ZodPipe(IdParam, "/params")) params: z.infer<typeof IdParam>) {
    const actor = this.requireFinance(req);
    return adminPayoutWire(unwrap(await this.commands.approve({ payoutId: params.id, actor, key: requireKey(req) })));
  }

  @Post(":id/hold")
  @HttpCode(200)
  @Authorize({ audience: "admin_api", action: "read", resourceType: "payout", resolver: ADMIN_PAYOUT_RESOLVER, idParam: "id" })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 30, windowSeconds: 60 }])
  async hold(@Req() req: ApiRequest, @Param(new ZodPipe(IdParam, "/params")) params: z.infer<typeof IdParam>) {
    const actor = this.requireFinance(req);
    return adminPayoutWire(unwrap(await this.commands.hold({ payoutId: params.id, actor, key: requireKey(req) })));
  }

  @Post(":id/cancel")
  @HttpCode(200)
  @Authorize({ audience: "admin_api", action: "read", resourceType: "payout", resolver: ADMIN_PAYOUT_RESOLVER, idParam: "id" })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 30, windowSeconds: 60 }])
  async cancel(
    @Req() req: ApiRequest,
    @Param(new ZodPipe(IdParam, "/params")) params: z.infer<typeof IdParam>,
    @Body(new ZodPipe(z.object({}).strict())) _body: Record<string, never>,
  ) {
    const actor = this.requireFinance(req);
    return adminPayoutWire(unwrap(await this.commands.cancel({ payoutId: params.id, actor, key: requireKey(req) })));
  }
}
