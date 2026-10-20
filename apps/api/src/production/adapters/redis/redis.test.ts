import { drops } from "@outlet/domain";
import fc from "fast-check";
import RedisMock from "ioredis-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { FlagClient } from "../../../../../../packages/feature-flags/src/index";
import { loadConfig } from "../../../config/env";
import { QueueUnavailableError } from "../../../modules/waiting-room";
import { RateLimitGuard } from "../../../platform/rate-limit.guard";
import { ProblemError } from "../../../platform/problem";
import {
  LIMITER_FAILURE_POLICY,
  RedisCache,
  RedisConnection,
  RedisFlagProvider,
  RedisFlagWriter,
  RedisRateLimiter,
  RedisSingleUseTokens,
  RedisSoldOutFlags,
  RedisUnavailableError,
  RedisWaitingQueue,
  createRedisAdaptersFromConnection,
  keyHash,
  parseRedisEnv,
  tokenBucketReference,
  type BucketState,
  type RedisClient,
} from "./index";

const mock = (): RedisClient => new RedisMock() as unknown as RedisClient;
const newConn = (c: RedisClient = mock(), now: () => number = Date.now): RedisConnection => new RedisConnection(c, "t:v1", now);
beforeEach(async () => {
  await (new RedisMock() as unknown as { flushall(): Promise<unknown> }).flushall();
});

/** A client whose every command rejects, like a refused connection. */
function deadClient(): RedisClient {
  const boom = (): Promise<never> => Promise.reject(new Error("ECONNREFUSED"));
  const base = mock();
  return new Proxy(base, {
    get(t, p, r) {
      if (p === "defineCommand" || p === "status" || p === "on" || p === "disconnect") return Reflect.get(t, p, r) as unknown;
      return typeof p === "string" ? boom : undefined;
    },
  });
}

describe("rate limiter", () => {
  it("matches the TS reference exactly (property)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 8 }),
        fc.integer({ min: 20_000, max: 60_000 }), // real-time key TTL must outlast the test
        fc.array(fc.integer({ min: 0, max: 30_000 }), { minLength: 1, maxLength: 25 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        async (limit, windowMs, gaps, id) => {
          const lim = new RedisRateLimiter(newConn());
          const key = `k${id}-${Math.random()}`;
          let state: BucketState | null = null;
          let now = 1_700_000_000_000;
          for (const g of gaps) {
            now += g;
            const want = tokenBucketReference(state, now, { limit, windowMs });
            const got = await lim.consume(key, { limit, windowMs }, now);
            expect(got).toEqual(want.outcome);
            state = want.state;
          }
        },
      ),
      { numRuns: 40 },
    );
  });

  it("allows exactly `limit` immediately, then denies, then refills", async () => {
    const lim = new RedisRateLimiter(newConn());
    const rule = { limit: 5, windowMs: 10_000 };
    const t0 = 1_700_000_000_000;
    const results = [];
    for (let i = 0; i < 8; i++) results.push((await lim.consume("a", rule, t0)).allowed);
    expect(results.filter(Boolean)).toHaveLength(5);
    const denied = await lim.consume("a", rule, t0);
    expect(denied.resetAtMs).toBe(t0 + 2000); // one token per window/limit ms
    expect((await lim.consume("a", rule, t0 + 2000)).allowed).toBe(true);
    expect((await lim.consume("b", rule, t0)).allowed).toBe(true); // keys are independent
  });

  it("is atomic under concurrency: 100 parallel calls admit exactly the limit", async () => {
    const lim = new RedisRateLimiter(newConn());
    const outs = await Promise.all(Array.from({ length: 100 }, () => lim.consume("burst", { limit: 30, windowMs: 60_000 }, 1_700_000_000_000)));
    expect(outs.filter((o) => o.allowed)).toHaveLength(30);
  });

  it("rejects invalid rules and never puts raw ids in keys", async () => {
    const conn = newConn();
    const lim = new RedisRateLimiter(conn);
    await expect(lim.consume("k", { limit: 0, windowMs: 1000 }, 1)).rejects.toBeInstanceOf(RangeError);
    await lim.consume("rl:v1:abc", { limit: 1, windowMs: 1000 }, 1);
    expect(conn.key("rl", "rl:v1:abc")).toBe("t:v1:rl:rl:v1:abc");
    expect(keyHash("u", "user-1")).toHaveLength(32);
  });

  it("failure policy table: OTP, checkout, drops and gift cards fail closed; reads fail open", () => {
    expect(LIMITER_FAILURE_POLICY).toEqual({ auth_otp: "closed", checkout: "closed", drops: "closed", gift_card_redemption: "closed", read: "open" });
  });

  it("Redis down: limiter throws; the guard returns 503 on a closed route and allows an open route", async () => {
    const conn = newConn(deadClient());
    const lim = new RedisRateLimiter(conn);
    await expect(lim.consume("k", { limit: 1, windowMs: 1000 }, 1)).rejects.toBeInstanceOf(RedisUnavailableError);
    const ctx = {
      getHandler: () => null,
      getClass: () => null,
      switchToHttp: () => ({
        getRequest: () => ({ method: "POST", route: { path: "/x" }, ip: "1.2.3.4", headers: {}, body: {} }),
        getResponse: () => ({ setHeader: () => undefined }),
      }),
    };
    const guard = (onLimiterError: "open" | "closed"): RateLimitGuard =>
      new RateLimitGuard(
        { getAllAndOverride: () => ({ rules: [{ dimension: "ip", limit: 1, windowSeconds: 1 }], onLimiterError }) } as never,
        lim,
        {} as never,
        { nowMs: () => 1 } as never,
      );
    await expect(guard("closed").canActivate(ctx as never)).rejects.toBeInstanceOf(ProblemError);
    await expect(guard("open").canActivate(ctx as never)).resolves.toBe(true);
  });
});

