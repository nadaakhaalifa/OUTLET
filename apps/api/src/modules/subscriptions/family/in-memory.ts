import { createHmac, randomBytes } from "node:crypto";
import {
  settleMember,
  type FamilyGroup,
  type FamilyInvite,
  type FamilyMember,
  type StudentVerification,
} from "../domain/bridge";
import type {
  FamilyEvent,
  FamilyIdentityPort,
  FamilyInviteDeliveryPort,
  FamilyStore,
  GroupContext,
  GroupMutation,
  InviteDelivery,
  InviteLookup,
  InviteTokenPort,
  Membership,
  MutateOutcome,
  StudentCallback,
  StudentStartMethod,
  StudentStartResult,
  StudentStore,
  StudentVerifierPort,
} from "./ports";

const holdsUserSeat = (m: FamilyMember): boolean => m.userId !== null && (m.status === "ACTIVE" || m.status === "REMOVED");
const holdsGroupSeat = (m: FamilyMember): boolean => m.status === "INVITED" || m.status === "ACTIVE" || m.status === "REMOVED";

/** Same guarantees as the Postgres adapter: unique seats, one family per user, atomic apply, outbox events. */
export class InMemoryFamilyStore implements FamilyStore {
  readonly groups = new Map<string, FamilyGroup>();
  readonly members = new Map<string, FamilyMember>();
  readonly invites = new Map<string, FamilyInvite>();
  readonly events: FamilyEvent[] = [];

  async getGroupByOwner(ownerUserId: string): Promise<FamilyGroup | null> {
    return [...this.groups.values()].find((g) => g.ownerUserId === ownerUserId && g.status === "ACTIVE") ?? null;
  }

  async getGroup(id: string): Promise<FamilyGroup | null> {
    return this.groups.get(id) ?? null;
  }

  async membershipOf(userId: string): Promise<Membership | null> {
    for (const m of this.members.values()) {
      if (m.userId !== userId || !holdsUserSeat(m)) continue;
      const group = this.groups.get(m.groupId);
      if (group !== undefined && group.status === "ACTIVE") return { group, member: m };
    }
    return null;
  }

  async listMembers(groupId: string): Promise<readonly FamilyMember[]> {
    return [...this.members.values()].filter((m) => m.groupId === groupId).sort((a, b) => a.seatNo - b.seatNo || a.invitedAtMs - b.invitedAtMs);
  }

  async listInvites(groupId: string): Promise<readonly FamilyInvite[]> {
    return [...this.invites.values()].filter((i) => i.groupId === groupId);
  }

  async findInviteByTokenHash(tokenHash: string): Promise<InviteLookup | null> {
    const invite = [...this.invites.values()].find((i) => i.tokenHash === tokenHash);
    if (invite === undefined) return null;
    const member = this.members.get(invite.memberId);
    const group = this.groups.get(invite.groupId);
    return member === undefined || group === undefined ? null : { invite, member, group };
  }

  async createGroup(group: FamilyGroup, owner: FamilyMember, events: readonly FamilyEvent[]): Promise<"ok" | "exists"> {
    const dup =
      [...this.groups.values()].some((g) => g.subscriptionId === group.subscriptionId) ||
      [...this.groups.values()].some((g) => g.ownerUserId === group.ownerUserId && g.status === "ACTIVE") ||
      [...this.members.values()].some((m) => m.userId === owner.userId && holdsUserSeat(m));
    if (dup) return "exists";
    this.groups.set(group.id, group);
    this.members.set(owner.id, owner);
    this.events.push(...events);
    return "ok";
  }

  async mutateGroup<R>(groupId: string, nowMs: number, fn: (ctx: GroupContext) => GroupMutation<R>): Promise<MutateOutcome<R>> {
    const group = this.groups.get(groupId);
    if (group === undefined) return { kind: "not_found" };
    for (const m of [...this.members.values()].filter((x) => x.groupId === groupId)) {
      const s = settleMember(m, nowMs);
      if (s !== m) this.members.set(s.id, s);
    }
    const members = [...this.members.values()].filter((m) => m.groupId === groupId);
    const invites = [...this.invites.values()].filter((i) => i.groupId === groupId);
    const out = fn({ group, members, invites });
    const nextMembers = new Map(this.members);
    for (const m of out.members ?? []) nextMembers.set(m.id, m);
    const all = [...nextMembers.values()];
    const seats = new Set<string>();
    const users = new Set<string>();
    for (const m of all) {
      if (holdsGroupSeat(m)) {
        const k = `${m.groupId}:${m.seatNo}`;
        if (seats.has(k)) return { kind: "conflict" };
        seats.add(k);
      }
      if (holdsUserSeat(m) && m.userId !== null) {
        if (users.has(m.userId)) return { kind: "conflict" };
        users.add(m.userId);
      }
    }
    for (const m of out.members ?? []) this.members.set(m.id, m);
    for (const i of out.invites ?? []) this.invites.set(i.id, i);
    if (out.group !== undefined) this.groups.set(out.group.id, { ...out.group, version: group.version + 1 });
    this.events.push(...out.events);
    return { kind: "applied", result: out.result };
  }

