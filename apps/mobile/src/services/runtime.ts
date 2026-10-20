import { createClient, type FetchLike, type OutletClient } from "./api-client";
import type { AdapterContext, Lang } from "./wire";
import type { TokenStorage } from "../platform/secure-storage";

declare const process: { env: { EXPO_PUBLIC_API_BASE_URL?: string | undefined } };

/**
 * The API base URL. Must be written as the literal `process.env.EXPO_PUBLIC_API_BASE_URL` so Expo can inline it.
 * Unset or blank means "no backend": the in-memory fakes are used in development and release builds refuse to start.
 */
export function apiBaseUrlFromEnv(): string | null {
  const v = process.env.EXPO_PUBLIC_API_BASE_URL;
  return v !== undefined && v.trim().length > 0 ? v.trim() : null;
}

/** What the real client needs from the app shell. Registered once by createServices, before any port is read. */
export interface ApiRuntime {
  readonly baseUrl: string;
  readonly tokens: TokenStorage;
  readonly installId: () => Promise<string>;
  readonly locale: () => Lang;
  readonly platform: "ios" | "android";
  /** App Attest / Play Integrity assertion for the attested routes. Absent until the native module lands (gap). */
  readonly attest?: () => Promise<string | null>;
  readonly clock?: () => number;
  readonly fetch?: FetchLike;
}

let configured: ApiRuntime | null = null;
let shared: { readonly runtime: ApiRuntime; readonly client: OutletClient } | null = null;

export function configureApiRuntime(rt: ApiRuntime | null): void {
  configured = rt;
  shared = null;
}

export function getApiRuntime(): ApiRuntime | null {
  return configured;
}

const WIRE_LOCALE: Readonly<Record<Lang, string>> = { ar: "ar-EG", en: "en" };

/** One client per runtime: bearer from secure storage, single shared refresh, attest + locale headers. Tokens are never logged. */
export function getSharedClient(rt: ApiRuntime): OutletClient {
  if (shared !== null && shared.runtime === rt) return shared.client;
  const common = {
    baseUrl: rt.baseUrl,
    ...(rt.fetch !== undefined ? { fetch: rt.fetch } : {}),
    ...(rt.clock !== undefined ? { clock: rt.clock } : {}),
    getHeaders: async (): Promise<Record<string, string>> => {
      const h: Record<string, string> = { "X-Client-Platform": rt.platform, "Accept-Language": WIRE_LOCALE[rt.locale()] };
      const a = rt.attest !== undefined ? await rt.attest() : null;
      if (a !== null) h["X-App-Attest"] = a;
      return h;
    },
  };
  // The refresh call itself must not trigger a refresh: it uses a client without a refresh callback.
  const bare = createClient({ ...common, getToken: async () => null });
  const client = createClient({
    ...common,
    getToken: async () => (await rt.tokens.load())?.accessToken ?? null,
    refreshToken: async () => {
      const current = await rt.tokens.load();
      if (current === null) return null;
      try {
        const r = await bare.refreshSession({ body: { refresh_token: current.refreshToken, device_install_id: await rt.installId() } });
        if (r.notModified) return null;
        const t = { accessToken: r.data.access_token, refreshToken: r.data.refresh_token, accessExpiresAtMs: Date.parse(r.data.access_expires_at) };
        await rt.tokens.save(t);
        return t.accessToken;
      } catch {
        await rt.tokens.clear();
        return null;
      }
    },
  });
  shared = { runtime: rt, client };
  return client;
}

export function createAdapterContext(rt: ApiRuntime): AdapterContext {
  return {
    client: getSharedClient(rt),
    locale: rt.locale,
    nowMs: rt.clock ?? (() => Date.now()),
    deviceId: rt.installId,
    isGuest: async () => (await rt.tokens.load()) === null,
  };
}