describe("circuit breaker and connection", () => {
  it("opens after 3 failures and fails instantly, then probes again", async () => {
    let t = 1000;
    const conn = newConn(deadClient(), () => t);
    const run = (): Promise<unknown> => conn.exec("x", (c) => c.get("a"));
    for (let i = 0; i < 3; i++) await expect(run()).rejects.toMatchObject({ reason: "command" });
    await expect(run()).rejects.toMatchObject({ reason: "breaker_open" });
    expect(conn.stats.get("redis.breaker_rejected")).toBe(1);
    t += 1001;
    await expect(run()).rejects.toMatchObject({ reason: "command" }); // half-open probe
    expect(await conn.ping()).toBe(false);
  });

  it("real ioredis against a closed port: connection refused maps to unavailable, fast", async () => {
    const conn = RedisConnection.fromConfig({ url: "redis://127.0.0.1:1", tls: false, keyPrefix: "t", commandTimeoutMs: 200, connectTimeoutMs: 300 });
    const q = new RedisWaitingQueue(conn);
    const t0 = Date.now();
    await expect(q.join("d1", "t1", "u1", "dev1", 1)).rejects.toBeInstanceOf(QueueUnavailableError);
    await expect(new RedisRateLimiter(conn).consume("k", { limit: 1, windowMs: 1000 }, 1)).rejects.toBeInstanceOf(RedisUnavailableError);
    expect(await new RedisSoldOutFlags(conn).isSoldOut("d1")).toBe(false);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect((await createRedisAdaptersFromConnection(conn).describe()).redis).toBe("configured_unreachable");
    await conn.close();
  });

  it("describe reports reachable on a live client; env parsing", async () => {
    expect((await createRedisAdaptersFromConnection(newConn()).describe()).redis).toBe("configured_reachable");
    expect(parseRedisEnv({}).config).toBeUndefined();
    expect(parseRedisEnv({ REDIS_URL: "rediss://h:6379" }).config).toMatchObject({ tls: true, keyPrefix: "outlet:v1" });
    expect(parseRedisEnv({ REDIS_URL: "http://h" }).issues).toHaveLength(1);
    const cfg = loadConfig({ REDIS_URL: "redis://h:6379" });
    expect(cfg.redis?.url).toBe("redis://h:6379");
    expect(loadConfig({}).redis).toBeUndefined();
  });
});

