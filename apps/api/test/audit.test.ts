import { Controller, Delete, Get, Post, Put } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createApp } from "../src/app.js";
import { Authorize, Contract, Deprecated, KillSwitch, NoIdempotency, NoRateLimit, Paginated, Public, RateLimit, ReasonCode } from "../src/platform/decorators.js";
import { CursorQuery, pageOf } from "../src/platform/pagination.js";
import { RATE_BUDGETS } from "../src/platform/rate-limit/budgets.js";
import type { RateBudget } from "../src/platform/rate-limit/budgets.js";
import { activeStore, self } from "../src/platform/resolvers.js";
import { RouteAuditError, assertRoutes, assertServedMatchesAudited, auditRoutes, collectRoutes, servedRouteKey } from "../src/platform/route-registry.js";

const R = z.strictObject({ ok: z.boolean() });
const c = (operationId: string, extra: Record<string, unknown> = {}): Parameters<typeof Contract>[0] => ({ operationId, summary: operationId, response: R, maxQueries: 0, ...extra });
const ZERO: RateBudget = { name: "zero", limit: 0, periodMs: 1000, keys: ["user"], failMode: "open", source: "default" };

@Controller("v1/:market/bad")
class BadController {
  @Get("a")
  nothing(): string {
    return "unreachable";
  }

  @Get("b")
  @Public()
  @Authorize("cart.read", self)
  @RateLimit({ budget: RATE_BUDGETS.publicRead })
  @Contract(c("b", { cacheControl: "public" }))
  bothDecorators(): string {
    return "unreachable";
  }

  @Get("list")
  @Public()
  @RateLimit({ budget: RATE_BUDGETS.publicRead })
  @Contract(c("list", { response: z.array(R), cacheControl: "no-store" }))
  unpaginatedList(): string {
    return "unreachable";
  }

  @Get("paged")
  @Public()
  @Paginated()
  @RateLimit({ budget: RATE_BUDGETS.publicRead })
  @Contract(c("paged", { response: R, cacheControl: "no-store" }))
  badPaged(): string {
    return "unreachable";
  }

  @Get("export")
  @Authorize("privacy.export", self)
  @RateLimit({ budget: RATE_BUDGETS.shopperRead, keys: ["ip"] })
  @Contract(c("export", { cacheControl: "public" }))
  missingReason(): string {
    return "unreachable";
  }

  @Get("reason")
  @Public()
  @ReasonCode()
  @NoRateLimit("probe")
  @Contract(c("reason", { cacheControl: "no-store", maxQueries: -1 }))
  pointlessReason(): string {
    return "unreachable";
  }

  @Post("write")
  @Authorize("cart.write", self)
  @RateLimit({ budget: RATE_BUDGETS.sellerWrite })
  @NoIdempotency(" ")
  @Contract(c("write"))
  writeNoBody(): string {
    return "unreachable";
  }

  @Put("put/:id")
  @Authorize("listing.write", activeStore)
  @NoRateLimit("")
  @NoIdempotency("pure")
  @Contract(c("put", { body: R }))
  putPure(): string {
    return "unreachable";
  }

  @Get("get-body")
  @Authorize("payout.approve", self)
  @RateLimit({ budget: ZERO, keys: [] })
  @NoIdempotency("x")
  @KillSwitch("not.a.switch" as "drops.enabled")
  @Deprecated({ deprecatedAt: new Date("2030-01-01"), sunset: new Date("2030-02-01") })
  @Contract(c("get-body", { body: R }))
  getWithBody(): string {
    return "unreachable";
  }

  @Delete("del")
  @Public()
  @RateLimit({ budget: RATE_BUDGETS.publicRead, keys: ["user", "store", "nope" as "user"] })
  @Contract(c("b"))
  del(): string {
    return "unreachable";
  }

  @Get("list2")
  @Public()
  @Paginated()
  @RateLimit({ budget: RATE_BUDGETS.publicRead })
  @Contract(c("list2", { response: pageOf(R), query: CursorQuery }))
  missingCache(): string {
    return "unreachable";
  }
}

@Controller("health")
class UnversionedController {
  @Post("x")
  @Authorize("listing.read", activeStore, { tenant: "store" })
  @RateLimit({ budget: RATE_BUDGETS.sellerRead })
  @Contract(c("x", { body: R }))
  x(): string {
    return "unreachable";
  }

  @Get("x")
  @Authorize("cart.read", activeStore, { tenant: "store" })
  @RateLimit({ budget: RATE_BUDGETS.sellerRead })
  @Contract(c("x2"))
  y(): string {
    return "unreachable";
  }
}

