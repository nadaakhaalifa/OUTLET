import { Controller, Get, Header, Inject, Query, Req } from "@nestjs/common";
import { adminGateDenial, computeAccess, type AdminAccess, type AdminAuditPort } from "../../admin";
import { z } from "zod";
import { AuthenticatedSelf, RateLimit } from "../../../platform/decorators";
import type { ApiRequest } from "../../../platform/http-types";
import type { AuditSink, Clock } from "../../../platform/ports";
import { ProblemError, Problems } from "../../../platform/problem";
import { AUDIT_SINK, CLOCK } from "../../../platform/tokens";
import { ZodPipe } from "../../../platform/zod.pipe";
import { MAX_VERIFY_PROBLEMS, MAX_VERIFY_ROWS } from "../domain/audit-verify";
import { ATTENTION_COUNT_CAP, visibleAttentionItems, type AttentionItemDef } from "../domain/attention";
import type { AdminRoleName, AttentionReading, AttentionSourcePort, AuditChainReader, ElevationLookup } from "../domain/ports";
import {
  ATTENTION_ROUTES_ENABLED,
  ATTENTION_SOURCES,
  AUDIT_CHAIN_READER,
  AUDIT_LOG_ROUTES_ENABLED,
  ELEVATION_LOOKUP,
  META_AUDIT,
} from "./tokens";

/** Mirrors policy rule `audit_log.read` (packages/policy/src/rules.ts): dpo, security, super_admin; first held wins. */
export const AUDIT_READ_ROLES = ["dpo", "security", "super_admin"] as const satisfies readonly AdminRoleName[];
export const SOURCE_TIMEOUT_MS = 2000;
export const SOURCE_CACHE_MS = 30_000;

const VerifyQuery = z.object({ chain_id: z.string().min(1).max(128).regex(/^[A-Za-z0-9:_.-]+$/) }).strict();
/** "Any effective admin role" (spec 7.2): standing super_admin without break-glass has none. */
const ANY_EFFECTIVE_ROLE = ["ops", "finance", "marketing", "support", "trust_safety", "dpo", "security", "super_admin"] as const satisfies readonly AdminRoleName[];
const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

@Controller("admin")
export class AdminAttentionController {
  private readonly cache = new Map<string, { atMs: number; reading: AttentionReading }>();

