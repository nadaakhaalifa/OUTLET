import { Controller, Get, Inject, Injectable, Query, Req } from "@nestjs/common";
import { decide, type Action, type Actor, type ResourceType, type Rule } from "@outlet/policy";
import { z } from "zod";
import { Authorize, AuthenticatedSelf, RateLimit } from "../../../platform/decorators";
import type { ApiRequest } from "../../../platform/http-types";
import { Problems } from "../../../platform/problem";
import type { AuditSink, Clock } from "../../../platform/ports";
import { AUDIT_SINK, CLOCK, POLICY_RULES } from "../../../platform/tokens";
import { ZodPipe } from "../../../platform/zod.pipe";
import { decodeCursor, type ListCrawlIncidents, type ListParityWarnings } from "../application/incidents";
import type { IncidentRow } from "../domain/ports";
import { CRAWL_ADMIN_RESOLVER, CRAWL_LIST_INCIDENTS, CRAWL_LIST_PARITY } from "./tokens";

const KINDS = ["ssrf_refused", "dns_rebinding", "robots_disallowed", "blocked", "parser_error", "size_exceeded", "redirect_refused", "kill_switch"] as const;
const CursorField = z.string().min(8).max(200).regex(/^[A-Za-z0-9_-]+$/);
const AdminQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(50),
    cursor: CursorField.optional(),
    kind: z.enum(KINDS).optional(),
    store_id: z.uuid().optional(),
  })
  .strict();
const SellerQuery = z.object({ store_id: z.uuid(), limit: z.coerce.number().int().min(1).max(50).default(50), cursor: CursorField.optional(), kind: z.enum(KINDS).optional() }).strict();
const ParityQuery = z.object({ store_id: z.uuid(), limit: z.coerce.number().int().min(1).max(50).default(50), cursor: CursorField.optional() }).strict();

const ADMIN_ROLES = ["ops", "trust_safety", "security", "super_admin"] as const;
const iso = (ms: number): string => new Date(ms).toISOString();

const incidentWire = (i: IncidentRow) => ({
  id: i.id,
  target_id: i.targetId,
  store_id: i.storeId,
  kind: i.kind,
  host: i.host,
  detail: i.detail,
  created_at: iso(i.createdAtMs),
});
const principalOf = (req: ApiRequest) => {
  const p = req.principal;
  if (p === null || p === undefined) throw Problems.unauthenticated();
  return p;
};
const badCursor = () => Problems.validation([{ pointer: "/query/cursor", code: "invalid_cursor" }]);

/** Store addressed by query: the central policy decides (foreign store 404, missing role 403). */
@Injectable()
export class CrawlStoreAccess {
  constructor(
    @Inject(POLICY_RULES) private readonly rules: readonly Rule[],
    @Inject(AUDIT_SINK) private readonly audit: AuditSink,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}
  async require(actor: Actor, storeId: string, action: Action, resourceType: ResourceType): Promise<void> {
    const d = decide({ actor, action, resourceType, resource: { type: resourceType, id: storeId, storeId, state: "active" }, nowMs: this.clock.nowMs() }, this.rules);
    try {
      await this.audit.record(d.audit);
    } catch {
      if (d.effect === "allow") throw Problems.unavailable("audit_unavailable");
    }
    if (d.effect === "allow") return;
    if (d.httpStatus === 404) throw Problems.notFound();
    throw d.httpStatus === 401 ? Problems.unauthenticated() : Problems.forbidden();
  }
}

@Controller()
export class CrawlIncidentsController {
  constructor(
    @Inject(CRAWL_LIST_INCIDENTS) private readonly incidents: ListCrawlIncidents,
    @Inject(CRAWL_LIST_PARITY) private readonly parity: ListParityWarnings,
    private readonly access: CrawlStoreAccess,
  ) {}

  @Get("admin/price-crawler/incidents")
  @Authorize({ audience: "admin_api", action: "read", resourceType: "admin_console", resolver: CRAWL_ADMIN_RESOLVER, idParam: "none" })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async adminIncidents(@Req() req: ApiRequest, @Query(new ZodPipe(AdminQuery, "/query")) q: z.output<typeof AdminQuery>) {
    const ok = principalOf(req).actor.grants.some((g) => g.kind === "admin" && (ADMIN_ROLES as readonly string[]).includes(g.role));
    if (!ok) throw Problems.forbidden();
    const after = q.cursor === undefined ? null : decodeCursor(q.cursor);
    if (q.cursor !== undefined && after === null) throw badCursor();
    const page = await this.incidents.execute({ storeId: q.store_id?.toLowerCase() ?? null, kind: q.kind ?? null, limit: q.limit, after });
    return { items: page.items.map(incidentWire), next_cursor: page.nextCursor };
  }

  @Get("seller/crawl-incidents")
  @AuthenticatedSelf("seller_api")
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async sellerIncidents(@Req() req: ApiRequest, @Query(new ZodPipe(SellerQuery, "/query")) q: z.output<typeof SellerQuery>) {
    const storeId = q.store_id.toLowerCase();
    await this.access.require(principalOf(req).actor, storeId, "read", "store_settings");
    const after = q.cursor === undefined ? null : decodeCursor(q.cursor);
    if (q.cursor !== undefined && after === null) throw badCursor();
    const page = await this.incidents.execute({ storeId, kind: q.kind ?? null, limit: q.limit, after });
    return { items: page.items.map(incidentWire), next_cursor: page.nextCursor };
  }

  @Get("seller/parity-warnings")
  @AuthenticatedSelf("seller_api")
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async parityWarnings(@Req() req: ApiRequest, @Query(new ZodPipe(ParityQuery, "/query")) q: z.output<typeof ParityQuery>) {
    const storeId = q.store_id.toLowerCase();
    await this.access.require(principalOf(req).actor, storeId, "read", "store_settings");
    let afterSku: string | null = null;
    if (q.cursor !== undefined) {
      afterSku = Buffer.from(q.cursor, "base64url").toString("utf8");
      if (!/^[0-9a-f-]{36}$/i.test(afterSku)) throw badCursor();
    }
    const page = await this.parity.execute(storeId, q.limit, afterSku);
    return {
      items: page.items.map((w) => ({
        sku_id: w.skuId,
        opened_at: iso(w.openedAtMs),
        fix_deadline_at: iso(w.deadlineMs),
        remaining_seconds: Math.floor(w.remainingMs / 1000),
        overdue: w.overdue,
      })),
      next_cursor: page.nextCursor,
    };
  }
}
