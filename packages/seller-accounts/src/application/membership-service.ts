import { withDbContext } from "@outlet/db";
import type { Queryable } from "@outlet/outbox";
import { authorize } from "@outlet/policy";
import type { Principal } from "@outlet/policy";
import { z } from "zod";
import { SellerAccountsError, notFound } from "../domain/errors.js";
import { isSellerRole, roleCan } from "../domain/roles.js";
import type { SellerRole } from "../domain/roles.js";
import { conflict, emit, isUniqueViolation, kycJob, makeEnv } from "./env.js";
import type { Env, SellerAccountsDeps } from "./env.js";
import type { StrongAuthMethod, StrongAuthPort } from "./ports.js";

export const MEMBER_STATUSES = ["invited", "active", "suspended", "removed"] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

const InviteInput = z.strictObject({
  contact: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("phone"), value: z.string().regex(/^\+[1-9]\d{7,14}$/u, "E.164 phone") }),
    z.strictObject({ kind: z.literal("email"), value: z.email().max(254) }),
  ]),
  role: z.enum(["owner", "manager", "catalog", "warehouse", "finance", "support"]),
});
export type InviteInput = z.input<typeof InviteInput>;

export interface StoreMemberView {
  readonly id: string;
  readonly storeId: string;
  readonly userId: string | null;
  readonly role: SellerRole;
  readonly status: MemberStatus;
  readonly strongAuthEnrolledAt: string | null;
  readonly version: number;
}

interface MemberRow {
  id: string;
  store_id: string;
  user_id: string | null;
  role_code: string;
  status: MemberStatus;
  invitee_kind: "phone" | "email" | null;
  invitee_bidx: Uint8Array | null;
  invite_expires_at: Date | string | null;
  strong_auth_enrolled_at: Date | string | null;
  version: number;
}
const COLS = "id, store_id, user_id, role_code, status, invitee_kind, invitee_bidx, invite_expires_at, strong_auth_enrolled_at, version";
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const iso = (v: Date | string | null): string | null => (v === null ? null : (v instanceof Date ? v : new Date(v)).toISOString());
const toView = (r: MemberRow): StoreMemberView => ({
  id: r.id, storeId: r.store_id, userId: r.user_id, role: isSellerRole(r.role_code) ? r.role_code : "support", status: r.status,
  strongAuthEnrolledAt: iso(r.strong_auth_enrolled_at), version: r.version,
});
const one = <T>(rows: readonly T[]): T => {
  const r = rows[0];
  if (r === undefined) throw new SellerAccountsError("conflict", "expected one row");
  return r;
};
const same = (a: Uint8Array, b: Uint8Array): boolean => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

/**
 * Store staff membership. Implements the apps/api `StoreMembershipPort` (`find`) so UnconfiguredStoreMemberships can be
 * swapped for this class; the store switcher uses `membershipsFor` (one query, outlet_auth, own active rows only).
 */
export class StoreMembershipService {
  private readonly env: Env;
  constructor(
    deps: SellerAccountsDeps,
    private readonly strongAuth: StrongAuthPort,
  ) {
    this.env = makeEnv(deps);
  }

  private storeCtx = <T>(storeId: string, userId: string | undefined, fn: (tx: Queryable) => Promise<T>): Promise<T> =>
    withDbContext(this.env.app, { kind: "store", marketId: this.env.marketId, storeId, ...(userId === undefined ? {} : { userId }) }, fn);

  /** Policy check: foreign store -> not_found, wrong role -> forbidden (via @outlet/policy, not a copy of its matrix). */
  private authorizeStaff(actor: Principal, action: string, storeId: string): string {
    if (actor.kind !== "seller_staff" || actor.userId === undefined) throw new SellerAccountsError("forbidden", "forbidden");
    const d = authorize(actor, action, { type: "store_member", storeId, marketId: this.env.marketId });
    if (d.effect === "deny") throw new SellerAccountsError(d.reason, d.reason === "not_found" ? "not found" : "forbidden");
    return actor.userId;
  }

  /** The database must agree with the principal's claims: an active member with the action's role and enrolled strong auth. */
  private async assertManager(tx: Queryable, actorId: string, storeId: string): Promise<void> {
    const r = (await tx.query<{ role_code: string; strong_auth_enrolled_at: Date | string | null }>(
      "SELECT role_code, strong_auth_enrolled_at FROM store_members WHERE store_id = $1 AND user_id = $2 AND status = 'active'", [storeId, actorId],
    )).rows[0];
    if (r === undefined) throw notFound("store");
    if (!isSellerRole(r.role_code) || !roleCan(r.role_code, "team.manage")) throw new SellerAccountsError("forbidden", "forbidden");
    if (r.strong_auth_enrolled_at === null) throw new SellerAccountsError("passkey_required", "passkey or TOTP enrolment is required");
  }

