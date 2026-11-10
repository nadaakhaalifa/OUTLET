import { HttpException, NotFoundException } from "@nestjs/common";
import { AuthError } from "@outlet/auth-core";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { ZodError, z } from "zod";
import { EnvSchema, parseEnv, trustProxyList } from "../src/config.js";
import type { Queryable } from "@outlet/db";
import { ReadinessProbe } from "../src/modules/health/index.js";
import { InMemoryStoreMemberships, SessionTokenVerifier, UnconfiguredStoreMemberships } from "../src/platform/auth-ports.js";
import type { MarketTokenService } from "../src/platform/auth-ports.js";
import { CursorQuery, pageOf } from "../src/platform/pagination.js";
import { pgPoolOptions, pgSqlClient, runInRequestContext } from "../src/platform/db.js";
import type { PoolLike } from "../src/platform/db.js";
import { resolveMarket, weakEtag } from "../src/platform/hooks.js";
import { headerValue, systemClock } from "../src/platform/http.js";
import type { ApiRequest } from "../src/platform/http.js";
import { CircuitBreaker, CircuitOpenError, TimeoutError, withTimeout } from "../src/platform/outbound.js";
import { ProblemError } from "../src/platform/problem.js";
import { toProblem } from "../src/platform/problem-map.js";
import { gcra } from "../src/platform/rate-limit/gcra.js";
import { MemoryRateLimiter } from "../src/platform/rate-limit/memory.js";
import { GCRA_LUA, RedisRateLimiter } from "../src/platform/rate-limit/redis.js";
import { activeStore } from "../src/platform/resolvers.js";

describe("GCRA", () => {
  it("allows exactly `limit` in a burst from idle, then spaces requests by period/limit", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 200 }), fc.integer({ min: 1_000, max: 3_600_000 }), (limit, periodMs) => {
        let tat: number | undefined;
        let allowed = 0;
        for (let i = 0; i < limit + 5; i++) {
          const d = gcra(tat, 1_000_000, { limit, periodMs });
          if (d.allowed) {
            allowed += 1;
            tat = d.tat;
          } else expect(d.retryAfterMs).toBeGreaterThan(0);
        }
        expect(allowed).toBe(limit);
        const later = gcra(tat, 1_000_000 + Math.ceil(periodMs / limit), { limit, periodMs });
        expect(later.allowed).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it("never allows more than limit + elapsed/emission over any window (sustained rate)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 50 }), fc.array(fc.integer({ min: 0, max: 5_000 }), { minLength: 1, maxLength: 300 }), (limit, gaps) => {
        const periodMs = 10_000;
        let now = 0;
        let tat: number | undefined;
        let allowed = 0;
        for (const g of gaps) {
          now += g;
          const d = gcra(tat, now, { limit, periodMs });
          if (d.allowed) {
            allowed += 1;
            tat = d.tat;
          }
        }
        expect(allowed).toBeLessThanOrEqual(limit + Math.floor((now * limit) / periodMs) + 1);
      }),
    );
  });

  it("MemoryRateLimiter prunes idle keys when full and keeps budgets per key", async () => {
    let now = 0;
    const m = new MemoryRateLimiter(() => now, 2);
    expect((await m.hit("a", { limit: 1, periodMs: 1000 })).allowed).toBe(true);
    expect((await m.hit("a", { limit: 1, periodMs: 1000 })).allowed).toBe(false);
    await m.hit("b", { limit: 1, periodMs: 1000 });
    now = 5_000;
    await m.hit("c", { limit: 1, periodMs: 1000 });
    expect(m.size).toBe(1);
  });
});

describe("RedisRateLimiter (stubbed client; the Lua script is NOT executed here)", () => {
  it("sends one EVAL with the key prefix, emission and tolerance, and maps the reply", async () => {
    const calls: unknown[][] = [];
    const redis = { eval: (...args: unknown[]) => (calls.push(args), Promise.resolve([0, 1500, 0])) };
    const d = await new RedisRateLimiter(redis).hit("search:user:abc", { limit: 30, periodMs: 10_000 });
    expect(d).toEqual({ allowed: false, retryAfterMs: 1500, remaining: 0 });
    expect(calls[0]?.slice(1)).toEqual([1, "rl:search:user:abc", 10_000 / 30, 10_000]);
    expect(calls[0]?.[0]).toBe(GCRA_LUA);
    expect(GCRA_LUA).toContain("redis.call('TIME')");
  });

  it("rejects malformed replies, times out slow calls and opens the breaker", async () => {
    await expect(new RedisRateLimiter({ eval: () => Promise.resolve(["x"]) }).hit("k", { limit: 1, periodMs: 1 })).rejects.toThrow();
    const slow = new RedisRateLimiter({ eval: () => new Promise((r) => setTimeout(() => { r([1, 0, 0]); }, 100)) }, { timeoutMs: 5 });
    await expect(slow.hit("k", { limit: 1, periodMs: 1 })).rejects.toBeInstanceOf(TimeoutError);
    const breaker = new CircuitBreaker({ label: "r", failureThreshold: 1, openMs: 1000, now: () => 0 });
    const down = new RedisRateLimiter({ eval: () => Promise.reject(new Error("down")) }, { breaker });
    await expect(down.hit("k", { limit: 1, periodMs: 1 })).rejects.toThrow("down");
    await expect(down.hit("k", { limit: 1, periodMs: 1 })).rejects.toBeInstanceOf(CircuitOpenError);
  });
});

