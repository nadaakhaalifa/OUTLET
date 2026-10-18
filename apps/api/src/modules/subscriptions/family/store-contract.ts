import { describe, expect, it } from "vitest";
import {
  acceptMember,
  endSeat,
  newInvitedMember,
  ownerMember,
  type FamilyGroup,
  type FamilyInvite,
  type FamilyMember,
  type StudentVerification,
} from "../domain/bridge";
import type { FamilyStore, StudentStore } from "./ports";

export const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const T0 = 1_800_000_000_000;
const DAY = 86_400_000;
const hex = (c: string): string => c.repeat(64);

export interface FamilyFixture {
  readonly family: FamilyStore;
  readonly students: StudentStore;
  /** Creates the user and a live subscription row for them and returns the subscription id. */
  seedOwner(userN: number): Promise<string>;
  ensureUser(userN: number): Promise<void>;
  eventTypes(): Promise<readonly string[]>;
}

const group = (n: number, ownerN: number, subId: string, over: Partial<FamilyGroup> = {}): FamilyGroup => ({
  id: U(1000 + n),
  ownerUserId: U(ownerN),
  subscriptionId: subId,
  seatLimit: 4,
  status: "ACTIVE",
  endingNoticeSentAtMs: null,
  createdAtMs: T0,
  version: 0,
  ...over,
});

const invite = (n: number, g: FamilyGroup, m: FamilyMember, over: Partial<FamilyInvite> = {}): FamilyInvite => ({
  id: U(3000 + n),
  groupId: g.id,
  memberId: m.id,
  inviteePhoneHash: hex("a"),
  tokenHash: hex(String(n % 10)) .slice(0, 63) + String.fromCharCode(97 + (n % 20)),
  expiresAtMs: m.inviteExpiresAtMs ?? T0 + 7 * DAY,
  acceptedAtMs: null,
  revokedAtMs: null,
  createdAtMs: T0,
  ...over,
});

const memberFor = (n: number, g: FamilyGroup, seatNo: number, nowMs = T0): FamilyMember =>
  newInvitedMember({ id: U(2000 + n), groupId: g.id, seatNo, nickname: `n${n}`, nowMs });

