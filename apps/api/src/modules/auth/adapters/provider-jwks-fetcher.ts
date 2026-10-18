import { lookup as dnsLookup } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { JsonWebKey as NodeJwk } from "node:crypto";
import { z } from "zod";
import type { Clock } from "../application/common";
import type { JwksKeyFetcher } from "./jwt-identity-verifier";

/** Fixed provider endpoints. Nothing user-supplied ever reaches a URL (SSRF, API7). */
export const PROVIDER_JWKS_URLS = {
  apple: "https://appleid.apple.com/auth/keys",
  google: "https://www.googleapis.com/oauth2/v3/certs",
} as const;
const ALLOWED_HOSTS: Readonly<Record<"apple" | "google", readonly string[]>> = {
  apple: ["appleid.apple.com"],
  google: ["www.googleapis.com"],
};

export interface JwksHttpResponse {
  readonly status: number;
  /** Lower-cased header names. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** Transport port. The production adapter is `NodeJwksHttp`; tests inject one that talks to a fixture server. */
export interface JwksHttp {
  get(url: URL, options: { readonly timeoutMs: number; readonly maxBytes: number }): Promise<JwksHttpResponse>;
}

export class JwksFetchError extends Error {}

const JwkSchema = z.object({
  kty: z.literal("RSA"),
  kid: z.string().min(1).max(256),
  n: z.string().min(1),
  e: z.string().min(1),
  alg: z.string().optional(),
  use: z.string().optional(),
});
const DocSchema = z.object({ keys: z.array(z.unknown()).max(64) });

export interface CachingJwksFetcherConfig {
  readonly http: JwksHttp;
  readonly clock: Clock;
  /** Override endpoints (must still be https on the provider's fixed host). Defaults to PROVIDER_JWKS_URLS. */
  readonly endpoints?: Readonly<Record<"apple" | "google", string>>;
  /** Cache lifetime bounds in seconds applied to Cache-Control max-age. */
  readonly floorSeconds?: number;
  readonly ceilingSeconds?: number;
  /** Minimum gap between forced refreshes caused by unknown kids (amplification guard). */
  readonly forcedRefreshCooldownMs?: number;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

interface Entry {
  readonly keys: ReadonlyMap<string, NodeJwk>;
  readonly expiresAtMs: number;
}

export function validateEndpoint(provider: "apple" | "google", raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new JwksFetchError("JWKS endpoint must be https");
  if (url.username !== "" || url.password !== "" || url.port !== "") throw new JwksFetchError("JWKS endpoint must not carry credentials or a port");
  if (!ALLOWED_HOSTS[provider].includes(url.hostname)) throw new JwksFetchError("JWKS host is not on the allow-list");
  return url;
}

/**
 * Fetches and caches Apple / Google JWKS. HTTP caching honours `Cache-Control: max-age` clamped to
 * [floor, ceiling] (defaults 5 min .. 24 h). A `kid` that is not in a fresh cache triggers exactly
 * one forced refresh (rate limited by a cooldown) so a key rotation is picked up without letting
 * garbage tokens turn the API into a request amplifier. Only RSA keys are accepted.
 */
export class CachingJwksKeyFetcher implements JwksKeyFetcher {
  private readonly cache = new Map<"apple" | "google", Entry>();
  private readonly inflight = new Map<"apple" | "google", Promise<Entry>>();
  private readonly lastForcedMs = new Map<"apple" | "google", number>();
  private readonly urls: Readonly<Record<"apple" | "google", URL>>;

  constructor(private readonly cfg: CachingJwksFetcherConfig) {
    const e = cfg.endpoints ?? PROVIDER_JWKS_URLS;
    this.urls = { apple: validateEndpoint("apple", e.apple), google: validateEndpoint("google", e.google) };
  }

  async getKey(provider: "apple" | "google", kid: string): Promise<NodeJwk | null> {
    const now = this.cfg.clock.nowMs();
    let entry = this.cache.get(provider);
    if (entry === undefined || entry.expiresAtMs <= now) {
      entry = await this.refresh(provider);
    } else if (!entry.keys.has(kid)) {
      const last = this.lastForcedMs.get(provider) ?? -Infinity;
      if (now - last >= (this.cfg.forcedRefreshCooldownMs ?? 10_000)) {
        this.lastForcedMs.set(provider, now);
        entry = await this.refresh(provider);
      }
    }
    return entry.keys.get(kid) ?? null;
  }

  private refresh(provider: "apple" | "google"): Promise<Entry> {
    const existing = this.inflight.get(provider);
    if (existing !== undefined) return existing;
    const p = this.fetchOnce(provider).finally(() => this.inflight.delete(provider));
    this.inflight.set(provider, p);
    return p;
  }

