import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { generateKeyPairSync, createSign, type KeyObject } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "@outlet/auth-core";
import {
  CachingJwksKeyFetcher,
  JwksFetchError,
  NodeJwksHttp,
  PROVIDER_JWKS_URLS,
  isPublicAddress,
  validateEndpoint,
  type JwksHttp,
} from "./provider-jwks-fetcher";
import { JwtIdentityVerifier } from "./jwt-identity-verifier";

/**
 * Fixture JWKS server on 127.0.0.1 (no real network in tests). The fetcher under test still sees
 * the real provider URL; the injected transport only rewrites host and port to the fixture.
 */
let server: Server;
let port = 0;
let hits: string[] = [];
let handler: (req: IncomingMessage, res: ServerResponse) => void = () => undefined;

beforeAll(async () => {
  server = createServer((req, res) => {
    hits.push(req.url ?? "");
    handler(req, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => {
  hits = [];
});

const insecure = new NodeJwksHttp({ unsafeAllowLoopbackHttpForTests: true });
const toFixture: JwksHttp = { get: (url, o) => insecure.get(new URL(`http://127.0.0.1:${port}${url.pathname}`), o) };

interface RsaKey { kid: string; priv: KeyObject; jwk: Record<string, string> }
function rsa(kid: string): RsaKey {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, string>;
  return { kid, priv: privateKey, jwk: { ...jwk, kid, alg: "RS256", use: "sig" } };
}
const serve = (keys: RsaKey[], headers: Record<string, string> = { "cache-control": "public, max-age=3600" }) => {
  handler = (_req, res) => {
    res.writeHead(200, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify({ keys: keys.map((k) => k.jwk) }));
  };
};
let now = 1_800_000_000_000;
const clock = { nowMs: () => now };
const fetcher = (extra: Partial<ConstructorParameters<typeof CachingJwksKeyFetcher>[0]> = {}) =>
  new CachingJwksKeyFetcher({ http: toFixture, clock, ...extra });

function idToken(k: RsaKey, claims: Record<string, unknown>, header: Record<string, unknown> = {}): string {
  const h = Buffer.from(JSON.stringify({ alg: "RS256", kid: k.kid, ...header })).toString("base64url");
  const p = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const sig = createSign("RSA-SHA256").update(`${h}.${p}`).sign(k.priv).toString("base64url");
  return `${h}.${p}.${sig}`;
}

describe("CachingJwksKeyFetcher", () => {
  it("fetches once and serves from cache within max-age", async () => {
    const k = rsa("a");
    serve([k]);
    const f = fetcher();
    expect(await f.getKey("apple", "a")).toMatchObject({ kty: "RSA" });
    now += 1000;
    expect(await f.getKey("apple", "a")).not.toBeNull();
    expect(hits).toEqual(["/auth/keys"]);
    now += 3_600_000;
    await f.getKey("apple", "a");
    expect(hits).toHaveLength(2);
  });

  it("clamps Cache-Control max-age to the floor and the ceiling", async () => {
    serve([rsa("a")], { "cache-control": "max-age=1" });
    const low = fetcher({ floorSeconds: 300 });
    await low.getKey("apple", "a");
    now += 200_000;
    await low.getKey("apple", "a");
    expect(hits).toHaveLength(1); // 1 s raised to the 300 s floor
    hits = [];
    serve([rsa("a")], { "cache-control": "max-age=999999999" });
    const high = fetcher({ ceilingSeconds: 600 });
    await high.getKey("google", "a");
    now += 601_000;
    await high.getKey("google", "a");
    expect(hits).toHaveLength(2); // huge max-age capped at the 600 s ceiling
  });

  it("a kid miss forces exactly one refresh, then the cooldown stops request amplification", async () => {
    const a = rsa("a");
    serve([a]);
    const f = fetcher({ forcedRefreshCooldownMs: 10_000 });
    await f.getKey("google", "a");
    const b = rsa("b");
    serve([a, b]);
    expect(await f.getKey("google", "b")).not.toBeNull(); // rotation picked up by the forced refresh
    expect(hits).toHaveLength(2);
    expect(await f.getKey("google", "zzz")).toBeNull(); // within cooldown: no new fetch
    expect(await f.getKey("google", "yyy")).toBeNull();
    expect(hits).toHaveLength(2);
    now += 11_000;
    expect(await f.getKey("google", "zzz")).toBeNull(); // cooldown over: one more forced refresh
    expect(hits).toHaveLength(3);
  });

  it("concurrent lookups share one in-flight fetch", async () => {
    serve([rsa("a")]);
    const f = fetcher();
    await Promise.all([1, 2, 3, 4, 5].map(() => f.getKey("apple", "a")));
    expect(hits).toHaveLength(1);
  });

  it("non-200, redirect, bad JSON and oversize responses fail (the verifier turns that into provider_unavailable)", async () => {
    const f = fetcher();
    handler = (_q, res) => { res.writeHead(500); res.end("no"); };
    await expect(f.getKey("apple", "a")).rejects.toThrow(JwksFetchError);
    handler = (_q, res) => { res.writeHead(302, { location: "http://169.254.169.254/latest" }); res.end(); };
    await expect(fetcher().getKey("apple", "a")).rejects.toThrow(JwksFetchError);
    expect(hits.some((h) => h.includes("169.254"))).toBe(false);
    handler = (_q, res) => { res.writeHead(200); res.end("<html>"); };
    await expect(fetcher().getKey("apple", "a")).rejects.toThrow(JwksFetchError);
    handler = (_q, res) => { res.writeHead(200); res.end("x".repeat(200_000)); };
    await expect(fetcher({ maxBytes: 1024 }).getKey("apple", "a")).rejects.toThrow();
  });

  it("times out a hanging provider", async () => {
    handler = () => undefined; // never answers
    await expect(fetcher({ timeoutMs: 100 }).getKey("apple", "a")).rejects.toThrow();
  });

  it("ignores non-RSA, wrong-alg and wrong-use keys", async () => {
    const good = rsa("good");
    handler = (_q, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: [good.jwk, { ...good.jwk, kid: "hs", alg: "HS256" }, { ...good.jwk, kid: "enc", use: "enc" }, { kty: "oct", kid: "oct", k: "AAAA" }] }));
    };
    const f = fetcher();
    expect(await f.getKey("apple", "good")).not.toBeNull();
    expect(await f.getKey("apple", "hs")).toBeNull();
    expect(await f.getKey("apple", "enc")).toBeNull();
    expect(await f.getKey("apple", "oct")).toBeNull();
  });
});

describe("endpoint allow-list (SSRF)", () => {
  it("accepts only the fixed https hosts for each provider", () => {
    expect(validateEndpoint("apple", PROVIDER_JWKS_URLS.apple).hostname).toBe("appleid.apple.com");
    expect(validateEndpoint("google", PROVIDER_JWKS_URLS.google).hostname).toBe("www.googleapis.com");
    for (const bad of [
      "http://appleid.apple.com/auth/keys",
      "https://evil.example/auth/keys",
      "https://appleid.apple.com.evil.example/auth/keys",
      "https://user:pw@appleid.apple.com/auth/keys",
      "https://appleid.apple.com:8443/auth/keys",
      "https://127.0.0.1/auth/keys",
      "https://www.googleapis.com/oauth2/v3/certs", // right host, wrong provider
    ]) {
      expect(() => validateEndpoint("apple", bad), bad).toThrow(JwksFetchError);
    }
    expect(() => new CachingJwksKeyFetcher({ http: toFixture, clock, endpoints: { apple: "https://evil.example/k", google: PROVIDER_JWKS_URLS.google } })).toThrow();
  });

  it("classifies private, loopback, link-local, CGNAT, multicast and mapped addresses as non-public", () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1", "::1", "::", "fc00::1", "fd12::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "not-an-ip"]) {
      expect(isPublicAddress(a), a).toBe(false);
    }
    for (const a of ["8.8.8.8", "17.253.144.10", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
      expect(isPublicAddress(a), a).toBe(true);
    }
  });

  it("the production transport refuses plain http and loopback targets", async () => {
    const strict = new NodeJwksHttp();
    await expect(strict.get(new URL(`http://127.0.0.1:${port}/x`), { timeoutMs: 500, maxBytes: 100 })).rejects.toThrow(JwksFetchError);
    await expect(strict.get(new URL(`https://127.0.0.1:${port}/x`), { timeoutMs: 500, maxBytes: 100 })).rejects.toThrow();
    await expect(strict.get(new URL(`https://localhost:${port}/x`), { timeoutMs: 500, maxBytes: 100 })).rejects.toThrow();
    expect(hits).toEqual([]);
  });
});

