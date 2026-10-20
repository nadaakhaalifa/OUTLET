import { SellerSettingsError } from "./errors";

export const SELLER_TEAM_ROLES = ["owner", "manager", "catalog", "warehouse", "finance", "support"] as const;
export type SellerTeamRole = (typeof SELLER_TEAM_ROLES)[number];

export const INVITE_TTL_MS = 72 * 3_600_000;
export const MAX_PENDING_INVITES = 20;

export const INVITE_STATES = ["PENDING", "ACCEPTED", "DECLINED", "REVOKED", "EXPIRED"] as const;
export type InviteState = (typeof INVITE_STATES)[number];
export type InviteEvent = "accept" | "decline" | "revoke" | "expire";

const TABLE: Readonly<Record<InviteEvent, InviteState>> = {
  accept: "ACCEPTED",
  decline: "DECLINED",
  revoke: "REVOKED",
  expire: "EXPIRED",
};

/** Only PENDING moves; every other state is terminal (single use). */
export function inviteTransition(state: InviteState, event: InviteEvent): InviteState {
  if (state !== "PENDING") throw new SellerSettingsError("invite_not_pending");
  return TABLE[event];
}

export function isInviteExpired(expiresAtMs: number, nowMs: number): boolean {
  return nowMs >= expiresAtMs;
}

/** "+201012345678" becomes "+20*******78": country prefix and the last two digits only. */
export function maskPhone(e164: string): string {
  if (e164.length < 8) return "***";
  return `${e164.slice(0, 3)}${"*".repeat(e164.length - 5)}${e164.slice(-2)}`;
}

export interface TeamMemberFacts {
  readonly userId: string;
  readonly role: SellerTeamRole;
}

/**
 * Owner-only role changes; the last owner can be neither demoted nor removed. `newRole` null removes.
 */
export function assertCanChangeMember(input: {
  readonly actorRole: SellerTeamRole;
  readonly members: readonly TeamMemberFacts[];
  readonly targetUserId: string;
  readonly newRole: SellerTeamRole | null;
}): void {
  if (input.actorRole !== "owner") throw new SellerSettingsError("owner_only");
  const target = input.members.find((m) => m.userId === input.targetUserId);
  if (target === undefined) throw new SellerSettingsError("member_not_found");
  if (target.role === "owner" && input.newRole !== "owner") {
    const owners = input.members.filter((m) => m.role === "owner").length;
    if (owners <= 1) throw new SellerSettingsError("last_owner");
  }
}
