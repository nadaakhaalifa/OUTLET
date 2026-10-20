import { cookies } from "next/headers";
import { createOnboardingApi, type OnboardingApi, type TokenSource } from "./api/onboarding-client";
import { readApiBaseUrl } from "./api/config";
import type { SellerRole, SellerSessionTokens } from "./api/schemas-onboarding";
import { createFetchTransport } from "./api/transport";
import { createTranslator, pickLocale, type Locale, type Translator } from "./i18n";
import { ApiSession } from "./session/api-session";
import type { SessionState } from "./session/port";
import { cookieSessionStore, INSTALL_COOKIE, LOCALE_COOKIE } from "./server-context";

export const ENROL_COOKIE = "sc_enrol";

/** Enrol-stage secrets stay in an httpOnly cookie: the browser JS never sees the enrol token or the OTP proof. */
export interface EnrolState {
  readonly enrolToken: string;
  readonly otpProof: string | null;
  readonly nextStep: "enrol_strong_factor" | "assert_strong_factor";
}

export async function readEnrol(): Promise<EnrolState | null> {
  const raw = (await cookies()).get(ENROL_COOKIE)?.value;
  if (raw === undefined) return null;
  try {
    const v: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (typeof v !== "object" || v === null) return null;
    const o = v as Record<string, unknown>;
    if (typeof o.enrolToken !== "string") return null;
    const next = o.nextStep === "assert_strong_factor" ? "assert_strong_factor" : "enrol_strong_factor";
    return { enrolToken: o.enrolToken, otpProof: typeof o.otpProof === "string" ? o.otpProof : null, nextStep: next };
  } catch {
    return null;
  }
}

export async function writeEnrol(state: EnrolState | null, maxAgeSec = 900): Promise<void> {
  const jar = await cookies();
  if (state === null) {
    jar.delete(ENROL_COOKIE);
    return;
  }
  jar.set(ENROL_COOKIE, Buffer.from(JSON.stringify(state), "utf8").toString("base64url"), {
    httpOnly: true, secure: true, sameSite: "strict", path: "/", maxAge: Math.max(60, Math.min(maxAgeSec, 1800)),
  });
}

export function sessionFromTokens(t: SellerSessionTokens, nowMs: number): SessionState {
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    accessExpiresAtMs: nowMs + t.expires_in * 1000,
    secondFactorRequired: false,
  };
}

export interface OnboardingContext {
  readonly locale: Locale;
  readonly t: Translator;
  /** null when SELLER_API_BASE_URL is not configured. */
  readonly api: OnboardingApi | null;
  /** True when a full seller session exists (not only an enrol token). */
  readonly hasSession: boolean;
  readonly hasEnrol: boolean;
  readonly startSession: (tokens: SellerSessionTokens) => Promise<void>;
}

export async function getOnboarding(): Promise<OnboardingContext> {
  const jar = await cookies();
  const locale = pickLocale(jar.get(LOCALE_COOKIE)?.value);
  const t = createTranslator(locale);
  const store = cookieSessionStore();
  const session = await store.read();
  const enrol = await readEnrol();
  const baseUrl = readApiBaseUrl(process.env);
  const startSession = async (tokens: SellerSessionTokens): Promise<void> => {
    await store.write(sessionFromTokens(tokens, Date.now()));
    await writeEnrol(null);
  };
  if (baseUrl === null) return { locale, t, api: null, hasSession: session !== null, hasEnrol: enrol !== null, startSession };
  const transport = createFetchTransport({ baseUrl });
  const apiSession = new ApiSession({
    transport, store, credentials: { async getAssertion() { return { ok: false, error: "unsupported" }; } },
    installId: () => jar.get(INSTALL_COOKIE)?.value ?? crypto.randomUUID(),
    newIdempotencyKey: () => crypto.randomUUID(),
  });
  const tokens: TokenSource = {
    async bearer() {
      const s = await store.read();
      if (s !== null) return s.accessToken;
      return enrol?.enrolToken ?? null;
    },
    async refresh() {
      const s = await store.read();
      if (s === null) return false;
      return (await apiSession.refresh()).ok;
    },
  };
  const api = createOnboardingApi({ transport, tokens, newIdempotencyKey: () => crypto.randomUUID() });
  return { locale, t, api, hasSession: session !== null, hasEnrol: enrol !== null, startSession };
}

export interface StoreScope {
  readonly userId: string;
  readonly storeId: string;
  readonly role: SellerRole;
}

/** The signed-in user's first store membership, or null (no store yet, or not signed in). */
export async function resolveStore(api: OnboardingApi): Promise<{ scope: StoreScope | null; unauthorized: boolean; offline: boolean }> {
  const r = await api.me();
  if (!r.ok) return { scope: null, unauthorized: r.error.kind === "unauthorized", offline: r.error.kind === "offline" };
  const m = r.value.data.memberships[0];
  return { scope: m === undefined ? null : { userId: r.value.data.user_id, storeId: m.store_id, role: m.role }, unauthorized: false, offline: false };
}