describe("outbound: timeout and circuit breaker", () => {
  it("withTimeout resolves fast calls and clears its timer", async () => {
    expect(await withTimeout("x", 50, () => Promise.resolve(7))).toBe(7);
  });

  it("closed → open after N failures → half-open single trial → closed on success", async () => {
    let now = 0;
    const b = new CircuitBreaker({ label: "psp", failureThreshold: 2, openMs: 100, now: () => now });
    const fail = (): Promise<never> => Promise.reject(new Error("x"));
    await expect(b.call(fail)).rejects.toThrow("x");
    expect(b.state).toBe("closed");
    await expect(b.call(fail)).rejects.toThrow("x");
    expect(b.state).toBe("open");
    await expect(b.call(() => Promise.resolve(1))).rejects.toBeInstanceOf(CircuitOpenError);
    now = 100;
    expect(b.state).toBe("half-open");
    let release: (v: number) => void = () => undefined;
    const trial = b.call(() => new Promise<number>((r) => (release = r)));
    await expect(b.call(() => Promise.resolve(2))).rejects.toBeInstanceOf(CircuitOpenError);
    release(3);
    expect(await trial).toBe(3);
    expect(b.state).toBe("closed");
    const d = new CircuitBreaker({ label: "d" });
    expect(d.state).toBe("closed");
  });

  it("a failed half-open trial re-opens the circuit", async () => {
    let now = 0;
    const b = new CircuitBreaker({ label: "x", failureThreshold: 1, openMs: 10, now: () => now });
    await expect(b.call(() => Promise.reject(new Error("a")))).rejects.toThrow();
    now = 10;
    await expect(b.call(() => Promise.reject(new Error("b")))).rejects.toThrow("b");
    expect(b.state).toBe("open");
  });
});

describe("token verifier and memberships", () => {
  const svc = (audience: string, ok: boolean): MarketTokenService => ({
    audience,
    verifyAccessToken: () => (ok ? Promise.resolve({ userId: "u", sessionId: "s", amr: ["otp"], expiresAt: new Date() }) : Promise.reject(new AuthError("ACCESS_TOKEN_INVALID", "x"))),
  });
  const jwtWithAud = (aud: unknown): string => `e30.${Buffer.from(JSON.stringify({ aud })).toString("base64url")}.x`;

  it("maps a valid token to the user; another configured market's audience → market-mismatch; garbage → invalid-token", async () => {
    const v = new SessionTokenVerifier(new Map([["EG", svc("outlet:eg", false)], ["SA", svc("outlet:sa", true)]]));
    const code = (p: Promise<unknown>): Promise<string> => p.then(() => "ok", (e: unknown) => (e as ProblemError).code);
    expect(await code(v.verify(jwtWithAud("outlet:sa"), "EG", new Date()))).toBe("market-mismatch");
    expect(await code(v.verify(jwtWithAud(["outlet:sa"]), "EG", new Date()))).toBe("market-mismatch");
    expect(await code(v.verify(jwtWithAud("outlet:eg"), "EG", new Date()))).toBe("invalid-token");
    expect(await code(v.verify(jwtWithAud(undefined), "EG", new Date()))).toBe("invalid-token");
    expect(await code(v.verify("not.a.jwt", "EG", new Date()))).toBe("invalid-token");
    expect(await code(v.verify("x", "ZZ", new Date()))).toBe("invalid-token");
    expect(await v.verify("x", "SA", new Date())).toEqual({ userId: "u", sessionId: "s", amr: ["otp"] });
  });

  it("memberships: unknown or empty → null; Unconfigured fails closed", async () => {
    const m = new InMemoryStoreMemberships();
    m.grant("EG", "u", "s", []);
    expect(await m.find("EG", "u", "s")).toBeNull();
    m.grant("EG", "u", "s", ["owner"]);
    expect(await m.find("EG", "u", "s")).toEqual({ roles: ["owner"] });
    expect(await m.find("SA", "u", "s")).toBeNull();
    expect(await new UnconfiguredStoreMemberships().find()).toBeNull();
  });

  it("activeStore resolver needs a proven store", () => {
    expect(activeStore({ req: {} as ApiRequest, marketId: "EG", userId: "u", storeId: undefined })).toBeNull();
  });
});

