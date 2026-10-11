import type { Actor, AdminRole, Grant } from "./types";

/**
 * The Postgres session context the db layer sets per transaction (see RLS.md and
 * packages/db/migrations/0002_roles_and_helpers.sql). Values for `role` that 0002 does not
 * yet list (ops, trust_safety, marketing, courier, creator) are an open item for the db agent.
 */
export type DbRole =
  | "customer"
  | "seller"
  | "ops"
  | "finance"
  | "trust_safety"
  | "support"
  | "marketing"
  | "dpo"
  | "security"
  | "super_admin"
  | "courier"
  | "creator"
  | "system";

export type Audience =
  | { readonly kind: "shopper" }
  | { readonly kind: "seller" }
  | { readonly kind: "admin"; readonly role: AdminRole }
  | { readonly kind: "courier" }
  | { readonly kind: "creator" };

export interface DbSessionContext {
  readonly userId: string;
  readonly role: DbRole;
  readonly storeIds: readonly string[];
}

const ADMIN_DB_ROLE: Record<AdminRole, DbRole> = {
  ops: "ops",
  finance: "finance",
  trust_safety: "trust_safety",
  support: "support",
  marketing: "marketing",
  dpo: "dpo",
  security: "security",
  super_admin: "super_admin",
};

function isLive(g: Grant, nowMs: number): boolean {
  return g.kind !== "admin" || g.expiresAtMs === undefined || g.expiresAtMs > nowMs;
}

/**
 * Derives the one DB role a request runs as. The audience comes from the route namespace
 * (/v1/admin, /v1/seller, ...), never from the client. Returns null (deny: set no context) when
 * the actor is not active or does not hold a grant for that audience, so RLS sees "no identity".
 */
export function dbSessionContext(actor: Actor, audience: Audience, nowMs: number): DbSessionContext | null {
  if (actor.status !== "active") return null;
  const live = actor.grants.filter((g) => isLive(g, nowMs));
  switch (audience.kind) {
    case "shopper":
      return live.some((g) => g.kind === "shopper" || g.kind === "plus")
        ? { userId: actor.id, role: "customer", storeIds: [] }
        : null;
    case "seller": {
      const stores = [...new Set(live.flatMap((g) => (g.kind === "brand" ? [g.storeId] : [])))].sort();
      return stores.length > 0 ? { userId: actor.id, role: "seller", storeIds: stores } : null;
    }
    case "admin": {
      const held = live.some((g) => g.kind === "admin" && g.role === audience.role);
      return held && actor.assurance === "passkey"
        ? { userId: actor.id, role: ADMIN_DB_ROLE[audience.role], storeIds: [] }
        : null;
    }
    case "courier":
      return live.some((g) => g.kind === "courier") ? { userId: actor.id, role: "courier", storeIds: [] } : null;
    case "creator":
      return live.some((g) => g.kind === "creator") ? { userId: actor.id, role: "creator", storeIds: [] } : null;
  }
}
