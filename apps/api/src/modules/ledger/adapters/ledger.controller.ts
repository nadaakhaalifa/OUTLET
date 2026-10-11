import { Controller, Get, Inject, Param, Query, Req } from "@nestjs/common";
import { z } from "zod";
import { AuthenticatedSelf, RateLimit } from "../../../platform/decorators";
import type { ApiRequest } from "../../../platform/http-types";
import type { AuditSink, Clock } from "../../../platform/ports";
import { Problems } from "../../../platform/problem";
import { AUDIT_SINK, CLOCK } from "../../../platform/tokens";
import { ZodPipe } from "../../../platform/zod.pipe";
import type { GetEntry, ListBalances } from "../application/queries";
import { GET_ENTRY, LIST_BALANCES } from "./tokens";
import { balanceWire, entryWire } from "./wire";

const IdParam = z.object({ id: z.uuid() }).strict();
const BalancesQuery = z
  .object({
    owner_type: z.enum(["store", "user", "platform", "psp", "courier", "bnpl", "bank"]).optional(),
    owner_id: z.string().min(1).max(128).optional(),
    type: z.string().regex(/^[a-z_]{1,48}$/).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

/**
 * Finance read API (spec ledger-posting). Gate on every route, in order: admin audience (guard) ->
 * active actor (guard) -> unexpired standing `finance` grant -> passkey assurance. Standing
 * super_admin opens nothing here, consistent with the admin module (break-glass only). Every
 * decision goes to the AuditSink. There is no write route: posting is internal.
 */
@Controller("admin/ledger")
export class LedgerController {
  constructor(
    @Inject(LIST_BALANCES) private readonly balances: ListBalances,
    @Inject(GET_ENTRY) private readonly entries: GetEntry,
    @Inject(AUDIT_SINK) private readonly audit: AuditSink,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private async gate(req: ApiRequest, routeId: string, resourceId: string | null): Promise<string> {
    const actor = req.principal?.actor;
    if (actor === undefined) throw Problems.unauthenticated();
    const now = this.clock.nowMs();
    const hasRole = actor.grants.some(
      (g) => g.kind === "admin" && g.role === "finance" && (g.expiresAtMs === undefined || g.expiresAtMs > now),
    );
    let reason: "missing_role" | "passkey_required" | null = null;
    if (!hasRole) reason = "missing_role";
    else if (actor.assurance !== "passkey") reason = "passkey_required";
    try {
      await this.audit.record({
        effect: reason === null ? "allow" : "deny",
        actorId: actor.id,
        action: "read",
        resourceType: "admin_console",
        resourceId,
        ruleId: `ledger.${routeId}`,
        reason: reason ?? "allowed",
        httpStatus: reason === null ? 200 : 403,
        approverIds: [],
        atMs: now,
      });
    } catch {
      if (reason === null) throw Problems.unavailable("audit_unavailable");
    }
    if (reason !== null) throw Problems.forbidden(reason);
    return actor.id;
  }

  @Get("balances")
  @AuthenticatedSelf("admin_api")
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async listBalances(@Req() req: ApiRequest, @Query(new ZodPipe(BalancesQuery, "/query")) q: z.infer<typeof BalancesQuery>) {
    const actorId = await this.gate(req, "balances", null);
    const rows = await this.balances.execute(
      { actorId, role: "finance" },
      {
        limit: q.limit,
        ...(q.type !== undefined ? { type: q.type } : {}),
        ...(q.owner_type !== undefined ? { ownerType: q.owner_type } : {}),
        ...(q.owner_id !== undefined ? { ownerId: q.owner_id } : {}),
      },
    );
    return { items: rows.map(balanceWire) };
  }

  @Get("entries/:id")
  @AuthenticatedSelf("admin_api")
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async entry(@Req() req: ApiRequest, @Param(new ZodPipe(IdParam, "/params")) params: z.infer<typeof IdParam>) {
    const actorId = await this.gate(req, "entry", params.id);
    const found = await this.entries.execute({ actorId, role: "finance" }, params.id);
    if (found === null) throw Problems.notFound();
    return entryWire(found);
  }
}
