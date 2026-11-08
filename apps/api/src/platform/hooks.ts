import { createHash } from "node:crypto";
import { uuidv7 } from "@outlet/ids";
import type { Logger } from "@outlet/logger";
import { listMarkets } from "@outlet/markets-config";
import type { Market } from "@outlet/markets-config";
import type { FastifyInstance } from "fastify";
import { headerValue } from "./http.js";
import type { ApiReply, ApiRequest, RequestState } from "./http.js";
import { ProblemError, Problems, problemBody } from "./problem.js";

const REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;
const MARKET_SEGMENT = /^[a-z]{2}(-[a-z0-9]{2,3})?$/;

/** API responses are JSON only: nothing here may be framed, sniffed, scripted or leak a referrer. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-site",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
});

const markets = (): ReadonlyMap<string, Market> => new Map(listMarkets().map((m) => [m.id, m]));

/**
 * Market binding (ADR draft H7). `/v1/{segment}/...`: a segment shaped like a market id must be a configured market
 * (else 404 unknown-market). `X-Market` must name a configured market and agree with the path (else 400).
 */
export const resolveMarket = (url: string, xMarket: string | undefined, known: ReadonlyMap<string, Market> = markets()): Market | undefined => {
  const seg = /^\/v1\/([^/?#]+)/.exec(url)?.[1];
  let fromPath: Market | undefined;
  if (seg !== undefined && MARKET_SEGMENT.test(seg)) {
    fromPath = known.get(seg);
    if (fromPath === undefined) throw Problems.notFound("unknown-market");
  }
  if (xMarket === undefined) return fromPath;
  const fromHeader = known.get(xMarket.toLowerCase());
  if (fromHeader === undefined) throw Problems.badRequest("unknown-market");
  if (fromPath !== undefined && fromPath.id !== fromHeader.id) throw Problems.badRequest("market-mismatch");
  return fromPath ?? fromHeader;
};

const sendProblem = (reply: ApiReply, p: ProblemError, requestId: string): ApiReply => {
  for (const [k, v] of Object.entries(p.options.headers ?? {})) void reply.header(k, v);
  return reply.code(p.status).header("cache-control", "no-store").type("application/problem+json; charset=utf-8").send(JSON.stringify(problemBody(p, requestId)));
};

export const weakEtag = (payload: string): string => `W/"${createHash("sha256").update(payload).digest("base64url").slice(0, 27)}"`;

/** Registers the request lifecycle hooks on the root Fastify instance (before Nest registers routes). */
export const registerHooks = (fastify: FastifyInstance, log: Logger, now: () => number = Date.now): void => {
  fastify.decorateRequest("ctx", null as unknown as RequestState);

  fastify.addHook("onRequest", (req: ApiRequest, reply: ApiReply, done) => {
    const incoming = headerValue(req, "x-request-id");
    const requestId = incoming !== undefined && REQUEST_ID.test(incoming) ? incoming : uuidv7();
    req.ctx = {
      requestId,
      startedAt: now(),
      market: undefined,
      marketId: undefined,
      log: log.child({ requestId }),
      user: undefined,
      principal: undefined,
      storeId: undefined,
      db: undefined,
      reasonCode: undefined,
    };
    void reply.headers(SECURITY_HEADERS).header("x-request-id", requestId);
    try {
      const market = resolveMarket(req.url, headerValue(req, "x-market"));
      if (market !== undefined) {
        req.ctx.market = market;
        req.ctx.marketId = market.id.toUpperCase();
        req.ctx.log = log.child({ requestId, marketId: req.ctx.marketId });
      }
    } catch (e) {
      sendProblem(reply, e instanceof ProblemError ? e : Problems.internal(), requestId);
      return;
    }
    done();
  });

  // Weak ETag on every successful GET; If-None-Match → 304 with no body.
  fastify.addHook("onSend", (req: ApiRequest, reply: ApiReply, payload: unknown, done) => {
    if (req.method !== "GET" || reply.statusCode !== 200 || typeof payload !== "string") {
      done(null, payload);
      return;
    }
    const tag = weakEtag(payload);
    void reply.header("etag", tag);
    const inm = headerValue(req, "if-none-match");
    if (inm?.split(",").some((t) => t.trim() === tag) === true) {
      void reply.code(304);
      done(null, "");
      return;
    }
    done(null, payload);
  });

  // Access log: route template only (no query string, no ids), status and duration.
  fastify.addHook("onResponse", (req: ApiRequest, reply: ApiReply, done) => {
    const s = (req as Partial<ApiRequest>).ctx;
    s?.log.info("request", { method: req.method, route: req.routeOptions.url ?? "unmatched", status: reply.statusCode, ms: now() - s.startedAt });
    done();
  });
};
