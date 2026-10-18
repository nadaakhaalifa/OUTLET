import { sessionTokens } from "../api/schemas";
import type { Transport } from "../api/transport";
import { INSTALL_HEADER } from "./install-token";
import { toState, type SessionState } from "./port";

/** Refresh this many ms before the access token expires, so a render never races expiry. */
export const REFRESH_SKEW_MS = 60_000;

export type RefreshOutcome =
  | { readonly kind: "fresh"; readonly state: SessionState }
  | { readonly kind: "refreshed"; readonly state: SessionState }
  | { readonly kind: "signed_out" };

/**
 * Used by the proxy (the only place cookies can be rotated before render). A rejected refresh signs out:
 * a rotating refresh token that is replayed would revoke the whole family, so we never retry it.
 */
export async function refreshIfNeeded(
  state: SessionState,
  nowMs: number,
  deps: {
    readonly transport: Transport;
    /** The server-minted install token from the `__Host-admin-install` cookie; null when the cookie is absent. */
    readonly installToken: string | null;
  },
): Promise<RefreshOutcome> {
  if (state.accessExpiresAtMs - nowMs > REFRESH_SKEW_MS) return { kind: "fresh", state };
  try {
    const res = await deps.transport.send({
      method: "POST",
      path: "/v1/auth/refresh",
      headers: deps.installToken === null ? {} : { [INSTALL_HEADER]: deps.installToken },
      body: { refresh_token: state.refreshToken },
    });
    const tokens = sessionTokens.safeParse(res.json);
    if (res.status !== 200 || !tokens.success || tokens.data.second_factor_required === true) return { kind: "signed_out" };
    return { kind: "refreshed", state: toState(tokens.data) };
  } catch {
    // Network failure: keep the old state; the API call will 401 and the screen will say so.
    return { kind: "fresh", state };
  }
}

const b64u = {
  enc: (s: string): string => {
    let bin = "";
    for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  dec: (s: string): string => {
    const pad = "=".repeat((4 - (s.length % 4)) % 4);
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  },
};

export function encodeSessionCookie(state: SessionState): string {
  return b64u.enc(JSON.stringify(state));
}

export function decodeSessionCookie(value: string | undefined): SessionState | null {
  if (value === undefined || value.length === 0 || value.length > 4096) return null;
  try {
    const o: unknown = JSON.parse(b64u.dec(value));
    if (typeof o !== "object" || o === null) return null;
    const r = o as Record<string, unknown>;
    if (typeof r.accessToken !== "string" || typeof r.refreshToken !== "string" || typeof r.accessExpiresAtMs !== "number") return null;
    return { accessToken: r.accessToken, refreshToken: r.refreshToken, accessExpiresAtMs: r.accessExpiresAtMs };
  } catch {
    return null;
  }
}

export const SESSION_COOKIE = "__Host-admin-session";
