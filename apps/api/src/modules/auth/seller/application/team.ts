import { MS, parseE164, type AccessClaims } from "@outlet/auth-core";
import { BRAND_ROLES, type Actor, type BrandRole, type Grant } from "@outlet/policy";
import type { Clock } from "../../application/common";
import type {
  SellerAuthEvents,
  SellerActorResolver,
  SellerInviteRepository,
  SellerMembership,
  SellerMembershipRepository,
  SellerMembershipsPort,
  SellerSessionRepository,
  SellerUser,
  SellerUserDirectory,
} from "../domain/ports";

export const INVITE_TTL_MS = 7 * MS.day;

/** Roles a non-owner manager may hand out; only an owner creates owners and managers. */
const MANAGER_MAY_INVITE: readonly BrandRole[] = ["catalog", "warehouse", "finance", "support"];

export const isBrandRole = (value: string): value is BrandRole => (BRAND_ROLES as readonly string[]).includes(value);

export type GrantResult = { readonly kind: "ok"; readonly membership: SellerMembership } | { readonly kind: "seller_not_found" };
export type RevokeResult = { readonly kind: "revoked" } | { readonly kind: "not_found" } | { readonly kind: "last_owner" };
export type InviteResult =
  | { readonly kind: "ok"; readonly inviteId: string; readonly expiresAtMs: number }
  | { readonly kind: "forbidden" }
  | { readonly kind: "invalid_phone" };

export class SellerMembershipService implements SellerMembershipsPort {
  constructor(
    private readonly deps: {
      readonly memberships: SellerMembershipRepository;
      readonly invites: SellerInviteRepository;
      readonly users: SellerUserDirectory;
      readonly events: SellerAuthEvents;
      readonly clock: Clock;
      readonly newId: () => string;
    },
  ) {}

  /** Used by the provisioning step on approval (first owner grant) and by team management. Idempotent. */
  async grantStoreRole(input: { sellerUserId: string; storeId: string; role: BrandRole; grantedBy: string | null }): Promise<GrantResult> {
    const d = this.deps;
    const seller = await d.users.findById(input.sellerUserId);
    if (seller === null || seller.status !== "active") return { kind: "seller_not_found" };
    const nowMs = d.clock.nowMs();
    const membership = await d.memberships.upsert({ id: d.newId(), ...input, nowMs });
    await d.events.publish({ type: "seller.membership_granted", sellerUserId: input.sellerUserId, storeId: input.storeId, role: input.role, occurredAtMs: nowMs });
    return { kind: "ok", membership };
  }

  async revokeStoreRole(input: { sellerUserId: string; storeId: string }): Promise<RevokeResult> {
    const nowMs = this.deps.clock.nowMs();
    const r = await this.deps.memberships.revoke({ ...input, nowMs });
    if (r === "revoked") await this.deps.events.publish({ type: "seller.membership_revoked", ...input, occurredAtMs: nowMs });
    return { kind: r };
  }

  async listMemberships(sellerUserId: string): Promise<readonly SellerMembership[]> {
    return this.deps.memberships.listBySeller(sellerUserId);
  }

  async listStoreMembers(storeId: string): Promise<readonly SellerMembership[]> {
    return this.deps.memberships.listByStore(storeId);
  }

  // ---- Public read port ---------------------------------------------------------------------

  async list(sellerUserId: string): Promise<readonly { readonly storeId: string; readonly role: BrandRole }[]> {
    return (await this.deps.memberships.listBySeller(sellerUserId)).map((m) => ({ storeId: m.storeId, role: m.role }));
  }

  async grantsFor(sellerUserId: string): Promise<readonly Grant[]> {
    return (await this.list(sellerUserId)).map((m) => ({ kind: "brand", storeId: m.storeId, role: m.role }));
  }

  // ---- Staff invitations --------------------------------------------------------------------

  /** An owner (or a manager, for non-managerial roles) invites a person by phone. Accepted after OTP + strong factor. */
  async inviteStaff(input: { inviterSellerUserId: string; storeId: string; phoneE164: string; role: BrandRole }): Promise<InviteResult> {
    const d = this.deps;
    let phone: string;
    try {
      phone = parseE164(input.phoneE164);
    } catch {
      return { kind: "invalid_phone" };
    }
    const mine = (await d.memberships.listBySeller(input.inviterSellerUserId)).find((m) => m.storeId === input.storeId);
    if (mine === undefined) return { kind: "forbidden" };
    const allowed = mine.role === "owner" || (mine.role === "manager" && MANAGER_MAY_INVITE.includes(input.role));
    if (!allowed) return { kind: "forbidden" };
    const nowMs = d.clock.nowMs();
    const invite = await d.invites.upsertOpen({
      id: d.newId(),
      storeId: input.storeId,
      role: input.role,
      phoneE164: phone,
      invitedBy: input.inviterSellerUserId,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + INVITE_TTL_MS,
    });
    return { kind: "ok", inviteId: invite.id, expiresAtMs: invite.expiresAtMs };
  }