  async listActiveGroups(afterId: string | null, limit: number): Promise<readonly FamilyGroup[]> {
    return [...this.groups.values()]
      .filter((g) => g.status === "ACTIVE" && (afterId === null || g.id > afterId))
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .slice(0, limit);
  }
}

export class InMemoryStudentStore implements StudentStore {
  readonly rows = new Map<string, StudentVerification>();
  readonly events: FamilyEvent[] = [];

  async getById(id: string): Promise<StudentVerification | null> {
    return this.rows.get(id) ?? null;
  }

  async latestForUser(userId: string): Promise<StudentVerification | null> {
    return [...this.rows.values()].filter((v) => v.userId === userId).sort((a, b) => b.createdAtMs - a.createdAtMs)[0] ?? null;
  }

  async latestVerifiedForUser(userId: string): Promise<StudentVerification | null> {
    return (
      [...this.rows.values()]
        .filter((v) => v.userId === userId && v.verifiedAtMs !== null)
        .sort((a, b) => (b.verifiedAtMs ?? 0) - (a.verifiedAtMs ?? 0))[0] ?? null
    );
  }

  async getByRef(verifier: string, ref: string): Promise<StudentVerification | null> {
    return [...this.rows.values()].find((v) => v.verifier === verifier && v.ref === ref) ?? null;
  }

  async save(v: StudentVerification, expectedVersion: number | null, events: readonly FamilyEvent[]): Promise<"ok" | "conflict" | "exists"> {
    const cur = this.rows.get(v.id);
    if (expectedVersion === null) {
      const dupRef = [...this.rows.values()].some((x) => x.verifier === v.verifier && x.ref === v.ref);
      const dupPending =
        v.status === "PENDING" && [...this.rows.values()].some((x) => x.userId === v.userId && x.status === "PENDING");
      if (cur !== undefined || dupRef || dupPending) return "exists";
      this.rows.set(v.id, { ...v, version: 0 });
    } else {
      if (cur === undefined || cur.version !== expectedVersion) return "conflict";
      this.rows.set(v.id, { ...v, version: expectedVersion + 1 });
    }
    this.events.push(...events);
    return "ok";
  }

  async listNoticeDue(nowMs: number, limit: number): Promise<readonly StudentVerification[]> {
    const horizon = nowMs + 30 * 86_400_000;
    return [...this.rows.values()]
      .filter((v) => v.status === "VERIFIED" && v.noticeSentAtMs === null && v.validUntilMs !== null && v.validUntilMs <= horizon)
      .slice(0, limit);
  }

  async listLapsed(nowMs: number, limit: number): Promise<readonly StudentVerification[]> {
    return [...this.rows.values()]
      .filter((v) => v.status === "VERIFIED" && v.validUntilMs !== null && v.validUntilMs <= nowMs)
      .slice(0, limit);
  }
}

// ---- fakes (development and tests only; production uses real adapters or fails closed) -------

export class FakeFamilyIdentity implements FamilyIdentityPort {
  private readonly byPhone = new Map<string, string>();
  private readonly verified = new Set<string>();
  constructor(private readonly secret = "dev-only-family-identity") {}
  hashPhone(phoneE164: string): string {
    return createHmac("sha256", this.secret).update(`phone:${phoneE164}`).digest("hex");
  }
  /** Registers an account with this phone. `otpVerified` defaults to true. */
  register(userId: string, phoneE164: string, otpVerified = true): string {
    const h = this.hashPhone(phoneE164);
    this.byPhone.set(h, userId);
    if (otpVerified) this.verified.add(userId);
    return h;
  }
  async userIdByPhoneHash(phoneHash: string): Promise<string | null> {
    return this.byPhone.get(phoneHash) ?? null;
  }
  async phoneVerified(userId: string): Promise<boolean> {
    return this.verified.has(userId);
  }
}