const T0 = 1_700_000_000_000;
describe("waiting room queue", () => {
  const mk = (hb = 30_000): RedisWaitingQueue => new RedisWaitingQueue(newConn(), { heartbeatTtlMs: hb });

  it("join, existing, device_busy, position, admit FIFO, finish", async () => {
    const q = mk();
    const a = await q.join("d1", "ta", "ua", "dva", T0);
    expect(a).toMatchObject({ kind: "joined", ticket: { id: "ta", seq: 0, state: "waiting", admittedAtMs: null } });
    expect(await q.join("d1", "tb", "ub", "dvb", T0 + 1)).toMatchObject({ kind: "joined", ticket: { seq: 1 } });
    expect(await q.join("d1", "tx", "ua", "dvz", T0 + 2)).toMatchObject({ kind: "existing", ticket: { id: "ta" } });
    expect(await q.join("d1", "tc", "uc", "dva", T0 + 3)).toEqual({ kind: "device_busy" });
    expect(await q.position("d1", "ub")).toBe(2);
    expect(await q.size("d1")).toBe(2);
    expect((await q.peek("d1", 5)).map((t) => t.id)).toEqual(["ta", "tb"]);
    expect((await q.admit("d1", 1, T0 + 10)).map((t) => t.id)).toEqual(["ta"]);
    expect(await q.admit("d1", 1, T0 + 11)).toHaveLength(1);
    expect(await q.admit("d1", 5, T0 + 12)).toHaveLength(0);
    expect(await q.join("d1", "td", "ua", "dvq", T0 + 13)).toMatchObject({ kind: "existing", ticket: { state: "admitted" } });
    await q.finish("d1", "ta");
    expect(await q.join("d1", "te", "ua", "dva", T0 + 14)).toMatchObject({ kind: "joined" });
    const hb = await q.heartbeat("d1", "ua", T0 + 15);
    expect(hb?.position).toBe(1);
    expect(await q.heartbeat("d1", "nobody", T0)).toBeNull();
  });

  it("keys hold hashed ids only (no raw user or device ids in key names)", async () => {
    const client = mock();
    const q = new RedisWaitingQueue(new RedisConnection(client, "t:v1", Date.now));
    await q.join("d1", "t1", "user-secret-123", "device-secret-456", T0);
    const keys = await (client as unknown as { keys(p: string): Promise<string[]> }).keys("*");
    expect(keys.length).toBeGreaterThan(3);
    expect(keys.join(" ")).not.toMatch(/user-secret|device-secret/);
  });

  it("reject and heartbeat expiry release the slot; expire reports abandoned once", async () => {
    const q = mk(1000);
    await q.join("d1", "t1", "u1", "v1", T0);
    await q.join("d1", "t2", "u2", "v2", T0);
    expect((await q.reject("d1", "t2", T0 + 1))?.state).toBe("rejected");
    expect(await q.reject("d1", "t2", T0 + 1)).toBeNull();
    expect((await q.expire("d1", T0 + 5000)).map((t) => t.id)).toEqual(["t1"]);
    expect(await q.expire("d1", T0 + 5001)).toHaveLength(0);
    expect(await q.size("d1")).toBe(0);
  });

  it("queue matches the pure FifoWaitingQueue under random operation sequences (property)", async () => {
    const op = fc.record({
      k: fc.constantFrom("join", "join", "join", "heartbeat", "admit", "expire", "reject", "finish", "peek"),
      u: fc.integer({ min: 0, max: 5 }),
      v: fc.integer({ min: 0, max: 5 }),
      dt: fc.integer({ min: 0, max: 700 }),
      n: fc.integer({ min: 0, max: 3 }),
      t: fc.integer({ min: 0, max: 30 }),
    });
    let run = 0;
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 60 }), async (ops) => {
        run += 1;
        const drop = `p${run}`;
        const q = mk(1000);
        const model = new drops.FifoWaitingQueue(1000);
        let now = T0;
        let seqNo = 0;
        const view = (t: drops.Ticket | null | undefined): unknown => (t === null || t === undefined ? null : { id: t.id, st: t.state, seq: t.seq, u: t.userId, l: t.lastSeenMs, a: t.admittedAtMs });
        for (const o of ops) {
          now += o.dt;
          const user = `u${o.u}`;
          const dev = `v${o.v}`;
          const tid = `T${o.t}`;
          switch (o.k) {
            case "join": {
              const id = `n${seqNo++}`;
              const want = model.join(id, user, dev, now);
              const got = await q.join(drop, id, user, dev, now);
              expect(got.kind).toBe(want.kind);
              if (want.kind !== "device_busy" && got.kind !== "device_busy") expect(view(got.ticket)).toEqual(view(want.ticket));
              break;
            }
            case "heartbeat": {
              const t = model.heartbeat(user, now);
              const got = await q.heartbeat(drop, user, now);
              expect(view(got?.ticket)).toEqual(view(t));
              expect(got?.position ?? null).toBe(t === null ? null : model.position(t.id));
              break;
            }
            case "admit": {
              model.expire(now); // see ADR-0033: Redis reports expiry-during-admit on the next expire()
              const wantExp = model.expire(now);
              void wantExp;
              await q.expire(drop, now);
              const want = model.admit(o.n, now).map((t) => t.id);
              const got = (await q.admit(drop, o.n, now)).map((t) => t.id);
              expect(got).toEqual(want);
              break;
            }
            case "expire": {
              const want = model.expire(now).map((t) => t.id).sort();
              const got = (await q.expire(drop, now)).map((t) => t.id).sort();
              expect(got).toEqual(want);
              break;
            }
            case "reject": {
              const want = view(model.reject(tid, now));
              const got = view(await q.reject(drop, tid, now));
              expect(got).toEqual(want);
              break;
            }
            case "finish":
              model.finish(tid);
              await q.finish(drop, tid);
              break;
            case "peek":
              expect((await q.peek(drop, o.n + 1)).map((t) => t.id)).toEqual(model.waitingTickets(o.n + 1).map((t) => t.id));
              break;
          }
          expect(await q.size(drop)).toBe(model.waitingCount);
        }
      }),
      { numRuns: 60 },
    );
  });

  // The 5,000-user case is a load test: it is skipped unless RUN_LOAD_TESTS=1 (the `load` job).
  // The unit run keeps a small deterministic version of the same invariants (N=300, admit 50).
  const fullLoad = process.env["RUN_LOAD_TESTS"] === "1";
  const sizes = [{ label: "unit", N: 300, batch: 5, run: true }, { label: "load", N: 5000, batch: 50, run: fullLoad }];
  for (const { label, N, batch, run } of sizes) {
    it.skipIf(!run)(`${label}: ${N} users, admit ${batch * 10} in concurrent batches: strict FIFO, zero duplicates`, async () => {
      const q = mk(10 * 60_000);
      const take = batch * 10;
      for (let i = 0; i < N; i++) await q.join("big", `t${i}`, `u${i}`, `v${i}`, T0 + i);
      expect(await q.size("big")).toBe(N);
      const batches = await Promise.all(Array.from({ length: 10 }, () => q.admit("big", batch, T0 + N)));
      const admitted = batches.flat();
      const seqs = admitted.map((t) => t.seq);
      const ids = admitted.map((t) => t.id);
      expect(admitted).toHaveLength(take);
      expect(new Set(ids).size).toBe(take); // zero duplicates
      expect([...seqs].sort((a, b) => a - b)).toEqual(Array.from({ length: take }, (_, i) => i)); // exactly the first `take`
      expect(drops.fifoDeviation(seqs)).toBeLessThanOrEqual(0.01);
      expect(await q.size("big")).toBe(N - take);
      expect(await q.position("big", `u${take}`)).toBe(1);
      expect(await q.position("big", `u${N - 1}`)).toBe(N - take);
      expect(await q.admit("big", take, T0 + N + 1)).toHaveLength(take);
      expect(await q.admit("big", 10_000, T0 + N + 2)).toHaveLength(N - 2 * take);
    }, 60_000);
  }
});

