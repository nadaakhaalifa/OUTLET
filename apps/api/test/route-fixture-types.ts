import type { InjectOptions } from "fastify";
import type { TestApp } from "./harness.js";

export interface HappyRequest {
  readonly req: InjectOptions;
  readonly status: number;
  /** Run once before counting (steady state: e.g. readiness caches its one-off checks). */
  readonly warmup?: boolean;
}

/**
 * One entry per production route, keyed `METHOD /openapi/path`. routes.test.ts fails when a route has no entry, so a
 * new endpoint cannot ship without its negative-authorization and query-count cases.
 * Store-tenant happy requests act for `seed.storeA` (the generator swaps tokens and X-Store-Id around it).
 */
export interface RouteFixture {
  happy(t: TestApp): Promise<HappyRequest>;
  /** Public routes with object ids: a request for an id that does not exist (or is not public) → 404. */
  missing?(t: TestApp): InjectOptions;
  /** User-tenant routes with object ids: the same request for another user's object → 404. */
  otherTenant?(t: TestApp): Promise<InjectOptions>;
}
