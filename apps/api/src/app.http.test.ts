import { Body, Controller, Get, HttpCode, Post } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { Idempotent, Public, RateLimit, ZodPipe, type RateLimiter, RATE_LIMITER, AuthenticatedSelf } from "./platform";
import { createHarness, IDEM_KEY_1, IDEM_KEY_2, type Harness } from "./test/harness";
import { ReadinessRegistry } from "./platform";

let counter = 0;
let failuresLeft = 0;

@Controller("test")
class ProbeController {
  /** No authorization declaration on purpose: must be denied by default. */
  @Get("undeclared")
  undeclared() {
    return { leaked: true };
  }

  @Get("public")
  @Public()
  pub() {
    return { ok: true };
  }

  @Post("echo")
  @Public()
  @HttpCode(200)
  echo(@Body(new ZodPipe(z.object({ n: z.number().int(), nested: z.object({ s: z.string() }) }).strict())) b: { n: number }) {
    return b;
  }

  @Post("boom")
  @Public()
  boom(): never {
    throw new Error("secret internal detail: db password=hunter2");
  }

  @Post("counted")
  @Public()
  @HttpCode(201)
  @Idempotent({ required: true })
  counted() {
    counter += 1;
    return { count: counter };
  }

  @Post("flaky")
  @Public()
  @HttpCode(201)
  @Idempotent({ required: true })
  flaky() {
    if (failuresLeft > 0) {
      failuresLeft -= 1;
      throw new Error("transient");
    }
    counter += 1;
    return { count: counter };
  }

  @Get("limited")
  @Public()
  @RateLimit([{ dimension: "ip", limit: 2, windowSeconds: 60 }])
  limited() {
    return { ok: true };
  }

  @Get("limited-closed")
  @Public()
  @RateLimit([{ dimension: "ip", limit: 5, windowSeconds: 60 }], "closed")
  closed() {
    return { ok: true };
  }

  @Get("limited-open")
  @Public()
  @RateLimit([{ dimension: "ip", limit: 5, windowSeconds: 60 }], "open")
  open() {
    return { ok: true };
  }

  @Get("me")
  @AuthenticatedSelf()
  me() {
    return { ok: true };
  }
}

