import { sql } from "kysely";
import { z } from "zod";
import type { FamilyGroup, FamilyInvite, FamilyMember, StudentVerification } from "../domain/bridge";
import type { PlusDb } from "../adapters/kysely-store";
import type { IdPort } from "../domain/ports";
import type {
  FamilyEvent,
  FamilyStore,
  GroupContext,
  GroupMutation,
  InviteLookup,
  Membership,
  MutateOutcome,
  StudentStore,
} from "./ports";

const Int = z.string().regex(/^-?\d+$/);
const Ms = Int.transform((s) => Number(s));
const EPOCH = (col: string) => sql.raw(`floor(extract(epoch from ${col}) * 1000)::text`);
const ts = (ms: number) => sql`to_timestamp(${ms}::double precision / 1000.0)`;
const tsOrNull = (ms: number | null) => (ms === null ? sql`null::timestamptz` : ts(ms));

const GroupRow = z.object({
  id: z.string(),
  owner_user_id: z.string(),
  subscription_id: z.string(),
  seat_limit: z.number().int(),
  status: z.enum(["ACTIVE", "ENDED"]),
  ending_ms: Ms.nullable(),
  created_ms: Ms,
  version: z.number().int(),
});
const GROUP_COLS = sql`id::text as id, owner_user_id::text as owner_user_id, subscription_id::text as subscription_id,
  seat_limit::int as seat_limit, status, ${EPOCH("ending_notice_sent_at")} as ending_ms,
  ${EPOCH("created_at")} as created_ms, version::int as version`;

const MemberRow = z.object({
  id: z.string(),
  group_id: z.string(),
  user_id: z.string().nullable(),
  role: z.enum(["owner", "member"]),
  status: z.enum(["INVITED", "ACTIVE", "REMOVED", "ENDED"]),
  seat_no: z.number().int(),
  nickname: z.string().nullable(),
  invited_ms: Ms,
  invite_expires_ms: Ms.nullable(),
  effective_ms: Ms.nullable(),
  end_ms: Ms.nullable(),
  removed_ms: Ms.nullable(),
  removed_by: z.enum(["owner", "self", "system"]).nullable(),
});
const MEMBER_COLS = sql`m.id::text as id, m.group_id::text as group_id, m.user_id::text as user_id, m.role, m.status,
  m.seat_no::int as seat_no, m.nickname, ${EPOCH("m.invited_at")} as invited_ms,
  ${EPOCH("i.expires_at")} as invite_expires_ms, ${EPOCH("m.seat_effective_from")} as effective_ms,
  ${EPOCH("m.seat_end_at")} as end_ms, ${EPOCH("m.removed_at")} as removed_ms, m.removed_by`;

const InviteRow = z.object({
  id: z.string(),
  group_id: z.string(),
  member_id: z.string(),
  invitee_phone_hash: z.string(),
  token_hash: z.string(),
  expires_ms: Ms,
  accepted_ms: Ms.nullable(),
  revoked_ms: Ms.nullable(),
  created_ms: Ms,
});
const INVITE_COLS = sql`id::text as id, group_id::text as group_id, member_id::text as member_id, invitee_phone_hash,
  token_hash, ${EPOCH("expires_at")} as expires_ms, ${EPOCH("accepted_at")} as accepted_ms,
  ${EPOCH("revoked_at")} as revoked_ms, ${EPOCH("created_at")} as created_ms`;