describe("problem mapping", () => {
  it.each([
    [new AuthError("RATE_LIMITED", "x", { retryAfterSeconds: 9 }), 429, "rate-limited"],
    [new AuthError("RATE_LIMITED", "x"), 429, "rate-limited"],
    [new AuthError("ACCESS_TOKEN_INVALID", "x"), 401, "invalid-token"],
    [new AuthError("OTP_INVALID", "x"), 400, "auth-rejected"],
    [new ZodError([]), 400, "validation-failed"],
    [Object.assign(new Error("x"), { statusCode: 413, code: "FST_ERR_CTP_BODY_TOO_LARGE" }), 413, "payload-too-large"],
    [Object.assign(new Error("x"), { statusCode: 415, code: "FST_ERR_CTP_INVALID_MEDIA_TYPE" }), 415, "unsupported-media-type"],
    [Object.assign(new SyntaxError("x"), { statusCode: 400 }), 400, "malformed-request"],
    [Object.assign(new Error("x"), { statusCode: 500, code: "FST_ERR_X" }), 500, "internal-error"],
    [Object.assign(new Error("x"), { statusCode: 400, code: "ECONNRESET" }), 500, "internal-error"],
    [new NotFoundException(), 404, "route-not-found"],
    [new HttpException("x", 405), 405, "method-not-allowed"],
    [new HttpException("x", 413), 413, "payload-too-large"],
    [new HttpException("x", 415), 415, "unsupported-media-type"],
    [new HttpException("x", 502), 500, "internal-error"],
    ["a string", 500, "internal-error"],
    [null, 500, "internal-error"],
  ])("%s → %i %s", (e, status, code) => {
    const p = toProblem(e);
    expect([p.status, p.code]).toEqual([status, code]);
  });
});

describe("market resolution, ETag, headers", () => {
  it("resolves path and header markets", () => {
    expect(resolveMarket("/v1/eg/stores", undefined)?.id).toBe("eg");
    expect(resolveMarket("/v1/health/live", undefined)).toBeUndefined();
    expect(resolveMarket("/v1/health/live", "EG")?.id).toBe("eg");
    expect(resolveMarket("/other", undefined)).toBeUndefined();
    expect(() => resolveMarket("/v1/zz/x", undefined)).toThrow(ProblemError);
    expect(() => resolveMarket("/v1/health", "zz")).toThrow(ProblemError);
  });

  it("weak ETag is stable and content-sensitive; headerValue takes the first of repeated headers", () => {
    expect(weakEtag("a")).toBe(weakEtag("a"));
    expect(weakEtag("a")).not.toBe(weakEtag("b"));
    expect(headerValue({ headers: { "x-a": ["1", "2"] } }, "X-A")).toBe("1");
    expect(systemClock.now()).toBeInstanceOf(Date);
  });
});

describe("readiness probe", () => {
  const db = (fail: { ping?: boolean; migrations?: boolean; role?: boolean } = {}): Queryable & { query: ReturnType<typeof vi.fn> } => {
    const query = vi.fn((sql: string): Promise<{ rows: object[] }> => {
      if (sql.startsWith("SELECT 1")) return fail.ping === true ? Promise.reject(new Error("down")) : Promise.resolve({ rows: [{ ok: 1 }] });
      if (sql.includes("schema_migrations")) return fail.migrations === true ? Promise.reject(new Error("no table")) : Promise.resolve({ rows: [{ name: "0001_a" }] });
      return fail.role === true ? Promise.resolve({ rows: [] }) : Promise.reject(new Error("role query"));
    });
    return { query } as unknown as Queryable & { query: ReturnType<typeof vi.fn> };
  };

  it("draining → not ready without touching the database", async () => {
    const q = db();
    const r = await new ReadinessProbe(q, { draining: true }, () => Promise.resolve(["0001_a"])).check();
    expect(r).toEqual({ ready: false, checks: { lifecycle: "failed", db: "skipped", migrations: "skipped", role: "skipped" } });
    expect(q.query.mock.calls.length).toBe(0);
  });

  it("ping failure, missing migration and failed role check are each reported", async () => {
    expect((await new ReadinessProbe(db({ ping: true }), { draining: false }).check()).checks.db).toBe("failed");
    expect((await new ReadinessProbe(db(), { draining: false }, () => Promise.resolve(["0001_a", "0002_b"])).check()).checks.migrations).toBe("failed");
    expect((await new ReadinessProbe(db({ migrations: true }), { draining: false }, () => Promise.resolve([])).check()).checks.migrations).toBe("failed");
    expect((await new ReadinessProbe(db({ role: true }), { draining: false }, () => Promise.resolve(["0001_a"])).check()).checks.role).toBe("failed");
  });
});