describe("route audit (BUILD-PROMPT §2 route rules)", () => {
  const v = auditRoutes(collectRoutes([BadController, UnversionedController]));
  const has = (route: string, msg: string): void => {
    expect(v.some((x) => x.includes(route) && x.includes(msg)), `${route}: ${msg}\n${v.join("\n")}`).toBe(true);
  };

  it.each([
    ["nothing", "missing @Contract"],
    ["nothing", "missing @Public() or @Authorize()"],
    ["nothing", "missing @RateLimit()"],
    ["unpaginatedList", "must be @Paginated"],
    ["badPaged", "paginated response must be { items, next_cursor }"],
    ["badPaged", "paginated query must include cursor and limit"],
    ["missingReason", "requires @ReasonCode()"],
    ["missingReason", "always private, no-store"],
    ["missingReason", "never rate-limit on IP/ASN alone"],
    ["pointlessReason", "@ReasonCode() only on REQUIRES_REASON_CODE actions"],
    ["pointlessReason", "maxQueries must be a non-negative integer"],
    ["writeNoBody", "mutating routes declare a body schema"],
    ["writeNoBody", "@NoIdempotency only on pure POSTs, with a reason"],
    ["putPure", "params schema keys"],
    ["putPure", "@NoRateLimit needs a reason"],
    ["putPure", "@NoRateLimit only on public GET probes"],
    ["putPure", "@NoIdempotency only on pure POSTs"],
    ["getWithBody", "GET routes take no body"],
    ["getWithBody", "not grantable to shoppers or seller staff"],
    ["getWithBody", "rate limit needs at least one key"],
    ["getWithBody", "budget limit and period must be positive"],
    ["getWithBody", "@NoIdempotency on a non-mutating route"],
    ["getWithBody", "unknown kill switch"],
    ["getWithBody", "Sunset must be at least 6 months"],
    ["del", "duplicate operationId"],
    ["del", "unknown rate-limit key"],
    ["del", "store key only on store-tenant routes"],
    ["del", "user key only on authenticated routes"],
    ["missingCache", "public GET routes declare cacheControl"],
    ["UnversionedController.x", "every route is versioned under /v1/"],
    ["UnversionedController.x", "authenticated routes live under /v1/:market/"],
    ["UnversionedController.y", "is not a seller action"],
  ])("%s: %s", (route, msg) => {
    has(route, msg);
  });

  it("assertRoutes throws RouteAuditError listing every violation; createApp refuses to start", async () => {
    expect(() => {
      assertRoutes(collectRoutes([BadController]));
    }).toThrow(RouteAuditError);
    await expect(createApp({} as never, { extraControllers: [BadController] })).rejects.toThrow(/route audit failed/);
  });

  it("detects duplicate routes", () => {
    const routes = collectRoutes([UnversionedController]);
    const first = routes[0];
    if (first === undefined) throw new Error("no routes");
    expect(auditRoutes([first, first]).some((x) => x.includes("duplicate route"))).toBe(true);
  });
});

/** A base class with an undeclared handler: Nest serves it on every subclass, so the audit must see it there. */
class BaseWithHandler {
  @Get("inherited")
  inherited(): string {
    return "x";
  }
}

@Controller("v1/:market/child")
class ChildInheriting extends BaseWithHandler {}

class DeclaredBase {
  @Get("inherited")
  @Public()
  @RateLimit({ budget: RATE_BUDGETS.publicRead })
  @Contract(c("inheritedDeclared", { cacheControl: "no-store" }))
  inherited(): { ok: boolean } {
    return { ok: true };
  }
}

@Controller("v1/:market/declared-child")
class DeclaredChild extends DeclaredBase {}

describe("inherited handlers and served-vs-audited routes", () => {
  it("collects an inherited route under the subclass and startup refuses it unless declared", async () => {
    const routes = collectRoutes([ChildInheriting]);
    expect(routes.map((r) => `${r.controller}.${r.handler}`)).toEqual(["ChildInheriting.inherited"]);
    expect(auditRoutes(routes).some((x) => x.includes("missing @Public() or @Authorize()"))).toBe(true);
    await expect(createApp({} as never, { extraControllers: [ChildInheriting] })).rejects.toThrow(/route audit failed/);
  });

  it("an inherited route that is fully declared passes the audit", () => {
    const routes = collectRoutes([DeclaredChild]);
    expect(routes.map((r) => r.openapiPath)).toEqual(["/v1/{market}/declared-child/inherited"]);
    expect(auditRoutes(routes).filter((x) => !x.includes("/v1/"))).toEqual([]);
  });

  it("refuses a served route nobody audited, and an audited route nobody serves", () => {
    const routes = collectRoutes([DeclaredChild]);
    const key = servedRouteKey("GET", "/v1/:market/declared-child/inherited");
    expect(key).toBe("GET /v1/{market}/declared-child/inherited");
    expect(() => {
      assertServedMatchesAudited([key], routes);
    }).not.toThrow();
    expect(() => {
      assertServedMatchesAudited([key, "GET /v1/{market}/shadow"], routes);
    }).toThrow(/GET \/v1\/\{market\}\/shadow: served but not audited/);
    expect(() => {
      assertServedMatchesAudited([], routes);
    }).toThrow(/audited but not served/);
  });
});