describe("single-use tokens, sold-out hint, cache, flags", () => {
  it("token marker: first wins within TTL", async () => {
    const t = new RedisSingleUseTokens(newConn());
    expect(await t.consumeOnce("jti-1", 5000)).toBe("used");
    expect(await t.consumeOnce("jti-1", 5000)).toBe("already_used");
    expect(await t.consumeOnce("jti-2", 5000)).toBe("used");
    await expect(new RedisSingleUseTokens(newConn(deadClient())).consumeOnce("j", 1000)).rejects.toBeInstanceOf(RedisUnavailableError);
  });

  it("sold-out hint set/clear/expire and degrades to false when Redis is down", async () => {
    const s = new RedisSoldOutFlags(newConn());
    expect(await s.isSoldOut("d")).toBe(false);
    await s.mark("d", 60_000);
    expect(await s.isSoldOut("d")).toBe(true);
    await s.clear("d");
    expect(await s.isSoldOut("d")).toBe(false);
    const dead = new RedisSoldOutFlags(newConn(deadClient()));
    await dead.mark("d", 1000);
    expect(await dead.isSoldOut("d")).toBe(false);
  });

  const schema = z.object({ n: z.number() });
  it("cache: single-flight, versioned keys, invalid entry is a miss, Redis down still loads", async () => {
    const conn = newConn();
    const cache = new RedisCache(conn, async () => undefined);
    let calls = 0;
    const loader = async (): Promise<{ n: number }> => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 10));
      return { n: calls };
    };
    const o = { version: 1, ttlMs: 60_000, schema };
    const results = await Promise.all(Array.from({ length: 50 }, () => cache.getOrLoad("ns", "k", o, loader)));
    expect(calls).toBe(1);
    expect(new Set(results.map((r) => r.n))).toEqual(new Set([1]));
    expect(await cache.getOrLoad("ns", "k", o, loader)).toEqual({ n: 1 }); // hit
    expect(await cache.getOrLoad("ns", "k", { ...o, version: 2 }, loader)).toEqual({ n: 2 }); // new version, new key
    await cache.invalidate("ns", "k", 1);
    expect(await cache.getOrLoad("ns", "k", o, loader)).toEqual({ n: 3 });
    expect(conn.stats.get("cache.hit")).toBeGreaterThanOrEqual(1);
    const bad = newConn();
    const c2 = new RedisCache(bad, async () => undefined);
    await bad.exec("seed", (c) => c.set(bad.key("c", "v1", "ns", keyHash("ns", "z")), '{"n":"x"}'));
    expect(await c2.getOrLoad("ns", "z", o, async () => ({ n: 9 }))).toEqual({ n: 9 });
    const down = new RedisCache(newConn(deadClient()), async () => undefined);
    expect(await down.getOrLoad("ns", "k", o, async () => ({ n: 7 }))).toEqual({ n: 7 });
  });

  it("flag provider: allowed when true, registry default when absent, false default when Redis is down", async () => {
    const conn = newConn();
    let t = 0;
    const provider = new RedisFlagProvider(conn, 1000, () => t);
    const client = new FlagClient({ provider });
    expect(await client.isEnabled("kill.games")).toBe(false); // absent: registry default
    await new RedisFlagWriter(conn).set("kill.games", true);
    expect(await client.isEnabled("kill.games")).toBe(false); // still inside local TTL
    t = 1500;
    expect(await client.isEnabled("kill.games")).toBe(true);
    await expect(new RedisFlagWriter(conn).set("nope.flag", true)).rejects.toBeInstanceOf(RangeError);
    // Redis goes away: after the TTL the cached "true" is NOT trusted
    const downConn = newConn(deadClient());
    const down = new FlagClient({ provider: new RedisFlagProvider(downConn, 1000, () => t) });
    expect(await down.isEnabled("kill.games")).toBe(false);
    expect(await down.evaluate("kill.games")).toMatchObject({ source: "default_provider_error" });
    const bad = newConn();
    await bad.exec("seed", (c) => c.hset(bad.key("flags"), "kill.games", "maybe"));
    expect(await new FlagClient({ provider: new RedisFlagProvider(bad) }).isEnabled("kill.games")).toBe(false);
  });
});
