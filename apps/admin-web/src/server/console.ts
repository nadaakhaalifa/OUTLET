import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { createAdminApi, type AdminApi } from "../api/client";
import { readApiBaseUrl } from "../api/config";
import type { AdminMe } from "../api/schemas";
import { createFetchTransport, type Transport } from "../api/transport";
import { createTranslator, pickLocale, type Locale, type Translator } from "../i18n";
import { ApiSession } from "../session/api-session";
import { INSTALL_COOKIE, INSTALL_COOKIE_OPTIONS, parseInstallToken, type InstallTokenStore } from "../session/install-token";
import { decodeSessionCookie, encodeSessionCookie, SESSION_COOKIE } from "../session/refresh";
import type { SessionState, SessionStore } from "../session/port";
import { evaluatePosture, type Posture } from "../view-models/posture";
import type { Role } from "../view-models/common";

export const LOCALE_COOKIE = "admin-locale";

export interface ConsoleContext {
  readonly locale: Locale;
  readonly t: Translator;
  readonly api: AdminApi;
  readonly me: AdminMe | null;
  readonly roles: readonly Role[] | null;
  readonly selfId: string | null;
  readonly posture: Posture;
  readonly configured: boolean;
  readonly deviceNowMs: number;
  readonly nonce: string | null;
}

export function buildTransport(): Transport | null {
  const base = readApiBaseUrl(process.env);
  return base === null ? null : createFetchTransport({ baseUrl: base });
}

/**
 * Session cookie adapter. Rendering cannot set cookies in Next, so `write` is best effort here: refresh and
 * rotation happen in the proxy (before render) and in server actions. A failed write is not an error.
 */
export function cookieSessionStore(): SessionStore {
  return {
    async read(): Promise<SessionState | null> {
      return decodeSessionCookie((await cookies()).get(SESSION_COOKIE)?.value);
    },
    async write(state: SessionState | null): Promise<void> {
      try {
        const jar = await cookies();
        if (state === null) jar.delete(SESSION_COOKIE);
        else {
          jar.set(SESSION_COOKIE, encodeSessionCookie(state), {
            httpOnly: true, secure: true, sameSite: "strict", path: "/", maxAge: 60 * 60 * 12,
          });
        }
      } catch {
        // Not in a mutable context (render). The proxy owns rotation.
      }
    },
  };
}

/**
 * Install-token cookie adapter (`__Host-admin-install`). Written by server actions (sign-in rotates it) and
 * cleared on sign-out; read by the Next server for refresh and, later, for /v1/admin/me. Render cannot set
 * cookies, so a write there is best effort, exactly like the session cookie.
 */
export function cookieInstallTokenStore(): InstallTokenStore {
  return {
    async read(): Promise<string | null> {
      return parseInstallToken((await cookies()).get(INSTALL_COOKIE)?.value);
    },
    async write(token: string | null): Promise<void> {
      try {
        const jar = await cookies();
        if (token === null) jar.delete(INSTALL_COOKIE);
        else jar.set(INSTALL_COOKIE, token, INSTALL_COOKIE_OPTIONS);
      } catch {
        // Not in a mutable context (render). Sign-in and the proxy own this cookie.
      }
    },
  };
}

export function makeSession(transport: Transport): ApiSession {
  return new ApiSession({
    transport,
    store: cookieSessionStore(),
    credentials: { getAssertion: async () => ({ ok: false, error: "unsupported" }) },
    installTokens: cookieInstallTokenStore(),
    newIdempotencyKey: () => crypto.randomUUID(),
  });
}

export async function readLocale(): Promise<Locale> {
  return pickLocale((await cookies()).get(LOCALE_COOKIE)?.value);
}

/** Per-request context. No session means redirect to /login; the API is still the authority on every call. */
export const getConsole = cache(async (): Promise<ConsoleContext> => {
  const locale = await readLocale();
  const t = createTranslator(locale);
  const nonce = (await headers()).get("x-nonce");
  const transport = buildTransport();
  const store = cookieSessionStore();
  if ((await store.read()) === null) redirect("/login");
  if (transport === null) {
    const dead = createAdminApi({
      transport: { send: async () => { throw new Error("not_configured"); } },
      session: makeSession(createFetchTransport({ baseUrl: "http://localhost" })),
      newIdempotencyKey: () => crypto.randomUUID(),
    });
    return { locale, t, api: dead, me: null, roles: null, selfId: null, posture: evaluatePosture(null), configured: false, deviceNowMs: Date.now(), nonce };
  }
  const api = createAdminApi({ transport, session: makeSession(transport), newIdempotencyKey: () => crypto.randomUUID() });
  const me = await api.me();
  if (!me.ok && me.error.kind === "unauthorized") redirect("/login");
  const identity = me.ok ? me.value.data : null;
  return {
    locale, t, api, me: identity,
    roles: identity === null ? null : identity.roles,
    selfId: identity === null ? null : identity.user_id,
    posture: evaluatePosture(identity),
    configured: true,
    deviceNowMs: Date.now(),
    nonce,
  };
});