  private async loadMember(tx: Queryable, storeId: string, memberId: string): Promise<MemberRow> {
    const r = (await tx.query<MemberRow>(`SELECT ${COLS} FROM store_members WHERE id = $1 AND store_id = $2 FOR UPDATE`, [memberId, storeId])).rows[0];
    if (r === undefined) throw notFound("member");
    return r;
  }

  /** Refuses to take the last active owner out of ownership (demote, suspend or remove). Locks the owner rows. */
  private async guardLastOwner(tx: Queryable, storeId: string, target: MemberRow): Promise<void> {
    if (target.role_code !== "owner" || target.status !== "active") return;
    const owners = await tx.query<{ id: string }>("SELECT id FROM store_members WHERE store_id = $1 AND role_code = 'owner' AND status = 'active' FOR UPDATE", [storeId]);
    if (owners.rows.length <= 1) throw new SellerAccountsError("last_owner", "a store must keep at least one active owner");
  }

  /**
   * First owner of a store: the applicant of the store's seller, once that seller's KYC is APPROVED, and only while the
   * store has no members. No store membership exists yet to authorize against, so the checks read under the applicant's
   * own store+user context (outlet_app) and the INSERT runs as the 'seller.kyc' worker job (store_members__worker_seller_kyc).
   */
  async bootstrapOwner(userId: string, storeId: string): Promise<StoreMemberView> {
    const id = this.env.newId();
    const at = this.env.now();
    await this.storeCtx(storeId, userId, async (tx) => {
      const ok = await tx.query(
        `SELECT 1 FROM stores s JOIN kyc_cases c ON c.seller_id = s.seller_id AND c.kind = 'onboarding'
          WHERE s.id = $1 AND s.market_id = $2 AND c.applicant_user_id = $3 AND c.state = 'APPROVED'`,
        [storeId, this.env.marketId, userId],
      );
      if (ok.rows.length === 0) throw notFound("store");
      const any = await tx.query("SELECT 1 FROM store_members WHERE store_id = $1 AND status <> 'removed' LIMIT 1", [storeId]);
      if (any.rows.length > 0) throw conflict("store already has members");
    });
    try {
      return await kycJob(this.env, userId, async (tx) => {
        const r = await tx.query<MemberRow>(
          `INSERT INTO store_members (id, store_id, market_id, user_id, role_code, status, accepted_at, created_at, updated_at)
           VALUES ($1,$2,$3,$4,'owner','active',$5,$5,$5) RETURNING ${COLS}`,
          [id, storeId, this.env.marketId, userId, at],
        );
        await emit(this.env, tx, "store_member.owner_bootstrapped", "store_member", id, { storeId });
        return toView(one(r.rows));
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict("store already has members");
      throw e;
    }
  }

  async invite(actor: Principal, storeId: string, raw: InviteInput): Promise<StoreMemberView> {
    const input = InviteInput.parse(raw);
    const actorId = this.authorizeStaff(actor, "team.manage", storeId);
    const normalized = input.contact.kind === "email" ? input.contact.value.trim().toLowerCase() : input.contact.value;
    const bidx = this.env.hasher.hmac(input.contact.kind, `${this.env.marketId}:${normalized}`);
    const id = this.env.newId();
    const at = this.env.now();
    try {
      return await this.storeCtx(storeId, actorId, async (tx) => {
        await this.assertManager(tx, actorId, storeId);
        const r = await tx.query<MemberRow>(
          `INSERT INTO store_members (id, store_id, market_id, role_code, status, invitee_kind, invitee_bidx, invite_expires_at, invited_by, created_at, updated_at)
           VALUES ($1,$2,$3,$4,'invited',$5,$6,$7,$8,$9,$9) RETURNING ${COLS}`,
          [id, storeId, this.env.marketId, input.role, input.contact.kind, bidx, new Date(at.getTime() + INVITE_TTL_MS), actorId, at],
        );
        await emit(this.env, tx, "store_member.invited", "store_member", id, { storeId, role: input.role });
        return toView(one(r.rows));
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict("this person is already invited");
      throw e;
    }
  }

  /** The invitee proves they are the invited person by holding the phone/email whose blind index the invite carries. */
  async accept(userId: string, storeId: string, memberId: string): Promise<StoreMemberView> {
    const at = this.env.now();
    return this.storeCtx(storeId, userId, async (tx) => {
      const m = await this.loadMember(tx, storeId, memberId).catch(() => {
        throw notFound("invitation");
      });
      const u = (await tx.query<{ phone_bidx: Uint8Array | null; email_bidx: Uint8Array | null }>("SELECT phone_bidx, email_bidx FROM users WHERE id = $1", [userId])).rows[0];
      const mine = m.invitee_kind === "phone" ? u?.phone_bidx : m.invitee_kind === "email" ? u?.email_bidx : null;
      const expires = m.invite_expires_at === null ? null : new Date(m.invite_expires_at);
      if (m.status !== "invited" || m.invitee_bidx === null || mine == null || !same(m.invitee_bidx, mine) || expires === null || expires.getTime() < at.getTime()) throw notFound("invitation");
      try {
        const r = await tx.query<MemberRow>(
          `UPDATE store_members SET user_id = $2, status = 'active', accepted_at = $3, invitee_bidx = NULL, invitee_kind = NULL, invite_expires_at = NULL, version = version + 1, updated_at = $3
            WHERE id = $1 RETURNING ${COLS}`,
          [memberId, userId, at],
        );
        await emit(this.env, tx, "store_member.accepted", "store_member", memberId, { storeId, role: m.role_code });
        return toView(one(r.rows));
      } catch (e) {
        if (isUniqueViolation(e)) throw conflict("already a member of this store");
        throw e;
      }
    });
  }

  private async mutate(
    actor: Principal, storeId: string, memberId: string, expectedVersion: number | undefined,
    change: (tx: Queryable, m: MemberRow) => Promise<{ set: string; params: unknown[]; event: string; payload: Record<string, string> }>,
  ): Promise<StoreMemberView> {
    const actorId = this.authorizeStaff(actor, "team.manage", storeId);
    const at = this.env.now();
    return this.storeCtx(storeId, actorId, async (tx) => {
      await this.assertManager(tx, actorId, storeId);
      const m = await this.loadMember(tx, storeId, memberId);
      if (expectedVersion !== undefined && m.version !== expectedVersion) throw conflict("member was changed by someone else");
      const c = await change(tx, m);
      const r = await tx.query<MemberRow>(`UPDATE store_members SET ${c.set}, version = version + 1, updated_at = $2 WHERE id = $1 RETURNING ${COLS}`, [memberId, at, ...c.params]);
      await emit(this.env, tx, c.event, "store_member", memberId, { storeId, ...c.payload });
      return toView(one(r.rows));
    });
  }

  /** Role change. Needs team.manage (owner in the @outlet/policy matrix) and strong auth. */
  changeRole(actor: Principal, storeId: string, memberId: string, role: SellerRole, expectedVersion?: number): Promise<StoreMemberView> {
    if (!isSellerRole(role)) throw new SellerAccountsError("validation", "unknown role");
    return this.mutate(actor, storeId, memberId, expectedVersion, async (tx, m) => {
      if (m.status !== "active" && m.status !== "suspended") throw conflict(`member is ${m.status}`);
      if (role !== "owner") await this.guardLastOwner(tx, storeId, m);
      return { set: "role_code = $3", params: [role], event: "store_member.role_changed", payload: { from: m.role_code, to: role } };
    });
  }

  suspend(actor: Principal, storeId: string, memberId: string, expectedVersion?: number): Promise<StoreMemberView> {
    return this.mutate(actor, storeId, memberId, expectedVersion, async (tx, m) => {
      if (m.status !== "active") throw conflict(`member is ${m.status}`);
      await this.guardLastOwner(tx, storeId, m);
      return { set: "status = 'suspended'", params: [], event: "store_member.suspended", payload: {} };
    });
  }

  reinstate(actor: Principal, storeId: string, memberId: string, expectedVersion?: number): Promise<StoreMemberView> {
    return this.mutate(actor, storeId, memberId, expectedVersion, (_tx, m) => {
      if (m.status !== "suspended") throw conflict(`member is ${m.status}`);
      return Promise.resolve({ set: "status = 'active'", params: [], event: "store_member.reinstated", payload: {} });
    });
  }

  /** Removes an active or suspended member, or revokes a pending invitation. The row stays (status removed) for audit. */
  remove(actor: Principal, storeId: string, memberId: string, expectedVersion?: number): Promise<StoreMemberView> {
    return this.mutate(actor, storeId, memberId, expectedVersion, async (tx, m) => {
      if (m.status === "removed") throw conflict("member is already removed");
      await this.guardLastOwner(tx, storeId, m);
      return { set: "status = 'removed', removed_at = $2, invitee_bidx = NULL, invite_expires_at = NULL", params: [], event: "store_member.removed", payload: {} };
    });
  }

  async listMembers(actor: Principal, storeId: string): Promise<StoreMemberView[]> {
    const actorId = this.authorizeStaff(actor, "store.read", storeId);
    return this.storeCtx(storeId, actorId, async (tx) => {
      const r = await tx.query<MemberRow>(`SELECT ${COLS} FROM store_members WHERE store_id = $1 AND status <> 'removed' ORDER BY created_at, id`, [storeId]);
      return r.rows.map(toView);
    });
  }

  /** Records passkey/TOTP enrolment for the caller's own active membership, after StrongAuthPort verifies the proof. */
  async enrollStrongAuth(userId: string, storeId: string, method: StrongAuthMethod, proof: string): Promise<void> {
    const verified = await this.strongAuth.verifyEnrollment({ userId, method, proof });
    if (!verified) throw new SellerAccountsError("validation", "strong authentication enrolment could not be verified");
    const at = this.env.now();
    await this.storeCtx(storeId, userId, async (tx) => {
      const r = await tx.query<{ id: string }>(
        `UPDATE store_members SET strong_auth_enrolled_at = $3, strong_auth_method = $4, version = version + 1, updated_at = $3
          WHERE store_id = $1 AND user_id = $2 AND status = 'active' RETURNING id`,
        [storeId, userId, at, method],
      );
      const row = r.rows[0];
      if (row === undefined) throw notFound("store");
      await emit(this.env, tx, "store_member.strong_auth_enrolled", "store_member", row.id, { storeId, method });
    });
  }

  /** Throws passkey_required (step-up) unless the user is an active member of the store with passkey/TOTP enrolled; not a member: not_found. */
  async requireStrongAuth(userId: string, storeId: string): Promise<void> {
    const r = await this.storeCtx(storeId, userId, (tx) =>
      tx.query<{ strong_auth_enrolled_at: Date | string | null }>("SELECT strong_auth_enrolled_at FROM store_members WHERE store_id = $1 AND user_id = $2 AND status = 'active'", [storeId, userId]),
    );
    const row = r.rows[0];
    if (row === undefined) throw notFound("store");
    if (row.strong_auth_enrolled_at === null) throw new SellerAccountsError("passkey_required", "passkey or TOTP enrolment is required");
  }

  /** apps/api StoreMembershipPort. Active memberships only; a different market than this cell's: null. */
  async find(marketId: string, userId: string, storeId: string): Promise<{ readonly roles: readonly SellerRole[] } | null> {
    if (marketId !== this.env.marketId) return null;
    const r = await this.storeCtx(storeId, userId, (tx) =>
      tx.query<{ role_code: string }>("SELECT role_code FROM store_members WHERE store_id = $1 AND user_id = $2 AND status = 'active'", [storeId, userId]),
    );
    const role = r.rows[0]?.role_code;
    return role !== undefined && isSellerRole(role) ? { roles: [role] } : null;
  }

  async isMember(userId: string, storeId: string): Promise<boolean> {
    return (await this.find(this.env.marketId, userId, storeId)) !== null;
  }

  /** Store switcher / token claims: every active membership of the user, in ONE query (outlet_auth, narrowed user context). */
  async membershipsFor(userId: string): Promise<readonly { readonly storeId: string; readonly role: SellerRole; readonly strongAuthEnrolled: boolean }[]> {
    const r = await withDbContext(this.env.auth, { kind: "auth", marketId: this.env.marketId, userId }, (tx) =>
      tx.query<{ store_id: string; role_code: string; strong_auth_enrolled_at: Date | string | null }>(
        "SELECT store_id, role_code, strong_auth_enrolled_at FROM store_members WHERE user_id = $1 AND status = 'active' ORDER BY store_id", [userId],
      ),
    );
    return r.rows.flatMap((x) => (isSellerRole(x.role_code) ? [{ storeId: x.store_id, role: x.role_code, strongAuthEnrolled: x.strong_auth_enrolled_at !== null }] : []));
  }
}
