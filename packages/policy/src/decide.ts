import { InvalidRuleSetError } from "./errors";
import type {
  Actor,
  AuditRecord,
  AuthzRequest,
  Decision,
  DenyReason,
  DenyStatus,
  Grant,
  GrantMatcher,
  Resource,
  Rule,
} from "./types";

/**
 * Evaluation stages, in the order they are applied. A rule is allowed only if it passes all
 * of them. When no rule passes, the failure of the furthest stage is reported.
 *
 * Stages 1 and 2 never look at the resource, so a 403 cannot reveal whether an object ID
 * exists. Stages 3 and 4 report 404 so that "not yours" and "does not exist" look the same.
 */
const STAGE_ROLE = 1;
const STAGE_GATE = 2;
const STAGE_RESOURCE = 3;
const STAGE_SCOPE = 4;
const STAGE_REASON = 5;
const STAGE_APPROVAL = 6;

interface Failure {
  readonly stage: number;
  readonly reason: DenyReason;
  readonly status: DenyStatus;
}

const fail = (stage: number, reason: DenyReason, status: DenyStatus): Failure => ({ stage, reason, status });

function grantIsLive(grant: Grant, nowMs: number): boolean {
  return grant.kind !== "admin" || grant.expiresAtMs === undefined || grant.expiresAtMs > nowMs;
}

function grantMatches(grant: Grant, matcher: GrantMatcher): boolean {
  switch (matcher.kind) {
    case "shopper":
      return grant.kind === "shopper" || grant.kind === "plus";
    case "plus":
      return grant.kind === "plus";
    case "brand":
      return grant.kind === "brand" && matcher.roles.includes(grant.role);
    case "admin":
      return grant.kind === "admin" && matcher.roles.includes(grant.role);
    case "courier":
      return grant.kind === "courier";
    case "creator":
      return grant.kind === "creator";
  }
}

/** Grants of the actor that satisfy the matcher. `expired` is true when only expired ones did. */
function matchingGrants(
  actor: Actor,
  matcher: GrantMatcher,
  nowMs: number,
): { live: readonly Grant[]; expired: boolean } {
  const all = actor.grants.filter((g) => grantMatches(g, matcher));
  const live = all.filter((g) => grantIsLive(g, nowMs));
  return { live, expired: all.length > 0 && live.length === 0 };
}

function inScope(rule: Rule, grants: readonly Grant[], actor: Actor, resource: Resource): boolean {
  switch (rule.scope) {
    case "platform":
      return true;
    case "owner":
      return resource.ownerUserId !== undefined && resource.ownerUserId === actor.id;
    case "store":
      return (
        resource.storeId !== undefined &&
        grants.some((g) => g.kind === "brand" && g.storeId === resource.storeId)
      );
    case "hub":
      return (
        resource.hubId !== undefined && grants.some((g) => g.kind === "courier" && g.hubId === resource.hubId)
      );
    case "creator":
      return (
        resource.creatorId !== undefined &&
        grants.some((g) => g.kind === "creator" && g.creatorId === resource.creatorId)
      );
  }
}

/** Approvers that count: active, not the requester, passkey-verified, holding a matching live admin grant. */
function validApprovers(rule: Rule, actor: Actor, approvals: readonly Actor[], nowMs: number): readonly string[] {
  const ids = new Set<string>();
  for (const approver of approvals) {
    if (approver.id === actor.id) continue;
    if (approver.status !== "active") continue;
    if (approver.assurance !== "passkey") continue;
    if (rule.grant.kind !== "admin") continue;
    const { live } = matchingGrants(approver, rule.grant, nowMs);
    if (live.length === 0) continue;
    ids.add(approver.id);
  }
  return [...ids].sort();
}

function approvalRequired(rule: Rule, resource: Resource): boolean {
  const policy = rule.dualApproval;
  if (policy === undefined) return false;
  if (policy.kind === "always") return true;
  return resource.amountMinor === undefined || resource.amountMinor >= policy.thresholdMinor;
}

type RuleOutcome = { readonly ok: true; readonly approverIds: readonly string[] } | { readonly ok: false; readonly failure: Failure };

function evaluateRule(rule: Rule, req: AuthzRequest, actor: Actor): RuleOutcome {
  const { live, expired } = matchingGrants(actor, rule.grant, req.nowMs);
  if (live.length === 0) {
    return { ok: false, failure: fail(STAGE_ROLE, expired ? "grant_expired" : "missing_role", 403) };
  }
  if (rule.requiresTokenScope !== undefined && !actor.tokenScopes.includes(rule.requiresTokenScope)) {
    return { ok: false, failure: fail(STAGE_GATE, "missing_token_scope", 403) };
  }
  if (rule.requiresPasskey === true && actor.assurance !== "passkey") {
    return { ok: false, failure: fail(STAGE_GATE, "passkey_required", 403) };
  }
  const resource = req.resource;
  if (resource === null || resource.type !== rule.resource) {
    return { ok: false, failure: fail(STAGE_RESOURCE, "resource_not_found", 404) };
  }
  if (resource.state === "deleted" && rule.allowDeleted !== true) {
    return { ok: false, failure: fail(STAGE_RESOURCE, "resource_deleted", 404) };
  }
  if (!inScope(rule, live, actor, resource)) {
    return { ok: false, failure: fail(STAGE_SCOPE, "not_owned", 404) };
  }
  if (rule.requiresReason === true && (req.reason === undefined || req.reason.trim() === "")) {
    return { ok: false, failure: fail(STAGE_REASON, "reason_required", 403) };
  }
  if (approvalRequired(rule, resource)) {
    const approvers = validApprovers(rule, actor, req.approvals ?? [], req.nowMs);
    if (approvers.length === 0) {
      return { ok: false, failure: fail(STAGE_APPROVAL, "dual_approval_required", 403) };
    }
    return { ok: true, approverIds: approvers };
  }
  return { ok: true, approverIds: [] };
}

