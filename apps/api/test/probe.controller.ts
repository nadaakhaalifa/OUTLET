import { Controller, Get, HttpCode, Post } from "@nestjs/common";
import { CatalogError } from "@outlet/catalog";
import { z } from "zod";
import { Authorize, Contract, Deprecated, KillSwitch, NoIdempotency, Paginated, Public, RateLimit, ReasonCode } from "../src/platform/decorators.js";
import type { RequestState } from "../src/platform/http.js";
import { CursorQuery, pageOf } from "../src/platform/pagination.js";
import type { RateBudget } from "../src/platform/rate-limit/budgets.js";
import { RATE_BUDGETS } from "../src/platform/rate-limit/budgets.js";
import { activeStore, self } from "../src/platform/resolvers.js";
import { Body, Ctx, Query } from "../src/platform/validation.js";

/** Tiny budgets so tests can exhaust them. */
export const TINY: RateBudget = { name: "probe_tiny", limit: 2, periodMs: 60_000, keys: ["user"], failMode: "closed", source: "default" };
export const TINY_OPEN: RateBudget = { name: "probe_tiny_open", limit: 2, periodMs: 60_000, keys: ["device", "ip"], failMode: "open", source: "default" };

/** Authenticated route keyed on user + device (device stays mandatory) and a fail-closed public route keyed on device only. */
export const USER_DEVICE: RateBudget = { name: "probe_user_device", limit: 50, periodMs: 60_000, keys: ["user", "device"], failMode: "closed", source: "default" };
export const DEVICE_CLOSED: RateBudget = { name: "probe_device_closed", limit: 50, periodMs: 60_000, keys: ["device"], failMode: "closed", source: "default" };

const Me = z.strictObject({ user_id: z.string(), db: z.string(), market_id: z.string() });
const N = z.strictObject({ n: z.number().int() });
const Calls = z.strictObject({ n: z.number().int(), calls: z.number().int() });
const Boom = z.strictObject({ kind: z.string() });
const Any = z.strictObject({ ok: z.boolean() });
const Store = z.strictObject({ store_id: z.string(), db: z.string(), roles: z.array(z.string()) });
const Echo = z.strictObject({ text: z.string().max(5_000_000) });
const Item = z.strictObject({ i: z.number().int() });

export const probeState = { calls: 0, slowMs: 0 };

/** Test-only routes exercising each guard and interceptor. Mounted with createTestApp({ extraControllers }). */
@Controller("v1/:market/probe")
export class ProbeController {
  @Get("me")
  @Authorize("cart.read", self)
  @RateLimit({ budget: TINY })
  @Contract({ operationId: "probeMe", summary: "me", response: Me, maxQueries: 0 })
  me(@Ctx() s: RequestState): z.infer<typeof Me> {
    return { user_id: s.user?.userId ?? "", db: s.db?.kind ?? "none", market_id: s.marketId ?? "" };
  }

  @Post("cart")
  @HttpCode(201)
  @Authorize("cart.write", self)
  @RateLimit({ budget: RATE_BUDGETS.shopperWrite })
  @Contract({ operationId: "probeCart", summary: "idempotent write", body: N, response: Calls, maxQueries: 2 })
  cart(@Body() b: z.infer<typeof N>): z.infer<typeof Calls> {
    probeState.calls += 1;
    if (b.n < 0) throw new CatalogError("conflict", "negative");
    return { n: b.n, calls: probeState.calls };
  }

  @Post("public-write")
  @Public()
  @RateLimit({ budget: RATE_BUDGETS.publicRead })
  @Contract({ operationId: "probePublicWrite", summary: "anonymous idempotent write", body: N, response: Calls, maxQueries: 2 })
  publicWrite(@Body() b: z.infer<typeof N>): z.infer<typeof Calls> {
    probeState.calls += 1;
    return { n: b.n, calls: probeState.calls };
  }

  @Post("quote")
  @HttpCode(200)
  @Public()
  @NoIdempotency("pure quote, no side effects")
  @RateLimit({ budget: RATE_BUDGETS.publicRead })
  @Contract({ operationId: "probeQuote", summary: "pure", body: N, response: N, maxQueries: 0 })
  quote(@Body() b: z.infer<typeof N>): z.infer<typeof N> {
    return b;
  }

  @Post("echo")
  @HttpCode(200)
  @Public()
  @NoIdempotency("echo")
  @RateLimit({ budget: RATE_BUDGETS.publicRead })
  @Contract({ operationId: "probeEcho", summary: "echo", body: Echo, response: z.strictObject({ length: z.number() }), maxQueries: 0 })
  echo(@Body() b: z.infer<typeof Echo>): { length: number } {
    return { length: b.text.length };
  }

  @Get("export")
  @Authorize("privacy.export", self)
  @ReasonCode()
  @RateLimit({ budget: RATE_BUDGETS.shopperRead })
  @Contract({ operationId: "probeExport", summary: "reason code", response: z.strictObject({ reason: z.string() }), maxQueries: 0 })
  export(@Ctx() s: RequestState): { reason: string } {
    return { reason: s.reasonCode ?? "" };
  }

