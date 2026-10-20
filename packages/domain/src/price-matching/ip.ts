/**
 * IP literal parsing and classification for the SSRF guard. Handles the encodings attackers use to
 * dodge naive string checks: decimal, octal and hex IPv4, short dotted forms, IPv4-mapped and
 * embedded IPv6 (NAT64, 6to4, IPv4-compatible).
 */

export type ParsedIp = { readonly version: 4 | 6; readonly value: bigint };

const HEX = /^0x[0-9a-f]+$/i;
const OCT = /^0[0-7]*$/;
const DEC = /^(0|[1-9][0-9]*)$/;

function ipv4Part(s: string): bigint | null {
  if (HEX.test(s)) return BigInt(s);
  if (s.length > 1 && OCT.test(s)) return BigInt(`0o${s.slice(1)}`);
  if (s === "0" || DEC.test(s)) return BigInt(s);
  return null;
}

/** True when a host "looks numeric": its last label is a number, so the platform URL parser would read it as IPv4. */
export function looksNumericHost(host: string): boolean {
  const last = host.split(".").filter((l) => l.length > 0).pop();
  if (last === undefined) return false;
  return HEX.test(last) || /^[0-9]+$/.test(last);
}

/** inet_aton semantics: 1..4 parts, each decimal, octal (leading 0) or hex (0x); the last part fills the remaining bytes. */
export function parseIpv4(host: string): ParsedIp | null {
  if (host.length === 0 || host.length > 40) return null;
  const parts = host.split(".");
  if (parts.length > 4 || parts.some((p) => p.length === 0)) return null;
  const nums: bigint[] = [];
  for (const p of parts) {
    const n = ipv4Part(p);
    if (n === null) return null;
    nums.push(n);
  }
  const lastIdx = nums.length - 1;
  let value = 0n;
  for (let i = 0; i < lastIdx; i += 1) {
    const n = nums[i];
    if (n === undefined || n > 255n) return null;
    value |= n << BigInt(8 * (3 - i));
  }
  const last = nums[lastIdx];
  if (last === undefined) return null;
  const room = 8 * (4 - lastIdx);
  if (last >= 1n << BigInt(room)) return null;
  return { version: 4, value: value | last };
}

function parseV6Groups(s: string): number[] | null {
  if (s.length === 0) return [];
  const out: number[] = [];
  for (const g of s.split(":")) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  return out;
}

