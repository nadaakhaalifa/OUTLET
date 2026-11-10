import { Controller, Get, HttpCode, Inject, Post } from "@nestjs/common";
import type { StoreMemberView } from "@outlet/seller-accounts";
import { z } from "zod";
import { Authorize, Contract, Paginated, RateLimit } from "../../platform/decorators.js";
import { API_DEPS } from "../../platform/deps.js";
import type { ApiDeps } from "../../platform/deps.js";
import type { RequestState } from "../../platform/http.js";
import { Problems } from "../../platform/problem.js";
import { RATE_BUDGETS } from "../../platform/rate-limit/budgets.js";
import { activeStore } from "../../platform/resolvers.js";
import { Body, Ctx, Query } from "../../platform/validation.js";
import { MembersQuery, StoreInvite, StoreInviteInput, StoreMember, StoreMemberPage } from "./dto.js";

const wire = (m: StoreMemberView): StoreMember => ({ id: m.id, user_id: m.userId, display_name: null, role_code: m.role, status: m.status, joined_at: null });

/**
 * Team of one store (store tenant, owner only: policy team.manage). Membership rows are the source of truth in the database; the service
 * re-checks the caller's role and enrolled strong authentication against them, so a stale token cannot manage the team.
 */
@Controller("v1/:market/seller/store")
export class SellerTeamController {
  constructor(@Inject(API_DEPS) private readonly deps: ApiDeps) {}

  private tenant(s: RequestState): { readonly principal: NonNullable<RequestState["principal"]>; readonly storeId: string; readonly svc: ReturnType<ApiDeps["sellerOnboarding"]> } {
    if (s.principal === undefined || s.storeId === undefined || s.marketId === undefined) throw Problems.internal("tenant-context-missing");
    return { principal: s.principal, storeId: s.storeId, svc: this.deps.sellerOnboarding(s.marketId) };
  }

  @Get("members")
  @Paginated()
  @Authorize("team.manage", activeStore, { tenant: "store" })
  @RateLimit({ budget: RATE_BUDGETS.sellerRead })
  @Contract({ operationId: "listStoreMembers", summary: "Members and open invites of my store", tags: ["Seller Team"], query: MembersQuery, response: StoreMemberPage, maxQueries: 3 })
  async list(@Ctx() s: RequestState, @Query() q: z.infer<typeof MembersQuery>): Promise<StoreMemberPage> {
    const t = this.tenant(s);
    const all = await t.svc.membership.listMembers(t.principal, t.storeId);
    const from = q.cursor === undefined ? 0 : all.findIndex((m) => m.id === Buffer.from(q.cursor ?? "", "base64url").toString("utf8")) + 1;
    const slice = all.slice(from, from + q.limit);
    const last = slice[slice.length - 1];
    return { items: slice.map(wire), next_cursor: from + q.limit < all.length && last !== undefined ? Buffer.from(last.id, "utf8").toString("base64url") : null };
  }

  @Post("invites")
  @HttpCode(201)
  @Authorize("team.manage", activeStore, { tenant: "store" })
  @RateLimit({ budget: RATE_BUDGETS.sellerWrite })
  @Contract({ operationId: "inviteStoreMember", summary: "Invite a person by phone or email (the invitee proves the contact when accepting)", tags: ["Seller Team"], body: StoreInviteInput, response: StoreInvite, status: 201, maxQueries: 10 })
  async invite(@Ctx() s: RequestState, @Body() b: z.infer<typeof StoreInviteInput>): Promise<StoreInvite> {
    const t = this.tenant(s);
    const contact = b.contact.startsWith("+") ? ({ kind: "phone", value: b.contact } as const) : ({ kind: "email", value: b.contact } as const);
    const m = await t.svc.membership.invite(t.principal, t.storeId, { contact, role: b.role_code });
    const expires = await t.svc.lookup.inviteExpiry(t.storeId, m.id);
    if (expires === null) throw Problems.internal("invite-expiry-missing");
    return { id: m.id, role_code: m.role, expires_at: expires.toISOString() };
  }
}
