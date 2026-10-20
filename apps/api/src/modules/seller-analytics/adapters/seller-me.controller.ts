import { Controller, Get, Inject, Param, Req } from "@nestjs/common";
import { evaluateSellerPermissions, type Actor, type ResourceState, type Rule } from "@outlet/policy";
import { Authorize, RateLimit } from "../../../platform/decorators";
import type { ApiRequest } from "../../../platform/http-types";
import type { Clock } from "../../../platform/ports";
import { Problems } from "../../../platform/problem";
import { CLOCK, POLICY_RULES } from "../../../platform/tokens";
import type { StoreStatus, StoreStatusLookup } from "../domain/store-status";
import { SELLER_ANALYTICS_STORE_STATUS, SELLER_ME_RESOLVER, SELLER_STORE_ME_RESOLVER } from "./tokens";

const STATE: Readonly<Record<StoreStatus, ResourceState>> = {
  DRAFT: "draft",
  ACTIVE: "active",
  PAUSED: "paused",
  SUSPENDED: "suspended",
};
const WIRE: Readonly<Record<StoreStatus, "draft" | "active" | "paused" | "suspended">> = {
  DRAFT: "draft",
  ACTIVE: "active",
  PAUSED: "paused",
  SUSPENDED: "suspended",
};

/** Role-aware navigation: the caller's own store memberships, read from the token's grants. */
@Controller("seller")
export class SellerMeController {
  constructor(
    @Inject(SELLER_ANALYTICS_STORE_STATUS) private readonly statuses: StoreStatusLookup,
    @Inject(POLICY_RULES) private readonly rules: readonly Rule[],
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private membership(actor: Actor, storeId: string, role: string, status: StoreStatus) {
    return {
      store_id: storeId,
      role,
      store_status: WIRE[status],
      // The policy engine decides, with the real store state; nothing is granted here.
      permissions: evaluateSellerPermissions({ actor, storeId, state: STATE[status], nowMs: this.clock.nowMs(), rules: this.rules }),
    };
  }

  private async load(ids: readonly string[]): Promise<ReadonlyMap<string, StoreStatus>> {
    try {
      return await this.statuses.statusesOf(ids);
    } catch {
      throw Problems.unavailable("store_status_unavailable");
    }
  }

  @Get("me")
  @Authorize({ audience: "seller_api", action: "read", resourceType: "store_product", resolver: SELLER_ME_RESOLVER, idParam: "none" })
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async me(@Req() req: ApiRequest) {
    const p = req.principal;
    if (p === null || p === undefined) throw Problems.unauthenticated();
    const held = p.actor.grants.flatMap((g) => (g.kind === "brand" ? [{ storeId: g.storeId, role: g.role }] : []));
    held.sort((a, b) => (a.storeId < b.storeId ? -1 : a.storeId > b.storeId ? 1 : 0));
    const ids = [...new Set(held.map((h) => h.storeId))].slice(0, 30);
    const status = await this.load(ids);
    const memberships = held.flatMap((h) => {
      const s = status.get(h.storeId);
      // A grant on a store without a row is not shown: never a partial or guessed membership.
      return s === undefined ? [] : [this.membership(p.actor, h.storeId, h.role, s)];
    });
    return { user_id: p.actor.id, memberships, server_time: new Date(this.clock.nowMs()).toISOString() };
  }

  /**
   * M8: the guard has already authorised from the token (a foreign, unknown or malformed id is a
   * 404 before this body runs and without a database read). Only a held grant reaches the lookup.
   */
  @Get("stores/:storeId/me")
  @Authorize({ audience: "seller_api", action: "read", resourceType: "store_product", resolver: SELLER_STORE_ME_RESOLVER, idParam: "storeId" })
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async storeMe(@Req() req: ApiRequest, @Param("storeId") storeId: string) {
    const p = req.principal;
    if (p === null || p === undefined) throw Problems.unauthenticated();
    const id = storeId.toLowerCase();
    const grant = p.actor.grants.find((g) => g.kind === "brand" && g.storeId.toLowerCase() === id);
    if (grant === undefined || grant.kind !== "brand") throw Problems.notFound();
    const s = (await this.load([grant.storeId])).get(grant.storeId);
    if (s === undefined) throw Problems.notFound();
    return {
      user_id: p.actor.id,
      membership: this.membership(p.actor, grant.storeId, grant.role, s),
      server_time: new Date(this.clock.nowMs()).toISOString(),
    };
  }
}
