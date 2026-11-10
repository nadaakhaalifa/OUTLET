import { HttpException } from "@nestjs/common";
import type { ArgumentsHost } from "@nestjs/common";
import { AuthError } from "@outlet/auth-core";
import { CatalogError } from "@outlet/catalog";
import type { Logger } from "@outlet/logger";
import { describe, expect, it } from "vitest";
import { z, ZodError } from "zod";
import { ProblemFilter } from "../src/platform/problem.filter.js";
import { Problems } from "../src/platform/problem.js";

interface Sent { status?: number; type?: string; body?: string; headers: Record<string, string> }
interface Call { level: string; msg: string; fields: Record<string, unknown> | undefined }

const ProblemBody = z.object({ request_id: z.string().optional(), code: z.string().optional(), retry_after_s: z.number().optional() });
const problemBody = (body: string | undefined): z.infer<typeof ProblemBody> => ProblemBody.parse(JSON.parse(body ?? "{}"));

const logger = (calls: Call[]): Logger => {
  const l: Logger = {
    debug: (msg, fields) => { calls.push({ level: "debug", msg, fields }); },
    info: (msg, fields) => { calls.push({ level: "info", msg, fields }); },
    warn: (msg, fields) => { calls.push({ level: "warn", msg, fields }); },
    error: (msg, fields) => { calls.push({ level: "error", msg, fields }); },
    child: () => l,
  };
  return l;
};

const run = (exception: unknown, opts: { ctx?: { requestId: string; log: Logger }; sent?: boolean } = {}) => {
  const out: Sent = { headers: {} };
  const reply = {
    sent: opts.sent === true,
    header(k: string, v: string) { out.headers[k] = v; return reply; },
    type(t: string) { out.type = t; return reply; },
    status(s: number) { out.status = s; return reply; },
    send(b: string) { out.body = b; return reply; },
  };
  const req = opts.ctx === undefined ? {} : { ctx: opts.ctx };
  const host = { switchToHttp: () => ({ getRequest: () => req, getResponse: () => reply }) } as unknown as ArgumentsHost;
  const rootCalls: Call[] = [];
  new ProblemFilter(logger(rootCalls)).catch(exception, host);
  return { out, rootCalls };
};

describe("ProblemFilter", () => {
  it("unknown errors become a bare 500 problem: no message, no stack, request id from the request context, logged at error with the class only", () => {
    const calls: Call[] = [];
    const secret = new Error("db password is hunter2 for +201001234567");
    const { out, rootCalls } = run(secret, { ctx: { requestId: "req-42", log: logger(calls) } });
    expect(out.status).toBe(500);
    expect(out.type).toBe("application/problem+json; charset=utf-8");
    expect(out.headers["cache-control"]).toBe("no-store");
    expect(JSON.parse(out.body ?? "{}")).toMatchObject({ status: 500, code: "internal-error", request_id: "req-42" });
    expect(out.body).not.toContain("hunter2");
    expect(out.body).not.toContain("201001234567");
    expect(calls).toEqual([{ level: "error", msg: "request failed", fields: { status: 500, code: "internal-error", error: "Error" } }]);
    expect(JSON.stringify(calls)).not.toContain("hunter2");
    expect(rootCalls).toEqual([]);
  });

  it("a thrown non-Error (string, null, object) is still a clean 500; the log records its typeof, not its content", () => {
    for (const [thrown, name] of [["token=abc123", "string"], [null, "object"], [{ password: "p" }, "object"], [42, "number"]] as const) {
      const { out, rootCalls } = run(thrown);
      expect(out.status).toBe(500);
      expect(out.body).not.toContain("abc123");
      expect(out.body).not.toContain("password");
      expect(rootCalls).toEqual([{ level: "error", msg: "request failed", fields: { status: 500, code: "internal-error", error: name } }]);
    }
  });

  it("with no request context the filter falls back to request id 'unknown' and its own logger", () => {
    const { out, rootCalls } = run(new Error("x"));
    expect(problemBody(out.body).request_id).toBe("unknown");
    expect(rootCalls).toHaveLength(1);
  });

  it("client errors are logged at debug (never error) and keep their mapped status, code and headers", () => {
    const calls: Call[] = [];
    const log = logger(calls);
    const cases: [unknown, number, string][] = [
      [Problems.unauthenticated("invalid-token"), 401, "invalid-token"],
      [new CatalogError("not_found", "nf"), 404, "not-found"],
      [new CatalogError("forbidden", "no"), 403, "forbidden"],
      [new CatalogError("conflict", "c"), 409, "version-conflict"],
      [new AuthError("RATE_LIMITED", "slow", { retryAfterSeconds: 7 }), 429, "rate-limited"],
      [new ZodError([]), 400, "validation-failed"],
      [new HttpException("x", 405), 405, "method-not-allowed"],
    ];
    for (const [e, status, code] of cases) {
      const { out } = run(e, { ctx: { requestId: "r1", log } });
      expect([out.status, problemBody(out.body).code]).toEqual([status, code]);
    }
    expect(calls.every((c) => c.level === "debug" && c.msg === "request rejected")).toBe(true);
    expect(calls).toHaveLength(cases.length);
    expect(run(Problems.unauthenticated(), { ctx: { requestId: "r", log } }).out.headers["WWW-Authenticate"]).toBe('Bearer realm="outlex"');
    expect(problemBody(run(new AuthError("RATE_LIMITED", "x", { retryAfterSeconds: 7 }), { ctx: { requestId: "r", log } }).out.body).retry_after_s).toBe(7);
  });

  it("when the response was already sent (stream started) the filter logs but writes nothing more", () => {
    const calls: Call[] = [];
    const { out } = run(new Error("late"), { ctx: { requestId: "r", log: logger(calls) }, sent: true });
    expect(out).toEqual({ headers: {} });
    expect(calls).toHaveLength(1);
  });
});