export function describeFamilyStoreContract(name: string, open: () => Promise<FamilyFixture>): void {
  describe(`FamilyStore contract: ${name}`, () => {
    const setup = async () => {
      const f = await open();
      const sub = await f.seedOwner(1);
      const g = group(1, 1, sub);
      const owner = ownerMember({ id: U(2000), groupId: g.id, userId: U(1), nowMs: T0 });
      expect(await f.family.createGroup(g, owner, [{ type: "family.created", groupId: g.id, ownerUserId: g.ownerUserId, subscriptionId: sub, seatLimit: 4 }])).toBe("ok");
      return { ...f, g, owner, sub };
    };

    it("creates a group once per subscription and once per active owner", async () => {
      const { family, g, owner, sub, seedOwner } = await setup();
      expect(await family.createGroup({ ...g, id: U(1500) }, { ...owner, id: U(2500), groupId: U(1500) }, [])).toBe("exists");
      const sub2 = await seedOwner(2);
      const other = group(2, 1, sub2);
      expect(await family.createGroup(other, ownerMember({ id: U(2600), groupId: other.id, userId: U(1), nowMs: T0 }), [])).toBe("exists");
      expect(await family.getGroupByOwner(U(1))).toMatchObject({ id: g.id, subscriptionId: sub, seatLimit: 4, status: "ACTIVE" });
      expect(await family.getGroup(g.id)).toMatchObject({ ownerUserId: U(1) });
      expect(await family.getGroupByOwner(U(77))).toBeNull();
      expect((await family.listMembers(g.id)).map((m) => m.role)).toEqual(["owner"]);
    });

    it("mutateGroup applies members, invites and events atomically and returns the callback result", async () => {
      const f = await setup();
      const m = memberFor(1, f.g, 2);
      const out = await f.family.mutateGroup(f.g.id, T0, () => ({
        result: "done",
        members: [m],
        invites: [invite(1, f.g, m)],
        events: [{ type: "family.member_invited", groupId: f.g.id, memberId: m.id }],
      }));
      expect(out).toEqual({ kind: "applied", result: "done" });
      const members = await f.family.listMembers(f.g.id);
      expect(members.map((x) => [x.seatNo, x.status])).toEqual([[1, "ACTIVE"], [2, "INVITED"]]);
      expect(members[1]?.inviteExpiresAtMs).toBe(T0 + 7 * DAY);
      expect(members[1]?.userId).toBeNull();
      expect((await f.family.listInvites(f.g.id))).toHaveLength(1);
      expect(await f.eventTypes()).toEqual(expect.arrayContaining(["family.created", "family.member_invited"]));
      const found = await f.family.findInviteByTokenHash(invite(1, f.g, m).tokenHash);
      expect(found).toMatchObject({ invite: { memberId: m.id }, member: { id: m.id }, group: { id: f.g.id } });
      expect(await f.family.findInviteByTokenHash(hex("f"))).toBeNull();
    });

    it("an unknown group is not_found and a callback that throws applies nothing", async () => {
      const f = await setup();
      expect(await f.family.mutateGroup(U(9999), T0, () => ({ result: 1, events: [] }))).toEqual({ kind: "not_found" });
      const m = memberFor(1, f.g, 2);
      await expect(
        f.family.mutateGroup(f.g.id, T0, () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(await f.family.listMembers(f.g.id)).toHaveLength(1);
      expect(m.seatNo).toBe(2);
    });

    it("two members can never share a seat number: the second write conflicts and nothing is applied", async () => {
      const f = await setup();
      const a = memberFor(1, f.g, 2);
      const b = memberFor(2, f.g, 2);
      expect((await f.family.mutateGroup(f.g.id, T0, () => ({ result: 1, members: [a], invites: [invite(1, f.g, a)], events: [] }))).kind).toBe("applied");
      const out = await f.family.mutateGroup(f.g.id, T0, () => ({
        result: 1,
        members: [b],
        invites: [invite(2, f.g, b)],
        events: [{ type: "family.member_invited", groupId: f.g.id, memberId: b.id }],
      }));
      expect(out).toEqual({ kind: "conflict" });
      expect((await f.family.listMembers(f.g.id)).map((m) => m.id)).toEqual([f.owner.id, a.id]);
      expect((await f.eventTypes()).filter((t) => t === "family.member_invited")).toHaveLength(0);
    });

    it("a user holds one seat across families", async () => {
      const f = await setup();
      await f.ensureUser(5);
      const sub2 = await f.seedOwner(2);
      const g2 = group(2, 2, sub2);
      await f.family.createGroup(g2, ownerMember({ id: U(2700), groupId: g2.id, userId: U(2), nowMs: T0 }), []);
      const m1 = memberFor(1, f.g, 2);
      const m2 = { ...memberFor(2, g2, 2), id: U(2701) };
      await f.family.mutateGroup(f.g.id, T0, () => ({ result: 1, members: [m1], invites: [invite(1, f.g, m1)], events: [] }));
      await f.family.mutateGroup(g2.id, T0, () => ({ result: 1, members: [m2], invites: [invite(2, g2, m2)], events: [] }));
      const a1 = acceptMember(m1, U(5), T0 + 1);
      const a2 = acceptMember(m2, U(5), T0 + 1);
      expect((await f.family.mutateGroup(f.g.id, T0 + 1, () => ({ result: 1, members: [a1], events: [] }))).kind).toBe("applied");
      expect((await f.family.mutateGroup(g2.id, T0 + 1, () => ({ result: 1, members: [a2], events: [] }))).kind).toBe("conflict");
      expect(await f.family.membershipOf(U(5))).toMatchObject({ group: { id: f.g.id }, member: { id: m1.id, status: "ACTIVE" } });
      expect(await f.family.membershipOf(U(99))).toBeNull();
    });

    it("settles expired invites and elapsed removed seats inside the lock, freeing their seat numbers", async () => {
      const f = await setup();
      await f.ensureUser(5);
      const m = memberFor(1, f.g, 2);
      await f.family.mutateGroup(f.g.id, T0, () => ({ result: 1, members: [m], invites: [invite(1, f.g, m)], events: [] }));
      const later = T0 + 8 * DAY;
      const seen: string[] = [];
      await f.family.mutateGroup(f.g.id, later, (ctx) => {
        seen.push(...ctx.members.map((x) => x.status));
        return { result: 1, events: [] };
      });
      expect(seen).toEqual(["ACTIVE", "ENDED"]);
      // The freed seat number can be reused at once.
      const reuse = memberFor(2, f.g, 2, later);
      expect((await f.family.mutateGroup(f.g.id, later, () => ({ result: 1, members: [reuse], invites: [invite(2, f.g, reuse)], events: [] }))).kind).toBe("applied");
      const accepted = acceptMember(reuse, U(5), later + 1);
      await f.family.mutateGroup(f.g.id, later + 1, () => ({ result: 1, members: [accepted], events: [] }));
      const removed = endSeat(accepted, "owner", later + 2, later + 10 * DAY);
      await f.family.mutateGroup(f.g.id, later + 2, () => ({ result: 1, members: [removed], events: [] }));
      expect((await f.family.membershipOf(U(5)))?.member.status).toBe("REMOVED");
      const after = later + 11 * DAY;
      const statuses: string[] = [];
      await f.family.mutateGroup(f.g.id, after, (ctx) => {
        statuses.push(...ctx.members.map((x) => x.status));
        return { result: 1, events: [] };
      });
      expect(statuses).toEqual(["ACTIVE", "ENDED", "ENDED"]);
      expect(await f.family.membershipOf(U(5))).toBeNull();
    });

    it("ending the group stores the status and ends it for membership and owner lookups", async () => {
      const f = await setup();
      const out = await f.family.mutateGroup(f.g.id, T0 + DAY, (ctx) => ({
        result: 1,
        group: { ...ctx.group, status: "ENDED" },
        members: ctx.members.map((m) => ({ ...m, status: "ENDED" as const })),
        events: [{ type: "family.ended", groupId: f.g.id, reason: "subscription_ended" }],
      }));
      expect(out.kind).toBe("applied");
      expect(await f.family.getGroup(f.g.id)).toMatchObject({ status: "ENDED" });
      expect(await f.family.getGroupByOwner(U(1))).toBeNull();
      expect(await f.family.membershipOf(U(1))).toBeNull();
      expect(await f.family.listActiveGroups(null, 10)).toHaveLength(0);
    });

    it("lists active groups in id order with a cursor", async () => {
      const f = await setup();
      for (const n of [2, 3]) {
        const sub = await f.seedOwner(n);
        const g = group(n, n, sub);
        await f.family.createGroup(g, ownerMember({ id: U(2800 + n), groupId: g.id, userId: U(n), nowMs: T0 }), []);
      }
      const page1 = await f.family.listActiveGroups(null, 2);
      expect(page1.map((g) => g.id)).toEqual([U(1001), U(1002)]);
      const page2 = await f.family.listActiveGroups(page1[1]?.id ?? null, 2);
      expect(page2.map((g) => g.id)).toEqual([U(1003)]);
    });

    it("the group notice flag round trips and bumps the version", async () => {
      const f = await setup();
      await f.family.mutateGroup(f.g.id, T0, (ctx) => ({
        result: 1,
        group: { ...ctx.group, endingNoticeSentAtMs: T0 + 5 },
        events: [{ type: "family.ending_notified", groupId: f.g.id }],
      }));
      const g = await f.family.getGroup(f.g.id);
      expect(g?.endingNoticeSentAtMs).toBe(T0 + 5);
      expect(g?.version).toBe(1);
    });
  });
}

const student = (n: number, userN: number, over: Partial<StudentVerification> = {}): StudentVerification => ({
  id: U(4000 + n),
  userId: U(userN),
  verifier: "fake",
  ref: `ref-${n}`,
  status: "PENDING",
  verifiedAtMs: null,
  validUntilMs: null,
  noticeSentAtMs: null,
  createdAtMs: T0 + n,
  version: 0,
  ...over,
});

export function describeStudentStoreContract(name: string, open: () => Promise<FamilyFixture>): void {
  describe(`StudentStore contract: ${name}`, () => {
    const setup = async () => {
      const f = await open();
      await f.ensureUser(1);
      await f.ensureUser(2);
      return f;
    };

    it("inserts once per (verifier, ref) and allows one pending per user", async () => {
      const { students } = await setup();
      expect(await students.save(student(1, 1), null, [{ type: "student.verification_started", userId: U(1), verificationId: U(4001) }])).toBe("ok");
      expect(await students.save(student(2, 1, { ref: "ref-1" }), null, [])).toBe("exists");
      expect(await students.save(student(3, 1), null, [])).toBe("exists");
      expect(await students.save(student(4, 2), null, [])).toBe("ok");
      expect(await students.getByRef("fake", "ref-1")).toMatchObject({ userId: U(1), status: "PENDING" });
      expect(await students.getByRef("fake", "zzz")).toBeNull();
      expect(await students.getById(U(4001))).toMatchObject({ ref: "ref-1" });
    });

    it("updates are guarded by version and bump it", async () => {
      const { students } = await setup();
      await students.save(student(1, 1), null, []);
      const cur = await students.getById(U(4001));
      expect(cur?.version).toBe(0);
      const next = { ...student(1, 1), status: "VERIFIED" as const, verifiedAtMs: T0 + 10, validUntilMs: T0 + 100 * DAY };
      expect(await students.save(next, 0, [])).toBe("ok");
      expect(await students.save(next, 0, [])).toBe("conflict");
      expect(await students.getById(U(4001))).toMatchObject({ status: "VERIFIED", version: 1, validUntilMs: T0 + 100 * DAY });
    });

    it("latest, latest verified, notice due and lapsed queries", async () => {
      const { students } = await setup();
      const v = { status: "VERIFIED" as const, verifiedAtMs: T0, validUntilMs: T0 + 10 * DAY };
      await students.save(student(1, 1, v), null, []);
      await students.save(student(2, 2, { status: "VERIFIED", verifiedAtMs: T0, validUntilMs: T0 + 100 * DAY }), null, []);
      expect(await students.latestVerifiedForUser(U(1))).toMatchObject({ id: U(4001) });
      expect(await students.latestForUser(U(1))).toMatchObject({ id: U(4001) });
      expect(await students.latestForUser(U(9))).toBeNull();
      expect((await students.listNoticeDue(T0, 10)).map((x) => x.userId)).toEqual([U(1)]);
      expect((await students.listLapsed(T0 + 11 * DAY, 10)).map((x) => x.userId)).toEqual([U(1)]);
      expect(await students.listLapsed(T0, 10)).toHaveLength(0);
      await students.save({ ...student(1, 1, v), noticeSentAtMs: T0 + 1 }, 0, []);
      expect(await students.listNoticeDue(T0, 10)).toHaveLength(0);
      // A newer pending attempt is the latest, the verified one stays the latest verified.
      await students.save(student(5, 1, { createdAtMs: T0 + 50 }), null, []);
      expect((await students.latestForUser(U(1)))?.id).toBe(U(4005));
      expect((await students.latestVerifiedForUser(U(1)))?.id).toBe(U(4001));
    });
  });
}