  async revokeInvite(input: { inviterSellerUserId: string; storeId: string; phoneE164: string }): Promise<boolean> {
    const mine = (await this.deps.memberships.listBySeller(input.inviterSellerUserId)).find((m) => m.storeId === input.storeId);
    if (mine === undefined || (mine.role !== "owner" && mine.role !== "manager")) return false;
    return this.deps.invites.revoke(input.storeId, input.phoneE164, this.deps.clock.nowMs());
  }

  /** Called once the seller has a strong factor: open, unexpired invites for the verified phone become memberships. */
  async acceptInvites(seller: SellerUser): Promise<number> {
    const d = this.deps;
    const nowMs = d.clock.nowMs();
    let n = 0;
    for (const inv of await d.invites.listOpenByPhone(seller.phoneE164, nowMs)) {
      const inviter = await d.users.findById(inv.invitedBy);
      if (inviter === null || inviter.status !== "active") continue;
      const stillAllowed = (await d.memberships.listBySeller(inv.invitedBy)).some(
        (m) => m.storeId === inv.storeId && (m.role === "owner" || (m.role === "manager" && MANAGER_MAY_INVITE.includes(inv.role))),
      );
      if (!stillAllowed) continue;
      await d.memberships.upsert({ id: d.newId(), sellerUserId: seller.id, storeId: inv.storeId, role: inv.role, grantedBy: inv.invitedBy, nowMs });
      await d.invites.markAccepted(inv.id, nowMs);
      await d.events.publish({ type: "seller.membership_granted", sellerUserId: seller.id, storeId: inv.storeId, role: inv.role, occurredAtMs: nowMs });
      n++;
    }
    return n;
  }
}

/** Scopes a full seller session carries. Roles are enforced per store by the policy rules, not here. */
export const SELLER_SESSION_SCOPE = "seller:session";
export const SELLER_ENROL_RESTRICTED_SCOPE = "seller:enrol_restricted";

export class SellerActorDirectory implements SellerActorResolver {
  constructor(
    private readonly sessions: SellerSessionRepository,
    private readonly users: SellerUserDirectory,
    private readonly memberships: SellerMembershipsPort,
  ) {}

  async resolve(claims: AccessClaims, nowMs: number): Promise<Actor | null> {
    // Revocation is immediate: the session row decides, not the token's remaining lifetime.
    const stored = await this.sessions.find(claims.sid);
    if (stored === null || stored.session.revokedAtMs !== null || stored.session.sellerUserId !== claims.sub) return null;
    const seller = await this.users.findById(claims.sub);
    if (seller === null || seller.status !== "active") return null;
    const s = stored.session;
    if (s.kind === "enrol") {
      if (claims.scope !== "seller:enrol" || (s.expiresAtMs !== null && nowMs >= s.expiresAtMs)) return null;
      return {
        id: seller.id,
        status: "active",
        assurance: "basic",
        grants: [],
        tokenScopes: s.restricted ? ["seller:enrol", SELLER_ENROL_RESTRICTED_SCOPE] : ["seller:enrol"],
      };
    }
    // A full token must not carry the enrol scope, and must prove a strong factor in the claims AND the session.
    if (claims.scope !== undefined || !claims.amr.some((a) => a === "webauthn" || a === "totp") || !seller.strongFactor) return null;
    const grants = await this.memberships.grantsFor(seller.id);
    return {
      id: seller.id,
      status: "active",
      assurance: claims.amr.includes("webauthn") ? "passkey" : "basic",
      grants,
      tokenScopes: grants.length > 0 ? [SELLER_SESSION_SCOPE, "seller:read", "seller:write"] : [SELLER_SESSION_SCOPE],
    };
  }
}

/** Read-only memberships port straight over the repository (used by the actor resolver and other modules). */
export function membershipsPortFor(repo: SellerMembershipRepository): SellerMembershipsPort {
  const list = async (id: string) => (await repo.listBySeller(id)).map((m) => ({ storeId: m.storeId, role: m.role }));
  return {
    list,
    grantsFor: async (id) => (await list(id)).map((m): Grant => ({ kind: "brand", storeId: m.storeId, role: m.role })),
  };
}
