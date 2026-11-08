/**
 * Removes every inbound `x-middleware-*` header (CVE-2025-29927: `x-middleware-subrequest` skips middleware) and any
 * client-supplied `x-nonce`. Authorization is never decided by middleware alone; the edge must strip these too.
 */
export function sanitizeRequestHeaders(input: Headers): Headers {
  const out = new Headers(input);
  for (const name of [...out.keys()]) {
    const n = name.toLowerCase();
    if (n.startsWith("x-middleware-") || n === "x-nonce" || n === "content-security-policy") out.delete(name);
  }
  return out;
}