  @Get("killable")
  @Public()
  @KillSwitch("drops.enabled")
  @RateLimit({ budget: TINY_OPEN })
  @Contract({ operationId: "probeKillable", summary: "kill switch", response: Any, cacheControl: "public, max-age=5", maxQueries: 0 })
  killable(): z.infer<typeof Any> {
    return { ok: true };
  }

  @Get("device-auth")
  @Authorize("cart.read", self)
  @RateLimit({ budget: USER_DEVICE })
  @Contract({ operationId: "probeDeviceAuth", summary: "authenticated device key", response: Any, maxQueries: 0 })
  deviceAuth(): z.infer<typeof Any> {
    return { ok: true };
  }

  @Get("device-closed")
  @Public()
  @RateLimit({ budget: DEVICE_CLOSED })
  @Contract({ operationId: "probeDeviceClosed", summary: "fail-closed public device key", response: Any, cacheControl: "no-store", maxQueries: 0 })
  deviceClosed(): z.infer<typeof Any> {
    return { ok: true };
  }

  @Get("asn")
  @Public()
  @RateLimit({ budget: TINY_OPEN, keys: ["device", "asn"] })
  @Contract({ operationId: "probeAsn", summary: "asn key", response: Any, cacheControl: "no-store", maxQueries: 0 })
  asn(): z.infer<typeof Any> {
    return { ok: true };
  }

  @Get("slow")
  @Public()
  @RateLimit({ budget: RATE_BUDGETS.publicRead })
  @Contract({ operationId: "probeSlow", summary: "slow", response: Any, cacheControl: "no-store", maxQueries: 0 })
  async slow(): Promise<z.infer<typeof Any>> {
    await new Promise((r) => setTimeout(r, probeState.slowMs));
    return { ok: true };
  }

  @Get("boom")
  @Public()
  @RateLimit({ budget: RATE_BUDGETS.publicRead })
  @Contract({ operationId: "probeBoom", summary: "errors", query: Boom, response: Any, cacheControl: "no-store", maxQueries: 0 })
  boom(@Query() q: z.infer<typeof Boom>): z.infer<typeof Any> {
    if (q.kind === "zod") z.strictObject({ x: z.string() }).parse({ x: 1 });
    if (q.kind === "bad-response") return { ok: "yes" } as unknown as z.infer<typeof Any>;
    if (q.kind.startsWith("catalog-")) throw new CatalogError(q.kind.slice(8) as "not_found", "secret detail 01001234567", ["DETAIL_CODE"]);
    throw new Error("secret internal message +201001234567");
  }

  @Get("old")
  @Public()
  @Deprecated({ deprecatedAt: new Date("2030-01-01T00:00:00Z"), sunset: new Date("2030-09-01T00:00:00Z"), link: "https://docs.outlex.invalid/migrate" })
  @RateLimit({ budget: RATE_BUDGETS.publicRead })
  @Contract({ operationId: "probeOld", summary: "deprecated", response: Any, cacheControl: "public, max-age=60", maxQueries: 0 })
  old(): z.infer<typeof Any> {
    return { ok: true };
  }

  @Get("store")
  @Authorize("listing.read", activeStore, { tenant: "store" })
  @RateLimit({ budget: RATE_BUDGETS.sellerRead })
  @Contract({ operationId: "probeStore", summary: "store tenant", response: Store, maxQueries: 0 })
  store(@Ctx() s: RequestState): z.infer<typeof Store> {
    return { store_id: s.storeId ?? "", db: s.db?.kind ?? "none", roles: [...(s.principal?.roles ?? [])] };
  }

  /** Store-tenant object route: the object "belongs" to the store whose id equals item_id (anything else is 404). */
  @Get("store-items/:item_id")
  @Authorize("listing.read", (c) => (c.req.params !== undefined && (c.req.params as { item_id?: string }).item_id === c.storeId && c.storeId !== undefined ? { type: "listing", id: c.storeId, storeId: c.storeId, marketId: c.marketId } : null), { tenant: "store" })
  @RateLimit({ budget: RATE_BUDGETS.sellerRead })
  @Contract({ operationId: "probeStoreItem", summary: "store tenant object", params: z.strictObject({ item_id: z.uuid() }), response: Any, maxQueries: 0 })
  storeItem(): z.infer<typeof Any> {
    return { ok: true };
  }

  @Get("list")
  @Public()
  @Paginated()
  @RateLimit({ budget: RATE_BUDGETS.publicRead })
  @Contract({ operationId: "probeList", summary: "pagination", query: CursorQuery, response: pageOf(Item), cacheControl: "no-store", maxQueries: 0 })
  list(@Query() q: CursorQuery): z.infer<ReturnType<typeof pageOf<typeof Item>>> {
    return { items: Array.from({ length: q.limit }, (_, i) => ({ i })), next_cursor: q.cursor ?? null };
  }
}
