import { isIP } from "node:net";
import type { DnsPort, ChannelFetchPort, FetchRequest, FetchResponse } from "./ports.js";
import { WatchError } from "./watch-env.js";

const v4 = (ip: string): number[] | null => {
  const p = ip.split(".").map(Number);
  return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? p : null;
};
const v4Public = (ip: string): boolean => {
  const p = v4(ip);
  if (p === null) return false;
  const [a = 0, b = 0, c = 0] = p;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && ((b === 0 && (c === 0 || c === 2)) || b === 168)) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
};
const expandV6 = (ip: string): number[] | null => {
  let s = ip.toLowerCase().split("%")[0] ?? "";
  const m = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (m?.[1] !== undefined) {
    const q = v4(m[1]);
    if (q === null) return null;
    s = s.slice(0, s.length - m[1].length) + ((((q[0] ?? 0) << 8) | (q[1] ?? 0)).toString(16)) + ":" + ((((q[2] ?? 0) << 8) | (q[3] ?? 0)).toString(16));
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = (halves[0] ?? "") === "" ? [] : (halves[0] ?? "").split(":");
  const tail = halves.length === 2 && (halves[1] ?? "") !== "" ? (halves[1] ?? "").split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const parts = [...head, ...Array<string>(Math.max(fill, 0)).fill("0"), ...tail].map((h) => parseInt(h, 16));
  return parts.length === 8 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? parts : null;
};
const v6Public = (ip: string): boolean => {
  const h = expandV6(ip);
  if (h === null) return false;
  const [h0 = 0, h1 = 0, h2 = 0, h3 = 0, h4 = 0, h5 = 0, h6 = 0, h7 = 0] = h;
  if (h.every((x) => x === 0) || (h.slice(0, 7).every((x) => x === 0) && h7 === 1)) return false;
  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && (h5 === 0xffff || h5 === 0)) return v4Public(`${String(h6 >> 8)}.${String(h6 & 255)}.${String(h7 >> 8)}.${String(h7 & 255)}`);
  if (h0 === 0x64 && h1 === 0xff9b) return false;
  if ((h0 & 0xffc0) === 0xfe80 || (h0 & 0xfe00) === 0xfc00 || (h0 & 0xff00) === 0xff00) return false;
  if (h0 === 0x2001 && h1 === 0xdb8) return false;
  return true;
};
export const isPublicIp = (ip: string): boolean => (isIP(ip) === 4 ? v4Public(ip) : isIP(ip) === 6 ? v6Public(ip) : false);

export interface SafeTarget {
  readonly url: URL;
  readonly address: string;
}
export interface SsrfOptions {
  readonly dns: DnsPort;
  /** Seller-verified domains only; subdomains of them are allowed. */
  readonly allowedDomains: readonly string[];
}
const unsafe = (m: string): WatchError => new WatchError("unsafe_target", m);

/**
 * SSRF guard (API7): https only, port 443, no credentials, hostname (never an IP literal) inside a verified domain, EVERY resolved
 * address public. The caller connects to the returned `address` (resolve once, pin) so a second DNS answer cannot rebind to a private IP.
 */
export const assertSafeTarget = async (raw: string, o: SsrfOptions): Promise<SafeTarget> => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw unsafe("invalid url");
  }
  if (url.protocol !== "https:") throw unsafe("only https is allowed");
  if (url.username !== "" || url.password !== "") throw unsafe("credentials in url");
  if (url.port !== "" && url.port !== "443") throw unsafe("only port 443 is allowed");
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (isIP(host.replace(/^\[|\]$/g, "")) !== 0 || /^[0-9.]+$/.test(host)) throw unsafe("ip literal host");
  if (!o.allowedDomains.some((d) => host === d || host.endsWith(`.${d}`))) throw unsafe("host is not a verified domain");
  const addrs = await o.dns.resolve(host);
  if (addrs.length === 0) throw unsafe("host did not resolve");
  const bad = addrs.find((a) => !isPublicIp(a));
  if (bad !== undefined) throw unsafe("host resolves to a non-public address");
  return { url, address: addrs[0] ?? "" };
};

export const MAX_REDIRECTS = 3;
/** Follows redirects manually: every hop is re-validated (verified domain, public address), so a redirect to a private host is refused. */
export const safeFetch = async (port: ChannelFetchPort, rawUrl: string, o: SsrfOptions, base: Omit<FetchRequest, "url" | "address">): Promise<FetchResponse> => {
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const t = await assertSafeTarget(current, o);
    const res = await port.fetch({ ...base, url: t.url.toString(), address: t.address });
    if (res.status < 300 || res.status >= 400 || res.status === 304) return res;
    if (res.location === undefined) throw unsafe("redirect without location");
    current = new URL(res.location, t.url).toString();
  }
  throw unsafe("too many redirects");
};
