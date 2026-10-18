import type { Actor, Rule } from "@outlet/policy";
import { isFinanceActor } from "../../payouts";
import { canReadPrivacyConsole } from "../../privacy";
import { canReadReconciliation } from "../../reconciliation";
import { canReadTax } from "../../tax-eta";
import { BRAND_REVIEW_ROLES } from "../brand-review/domain";
import { brandReviewGateDenial, canPassAdminGate, ROUTE_ROLES, type AdminAccess } from "../domain/access";
import { ADMIN_ROLE_NAMES, isElevationLive, type AdminRoleName, type ElevationRecord } from "../domain/bridge";
import {
  ADMIN_ME_VERSION,
  assuranceFromAmr,
  composePosture,
  type Assurance,
  type Capabilities,
  type IpAllowlistSource,
  type Posture,
  type SessionBinding,
} from "../domain/me";

/**
 * Stages 1 and 2 of the policy engine for an admin rule (live admin grant in the rule's roles, token scope, passkey),
 * without the dual-approval stage: a capability being true never implies an approval has been obtained.
 */
export function adminRuleGate(rules: readonly Rule[], ruleId: string, actor: Actor, nowMs: number): boolean {
  const rule = rules.find((r) => r.id === ruleId);
  if (rule === undefined || rule.grant.kind !== "admin") return false;
  const roles = rule.grant.roles as readonly string[];
  const held = actor.grants.some(
    (g) => g.kind === "admin" && roles.includes(g.role) && (g.expiresAtMs === undefined || g.expiresAtMs > nowMs),
  );
  if (!held) return false;
  if (rule.requiresTokenScope !== undefined && !actor.tokenScopes.includes(rule.requiresTokenScope)) return false;
  if (rule.requiresPasskey === true && actor.assurance !== "passkey") return false;
  return true;
}

/** The actor as the effective-role gates see it: standing grants replaced by the effective admin roles. */
function effectiveActor(actor: Actor, access: AdminAccess): Actor {
  return {
    ...actor,
    grants: [
      ...actor.grants.filter((g) => g.kind !== "admin"),
      ...access.effective.map((role) => ({ kind: "admin" as const, role })),
    ],
  };
}

/** Ledger finance gate: an unexpired standing finance grant plus passkey (`LedgerController.gate`). Standing grants only. */
const canReadLedger = (actor: Actor, nowMs: number): boolean =>
  actor.grants.some((g) => g.kind === "admin" && g.role === "finance" && (g.expiresAtMs === undefined || g.expiresAtMs > nowMs)) &&
  actor.assurance === "passkey";

/** Every value comes from the predicate the matching route gate calls (ADR-0048 decision 2). Closed key set, version 1. */
export function computeCapabilities(i: {
  readonly actor: Actor;
  readonly access: AdminAccess;
  readonly rules: readonly Rule[];
  readonly nowMs: number;
}): Capabilities {
  const { actor, access, rules, nowMs } = i;
  const eff = effectiveActor(actor, access);
  const consoleAccess = adminRuleGate(rules, "admin.admin_console.access", eff, nowMs);
  const payoutRead = adminRuleGate(rules, "admin.payout.read", actor, nowMs);
  return {
    "console.access": consoleAccess,
    "flags.read": canPassAdminGate(access, ROUTE_ROLES.flagsRead),
    "flags.write": canPassAdminGate(access, ROUTE_ROLES.flagsWrite),
    "pii.view": canPassAdminGate(access, ROUTE_ROLES.piiView),
    "kyc.read": canPassAdminGate(access, ROUTE_ROLES.kycRead),
    "kyc.write": canPassAdminGate(access, ROUTE_ROLES.kycWrite),
    "kyc_review.read": canPassAdminGate(access, ROUTE_ROLES.kycReviewRead),
    "elevations.admin": canPassAdminGate(access, ROUTE_ROLES.elevationsAdmin),
    "ledger.read": canReadLedger(actor, nowMs),
    "ledger.integrity.read": canReadLedger(actor, nowMs),
    "audit_log.read": adminRuleGate(rules, "admin.audit_log.read", eff, nowMs),
    "payout.read": payoutRead,
    "payout.approve": payoutRead && isFinanceActor(actor, nowMs),
    "refund.approve": adminRuleGate(rules, "admin.refund.approve", actor, nowMs),
    "plan_price.update": adminRuleGate(rules, "admin.plan_price.update", actor, nowMs),
    "data_export.create": adminRuleGate(rules, "admin.data_export.create", actor, nowMs),
    "privacy.read": canReadPrivacyConsole(actor, nowMs),
    "recon.read": canReadReconciliation(actor, rules, nowMs),
    "tax.read": canReadTax(actor, nowMs),
    "brand_review.read": brandReviewGateDenial(access, BRAND_REVIEW_ROLES) === null,
    "attention.read": consoleAccess,
    "metrics.read.counts": canPassAdminGate(access, ROUTE_ROLES.metricsCounts),
    "metrics.read.money": canPassAdminGate(access, ROUTE_ROLES.metricsMoney),
  };
}

