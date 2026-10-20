import type { SellerApi } from "../api/client";
import type { SellerPermissions, SellerStoreStatus } from "../api/schemas-access";
import type { SellerRole } from "../api/schemas-onboarding";

/**
 * What the signed-in seller may do in the active store, as decided by the server (`decide()` via
 * store-scoped `me`). The client never derives access from a role name and never trusts its own state.
 * - open: the flag `release.seller_center.role_nav` is blocked, every link is listed, routes still decide.
 * - granted: server permissions for the store.
 * - no_access: 404 for the store (not a member, removed, or missing): one indistinguishable state.
 * - unavailable: me failed (5xx, offline, contract): fail closed.
 */
export type Access =
  | { readonly kind: "open" }
  | { readonly kind: "granted"; readonly storeId: string; readonly role: SellerRole; readonly storeStatus: SellerStoreStatus; readonly permissions: SellerPermissions }
  | { readonly kind: "no_access" }
  | { readonly kind: "unavailable" };

export const OPEN_ACCESS: Access = { kind: "open" };

/** Flag read: seller-web has no flag client, so the release flag is mirrored by one env var (default blocked). */
export function roleNavEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.SELLER_RELEASE_ROLE_NAV?.trim().toLowerCase() === "on";
}

export async function loadAccess(input: {
  readonly api: SellerApi | null;
  readonly enabled: boolean;
  /** The `sc_store` cookie. Only a lookup key: the server decides whether the user belongs to it. */
  readonly storeIdHint: string | null;
}): Promise<Access> {
  if (!input.enabled) return OPEN_ACCESS;
  if (input.api === null) return { kind: "unavailable" };
  let storeId = input.storeIdHint;
  if (storeId === null) {
    const s = await input.api.store();
    if (!s.ok) return s.error.kind === "not_found" ? { kind: "no_access" } : { kind: "unavailable" };
    storeId = s.value.data.id;
  }
  const r = await input.api.storeMe(storeId);
  if (!r.ok) return r.error.kind === "not_found" ? { kind: "no_access" } : { kind: "unavailable" };
  const m = r.value.data.membership;
  return { kind: "granted", storeId: m.store_id, role: m.role, storeStatus: m.store_status, permissions: m.permissions };
}

export const permissionsOf = (a: Access): SellerPermissions | null => (a.kind === "granted" ? a.permissions : null);
export const roleOf = (a: Access): SellerRole | null => (a.kind === "granted" ? a.role : null);