function audit(
  req: AuthzRequest,
  effect: "allow" | "deny",
  reason: DenyReason | "allowed",
  httpStatus: 200 | DenyStatus,
  ruleId: string | null,
  approverIds: readonly string[],
): AuditRecord {
  return {
    effect,
    actorId: req.actor?.id ?? null,
    action: req.action,
    resourceType: req.resourceType,
    resourceId: req.resource?.id ?? null,
    ruleId,
    reason,
    httpStatus,
    approverIds,
    atMs: req.nowMs,
  };
}

function deny(req: AuthzRequest, reason: DenyReason, httpStatus: DenyStatus): Decision {
  return { effect: "deny", httpStatus, reason, audit: audit(req, "deny", reason, httpStatus, null, []) };
}

/**
 * The single decision point. Returns allow only when an explicit rule in `rules` passes every
 * stage. Anything else, including an empty rule set, is a deny with a machine-readable reason.
 */
export function decide(req: AuthzRequest, rules: readonly Rule[]): Decision {
  const actor = req.actor;
  if (actor === null) return deny(req, "unauthenticated", 401);
  if (actor.status === "suspended") return deny(req, "actor_suspended", 403);
  if (actor.status === "deleted") return deny(req, "actor_deleted", 403);

  const candidates = rules.filter((r) => r.resource === req.resourceType && r.actions.includes(req.action));
  if (candidates.length === 0) return deny(req, "no_rule", 403);

  let best: Failure | null = null;
  for (const rule of candidates) {
    const outcome = evaluateRule(rule, req, actor);
    if (outcome.ok) {
      return {
        effect: "allow",
        ruleId: rule.id,
        httpStatus: 200,
        approverIds: outcome.approverIds,
        audit: audit(req, "allow", "allowed", 200, rule.id, outcome.approverIds),
      };
    }
    if (best === null || outcome.failure.stage > best.stage) best = outcome.failure;
  }
  const failure = best ?? fail(STAGE_ROLE, "missing_role", 403);
  return deny(req, failure.reason, failure.status);
}

/** Convenience: true only for an explicit allow. */
export function isAllowed(req: AuthzRequest, rules: readonly Rule[]): boolean {
  return decide(req, rules).effect === "allow";
}

/** What the client may see. Internal reasons such as `not_owned` never leave the server. */
export function toPublicProblem(decision: Decision): { status: 200 | DenyStatus; code: string } {
  if (decision.effect === "allow") return { status: 200, code: "ok" };
  switch (decision.httpStatus) {
    case 401:
      return { status: 401, code: "unauthenticated" };
    case 404:
      return { status: 404, code: "not_found" };
    case 403:
      return { status: 403, code: "forbidden" };
  }
}

/** Fails fast on duplicate rule ids or an approval policy that cannot be satisfied. */
export function assertValidRuleSet(rules: readonly Rule[]): void {
  const seen = new Set<string>();
  for (const rule of rules) {
    if (seen.has(rule.id)) throw new InvalidRuleSetError(`duplicate rule id ${rule.id}`);
    seen.add(rule.id);
    if (rule.actions.length === 0) throw new InvalidRuleSetError(`rule ${rule.id} has no actions`);
    if (rule.dualApproval !== undefined && rule.grant.kind !== "admin") {
      throw new InvalidRuleSetError(`rule ${rule.id}: dual approval is only defined for admin grants`);
    }
    if (rule.grant.kind === "admin" && rule.requiresPasskey !== true) {
      throw new InvalidRuleSetError(`rule ${rule.id}: admin rules must require a passkey`);
    }
    if (rule.scope === "owner" && rule.grant.kind !== "shopper" && rule.grant.kind !== "plus") {
      throw new InvalidRuleSetError(`rule ${rule.id}: owner scope applies to shopper grants only`);
    }
    if (rule.scope === "store" && rule.grant.kind !== "brand") {
      throw new InvalidRuleSetError(`rule ${rule.id}: store scope applies to brand grants only`);
    }
    if (rule.scope === "hub" && rule.grant.kind !== "courier") {
      throw new InvalidRuleSetError(`rule ${rule.id}: hub scope applies to courier grants only`);
    }
    if (rule.scope === "creator" && rule.grant.kind !== "creator") {
      throw new InvalidRuleSetError(`rule ${rule.id}: creator scope applies to creator grants only`);
    }
  }
}