export interface AdminMeView {
  readonly version: typeof ADMIN_ME_VERSION;
  readonly user_id: string;
  readonly roles: readonly AdminRoleName[];
  readonly standing_roles: readonly AdminRoleName[];
  readonly assurance: Assurance;
  readonly amr: readonly string[];
  readonly posture: Posture;
  readonly elevation: {
    readonly break_glass_live: boolean;
    readonly live: readonly { readonly id: string; readonly role: AdminRoleName; readonly expires_at: string }[];
    readonly next_expiry_at: string | null;
  };
  readonly capabilities: Capabilities;
  readonly server_time: string;
  readonly session_expires_at: string;
}

const iso = (ms: number): string => new Date(ms).toISOString();

export function buildAdminMe(i: {
  readonly actor: Actor;
  readonly access: AdminAccess;
  readonly elevations: readonly ElevationRecord[];
  readonly amr: readonly string[];
  readonly sessionExpiresAtMs: number;
  readonly rules: readonly Rule[];
  readonly nowMs: number;
  readonly ip: { readonly allowlisted: boolean; readonly source: IpAllowlistSource };
  readonly binding: SessionBinding;
  readonly devTrust: boolean;
}): AdminMeView {
  const live = i.elevations
    .filter(
      (e) =>
        e.userId === i.actor.id &&
        isElevationLive(e, i.nowMs) &&
        // Break-glass counts only for a standing super_admin (computeAccess rule).
        (e.role !== "super_admin" || i.access.breakGlassLive),
    )
    .flatMap((e) => (e.expiresAtMs === null ? [] : [{ id: e.id, role: e.role, expiresAtMs: e.expiresAtMs }]))
    .sort((a, b) => a.expiresAtMs - b.expiresAtMs || (a.id < b.id ? -1 : 1))
    .slice(0, 8);
  return {
    version: ADMIN_ME_VERSION,
    user_id: i.actor.id,
    roles: ADMIN_ROLE_NAMES.filter((r) => i.access.effective.includes(r)),
    standing_roles: i.access.standing,
    assurance: i.actor.assurance === "passkey" ? "passkey" : (assuranceFromAmr(i.amr) === "passkey" ? "otp" : assuranceFromAmr(i.amr)),
    amr: i.amr,
    posture: composePosture({ ip: i.ip, binding: i.binding, devTrust: i.devTrust }),
    elevation: {
      break_glass_live: i.access.breakGlassLive,
      live: live.map((e) => ({ id: e.id, role: e.role, expires_at: iso(e.expiresAtMs) })),
      next_expiry_at: live[0] === undefined ? null : iso(live[0].expiresAtMs),
    },
    capabilities: computeCapabilities({ actor: i.actor, access: i.access, rules: i.rules, nowMs: i.nowMs }),
    server_time: iso(i.nowMs),
    session_expires_at: iso(i.sessionExpiresAtMs),
  };
}