const toGroup = (r: z.infer<typeof GroupRow>): FamilyGroup => ({
  id: r.id,
  ownerUserId: r.owner_user_id,
  subscriptionId: r.subscription_id,
  seatLimit: r.seat_limit,
  status: r.status,
  endingNoticeSentAtMs: r.ending_ms,
  createdAtMs: r.created_ms,
  version: r.version,
});
const toMember = (r: z.infer<typeof MemberRow>): FamilyMember => ({
  id: r.id,
  groupId: r.group_id,
  userId: r.user_id,
  role: r.role,
  status: r.status,
  seatNo: r.seat_no,
  nickname: r.nickname,
  invitedAtMs: r.invited_ms,
  inviteExpiresAtMs: r.status === "INVITED" ? r.invite_expires_ms : null,
  seatEffectiveFromMs: r.effective_ms,
  seatEndAtMs: r.end_ms,
  removedAtMs: r.removed_ms,
  removedBy: r.removed_by,
});
const toInvite = (r: z.infer<typeof InviteRow>): FamilyInvite => ({
  id: r.id,
  groupId: r.group_id,
  memberId: r.member_id,
  inviteePhoneHash: r.invitee_phone_hash,
  tokenHash: r.token_hash,
  expiresAtMs: r.expires_ms,
  acceptedAtMs: r.accepted_ms,
  revokedAtMs: r.revoked_ms,
  createdAtMs: r.created_ms,
});

class Abort extends Error {}
const isUnique = (e: unknown, name: string): boolean => e instanceof Error && e.message.includes(name);
const SEAT_INDEXES = ["family_members_seat_uq", "family_members_user_one_family_uq"] as const;

function aggregateOf(e: FamilyEvent): { type: string; id: string } {
  switch (e.type) {
    case "student.verification_started":
    case "student.verified":
    case "student.rejected":
    case "student.expired":
      return { type: "student_verification", id: e.verificationId };
    default:
      return { type: "family_group", id: e.groupId };
  }
}

async function emit(trx: PlusDb, ids: IdPort, events: readonly FamilyEvent[]): Promise<void> {
  for (const e of events) {
    const agg = aggregateOf(e);
    const { type: _t, ...payload } = e;
    await sql`
      insert into outbox_events (id, aggregate_type, aggregate_id, event_type, ordering_key, payload)
      values (${ids.uuidV7()}::uuid, ${agg.type}, ${agg.id}::uuid, ${e.type},
              ${`${agg.type}:${agg.id}`}, ${JSON.stringify(payload)}::jsonb)`.execute(trx);
  }
}

async function systemTx<T>(db: PlusDb, run: (trx: PlusDb) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`select set_config('app.role', 'system', true)`.execute(trx);
    return run(trx as unknown as PlusDb);
  });
}

/**
 * Postgres family store. `mutateGroup` takes `select ... for update` on the group row, so two
 * accepts for the last seat serialise; the partial unique indexes on seat_no and user_id are the
 * backstop that makes oversubscription impossible even if a caller bypassed the lock.
 */
export class KyselyFamilyStore implements FamilyStore {
  constructor(
    private readonly db: PlusDb,
    private readonly ids: IdPort,
  ) {}

  private async groups(query: ReturnType<typeof sql>): Promise<FamilyGroup[]> {
    const r = await query.execute(this.db);
    return z.array(GroupRow).parse(r.rows).map(toGroup);
  }

  private async memberRows(query: ReturnType<typeof sql>, db: PlusDb = this.db): Promise<FamilyMember[]> {
    const r = await query.execute(db);
    return z.array(MemberRow).parse(r.rows).map(toMember);
  }

  async getGroupByOwner(ownerUserId: string): Promise<FamilyGroup | null> {
    const g = await this.groups(
      sql`select ${GROUP_COLS} from family_groups where owner_user_id = ${ownerUserId}::uuid and status = 'ACTIVE' limit 1`,
    );
    return g[0] ?? null;
  }

  async getGroup(id: string): Promise<FamilyGroup | null> {
    return (await this.groups(sql`select ${GROUP_COLS} from family_groups where id = ${id}::uuid`))[0] ?? null;
  }

  async membershipOf(userId: string): Promise<Membership | null> {
    const rows = await this.memberRows(sql`
      select ${MEMBER_COLS} from family_members m
      left join family_invites i on i.member_id = m.id
      join family_groups g on g.id = m.group_id
      where m.user_id = ${userId}::uuid and m.status in ('ACTIVE', 'REMOVED') and g.status = 'ACTIVE' limit 1`);
    const member = rows[0];
    if (member === undefined) return null;
    const group = await this.getGroup(member.groupId);
    return group === null ? null : { group, member };
  }

