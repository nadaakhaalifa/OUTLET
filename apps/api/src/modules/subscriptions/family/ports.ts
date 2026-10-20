import type {
  FamilyGroup,
  FamilyInvite,
  FamilyMember,
  PlusPlan,
  PlusSubscription,
  StudentVerification,
} from "../domain/bridge";

/** Events written to the outbox in the same transaction as the state change. No PII, ids and enums only. */
export type FamilyEvent =
  | { readonly type: "family.created"; readonly groupId: string; readonly ownerUserId: string; readonly subscriptionId: string; readonly seatLimit: number }
  | { readonly type: "family.member_invited"; readonly groupId: string; readonly memberId: string }
  | { readonly type: "family.invite_revoked"; readonly groupId: string; readonly memberId: string }
  | { readonly type: "family.member_added"; readonly groupId: string; readonly memberId: string; readonly userId: string }
  | {
      readonly type: "family.member_removed";
      readonly groupId: string;
      readonly memberId: string;
      readonly userId: string;
      readonly by: "owner" | "self" | "system";
      readonly seatEndAtMs: number;
    }
  | { readonly type: "family.ending_notified"; readonly groupId: string }
  | { readonly type: "family.ended"; readonly groupId: string; readonly reason: "subscription_ended" | "plan_changed" | "owner_deleted" }
  | { readonly type: "student.verification_started"; readonly userId: string; readonly verificationId: string }
  | { readonly type: "student.verified"; readonly userId: string; readonly verificationId: string; readonly validUntilMs: number }
  | { readonly type: "student.rejected"; readonly userId: string; readonly verificationId: string }
  | { readonly type: "student.expired"; readonly userId: string; readonly verificationId: string };

export interface GroupContext {
  readonly group: FamilyGroup;
  /** Members after expired invites and elapsed seats were settled inside the lock. */
  readonly members: readonly FamilyMember[];
  readonly invites: readonly FamilyInvite[];
}

/** What a locked mutation wants written. Everything lands in one transaction with the outbox events. */
export interface GroupMutation<R> {
  readonly result: R;
  readonly members?: readonly FamilyMember[];
  readonly invites?: readonly FamilyInvite[];
  readonly group?: FamilyGroup;
  readonly events: readonly FamilyEvent[];
}

export type MutateOutcome<R> =
  | { readonly kind: "applied"; readonly result: R }
  | { readonly kind: "not_found" }
  /** A unique index refused the write (a racing accept, a user already in a family). */
  | { readonly kind: "conflict" };

export interface Membership {
  readonly group: FamilyGroup;
  readonly member: FamilyMember;
}

export interface InviteLookup {
  readonly invite: FamilyInvite;
  readonly member: FamilyMember;
  readonly group: FamilyGroup;
}

export interface FamilyStore {
  getGroupByOwner(ownerUserId: string): Promise<FamilyGroup | null>;
  getGroup(id: string): Promise<FamilyGroup | null>;
  /** The seat a user holds (ACTIVE, or REMOVED and not yet ended) in a family that is still ACTIVE. */
  membershipOf(userId: string): Promise<Membership | null>;
  listMembers(groupId: string): Promise<readonly FamilyMember[]>;
  listInvites(groupId: string): Promise<readonly FamilyInvite[]>;
  findInviteByTokenHash(tokenHash: string): Promise<InviteLookup | null>;
  /** Creates the group and the owner seat, once per subscription. */
  createGroup(group: FamilyGroup, owner: FamilyMember, events: readonly FamilyEvent[]): Promise<"ok" | "exists">;
  /**
   * Runs `fn` while holding the group's row lock, after settling expired invites and elapsed seats.
   * `fn` is synchronous and pure: all I/O happens before. Seat counting under concurrency lives here.
   */
  mutateGroup<R>(groupId: string, nowMs: number, fn: (ctx: GroupContext) => GroupMutation<R>): Promise<MutateOutcome<R>>;
  /** ACTIVE groups with an id greater than `afterId`, ascending, for the sweeper. */
  listActiveGroups(afterId: string | null, limit: number): Promise<readonly FamilyGroup[]>;
}