  constructor(
    @Inject(AUDIT_CHAIN_READER) private readonly chains: AuditChainReader,
    @Inject(ATTENTION_SOURCES) private readonly sources: AttentionSourcePort,
    @Inject(ELEVATION_LOOKUP) private readonly elevations: ElevationLookup,
    @Inject(META_AUDIT) private readonly metaAudit: AdminAuditPort,
    @Inject(AUDIT_SINK) private readonly audit: AuditSink,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AUDIT_LOG_ROUTES_ENABLED) private readonly auditEnabled: () => Promise<boolean> | boolean,
    @Inject(ATTENTION_ROUTES_ENABLED) private readonly attentionEnabled: () => Promise<boolean> | boolean,
  ) {}

  /** Same order as AdminController.gate: actor, standing grant, passkey, effective role. Every decision is audited. */
  private async gate(
    req: ApiRequest,
    routeId: string,
    allowed: readonly AdminRoleName[] | "any_standing",
  ): Promise<{ access: AdminAccess; actorId: string }> {
    const actor = req.principal?.actor;
    if (actor === undefined) throw Problems.unauthenticated();
    const now = this.clock.nowMs();
    const access = computeAccess(actor, await this.elevations.liveElevations(actor.id, now), now);
    const reason = adminGateDenial(access, allowed);
    try {
      await this.audit.record({
        effect: reason === null ? "allow" : "deny",
        actorId: actor.id,
        action: "read",
        resourceType: "admin_console",
        resourceId: null,
        ruleId: `admin_attention.${routeId}`,
        reason: reason ?? "allowed",
        httpStatus: reason === null ? 200 : 403,
        approverIds: [],
        atMs: now,
      });
    } catch {
      if (reason === null) throw Problems.unavailable("audit_unavailable");
    }
    if (reason !== null) throw Problems.forbidden(reason);
    return { access, actorId: actor.id };
  }

  @Get("audit-log/verify")
  @AuthenticatedSelf("admin_api")
  @RateLimit([{ dimension: "user", limit: 6, windowSeconds: 60 }])
  @Header("Cache-Control", "private, no-store")
  async verify(@Req() req: ApiRequest, @Query(new ZodPipe(VerifyQuery, "/query")) q: z.infer<typeof VerifyQuery>) {
    if (!(await this.auditEnabled())) throw Problems.notFound();
    const { access, actorId } = await this.gate(req, "audit_verify", AUDIT_READ_ROLES);
    const role = AUDIT_READ_ROLES.find((r) => access.effective.includes(r));
    if (role === undefined) throw Problems.forbidden("missing_role");
    const nowMs = this.clock.nowMs();
    // Meta-audit BEFORE the body; its failure fails the request (closed).
    try {
      await this.metaAudit.append({
        action: "audit_log.verify",
        actorId,
        targetType: "audit_chain",
        targetId: null,
        reasonCode: null,
        diff: { chain_id: q.chain_id },
        requestId: req.ctx?.requestId ?? null,
        atMs: nowMs,
      });
    } catch {
      throw Problems.unavailable("audit_unavailable");
    }
    let length: number;
    try {
      length = await this.chains.chainLength(q.chain_id, role);
    } catch {
      throw Problems.unavailable("verify_unavailable");
    }
    if (length > MAX_VERIFY_ROWS) {
      throw new ProblemError(422, "chain-too-long", "Chain too long for inline verification", { code: "chain_too_long_use_job" });
    }
    let v;
    try {
      v = await this.chains.verify(q.chain_id, role);
    } catch {
      throw Problems.unavailable("verify_unavailable");
    }
    return {
      chain_id: q.chain_id,
      verified_at: new Date(nowMs).toISOString(),
      rows_checked: v.rowsChecked,
      head_seq: v.headSeq,
      head_hash: v.headHash,
      checkpoints_checked: v.checkpointsChecked,
      ok: v.problems.length === 0,
      problems: v.problems.slice(0, MAX_VERIFY_PROBLEMS).map((p) => ({ seq: String(p.seq), problem: p.problem.slice(0, 128) })),
      problems_truncated: v.problems.length > MAX_VERIFY_PROBLEMS,
    };
  }

  @Get("attention")
  @AuthenticatedSelf("admin_api")
  @RateLimit([{ dimension: "user", limit: 30, windowSeconds: 60 }])
  @Header("Cache-Control", "private, no-store")
  async attention(@Req() req: ApiRequest) {
    if (!(await this.attentionEnabled())) throw Problems.notFound();
    const { access, actorId } = await this.gate(req, "attention", ANY_EFFECTIVE_ROLE);
    const nowMs = this.clock.nowMs();
    const items = await Promise.all(visibleAttentionItems(access).map((i) => this.item(i, actorId, nowMs)));
    return { as_of: new Date(nowMs).toISOString(), items };
  }

  private async item(def: AttentionItemDef, actorId: string, nowMs: number) {
    const base = { id: def.id, group: def.group, severity: def.severity, href: def.href };
    const cached = def.perUser ? undefined : this.cache.get(def.id);
    let reading: AttentionReading | null;
    if (cached !== undefined && nowMs - cached.atMs < SOURCE_CACHE_MS) reading = cached.reading;
    else {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        reading = await Promise.race([
          this.sources.read(def.id, actorId, nowMs),
          new Promise<never>((_, rej) => {
            timer = setTimeout(() => rej(new Error("timeout")), SOURCE_TIMEOUT_MS);
          }),
        ]);
        if (!def.perUser) this.cache.set(def.id, { atMs: nowMs, reading });
      } catch {
        reading = null;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
    if (reading === null) {
      return { ...base, count: null, count_capped: false, oldest_at: null, deadline_at: null, state: "unavailable" as const };
    }
    const count = Math.max(0, Math.min(ATTENTION_COUNT_CAP, Math.trunc(reading.count)));
    return {
      ...base,
      count,
      count_capped: reading.count > ATTENTION_COUNT_CAP,
      oldest_at: iso(reading.oldestAtMs),
      deadline_at: iso(reading.deadlineAtMs),
      state: "ok" as const,
    };
  }
}
