import { cookies } from "next/headers";
import { SELLER_PERMISSION_KEYS, type SellerPermissions } from "./api/schemas-access";
import { createTranslator, type Locale, type Translator } from "./i18n";
import type { Ctx } from "./loaders";
import { getContext } from "./server-context";
import { loadAccess, permissionsOf, roleNavEnabled, roleOf, type Access } from "./view-models/access";

export interface PageCtx {
  readonly ctx: Ctx;
  readonly t: Translator;
  readonly locale: Locale;
  readonly access: Access;
}

export const STORE_COOKIE = "sc_store";
const NONE = Object.fromEntries(SELLER_PERMISSION_KEYS.map((k) => [k, false])) as SellerPermissions;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolves access once per request (the cookie is only a hint; the server decides membership). */
export async function resolveAccess(api: Ctx["api"]): Promise<Access> {
  const enabled = roleNavEnabled(process.env);
  const raw = enabled ? (await cookies()).get(STORE_COOKIE)?.value : undefined;
  return loadAccess({ api, enabled, storeIdHint: raw !== undefined && UUID.test(raw) ? raw : null });
}

/**
 * Role and permissions come from the server (store-scoped `me`) behind `release.seller_center.role_nav`.
 * Flag blocked: role and permissions stay null and every link shows. Flag on but `me` failed or the user
 * is not a member: permissions are all false (fail closed); routes still answer 403 or 404.
 */
export async function pageCtx(): Promise<PageCtx> {
  const c = await getContext();
  const access = await resolveAccess(c.api);
  const permissions = access.kind === "open" ? null : (permissionsOf(access) ?? NONE);
  return {
    ctx: { api: c.api, locale: c.locale, role: roleOf(access), permissions, nowMs: Date.now() },
    t: createTranslator(c.locale),
    locale: c.locale,
    access,
  };
}
