/**
 * Browser install token (docs/specs/dashboard-foundations.md track 1, "Session binding for admin-web"; ADR-0048).
 *
 * The API mints the token at the web passkey assertion (256 bits, base64url, 43 characters), stores only
 * its hash, and rotates it at every login. admin-web never generates one: a value the browser makes up
 * proves nothing the session cookie does not. The token lives in an httpOnly cookie, so page script cannot
 * read it, and the Next server sends it to the API as `X-Admin-Install`.
 *
 * It binds a session to a cookie jar; it is NOT device trust (a stolen jar carries both cookies).
 */
export const INSTALL_COOKIE = "__Host-admin-install";
export const INSTALL_HEADER = "x-admin-install";

/** `__Host-` prefix rules: Secure, Path=/, no Domain. SameSite=Strict, HttpOnly, same lifetime as the session cookie. */
export const INSTALL_COOKIE_OPTIONS = { httpOnly: true, secure: true, sameSite: "strict", path: "/", maxAge: 60 * 60 * 12 } as const;

const SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** Returns the token when it has the server's shape, else null (never trust a malformed cookie). */
export function parseInstallToken(value: string | null | undefined): string | null {
  return typeof value === "string" && SHAPE.test(value) ? value : null;
}

export interface InstallTokenStore {
  read(): Promise<string | null>;
  /** null clears it. */
  write(token: string | null): Promise<void>;
}