  async listMembers(groupId: string): Promise<readonly FamilyMember[]> {
    return this.memberRows(sql`
      select ${MEMBER_COLS} from family_members m left join family_invites i on i.member_id = m.id
      where m.group_id = ${groupId}::uuid order by m.seat_no, m.invited_at`);
  }

  async listInvites(groupId: string): Promise<readonly FamilyInvite[]> {
    const r = await sql`select ${INVITE_COLS} from family_invites where group_id = ${groupId}::uuid`.execute(this.db);
    return z.array(InviteRow).parse(r.rows).map(toInvite);
  }

  async findInviteByTokenHash(tokenHash: string): Promise<InviteLookup | null> {
    const r = await sql`select ${INVITE_COLS} from family_invites where token_hash = ${tokenHash}`.execute(this.db);
    const inv = z.array(InviteRow).parse(r.rows).map(toInvite)[0];
    if (inv === undefined) return null;
    const member = (
      await this.memberRows(sql`
        select ${MEMBER_COLS} from family_members m left join family_invites i on i.member_id = m.id
        where m.id = ${inv.memberId}::uuid`)
    )[0];
    const group = await this.getGroup(inv.groupId);
    return member === undefined || group === null ? null : { invite: inv, member, group };
  }

  async createGroup(group: FamilyGroup, owner: FamilyMember, events: readonly FamilyEvent[]): Promise<"ok" | "exists"> {
    try {
      await systemTx(this.db, async (trx) => {
        await sql`
          insert into family_groups (id, owner_user_id, subscription_id, seat_limit, status, created_at)
          values (${group.id}::uuid, ${group.ownerUserId}::uuid, ${group.subscriptionId}::uuid, ${group.seatLimit},
                  ${group.status}, ${ts(group.createdAtMs)})`.execute(trx);
        await this.writeMember(trx, owner);
        await emit(trx, this.ids, events);
      });
      return "ok";
    } catch (e) {
      if (
        isUnique(e, "family_groups_subscription_uq") ||
        isUnique(e, "family_groups_one_active_owner_uq") ||
        isUnique(e, "family_members_user_one_family_uq")
      ) {
        return "exists";
      }
      throw e;
    }
  }

  private async writeMember(trx: PlusDb, m: FamilyMember): Promise<void> {
    await sql`
      insert into family_members (id, group_id, user_id, role, status, seat_no, nickname, invited_at,
        seat_effective_from, seat_end_at, removed_at, removed_by)
      values (${m.id}::uuid, ${m.groupId}::uuid, ${m.userId === null ? null : m.userId}::uuid, ${m.role}, ${m.status},
        ${m.seatNo}, ${m.nickname}, ${ts(m.invitedAtMs)}, ${tsOrNull(m.seatEffectiveFromMs)}, ${tsOrNull(m.seatEndAtMs)},
        ${tsOrNull(m.removedAtMs)}, ${m.removedBy})
      on conflict (id) do update set user_id = excluded.user_id, status = excluded.status,
        seat_effective_from = excluded.seat_effective_from, seat_end_at = excluded.seat_end_at,
        removed_at = excluded.removed_at, removed_by = excluded.removed_by`.execute(trx);
  }

  private async writeInvite(trx: PlusDb, i: FamilyInvite, createdBy: string): Promise<void> {
    await sql`
      insert into family_invites (id, group_id, member_id, invitee_phone_hash, token_hash, expires_at, accepted_at,
        revoked_at, created_by, created_at)
      values (${i.id}::uuid, ${i.groupId}::uuid, ${i.memberId}::uuid, ${i.inviteePhoneHash}, ${i.tokenHash},
        ${ts(i.expiresAtMs)}, ${tsOrNull(i.acceptedAtMs)}, ${tsOrNull(i.revokedAtMs)}, ${createdBy}::uuid, ${ts(i.createdAtMs)})
      on conflict (id) do update set accepted_at = excluded.accepted_at, revoked_at = excluded.revoked_at`.execute(trx);
  }

