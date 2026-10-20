import { Controller, Get, Inject, Query, Req, Res } from "@nestjs/common";
import type { Rule } from "@outlet/policy";
import { z } from "zod";
import { AuthenticatedSelf, RateLimit } from "../../../platform/decorators";
import { headerValue, type ApiRequest, type ApiResponse } from "../../../platform/http-types";
import type { AuditSink, Clock } from "../../../platform/ports";
import { Problems } from "../../../platform/problem";
import { instruments } from "../../../platform/telemetry";
import { AUDIT_SINK, CLOCK, POLICY_RULES } from "../../../platform/tokens";
import { ZodPipe } from "../../../platform/zod.pipe";
import { buildAdminMe } from "../application/me";
import { computeAccess } from "../domain/access";
import type { ElevationRecord } from "../domain/bridge";
import { assuranceFromAmr, type SessionBinding } from "../domain/me";
import type { AdminStore } from "../domain/ports";
import { verifyEdgePosture, type EdgePostureKeys, type EdgeReplayStore } from "./edge-posture";
import { ADMIN_IDENTITY, ADMIN_STORE } from "./tokens";

/** Strict empty query: any parameter is 400. */
const NoQuery = z.object({}).strict();
const READ_TIMEOUT_MS = 2000;

/** What the session proves about the browser; never device trust. Default (no 0092 data): passkey sessions are `passkey_uv_unbound`. */
export interface SessionBindingPort {
  bindingOf(i: { readonly sessionId: string; readonly passkey: boolean; readonly installToken: string | undefined }): Promise<SessionBinding>;
}

export interface AdminIdentityOptions {
  /** `release.admin_console.identity` (default blocked: the route answers 404). */
  readonly enabled: () => Promise<boolean> | boolean;
  readonly edgeKeys: EdgePostureKeys;
  readonly replay: EdgeReplayStore;
  readonly binding: SessionBindingPort;
  /** `ADMIN_POSTURE_DEV_TRUST`; refused by the module at production boot. */
  readonly devTrust: boolean;
  /** Counts `outlet.admin.me.requests{outcome}` (L2). */
  readonly count: (outcome: "allow" | "deny" | "unavailable") => void;
}

/**
 * Telemetry binding. `outlet.admin.me.requests` must be added to INSTRUMENTS in platform/telemetry/metrics.ts
 * (not owned by this change); until then the registry throws and the count is dropped rather than failing the request.
 */
export function telemetryMeCounter(outcome: "allow" | "deny" | "unavailable"): void {
  try {
    instruments().counter("outlet.admin.me.requests").add(1, { outcome });
  } catch {
    // unregistered instrument: observability gap, not a request failure
  }
}

function withTimeout<T>(p: Promise<T>): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new Error("timeout")), READ_TIMEOUT_MS);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (t !== undefined) clearTimeout(t);
  });
}

/** `GET /v1/admin/me` (ADR-0048, Proposed signal sources). Nothing in the response comes from client input. */
@Controller("admin")
export class AdminMeController {
  constructor(
    @Inject(ADMIN_STORE) private readonly store: AdminStore,
    @Inject(ADMIN_IDENTITY) private readonly identity: AdminIdentityOptions,
    @Inject(POLICY_RULES) private readonly rules: readonly Rule[],
    @Inject(AUDIT_SINK) private readonly audit: AuditSink,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private count(outcome: "allow" | "deny" | "unavailable"): void {
    this.identity.count(outcome);
  }

  @Get("me")
  @AuthenticatedSelf("admin_api")
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async me(
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: ApiResponse,
    @Query(new ZodPipe(NoQuery, "/query")) _q: z.infer<typeof NoQuery>,
  ) {
    if (!(await this.identity.enabled())) throw Problems.notFound();
    const principal = req.principal;
    if (principal === null || principal === undefined) throw Problems.unauthenticated();
    const actor = principal.actor;
    const nowMs = this.clock.nowMs();
    // Standing grant check is pure (actor.grants): a non-admin token never reaches the elevation store.
    let elevations: readonly ElevationRecord[] = [];
    if (computeAccess(actor, [], nowMs).standing.length > 0) {
      try {
        elevations = await withTimeout(this.store.liveElevations(actor.id, nowMs));
      } catch {
        this.count("unavailable");
        throw Problems.unavailable("elevations_unavailable");
      }
    }
    const access = computeAccess(actor, elevations, nowMs);
    if (access.standing.length === 0) {
      try {
        await this.audit.record({
          effect: "deny",
          actorId: actor.id,
          action: "read",
          resourceType: "admin_console",
          resourceId: null,
          ruleId: "admin.me",
          reason: "missing_role",
          httpStatus: 403,
          approverIds: [],
          atMs: nowMs,
        });
      } catch {
        // The deny stands whether or not the audit write succeeded.
      }
      this.count("deny");
      throw Problems.forbidden("not_admin");
    }
    // The assurance shown must agree with the one the gates use (actor.assurance); disagreement with amr is refused.
    if ((actor.assurance === "passkey") !== (assuranceFromAmr(principal.claims.amr) === "passkey")) {
      this.count("deny");
      throw Problems.forbidden("assurance_mismatch");
    }
    const ip = this.identity.devTrust
      ? { allowlisted: true, source: "dev_override" as const }
      : await verifyEdgePosture({
          header: headerValue(req, "x-outlet-edge-posture"),
          keys: this.identity.edgeKeys,
          requestId: req.ctx?.requestId ?? "",
          nowMs,
          replay: this.identity.replay,
        });
    const install = headerValue(req, "x-admin-install");
    const binding = await withTimeout(
      this.identity.binding.bindingOf({
        sessionId: principal.claims.sid,
        passkey: access.passkey,
        // A repeated header arrives comma-joined; a token never legitimately contains a comma.
        installToken: install !== undefined && install.includes(",") ? undefined : install,
      }),
    ).catch((): SessionBinding => (access.passkey ? "passkey_uv_unbound" : "not_passkey"));
    const doc = buildAdminMe({
      actor,
      access,
      elevations,
      amr: principal.claims.amr,
      sessionExpiresAtMs: principal.claims.exp * 1000,
      rules: this.rules,
      nowMs,
      ip,
      binding,
      devTrust: this.identity.devTrust,
    });
    res.setHeader("Cache-Control", "no-store");
    this.count("allow");
    return doc;
  }
}