describe("config", () => {
  const base = {
    DATABASE_URL_APP: "postgres://outlet_app:x@pgbouncer:6432/outlet_catalog",
    JWT_ISSUER: "https://auth.outlex.invalid",
    JWT_KID: "k1",
    JWT_PUBLIC_KEY_PEM: "-----BEGIN PUBLIC KEY-----x",
    JWT_PRIVATE_KEY_PEM: "-----BEGIN PRIVATE KEY-----x",
    RATE_LIMIT_KEY_SECRET: "s".repeat(32),
  };

  it("parses defaults and booleans", () => {
    const e = parseEnv({ ...base, TRUST_ASN_HEADER: "true" });
    expect([e.PORT, e.NODE_ENV, e.TRUST_ASN_HEADER, e.OTEL_EXPORTER]).toEqual([8080, "development", true, "none"]);
  });

  it("production requires Redis; errors name variables, never values", () => {
    expect(() => parseEnv({ ...base, NODE_ENV: "production" })).toThrow(/REDIS_URL/);
    expect(() => parseEnv({ ...base, RATE_LIMIT_KEY_SECRET: "short-secret-value" })).toThrow(/RATE_LIMIT_KEY_SECRET \(too_small\)/);
    expect(() => parseEnv({ ...base, RATE_LIMIT_KEY_SECRET: "short-secret-value" })).not.toThrow(/short-secret-value/);
    expect(EnvSchema.safeParse({ ...base, NODE_ENV: "production", REDIS_URL: "rediss://cache:6380", DATABASE_URL_AUTH: "postgres://auth@pgbouncer:6432/outlet_auth" }).success).toBe(true);
  });

  it("trust proxy list", () => {
    expect(trustProxyList("")).toBe(false);
    expect(trustProxyList("10.0.0.0/8, 173.245.48.0/20")).toEqual(["10.0.0.0/8", "173.245.48.0/20"]);
  });
});

describe("pg adapter", () => {
  const fakePool = (failOn?: string) => {
    const log: string[] = [];
    const released: unknown[] = [];
    const run = (sql: string): Promise<{ rows: unknown[] }> => {
      log.push(sql);
      return sql === failOn ? Promise.reject(new Error("boom")) : Promise.resolve({ rows: [{ n: 1 }] });
    };
    const pool: PoolLike = { query: run, connect: () =>
        Promise.resolve({
          query: run,
          release: (e?: Error | boolean) => {
            released.push(e);
          },
        }),
    };
    return { pool, log, released };
  };

  it("tags the pool with application_name from @outlet/observability", () => {
    expect(pgPoolOptions("postgres://x", "catalog.read", 5)).toMatchObject({ application_name: "catalog.read", max: 5 });
    expect(() => pgPoolOptions("postgres://x", "nope" as "catalog.read", 5)).toThrow();
  });

  it("transactions commit, roll back on throw, and destroy a broken connection", async () => {
    const ok = fakePool();
    const c = pgSqlClient(ok.pool);
    expect((await c.query("SELECT 1", [1])).rows).toEqual([{ n: 1 }]);
    expect(await c.transaction(async (tx) => (await tx.query("SELECT 2")).rows.length)).toBe(1);
    expect(ok.log).toEqual(["SELECT 1", "BEGIN", "SELECT 2", "COMMIT"]);
    await expect(c.transaction(() => Promise.reject(new Error("app")))).rejects.toThrow("app");
    expect(ok.log.slice(-1)).toEqual(["ROLLBACK"]);
    const broken = fakePool("ROLLBACK");
    await expect(pgSqlClient(broken.pool).transaction(() => Promise.reject(new Error("app")))).rejects.toThrow("app");
    expect(broken.released).toEqual([true]);
  });

  it("runInRequestContext binds the request's context, and refuses without one", async () => {
    const p = fakePool();
    const c = pgSqlClient<"outlet_app">(p.pool);
    const req = { ctx: { db: { kind: "user", marketId: "EG" } } } as unknown as ApiRequest;
    await runInRequestContext(c, req, (tx) => tx.query("SELECT 3"));
    expect(p.log[1]).toContain("set_config");
    expect(() => runInRequestContext(c, { ctx: {} } as unknown as ApiRequest, () => Promise.resolve(1))).toThrow(ProblemError);
  });
});

describe("pagination schema", () => {
  it("CursorQuery defaults limit to 20 and coerces query strings", () => {
    expect(CursorQuery.parse({})).toEqual({ limit: 20 });
    expect(CursorQuery.parse({ limit: "50", cursor: "eyJ0IjoiMSJ9" })).toEqual({ limit: 50, cursor: "eyJ0IjoiMSJ9" });
    expect(pageOf(z.strictObject({ i: z.number() })).safeParse({ items: [], next_cursor: null }).success).toBe(true);
  });
});