  async mutateGroup<R>(groupId: string, nowMs: number, fn: (ctx: GroupContext) => GroupMutation<R>): Promise<MutateOutcome<R>> {
    try {
      return await systemTx(this.db, async (trx): Promise<MutateOutcome<R>> => {
        const locked = await sql`select ${GROUP_COLS} from family_groups where id = ${groupId}::uuid for update`.execute(trx);
        const g = z.array(GroupRow).parse(locked.rows).map(toGroup)[0];
        if (g === undefined) return { kind: "not_found" };
        // Settle inside the lock: expired invites and elapsed seats free their seat numbers.
        await sql`
          update family_members m set status = 'ENDED'
          where m.group_id = ${groupId}::uuid and m.status = 'INVITED'
            and exists (select 1 from family_invites i where i.member_id = m.id and i.expires_at <= ${ts(nowMs)})`.execute(trx);
        await sql`
          update family_members set status = 'ENDED'
          where group_id = ${groupId}::uuid and status = 'REMOVED' and seat_end_at <= ${ts(nowMs)}`.execute(trx);
        const members = await this.memberRows(
          sql`select ${MEMBER_COLS} from family_members m left join family_invites i on i.member_id = m.id where m.group_id = ${groupId}::uuid`,
          trx,
        );
        const ir = await sql`select ${INVITE_COLS} from family_invites where group_id = ${groupId}::uuid`.execute(trx);
        const invites = z.array(InviteRow).parse(ir.rows).map(toInvite);

        const out = fn({ group: g, members, invites });

        for (const m of out.members ?? []) await this.writeMember(trx, m);
        for (const i of out.invites ?? []) await this.writeInvite(trx, i, g.ownerUserId);
        if (out.group !== undefined) {
          await sql`
            update family_groups set status = ${out.group.status},
              ending_notice_sent_at = ${tsOrNull(out.group.endingNoticeSentAtMs)},
              ended_at = case when ${out.group.status} = 'ENDED' then ${ts(nowMs)} else ended_at end,
              version = version + 1
            where id = ${groupId}::uuid`.execute(trx);
        }
        await emit(trx, this.ids, out.events);
        return { kind: "applied", result: out.result };
      });
    } catch (e) {
      if (SEAT_INDEXES.some((n) => isUnique(e, n))) return { kind: "conflict" };
      if (e instanceof Abort) return { kind: "conflict" };
      throw e;
    }
  }

  async listActiveGroups(afterId: string | null, limit: number): Promise<readonly FamilyGroup[]> {
    return this.groups(
      afterId === null
        ? sql`select ${GROUP_COLS} from family_groups where status = 'ACTIVE' order by id limit ${limit}`
        : sql`select ${GROUP_COLS} from family_groups where status = 'ACTIVE' and id > ${afterId}::uuid order by id limit ${limit}`,
    );
  }
}

// ---- student ---------------------------------------------------------------------------------

const StudentRow = z.object({
  id: z.string(),
  user_id: z.string(),
  verifier: z.string(),
  ref: z.string(),
  status: z.enum(["PENDING", "VERIFIED", "REJECTED", "EXPIRED"]),
  verified_ms: Ms.nullable(),
  valid_ms: Ms.nullable(),
  notice_ms: Ms.nullable(),
  created_ms: Ms,
  version: z.number().int(),
});
const STUDENT_COLS = sql`id::text as id, user_id::text as user_id, verifier, ref, status,
  ${EPOCH("verified_at")} as verified_ms, ${EPOCH("valid_until")} as valid_ms, ${EPOCH("notice_sent_at")} as notice_ms,
  ${EPOCH("created_at")} as created_ms, version::int as version`;
