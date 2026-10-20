import { cookies } from "next/headers";
import { createSellerApi, type SellerApi } from "./api/client";
import { readApiBaseUrl } from "./api/config";
import { createFetchTransport } from "./api/transport";
import { createTranslator, pickLocale, type Locale, type Translator } from "./i18n";
import { ApiSession } from "./session/api-session";
import type { CredentialPort, SessionPort, SessionState, SessionStore } from "./session/port";

export const SESSION_COOKIE = "sc_session";
export const LOCALE_COOKIE = "sc_locale";
export const INSTALL_COOKIE = "sc_install";

export interface RequestContext {
  readonly locale: Locale;
  readonly t: Translator;
  /** null when SELLER_API_BASE_URL is not configured. */
  readonly api: SellerApi | null;
  readonly session: SessionPort | null;
  /** Same object as `session`, typed for the passkey two-step flow. */
  readonly auth: ApiSession | null;
}

/** Tokens live in an httpOnly, SameSite=Strict, Secure cookie; never in JS-readable storage. */
export function cookieSessionStore(): SessionStore {
  return {
    async read(): Promise<SessionState | null> {
      const raw = (await cookies()).get(SESSION_COOKIE)?.value;
      if (raw === undefined) return null;
      try {
        const v: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
        if (typeof v !== "object" || v === null) return null;
        const o = v as Record<string, unknown>;
        if (typeof o.accessToken !== "string" || typeof o.refreshToken !== "string" || typeof o.accessExpiresAtMs !== "number") return null;
        return { accessToken: o.accessToken, refreshToken: o.refreshToken, accessExpiresAtMs: o.accessExpiresAtMs, secondFactorRequired: o.secondFactorRequired === true };
      } catch {
        return null;
      }
    },
    async write(state): Promise<void> {
      const jar = await cookies();
      if (state === null) {
        jar.delete(SESSION_COOKIE);
        return;
      }
      jar.set(SESSION_COOKIE, Buffer.from(JSON.stringify(state), "utf8").toString("base64url"), {
        httpOnly: true,
        secure: true,
        sameSite: "strict",
        path: "/",
        maxAge: 60 * 60 * 8,
      });
    },
  };
}

/** Server-side there is no browser credential API: passkey assertion happens in the login client component. */
const serverCredentials: CredentialPort = {
  async getAssertion() {
    return { ok: false, error: "unsupported" };
  },
};

export async function getContext(): Promise<RequestContext> {
  const jar = await cookies();
  const locale = pickLocale(jar.get(LOCALE_COOKIE)?.value);
  const t = createTranslator(locale);
  const baseUrl = readApiBaseUrl(process.env);
  if (baseUrl === null) return { locale, t, api: null, session: null, auth: null };
  const transport = createFetchTransport({ baseUrl });
  const session = new ApiSession({
    transport,
    store: cookieSessionStore(),
    credentials: serverCredentials,
    installId: () => jar.get(INSTALL_COOKIE)?.value ?? crypto.randomUUID(),
    newIdempotencyKey: () => crypto.randomUUID(),
  });
  const api = createSellerApi({ transport, session, newIdempotencyKey: () => crypto.randomUUID() });
  return { locale, t, api, session, auth: session };
}
