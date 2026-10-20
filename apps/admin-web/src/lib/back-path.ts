/**
 * Open-redirect-safe "go back here" path for the language/theme forms and their server actions.
 * Accepts only a same-origin RELATIVE path (+ query): it must start with a single "/", and may not contain a
 * backslash, a control character, or resolve to a different origin ("//evil.test", "/\\evil.test", "https://x").
 * The one-shot flash param `r` is dropped so a toggle never replays a stale banner. Anything else returns "/".
 */
const MAX_LEN = 512;
const BASE = "http://relative.invalid";

export function safeBackPath(raw: string | null | undefined): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_LEN) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
  // eslint-disable-next-line no-control-regex
  if (raw.includes("\\") || /[\u0000-\u001f\u007f]/.test(raw)) return "/";
  let u: URL;
  try {
    u = new URL(raw, BASE);
  } catch {
    return "/";
  }
  if (u.origin !== BASE || u.pathname.startsWith("//")) return "/";
  u.searchParams.delete("r");
  const q = u.searchParams.toString();
  return q === "" ? u.pathname : `${u.pathname}?${q}`;
}