export class FakeInviteDelivery implements FamilyInviteDeliveryPort {
  readonly sent: InviteDelivery[] = [];
  failNext = false;
  async deliver(i: InviteDelivery) {
    if (this.failNext) {
      this.failNext = false;
      return { kind: "failed" as const, reason: "provider_down" };
    }
    this.sent.push(i);
    return { kind: "sent" as const };
  }
  last(): InviteDelivery | undefined {
    return this.sent[this.sent.length - 1];
  }
}

/** Fails closed: no delivery channel is configured, so no invite can be sent. */
export class UnconfiguredInviteDelivery implements FamilyInviteDeliveryPort {
  async deliver() {
    return { kind: "failed" as const, reason: "unconfigured" };
  }
}

export class SequentialInviteTokens implements InviteTokenPort {
  private n = 0;
  newToken(): string {
    this.n += 1;
    return `tok-${String(this.n).padStart(8, "0")}-${"x".repeat(24)}`;
  }
}

/**
 * Fake verifier for dev and tests. Callbacks are JSON `{ kind, ref, valid_until_ms? }` with header
 * `x-verifier-signature: ok`; `startResults` scripts the start call. Not a real MAC: never wired in production.
 */
export class FakeStudentVerifier implements StudentVerifierPort {
  readonly name = "fake";
  readonly started: { userId: string; method: StudentStartMethod; universityEmail: string | null }[] = [];
  allowedDomains: readonly string[] = ["cu.edu.eg", "aucegypt.edu"];
  available = true;
  private n = 0;

  async start(i: { userId: string; method: StudentStartMethod; universityEmail: string | null }): Promise<StudentStartResult> {
    if (!this.available) return { kind: "unavailable" };
    if (i.method === "university_email") {
      const domain = i.universityEmail?.split("@")[1]?.toLowerCase() ?? "";
      if (!this.allowedDomains.includes(domain)) return { kind: "domain_not_allowed" };
    }
    this.started.push(i);
    this.n += 1;
    const ref = `fake-ref-${this.n}`;
    return { kind: "started", ref, clientAction: { type: "redirect", url: `https://verifier.invalid/session/${ref}` } };
  }

  async verifyCallback(i: { rawBody: Uint8Array; headers: Readonly<Record<string, string | undefined>> }) {
    if (i.headers["x-verifier-signature"] !== "ok") return { kind: "rejected" as const };
    try {
      const b = JSON.parse(Buffer.from(i.rawBody).toString("utf8")) as {
        kind?: string;
        ref?: string;
        valid_until_ms?: number | null;
      };
      if (typeof b.ref !== "string") return { kind: "rejected" as const };
      const callback: StudentCallback =
        b.kind === "verified"
          ? { kind: "verified", ref: b.ref, validUntilMs: typeof b.valid_until_ms === "number" ? b.valid_until_ms : null }
          : { kind: "rejected", ref: b.ref };
      return { kind: "ok" as const, callback };
    } catch {
      return { kind: "rejected" as const };
    }
  }
}

/** Production default: no vendor contract exists (VR-P3-09), so nothing is ever verified. */
export class UnconfiguredStudentVerifier implements StudentVerifierPort {
  readonly name = "unconfigured";
  async start(): Promise<StudentStartResult> {
    return { kind: "unavailable" };
  }
  async verifyCallback() {
    return { kind: "rejected" as const };
  }
}

/** Production default: no users-module adapter is wired, so no invite can be sent or accepted. */
export class UnconfiguredFamilyIdentity implements FamilyIdentityPort {
  private readonly secret = randomBytes(32);
  hashPhone(phoneE164: string): string {
    return createHmac("sha256", this.secret).update(phoneE164).digest("hex");
  }
  async userIdByPhoneHash(): Promise<string | null> {
    return null;
  }
  async phoneVerified(): Promise<boolean> {
    return false;
  }
}

/** 128 bit CSPRNG token, URL safe. Real in every mode: it never leaves the process except in the invite link. */
export class CsprngInviteTokens implements InviteTokenPort {
  newToken(): string {
    return randomBytes(16).toString("base64url");
  }
}