  private async fetchOnce(provider: "apple" | "google"): Promise<Entry> {
    const c = this.cfg;
    const res = await c.http.get(this.urls[provider], { timeoutMs: c.timeoutMs ?? 5_000, maxBytes: c.maxBytes ?? 65_536 });
    // 3xx is a failure: redirects are never followed (they could leave the allow-listed host).
    if (res.status !== 200) throw new JwksFetchError(`JWKS endpoint answered ${res.status}`);
    let doc: z.infer<typeof DocSchema>;
    try {
      doc = DocSchema.parse(JSON.parse(res.body));
    } catch {
      throw new JwksFetchError("JWKS document is not valid");
    }
    const keys = new Map<string, NodeJwk>();
    for (const raw of doc.keys) {
      const k = JwkSchema.safeParse(raw);
      if (!k.success || (k.data.alg !== undefined && k.data.alg !== "RS256") || (k.data.use !== undefined && k.data.use !== "sig")) continue;
      keys.set(k.data.kid, { kty: "RSA", n: k.data.n, e: k.data.e });
    }
    const floor = c.floorSeconds ?? 300;
    const ceiling = c.ceilingSeconds ?? 86_400;
    const maxAge = /(?:^|[\s,])max-age=(\d{1,9})(?:[\s,]|$)/i.exec(res.headers["cache-control"] ?? "");
    const ttl = Math.min(ceiling, Math.max(floor, maxAge?.[1] === undefined ? floor : Number(maxAge[1])));
    const entry: Entry = { keys, expiresAtMs: c.clock.nowMs() + ttl * 1000 };
    this.cache.set(provider, entry);
    return entry;
  }
}

// ---- Node transport with an SSRF guard ------------------------------------------------------

/** True for addresses a public provider can legitimately have. Everything private, loopback, link-local, multicast or reserved is refused. */
export function isPublicAddress(address: string): boolean {
  const v = isIP(address);
  if (v === 4) {
    const [a = 0, b = 0, c = 0] = address.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0 && c === 0) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    return true;
  }
  if (v === 6) {
    const lower = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped?.[1] !== undefined) return isPublicAddress(mapped[1]);
    if (lower === "::" || lower === "::1") return false;
    const first = parseInt(lower.split(":")[0] || "0", 16);
    if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00) return false;
    return true;
  }
  return false;
}

export interface NodeJwksHttpOptions {
  /**
   * TEST ONLY. Allows plain http and loopback addresses so a fixture server on 127.0.0.1 can
   * exercise redirect, size and timeout handling of this very class. Never set in composition code.
   */
  readonly unsafeAllowLoopbackHttpForTests?: boolean;
}

export class NodeJwksHttp implements JwksHttp {
  constructor(private readonly opts: NodeJwksHttpOptions = {}) {}

  get(url: URL, o: { timeoutMs: number; maxBytes: number }): Promise<JwksHttpResponse> {
    const insecure = this.opts.unsafeAllowLoopbackHttpForTests === true;
    if (url.protocol !== "https:" && !(insecure && url.protocol === "http:")) return Promise.reject(new JwksFetchError("https required"));
    return new Promise<JwksHttpResponse>((resolve, reject) => {
      const doRequest = url.protocol === "https:" ? httpsRequest : httpRequest;
      const req = doRequest(
        url,
        {
          method: "GET",
          headers: { accept: "application/json", "user-agent": "outlet-nk-jwks/1" },
          timeout: o.timeoutMs,
          lookup: (hostname, options, callback) => {
            dnsLookup(hostname, { ...options, all: true }, (err, addrs) => {
              if (err) return callback(err, "", 4);
              const list = Array.isArray(addrs) ? addrs : [];
              const bad = list.find((a) => !(isPublicAddress(a.address) || (insecure && a.address === "127.0.0.1")));
              if (bad !== undefined || list.length === 0) return callback(new JwksFetchError("address not allowed"), "", 4);
              const first = list[0];
              return first === undefined ? callback(new JwksFetchError("no address"), "", 4) : callback(null, first.address, first.family);
            });
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (c: Buffer) => {
            size += c.length;
            if (size > o.maxBytes) {
              req.destroy(new JwksFetchError("response too large"));
              return;
            }
            chunks.push(c);
          });
          res.on("end", () => {
            const headers: Record<string, string> = {};
            for (const [k, v] of Object.entries(res.headers)) if (typeof v === "string") headers[k.toLowerCase()] = v;
            resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks).toString("utf8") });
          });
          res.on("error", reject);
        },
      );
      req.on("timeout", () => req.destroy(new JwksFetchError("timeout")));
      req.on("error", (e) => reject(e instanceof JwksFetchError ? e : new JwksFetchError("request failed")));
      req.end();
    });
  }
}
