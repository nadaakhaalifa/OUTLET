/**
 * Release guard (pure). A release build (`!__DEV__`) must never fall back to in-memory fixtures:
 * without a usable EXPO_PUBLIC_API_BASE_URL the app shows a blocking "not configured" screen.
 * Placeholder hosts documented in eas.json (`REPLACE-*`, `.invalid`) count as "not configured".
 */
export type BackendConfig =
  | { readonly kind: "api"; readonly baseUrl: string }
  | { readonly kind: "fixture" } // development / tests only
  | { readonly kind: "blocked"; readonly reason: "missing" | "placeholder" | "invalid" };

export function isPlaceholderUrl(url: string): boolean {
  const u = url.toLowerCase();
  return u.includes("replace-") || u.includes("replace_") || /\.invalid(\/|:|$)/.test(u) || u.includes("example.invalid");
}

export function resolveBackendConfig(rawUrl: string | null | undefined, isDev: boolean): BackendConfig {
  const url = rawUrl === null || rawUrl === undefined ? "" : rawUrl.trim();
  if (url === "") return isDev ? { kind: "fixture" } : { kind: "blocked", reason: "missing" };
  if (!/^https?:\/\/[^\s/]+/i.test(url)) return { kind: "blocked", reason: "invalid" };
  if (!isDev && isPlaceholderUrl(url)) return { kind: "blocked", reason: "placeholder" };
  if (!isDev && !/^https:\/\//i.test(url)) return { kind: "blocked", reason: "invalid" };
  return { kind: "api", baseUrl: url };
}

export class BackendNotConfiguredError extends Error {
  constructor(readonly reason: "missing" | "placeholder" | "invalid") {
    super(`Backend not configured (${reason}): release builds never use fixture data.`);
    this.name = "BackendNotConfiguredError";
  }
}

/** The runtime's view: reads the inlined env var and the dev flag. */
export function currentBackendConfig(rawUrl: string | null): BackendConfig {
  // Only an explicit `__DEV__ === false` is a release build (unit tests have no __DEV__ global).
  const isRelease = typeof __DEV__ !== "undefined" && !__DEV__;
  return resolveBackendConfig(rawUrl, !isRelease);
}

/**
 * The "Sign in as demo brand" shortcut (seeded in-memory brand) exists ONLY in a development build on the in-memory
 * fixture backend. Any release build, and any dev build pointed at a real API, gets `false`: it never renders and never works.
 */
export function isDemoBrandAllowed(cfg: BackendConfig, isDev: boolean): boolean {
  return isDev && cfg.kind === "fixture";
}

/** Runtime view of {@link isDemoBrandAllowed}. */
export function currentDemoBrandAllowed(rawUrl: string | null): boolean {
  const isDev = typeof __DEV__ === "undefined" || __DEV__;
  return isDemoBrandAllowed(currentBackendConfig(rawUrl), isDev);
}
