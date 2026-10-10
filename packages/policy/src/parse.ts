import { MalformedAuthzInputError } from "./errors";
import {
  ACTIONS,
  ADMIN_ROLES,
  BRAND_ROLES,
  RESOURCE_TYPES,
  type Action,
  type Actor,
  type Grant,
  type Resource,
  type ResourceType,
} from "./types";

/**
 * Strict hand-written parsers for the boundary where untrusted data (a decoded token, a
 * database row) becomes an Actor or Resource. Hand-written because @outlet/policy declares no
 * runtime dependency yet (see needsDeps: zod). Unknown shapes throw; callers must deny.
 */

type Rec = Readonly<Record<string, unknown>>;

function rec(v: unknown, what: string): Rec {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new MalformedAuthzInputError(`${what}: not an object`);
  return v as Rec;
}
function str(v: unknown, what: string): string {
  if (typeof v !== "string" || v.length === 0 || v.length > 128) throw new MalformedAuthzInputError(`${what}: not a string id`);
  return v;
}
function optStr(v: unknown, what: string): string | undefined {
  return v === undefined ? undefined : str(v, what);
}
function oneOf<T extends string>(v: unknown, allowed: readonly T[], what: string): T {
  const hit = allowed.find((a) => a === v);
  if (hit === undefined) throw new MalformedAuthzInputError(`${what}: unexpected value`);
  return hit;
}

function parseGrant(raw: unknown): Grant {
  const g = rec(raw, "grant");
  const kind = oneOf(g["kind"], ["shopper", "plus", "brand", "admin", "courier", "creator"] as const, "grant.kind");
  switch (kind) {
    case "shopper":
    case "plus":
      return { kind };
    case "brand":
      return { kind, storeId: str(g["storeId"], "grant.storeId"), role: oneOf(g["role"], BRAND_ROLES, "grant.role") };
    case "admin": {
      const role = oneOf(g["role"], ADMIN_ROLES, "grant.role");
      const exp = g["expiresAtMs"];
      if (exp === undefined) return { kind, role };
      if (typeof exp !== "number" || !Number.isFinite(exp)) throw new MalformedAuthzInputError("grant.expiresAtMs");
      return { kind, role, expiresAtMs: exp };
    }
    case "courier":
      return { kind, hubId: str(g["hubId"], "grant.hubId") };
    case "creator":
      return { kind, creatorId: str(g["creatorId"], "grant.creatorId") };
  }
}

export function parseActor(raw: unknown): Actor {
  const a = rec(raw, "actor");
  const grants = a["grants"];
  const scopes = a["tokenScopes"];
  if (!Array.isArray(grants)) throw new MalformedAuthzInputError("actor.grants");
  if (!Array.isArray(scopes)) throw new MalformedAuthzInputError("actor.tokenScopes");
  return {
    id: str(a["id"], "actor.id"),
    status: oneOf(a["status"], ["active", "suspended", "deleted"] as const, "actor.status"),
    assurance: oneOf(a["assurance"], ["basic", "passkey"] as const, "actor.assurance"),
    grants: grants.map(parseGrant),
    tokenScopes: scopes.map((s) => str(s, "actor.tokenScopes[]")),
  };
}

export function parseResource(raw: unknown): Resource {
  const r = rec(raw, "resource");
  const amount = r["amountMinor"];
  if (amount !== undefined && typeof amount !== "bigint") throw new MalformedAuthzInputError("resource.amountMinor must be bigint");
  const ownerUserId = optStr(r["ownerUserId"], "resource.ownerUserId");
  const storeId = optStr(r["storeId"], "resource.storeId");
  const hubId = optStr(r["hubId"], "resource.hubId");
  const creatorId = optStr(r["creatorId"], "resource.creatorId");
  return {
    type: oneOf<ResourceType>(r["type"], RESOURCE_TYPES, "resource.type"),
    id: str(r["id"], "resource.id"),
    state: oneOf(r["state"], ["active", "deleted"] as const, "resource.state"),
    ...(ownerUserId !== undefined ? { ownerUserId } : {}),
    ...(storeId !== undefined ? { storeId } : {}),
    ...(hubId !== undefined ? { hubId } : {}),
    ...(creatorId !== undefined ? { creatorId } : {}),
    ...(amount !== undefined ? { amountMinor: amount } : {}),
  };
}

export function parseAction(raw: unknown): Action {
  return oneOf(raw, ACTIONS, "action");
}