export interface StudentStore {
  getById(id: string): Promise<StudentVerification | null>;
  /** The newest verification of any status. */
  latestForUser(userId: string): Promise<StudentVerification | null>;
  /** The newest one that was ever VERIFIED (VERIFIED or EXPIRED). */
  latestVerifiedForUser(userId: string): Promise<StudentVerification | null>;
  getByRef(verifier: string, ref: string): Promise<StudentVerification | null>;
  /** Insert (expectedVersion null) or update guarded by version. Events share the transaction. */
  save(v: StudentVerification, expectedVersion: number | null, events: readonly FamilyEvent[]): Promise<"ok" | "conflict" | "exists">;
  listNoticeDue(nowMs: number, limit: number): Promise<readonly StudentVerification[]>;
  listLapsed(nowMs: number, limit: number): Promise<readonly StudentVerification[]>;
}

// ---- ports owned by other modules ------------------------------------------------------------

/** Users module. The hash is the same blind index `PersonKeyPort.phoneHash` returns for that phone. */
export interface FamilyIdentityPort {
  hashPhone(phoneE164: string): string;
  userIdByPhoneHash(phoneHash: string): Promise<string | null>;
  /** True only when the account's phone was verified by OTP. */
  phoneVerified(userId: string): Promise<boolean>;
}

export interface InviteDelivery {
  /** Transient: never stored. */
  readonly phoneE164: string;
  readonly token: string;
  readonly expiresAtMs: number;
}

/** SMS or WhatsApp invite link. The link carries the single use token; failure releases the seat. */
export interface FamilyInviteDeliveryPort {
  deliver(i: InviteDelivery): Promise<{ readonly kind: "sent" } | { readonly kind: "failed"; readonly reason: string }>;
}

/** 128 bit CSPRNG token, URL safe. Injected so tests are deterministic. */
export interface InviteTokenPort {
  newToken(): string;
}

export type StudentStartMethod = "university_email" | "verifier_session";

export type StudentStartResult =
  | { readonly kind: "started"; readonly ref: string; readonly clientAction: { readonly type: "redirect"; readonly url: string } }
  | { readonly kind: "domain_not_allowed" }
  | { readonly kind: "unavailable" };

export type StudentCallback =
  | { readonly kind: "verified"; readonly ref: string; readonly validUntilMs: number | null }
  | { readonly kind: "rejected"; readonly ref: string };

/**
 * Third party student verification (VR-P3-09). The adapter holds the vendor secret and the
 * university allow-list. Unconfigured in production: every call is `unavailable` or `rejected`
 * (fail closed), so no student price is ever granted without a real verifier.
 */
export interface StudentVerifierPort {
  readonly name: string;
  start(i: { readonly userId: string; readonly method: StudentStartMethod; readonly universityEmail: string | null }): Promise<StudentStartResult>;
  /** Verifies MAC and timestamp (replay window +/- 5 min) of the callback and normalises it. */
  verifyCallback(i: {
    readonly rawBody: Uint8Array;
    readonly headers: Readonly<Record<string, string | undefined>>;
  }): Promise<{ readonly kind: "ok"; readonly callback: StudentCallback } | { readonly kind: "rejected" }>;
}

/** Read side used by the renewal sweeper and the subscribe gate. */
export interface StudentEligibilityPort {
  /** Is a verified, unexpired student status in force at `atMs`? */
  validAt(userId: string, atMs: number): Promise<boolean>;
  /** Which price a student plan renews at: student only while verified, or while a lapse was not yet noticed 30 days ahead. */
  renewalPrice(userId: string, atMs: number): Promise<"student" | "individual">;
}

export interface PlanKinds {
  /** Plan lookup used by seat entitlement to know whether the owner's plan continues as family. */
  planByCode(code: string, atMs: number): Promise<PlusPlan | null>;
  subscription(id: string): Promise<PlusSubscription | null>;
}