export function parseIpv6(raw: string): ParsedIp | null {
  let s = raw.toLowerCase();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  if (s.length === 0 || s.length > 64 || s.includes("%") || !s.includes(":")) return null;
  // Embedded dotted IPv4 tail.
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseIpv4Strict(tail);
    if (v4 === null) return null;
    const hi = Number(v4 >> 16n).toString(16);
    const lo = Number(v4 & 0xffffn).toString(16);
    s = `${s.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const dbl = s.split("::");
  if (dbl.length > 2) return null;
  let groups: number[];
  if (dbl.length === 2) {
    const head = parseV6Groups(dbl[0] ?? "");
    const rest = parseV6Groups(dbl[1] ?? "");
    if (head === null || rest === null) return null;
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null;
    groups = [...head, ...Array<number>(fill).fill(0), ...rest];
  } else {
    const g = parseV6Groups(s);
    if (g === null || g.length !== 8) return null;
    groups = g;
  }
  let value = 0n;
  for (const g of groups) value = (value << 16n) | BigInt(g);
  return { version: 6, value };
}

/** Dotted quad only, each octet 0..255 decimal, no leading zeros (used for IPv6 tails and resolver output). */
function parseIpv4Strict(s: string): bigint | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (m === null) return null;
  let v = 0n;
  for (let i = 1; i <= 4; i += 1) {
    const t = m[i];
    if (t === undefined || (t.length > 1 && t.startsWith("0")) || Number(t) > 255) return null;
    v = (v << 8n) | BigInt(t);
  }
  return v;
}

/** Parse any IP literal (resolver output or URL host): strict dotted quad or IPv6, never the loose encodings. */
export function parseResolvedIp(s: string): ParsedIp | null {
  const strict = parseIpv4Strict(s);
  if (strict !== null) return { version: 4, value: strict };
  return parseIpv6(s);
}

const v4 = (a: number, b: number, c: number, d: number): bigint => (BigInt(a) << 24n) | (BigInt(b) << 16n) | (BigInt(c) << 8n) | BigInt(d);

const FORBIDDEN_V4: readonly (readonly [bigint, number])[] = [
  [v4(0, 0, 0, 0), 8],
  [v4(10, 0, 0, 0), 8],
  [v4(100, 64, 0, 0), 10],
  [v4(127, 0, 0, 0), 8],
  [v4(169, 254, 0, 0), 16], // link-local incl. 169.254.169.254 cloud metadata
  [v4(172, 16, 0, 0), 12],
  [v4(192, 0, 0, 0), 24],
  [v4(192, 0, 2, 0), 24],
  [v4(192, 88, 99, 0), 24],
  [v4(192, 168, 0, 0), 16],
  [v4(198, 18, 0, 0), 15],
  [v4(198, 51, 100, 0), 24],
  [v4(203, 0, 113, 0), 24],
  [v4(224, 0, 0, 0), 4],
  [v4(240, 0, 0, 0), 4],
];

const inV4 = (value: bigint, base: bigint, bits: number): boolean => value >> BigInt(32 - bits) === base >> BigInt(32 - bits);
const inV6 = (value: bigint, base: bigint, bits: number): boolean => value >> BigInt(128 - bits) === base >> BigInt(128 - bits);
const v6 = (hex: string): bigint => BigInt(`0x${hex}`);

export type IpVerdict = { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

/** True when the address is NOT publicly routable and must never be fetched. */
export function classifyIp(ip: ParsedIp): IpVerdict {
  if (ip.version === 4) {
    for (const [base, bits] of FORBIDDEN_V4) if (inV4(ip.value, base, bits)) return { allowed: false, reason: "non_public_ipv4" };
    return { allowed: true };
  }
  const x = ip.value;
  if (x === 0n || x === 1n) return { allowed: false, reason: "unspecified_or_loopback_ipv6" };
  const embedded = (low32: bigint): IpVerdict => {
    const r = classifyIp({ version: 4, value: low32 });
    return r.allowed ? { allowed: false, reason: "embedded_ipv4_not_allowed" } : r;
  };
  // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible): classify the embedded IPv4.
  if (inV6(x, v6("ffff00000000"), 96)) return classifyIp({ version: 4, value: x & 0xffffffffn });
  if (inV6(x, 0n, 96)) return embedded(x & 0xffffffffn);
  if (inV6(x, v6("0064ff9b000000000000000000000000"), 96)) return classifyIp({ version: 4, value: x & 0xffffffffn }); // NAT64
  if (inV6(x, v6("20020000000000000000000000000000"), 16)) return classifyIp({ version: 4, value: (x >> 80n) & 0xffffffffn }); // 6to4
  if (inV6(x, v6("fc000000000000000000000000000000"), 7)) return { allowed: false, reason: "unique_local_ipv6" }; // incl. fd00:ec2::254
  if (inV6(x, v6("fe800000000000000000000000000000"), 10)) return { allowed: false, reason: "link_local_ipv6" };
  if (inV6(x, v6("fec00000000000000000000000000000"), 10)) return { allowed: false, reason: "site_local_ipv6" };
  if (inV6(x, v6("ff000000000000000000000000000000"), 8)) return { allowed: false, reason: "multicast_ipv6" };
  if (inV6(x, v6("20010db8000000000000000000000000"), 32)) return { allowed: false, reason: "documentation_ipv6" };
  if (inV6(x, v6("01000000000000000000000000000000"), 64)) return { allowed: false, reason: "discard_ipv6" };
  // Only global unicast 2000::/3 is allowed.
  if (!inV6(x, v6("20000000000000000000000000000000"), 3)) return { allowed: false, reason: "non_global_ipv6" };
  return { allowed: true };
}