describe("HTTP platform", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness({ controllers: [ProbeController] });
  });
  afterAll(async () => h.close());

  it("serves liveness and readiness under /v1 with request id and trace headers", async () => {
    const r = await h.http().get("/v1/health").set("traceparent", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: "ok" });
    expect(r.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.headers["traceparent"]).toMatch(/^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01$/);
    expect(r.headers["traceparent"]).not.toContain("00f067aa0ba902b7-01");
    expect(r.headers["x-powered-by"]).toBeUndefined();
    expect(r.headers["cache-control"]).toBe("no-store");
    expect((await h.http().get("/health")).status).toBe(404);
  });

  it("echoes a safe client request id and replaces an unsafe one", async () => {
    expect((await h.http().get("/v1/health").set("X-Request-Id", "client-req-12345")).headers["x-request-id"]).toBe("client-req-12345");
    const bad = await h.http().get("/v1/health").set("X-Request-Id", "a b");
    expect(bad.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("readiness reports 503 when a check fails and never leaks details", async () => {
    expect((await h.http().get("/v1/ready")).status).toBe(200);
    h.app.get(ReadinessRegistry).register({ name: "db", check: async () => false });
    const r = await h.http().get("/v1/ready");
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ status: "not_ready", checks: { db: "fail" } });
  });

  it("returns problem+json for unknown routes, with the request id", async () => {
    const r = await h.http().get("/v1/nope");
    expect(r.status).toBe(404);
    expect(r.headers["content-type"]).toMatch(/^application\/problem\+json/);
    expect(r.body).toMatchObject({ type: "/problems/not-found", status: 404, code: "not_found" });
    expect(r.body.request_id).toBe(r.headers["x-request-id"]);
  });

  it("denies a route with no authorization declaration (deny by default)", async () => {
    const r = await h.http().get("/v1/test/undeclared");
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ code: "no_policy_declared" });
    expect(JSON.stringify(r.body)).not.toContain("leaked");
  });

  it("validates bodies with JSON pointers and never echoes values", async () => {
    const r = await h.http().post("/v1/test/echo").send({ n: 1.5, nested: { s: 42 }, extra: "TOPSECRET" });
    expect(r.status).toBe(400);
    expect(r.body.type).toBe("/problems/validation-failed");
    const pointers = (r.body.errors as { pointer: string }[]).map((e) => e.pointer).sort();
    expect(pointers).toEqual(["/body", "/body/n", "/body/nested/s"].sort());
    expect(JSON.stringify(r.body)).not.toContain("TOPSECRET");
  });

  it("maps malformed JSON to a 400 problem, not an HTML error", async () => {
    const r = await h.http().post("/v1/test/echo").set("Content-Type", "application/json").send("{not json");
    expect(r.status).toBe(400);
    expect(r.headers["content-type"]).toMatch(/problem\+json/);
    expect(r.body).toMatchObject({ type: "/problems/bad-request", status: 400, code: "bad_request" });
  });

  it("hides internals of unexpected errors behind a generic 500", async () => {
    const r = await h.http().post("/v1/test/boom");
    expect(r.status).toBe(500);
    expect(r.body).toMatchObject({ type: "/problems/internal-error", status: 500 });
    expect(JSON.stringify(r.body)).not.toContain("hunter2");
    expect(JSON.stringify(r.body)).not.toContain("stack");
  });

  describe("idempotency", () => {
    it("requires the key on required routes", async () => {
      const r = await h.http().post("/v1/test/counted");
      expect(r.status).toBe(400);
      expect(r.body.type).toBe("/problems/invalid-idempotency-key");
      expect((await h.http().post("/v1/test/counted").set("Idempotency-Key", "not-a-uuid")).status).toBe(400);
      // A UUIDv4 is not a UUIDv7.
      expect(
        (await h.http().post("/v1/test/counted").set("Idempotency-Key", "550e8400-e29b-41d4-a716-446655440000")).status,
      ).toBe(400);
    });

    it("replays the stored response without re-running the handler", async () => {
      const before = counter;
      const a = await h.http().post("/v1/test/counted").set("Idempotency-Key", IDEM_KEY_1).send({});
      const b = await h.http().post("/v1/test/counted").set("Idempotency-Key", IDEM_KEY_1).send({});
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      expect(b.body).toEqual(a.body);
      expect(counter).toBe(before + 1);
      expect(a.headers["idempotent-replayed"]).toBeUndefined();
      expect(b.headers["idempotent-replayed"]).toBe("true");
    });

    it("rejects the same key with a different request (422) and runs a new key fresh", async () => {
      const first = await h.http().post("/v1/test/counted").set("Idempotency-Key", IDEM_KEY_2).send({ a: 1 });
      expect(first.status).toBe(201);
      const reuse = await h.http().post("/v1/test/counted").set("Idempotency-Key", IDEM_KEY_2).send({ a: 2 });
      expect(reuse.status).toBe(422);
      expect(reuse.body.type).toBe("/problems/idempotency-key-reuse");
    });

    it("releases the key when the handler throws so a retry runs", async () => {
      failuresLeft = 1;
      const key = "0192f3a4-5b6c-7d8e-9f01-23456789abc3";
      const before = counter;
      const a = await h.http().post("/v1/test/flaky").set("Idempotency-Key", key).send({});
      expect(a.status).toBe(500);
      const b = await h.http().post("/v1/test/flaky").set("Idempotency-Key", key).send({});
      expect(b.status).toBe(201);
      expect(counter).toBe(before + 1);
    });

    it("concurrent same-key requests never double-run the handler", async () => {
      const key = "0192f3a4-5b6c-7d8e-9f01-23456789abc4";
      const before = counter;
      const rs = await Promise.all(
        Array.from({ length: 5 }, () => h.http().post("/v1/test/counted").set("Idempotency-Key", key).send({})),
      );
      expect(counter).toBe(before + 1);
      for (const r of rs) expect([201, 409]).toContain(r.status);
      expect(rs.some((r) => r.status === 201)).toBe(true);
    });
  });

  describe("rate limiting", () => {
    it("returns 429 with Retry-After and RateLimit headers once the window is spent, then recovers", async () => {
      const ok1 = await h.http().get("/v1/test/limited");
      expect(ok1.status).toBe(200);
      expect(ok1.headers["ratelimit-limit"]).toBe("2");
      expect(ok1.headers["ratelimit-remaining"]).toBe("1");
      expect((await h.http().get("/v1/test/limited")).status).toBe(200);
      const blocked = await h.http().get("/v1/test/limited");
      expect(blocked.status).toBe(429);
      expect(blocked.body).toMatchObject({ type: "/problems/rate-limited", code: "rate_limited" });
      expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
      h.clock.advance(61_000);
      expect((await h.http().get("/v1/test/limited")).status).toBe(200);
    });

    it("fails closed or open when the limiter itself is down, as declared per route", async () => {
      const limiter = h.app.get<RateLimiter>(RATE_LIMITER, { strict: false });
      const original = limiter.consume.bind(limiter);
      limiter.consume = async () => {
        throw new Error("redis down");
      };
      try {
        const closed = await h.http().get("/v1/test/limited-closed");
        expect(closed.status).toBe(503);
        expect(closed.body.code).toBe("rate_limiter_unavailable");
        expect((await h.http().get("/v1/test/limited-open")).status).toBe(200);
      } finally {
        limiter.consume = original;
      }
    });
  });

  describe("authentication edge cases", () => {
    it("401 with WWW-Authenticate for missing, malformed and unknown bearer tokens", async () => {
      const none = await h.http().get("/v1/test/me");
      expect(none.status).toBe(401);
      expect(none.headers["www-authenticate"]).toBe("Bearer");
      for (const header of ["Basic abc", "Bearer", "Bearer short", `Bearer ${"x".repeat(40)}`, "bearer dev_" + "a".repeat(64)]) {
        const r = await h.http().get("/v1/test/me").set("Authorization", header);
        expect(r.status, header).toBe(401);
        expect(r.body.type).toBe("/problems/unauthenticated");
      }
    });
  });
});