describe("Apple/Google ID token verification through the real fetcher", () => {
  const AUD = "com.outletnk.app";
  const nowS = () => Math.floor(now / 1000);
  const verifier = (f: CachingJwksKeyFetcher) =>
    new JwtIdentityVerifier({ provider: "apple", issuers: ["https://appleid.apple.com"], audience: AUD, keys: f, clock });
  const claims = (over: Record<string, unknown> = {}) => ({
    iss: "https://appleid.apple.com",
    aud: AUD,
    sub: "001234.abc",
    exp: nowS() + 600,
    iat: nowS(),
    nonce: sha256Hex("raw-nonce-1"),
    email: "x@privaterelay.appleid.com",
    email_verified: "true",
    ...over,
  });

  it("accepts a valid token, with Apple's hashed nonce", async () => {
    const k = rsa("k1");
    serve([k]);
    const r = await verifier(fetcher()).verify({ identityToken: idToken(k, claims()), expectedNonce: "raw-nonce-1" });
    expect(r).toMatchObject({ ok: true, identity: { provider: "apple", subject: "001234.abc", isPrivateRelay: true } });
  });

  it("rejects wrong audience, wrong issuer, expired, wrong nonce, alg none, HS256 and a token signed by an unknown key", async () => {
    const k = rsa("k1");
    serve([k]);
    const v = verifier(fetcher());
    const run = (t: string, nonce = "raw-nonce-1") => v.verify({ identityToken: t, expectedNonce: nonce });
    expect(await run(idToken(k, claims({ aud: "other.app" })))).toEqual({ ok: false, reason: "audience_mismatch" });
    expect(await run(idToken(k, claims({ iss: "https://evil.example" })))).toEqual({ ok: false, reason: "issuer_mismatch" });
    expect(await run(idToken(k, claims({ exp: nowS() - 600 })))).toEqual({ ok: false, reason: "expired" });
    expect(await run(idToken(k, claims()), "different")).toEqual({ ok: false, reason: "nonce_mismatch" });
    expect(await run(idToken(k, claims({ nonce: undefined })))).toEqual({ ok: false, reason: "nonce_mismatch" });
    const none = `${Buffer.from('{"alg":"none","kid":"k1"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims())).toString("base64url")}.`;
    expect(await run(none)).toMatchObject({ ok: false });
    expect(await run(idToken(k, claims(), { alg: "HS256" }))).toMatchObject({ ok: false, reason: "invalid_token" });
    const stranger = rsa("k1"); // same kid, different key material
    expect(await run(idToken(stranger, claims()))).toEqual({ ok: false, reason: "invalid_token" });
  });

  it("a rotated key (kid miss) is fetched once and then accepted", async () => {
    const old = rsa("old");
    serve([old]);
    const f = fetcher();
    const v = verifier(f);
    expect((await v.verify({ identityToken: idToken(old, claims()), expectedNonce: "raw-nonce-1" })).ok).toBe(true);
    const fresh = rsa("new");
    serve([old, fresh]);
    expect((await v.verify({ identityToken: idToken(fresh, claims()), expectedNonce: "raw-nonce-1" })).ok).toBe(true);
    expect(hits).toHaveLength(2);
  });

  it("an unreachable provider is provider_unavailable, not a login", async () => {
    handler = (_q, res) => { res.writeHead(503); res.end(); };
    const k = rsa("k1");
    expect(await verifier(fetcher()).verify({ identityToken: idToken(k, claims()), expectedNonce: "raw-nonce-1" })).toEqual({ ok: false, reason: "provider_unavailable" });
  });
});
