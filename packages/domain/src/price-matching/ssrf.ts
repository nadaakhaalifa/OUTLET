import { MAX_REDIRECTS } from "./types";
import { classifyIp, looksNumericHost, parseIpv6, parseResolvedIp } from "./ip";

/**
 * SSRF guard (API7, spec 08). Pure URL validation: HTTPS only, port 443 only, no userinfo, no IP
 * literals in any encoding, host must be (a subdomain of) a seller-verified or approved brand
 * domain. The DNS-rebinding half lives in `assertResolvedPublic` and the fetch pipeline pins the
 * resolved address and re-checks the connected address.
 */

export type UrlRejection =
  | "too_long"
  | "malformed"
  | "not_https"
  | "userinfo"
  | "bad_port"
  | "ip_literal"
  | "bad_host"
  | "reserved_host"
  | "domain_not_verified"
  | "bad_redirect"
  | "too_many_redirects";

export interface EgressTarget {
  readonly host: string;
  /** Path and query, always starting with "/". */
  readonly pathAndQuery: string;
  readonly url: string;
}

export type UrlResult = { readonly ok: true; readonly target: EgressTarget } | { readonly ok: false; readonly reason: UrlRejection };

const MAX_URL_LENGTH = 2_048;
const RESERVED_SUFFIXES = [".local", ".localhost", ".internal", ".lan", ".home", ".corp", ".test", ".invalid", ".example", ".arpa", ".onion"];
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** A syntactically public DNS name: >= 2 labels, alphabetic TLD, no reserved suffix, no IP literal. */
export function isPlausiblePublicDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  if (d.length < 4 || d.length > 253) return false;
  if (looksNumericHost(d) || d.includes(":")) return false;
  const labels = d.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return false;
  const tld = labels[labels.length - 1] ?? "";
  if (!/^[a-z]{2,24}$/.test(tld) && !/^xn--[a-z0-9-]{2,}$/.test(tld)) return false;
  return !RESERVED_SUFFIXES.some((s) => d === s.slice(1) || d.endsWith(s));
}

function hostMatches(host: string, verified: ReadonlySet<string>): boolean {
  for (const d of verified) if (host === d || host.endsWith(`.${d}`)) return true;
  return false;
}

export function validateEgressUrl(raw: string, verifiedDomains: ReadonlySet<string>): UrlResult {
  if (raw.length > MAX_URL_LENGTH) return { ok: false, reason: "too_long" };
  // Reject whitespace, control characters, backslashes (parser differentials) and non-ASCII outright.
  if (!/^[\x21-\x7e]+$/.test(raw) || raw.includes("\\")) return { ok: false, reason: "malformed" };
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^#]*)(#.*)?$/i.exec(raw);
  if (m === null) return { ok: false, reason: "malformed" };
  if ((m[1] ?? "").toLowerCase() !== "https") return { ok: false, reason: "not_https" };
  const authority = m[2] ?? "";
  if (authority.includes("@")) return { ok: false, reason: "userinfo" };
  let host = authority;
  if (host.startsWith("[")) return { ok: false, reason: "ip_literal" };
  const colon = host.lastIndexOf(":");
  if (colon !== -1) {
    const port = host.slice(colon + 1);
    if (port !== "443") return { ok: false, reason: "bad_port" };
    host = host.slice(0, colon);
  }
  if (host.includes(":") || host.includes("%")) return { ok: false, reason: "bad_host" };
  host = host.toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host.length === 0) return { ok: false, reason: "bad_host" };
  if (looksNumericHost(host) || parseIpv6(host) !== null) return { ok: false, reason: "ip_literal" };
  if (!isPlausiblePublicDomain(host)) {
    return { ok: false, reason: RESERVED_SUFFIXES.some((s) => host.endsWith(s)) || host === "localhost" ? "reserved_host" : "bad_host" };
  }
  if (!hostMatches(host, verifiedDomains)) return { ok: false, reason: "domain_not_verified" };
  let rest = m[3] ?? "";
  if (rest === "") rest = "/";
  if (rest.startsWith("?")) rest = `/${rest}`;
  return { ok: true, target: { host, pathAndQuery: rest, url: `https://${host}${rest}` } };
}

/** Resolve a redirect `Location` against the current URL and validate the result like any other URL. Counts hops. */
export function validateRedirect(current: EgressTarget, location: string, hop: number, verifiedDomains: ReadonlySet<string>): UrlResult {
  if (hop > MAX_REDIRECTS) return { ok: false, reason: "too_many_redirects" };
  if (location.length === 0 || location.length > MAX_URL_LENGTH) return { ok: false, reason: "bad_redirect" };
  let absolute: string;
  if (/^[a-z][a-z0-9+.-]*:/i.test(location)) absolute = location;
  else if (location.startsWith("//")) absolute = `https:${location}`;
  else if (location.startsWith("/")) absolute = `https://${current.host}${location}`;
  else {
    const dir = current.pathAndQuery.split("?")[0]?.replace(/[^/]*$/, "") ?? "/";
    absolute = `https://${current.host}${dir}${location}`;
  }
  return validateEgressUrl(absolute, verifiedDomains);
}

export type ResolvedVerdict = { readonly ok: true; readonly pinned: string } | { readonly ok: false; readonly reason: "no_addresses" | "non_public_address" | "unparseable_address" };

/**
 * DNS-rebinding guard: EVERY address a name resolves to must be public (a mixed answer is a poisoning
 * signal), and the first one is pinned for the connection.
 */
export function assertResolvedPublic(addresses: readonly string[]): ResolvedVerdict {
  const first = addresses[0];
  if (first === undefined) return { ok: false, reason: "no_addresses" };
  for (const a of addresses) {
    const ip = parseResolvedIp(a);
    if (ip === null) return { ok: false, reason: "unparseable_address" };
    if (!classifyIp(ip).allowed) return { ok: false, reason: "non_public_address" };
  }
  return { ok: true, pinned: first };
}

/** After the fetch: the address actually connected to must still be the pinned, public one. */
export function connectedAddressMatches(pinned: string, connected: string): boolean {
  const a = parseResolvedIp(pinned);
  const b = parseResolvedIp(connected);
  return a !== null && b !== null && a.version === b.version && a.value === b.value && classifyIp(b).allowed;
}