const toStudent = (r: z.infer<typeof StudentRow>): StudentVerification => ({
  id: r.id,
  userId: r.user_id,
  verifier: r.verifier,
  ref: r.ref,
  status: r.status,
  verifiedAtMs: r.verified_ms,
  validUntilMs: r.valid_ms,
  noticeSentAtMs: r.notice_ms,
  createdAtMs: r.created_ms,
  version: r.version,
});

export class KyselyStudentStore implements StudentStore {
  constructor(
    private readonly db: PlusDb,
    private readonly ids: IdPort,
  ) {}

  private async rows(query: ReturnType<typeof sql>): Promise<StudentVerification[]> {
    const r = await query.execute(this.db);
    return z.array(StudentRow).parse(r.rows).map(toStudent);
  }

  async getById(id: string): Promise<StudentVerification | null> {
    return (await this.rows(sql`select ${STUDENT_COLS} from student_verifications where id = ${id}::uuid`))[0] ?? null;
  }

  async latestForUser(userId: string): Promise<StudentVerification | null> {
    return (
      (await this.rows(
        sql`select ${STUDENT_COLS} from student_verifications where user_id = ${userId}::uuid order by created_at desc, id desc limit 1`,
      ))[0] ?? null
    );
  }

  async latestVerifiedForUser(userId: string): Promise<StudentVerification | null> {
    return (
      (await this.rows(sql`
        select ${STUDENT_COLS} from student_verifications
        where user_id = ${userId}::uuid and verified_at is not null order by verified_at desc, id desc limit 1`))[0] ?? null
    );
  }

  async getByRef(verifier: string, ref: string): Promise<StudentVerification | null> {
    return (
      (await this.rows(sql`select ${STUDENT_COLS} from student_verifications where verifier = ${verifier} and ref = ${ref}`))[0] ??
      null
    );
  }

  async save(v: StudentVerification, expectedVersion: number | null, events: readonly FamilyEvent[]): Promise<"ok" | "conflict" | "exists"> {
    try {
      return await systemTx(this.db, async (trx) => {
        if (expectedVersion === null) {
          await sql`
            insert into student_verifications (id, user_id, verifier, ref, status, verified_at, valid_until, notice_sent_at, version, created_at, updated_at)
            values (${v.id}::uuid, ${v.userId}::uuid, ${v.verifier}, ${v.ref}, ${v.status}, ${tsOrNull(v.verifiedAtMs)},
                    ${tsOrNull(v.validUntilMs)}, ${tsOrNull(v.noticeSentAtMs)}, 0, ${ts(v.createdAtMs)}, ${ts(v.createdAtMs)})`.execute(trx);
        } else {
          const r = await sql`
            update student_verifications set status = ${v.status}, verified_at = ${tsOrNull(v.verifiedAtMs)},
              valid_until = ${tsOrNull(v.validUntilMs)}, notice_sent_at = ${tsOrNull(v.noticeSentAtMs)},
              version = version + 1, updated_at = now()
            where id = ${v.id}::uuid and version = ${expectedVersion} returning id`.execute(trx);
          if (r.rows.length === 0) throw new Abort("conflict");
        }
        await emit(trx, this.ids, events);
        return "ok" as const;
      });
    } catch (e) {
      if (e instanceof Abort) return "conflict";
      if (isUnique(e, "student_verifications_ref_uq") || isUnique(e, "student_verifications_one_pending_uq") || isUnique(e, "student_verifications_pkey")) {
        return "exists";
      }
      throw e;
    }
  }

  async listNoticeDue(nowMs: number, limit: number): Promise<readonly StudentVerification[]> {
    return this.rows(sql`
      select ${STUDENT_COLS} from student_verifications
      where status = 'VERIFIED' and notice_sent_at is null and valid_until <= ${ts(nowMs + 30 * 86_400_000)}
      order by valid_until limit ${limit}`);
  }

  async listLapsed(nowMs: number, limit: number): Promise<readonly StudentVerification[]> {
    return this.rows(sql`
      select ${STUDENT_COLS} from student_verifications
      where status = 'VERIFIED' and valid_until <= ${ts(nowMs)} order by valid_until limit ${limit}`);
  }
}
