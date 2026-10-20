/**
 * In-memory seller auth stores. Same observable behaviour as the Kysely stores (the shared contract
 * suite runs against both); used by the development composition and the unit tests.
 */
import type { OtpChallenge } from "@outlet/auth-core";
import type {
  OtpProof,
  SellerAuthEvent,
  SellerAuthEvents,
  SellerInvite,
  SellerInviteRepository,
  SellerMembership,
  SellerMembershipRepository,
  SellerOtpChallengeRepository,
  SellerOtpProofStore,
  SellerOtpRecord,
  SellerOtpSendHistory,
  SellerOtpSendLog,
  SellerPasskey,
  SellerPasskeyChallenge,
  SellerPasskeyChallengeStore,
  SellerPasskeyRepository,
  SellerSessionRepository,
  SellerStores,
  SellerTotpRecord,
  SellerTotpStore,
  SellerUser,
  SellerUserDirectory,
  StoredSellerSession,
} from "../domain/ports";
import type { UserLanguage } from "../../domain/ports";

export class InMemorySellerUserDirectory implements SellerUserDirectory {
  private readonly rows = new Map<string, SellerUser>();

  async findOrCreateByPhone(input: { phoneE164: string; email: string | null; language: UserLanguage; newId: string; nowMs: number }): Promise<SellerUser> {
    const existing = [...this.rows.values()].find((u) => u.phoneE164 === input.phoneE164);
    if (existing !== undefined) return existing;
    const created: SellerUser = {
      id: input.newId,
      phoneE164: input.phoneE164,
      email: input.email,
      language: input.language,
      status: "active",
      strongFactor: false,
      shopperUserId: null,
      createdAtMs: input.nowMs,
    };
    this.rows.set(created.id, created);
    return created;
  }
  async findById(id: string): Promise<SellerUser | null> {
    return this.rows.get(id) ?? null;
  }
  async findByPhone(phoneE164: string): Promise<SellerUser | null> {
    return [...this.rows.values()].find((u) => u.phoneE164 === phoneE164) ?? null;
  }
  async markStrongFactor(id: string): Promise<void> {
    const u = this.rows.get(id);
    if (u !== undefined) this.rows.set(id, { ...u, strongFactor: true });
  }
  async linkShopper(id: string, shopperUserId: string): Promise<void> {
    const u = this.rows.get(id);
    if (u !== undefined) this.rows.set(id, { ...u, shopperUserId });
  }
  /** Test support. */
  suspend(id: string): void {
    const u = this.rows.get(id);
    if (u !== undefined) this.rows.set(id, { ...u, status: "suspended" });
  }
}

export class InMemorySellerOtpChallengeRepository implements SellerOtpChallengeRepository {
  private readonly rows = new Map<string, SellerOtpRecord>();
  async find(id: string): Promise<SellerOtpRecord | null> {
    return this.rows.get(id) ?? null;
  }
  async insert(record: SellerOtpRecord): Promise<void> {
    this.rows.set(record.challenge.id, { ...record, clientKey: await this.clientKeyOf(record.clientKey) });
  }
  async clientKeyOf(clientKey: string): Promise<string> {
    return clientKey.startsWith("ip:") ? "web" : clientKey;
  }
  async compareAndSet(previous: OtpChallenge, next: SellerOtpRecord): Promise<boolean> {
    const cur = this.rows.get(previous.id);
    if (cur === undefined || cur.challenge.attempts !== previous.attempts || cur.challenge.status !== previous.status) return false;
    this.rows.set(previous.id, next);
    return true;
  }
}

export class InMemorySellerOtpSendLog implements SellerOtpSendLog {
  private readonly rows: { phone: string; client: string; prefix: string; at: number; verified: boolean }[] = [];
  async history(phoneE164: string, clientKey: string, prefix: string, nowMs: number, prefixWindowMs: number): Promise<SellerOtpSendHistory> {
    const inPrefix = this.rows.filter((r) => r.prefix === prefix && r.at > nowMs - prefixWindowMs);
    return {
      phoneSendTimes: this.rows.filter((r) => r.phone === phoneE164).map((r) => r.at),
      clientSendTimes: this.rows.filter((r) => r.client === clientKey).map((r) => r.at),
      prefixSends: inPrefix.length,
      prefixVerified: inPrefix.filter((r) => r.verified).length,
    };
  }
  async record(phoneE164: string, clientKey: string, prefix: string, nowMs: number): Promise<void> {
    this.rows.push({ phone: phoneE164, client: clientKey, prefix, at: nowMs, verified: false });
  }
  async markVerified(phoneE164: string): Promise<void> {
    const last = [...this.rows].reverse().find((r) => r.phone === phoneE164);
    if (last !== undefined) last.verified = true;
  }
}

export class InMemorySellerOtpProofStore implements SellerOtpProofStore {
  private readonly rows = new Map<string, { proof: OtpProof; expiresAtMs: number; consumed: boolean }>();
  async put(proofHash: string, proof: OtpProof, expiresAtMs: number): Promise<void> {
    this.rows.set(proofHash, { proof, expiresAtMs, consumed: false });
  }
  async consume(proofHash: string, nowMs: number): Promise<OtpProof | null> {
    const r = this.rows.get(proofHash);
    if (r === undefined || r.consumed || nowMs >= r.expiresAtMs) return null;
    r.consumed = true;
    return r.proof;
  }
  async peek(proofHash: string, nowMs: number): Promise<OtpProof | null> {
    const r = this.rows.get(proofHash);
    return r === undefined || r.consumed || nowMs >= r.expiresAtMs ? null : r.proof;
  }
}

export class InMemorySellerPasskeyChallengeStore implements SellerPasskeyChallengeStore {
  private readonly rows = new Map<string, SellerPasskeyChallenge>();
  async put(record: SellerPasskeyChallenge): Promise<void> {
    this.rows.set(record.id, record);
  }
  async take(id: string, nowMs: number): Promise<SellerPasskeyChallenge | null> {
    const r = this.rows.get(id);
    if (r === undefined) return null;
    this.rows.delete(id);
    return nowMs < r.expiresAtMs ? r : null;
  }
  async peek(id: string, nowMs: number): Promise<SellerPasskeyChallenge | null> {
    const r = this.rows.get(id);
    return r !== undefined && nowMs < r.expiresAtMs ? r : null;
  }
}

export class InMemorySellerPasskeyRepository implements SellerPasskeyRepository {
  private readonly rows = new Map<string, SellerPasskey>();
  async insert(p: SellerPasskey): Promise<boolean> {
    if (this.rows.has(p.credentialId)) return false;
    this.rows.set(p.credentialId, p);
    return true;
  }
  async find(id: string): Promise<SellerPasskey | null> {
    return this.rows.get(id) ?? null;
  }
  async update(p: SellerPasskey): Promise<void> {
    this.rows.set(p.credentialId, p);
  }
  async listActive(sellerUserId: string): Promise<readonly SellerPasskey[]> {
    return [...this.rows.values()].filter((p) => p.sellerUserId === sellerUserId && p.status === "active");
  }
}

export class InMemorySellerTotpStore implements SellerTotpStore {
  private readonly rows = new Map<string, SellerTotpRecord>();
  private readonly codes = new Map<string, Map<string, boolean>>();
  async find(sellerUserId: string): Promise<SellerTotpRecord | null> {
    return this.rows.get(sellerUserId) ?? null;
  }
  async startEnrolment(record: SellerTotpRecord, recoveryHashes: readonly string[]): Promise<boolean> {
    if (this.rows.get(record.sellerUserId)?.status === "active") return false;
    this.rows.set(record.sellerUserId, record);
    this.codes.set(record.sellerUserId, new Map(recoveryHashes.map((h) => [h, false])));
    return true;
  }
  async acceptStep(sellerUserId: string, step: number, previousStep: number | null, activate: boolean): Promise<boolean> {
    const r = this.rows.get(sellerUserId);
    if (r === undefined || r.lastUsedStep !== previousStep) return false;
    this.rows.set(sellerUserId, { ...r, lastUsedStep: step, status: activate ? "active" : r.status });
    return true;
  }
  async recordFailure(sellerUserId: string, failedCount: number, lockCount: number, lockedUntilMs: number | null): Promise<void> {
    const r = this.rows.get(sellerUserId);
    if (r !== undefined) this.rows.set(sellerUserId, { ...r, failedCount, lockCount, lockedUntilMs });
  }
  async resetFailures(sellerUserId: string): Promise<void> {
    const r = this.rows.get(sellerUserId);
    if (r !== undefined) this.rows.set(sellerUserId, { ...r, failedCount: 0, lockCount: 0, lockedUntilMs: null });
  }
  async consumeRecoveryCode(sellerUserId: string, codeHash: string): Promise<boolean> {
    const m = this.codes.get(sellerUserId);
    if (m === undefined || m.get(codeHash) !== false) return false;
    m.set(codeHash, true);
    return true;
  }
  async remainingRecoveryCodes(sellerUserId: string): Promise<number> {
    return [...(this.codes.get(sellerUserId)?.values() ?? [])].filter((used) => !used).length;
  }
}

export class InMemorySellerSessionRepository implements SellerSessionRepository {
  private readonly rows = new Map<string, StoredSellerSession>();
  async insert(stored: StoredSellerSession): Promise<void> {
    this.rows.set(stored.session.id, stored);
  }
  async find(id: string): Promise<StoredSellerSession | null> {
    return this.rows.get(id) ?? null;
  }
  async save(stored: StoredSellerSession): Promise<void> {
    this.rows.set(stored.session.id, stored);
  }
  async findByRefreshHash(tokenHash: string): Promise<StoredSellerSession | null> {
    return [...this.rows.values()].find((s) => s.family?.records.some((r) => r.tokenHash === tokenHash) === true) ?? null;
  }
  async compareAndSave(previous: StoredSellerSession, next: StoredSellerSession): Promise<boolean> {
    const cur = this.rows.get(previous.session.id);
    if (cur === undefined) return false;
    const sig = (s: StoredSellerSession): string =>
      JSON.stringify([s.session.revokedAtMs, s.family?.revokedAtMs ?? null, s.family?.records.map((r) => [r.id, r.status]) ?? []]);
    if (sig(cur) !== sig(previous)) return false;
    this.rows.set(previous.session.id, next);
    return true;
  }
  async listBySeller(sellerUserId: string): Promise<readonly StoredSellerSession[]> {
    return [...this.rows.values()].filter((s) => s.session.sellerUserId === sellerUserId);
  }
}

export class InMemorySellerMembershipRepository implements SellerMembershipRepository {
  private readonly rows: (SellerMembership & { revokedAtMs: number | null })[] = [];
  async upsert(input: { id: string; sellerUserId: string; storeId: string; role: SellerMembership["role"]; grantedBy: string | null; nowMs: number }): Promise<SellerMembership> {
    const i = this.rows.findIndex((r) => r.sellerUserId === input.sellerUserId && r.storeId === input.storeId && r.revokedAtMs === null);
    const prev = i >= 0 ? this.rows[i] : undefined;
    if (prev !== undefined) {
      const next = { ...prev, role: input.role, grantedBy: input.grantedBy };
      this.rows[i] = next;
      return strip(next);
    }
    const row = { id: input.id, sellerUserId: input.sellerUserId, storeId: input.storeId, role: input.role, grantedBy: input.grantedBy, createdAtMs: input.nowMs, revokedAtMs: null };
    this.rows.push(row);
    return strip(row);
  }
  async revoke(input: { sellerUserId: string; storeId: string; nowMs: number }): Promise<"revoked" | "not_found" | "last_owner"> {
    const i = this.rows.findIndex((r) => r.sellerUserId === input.sellerUserId && r.storeId === input.storeId && r.revokedAtMs === null);
    const row = this.rows[i];
    if (row === undefined) return "not_found";
    if (row.role === "owner" && this.rows.filter((r) => r.storeId === input.storeId && r.role === "owner" && r.revokedAtMs === null).length <= 1) return "last_owner";
    this.rows[i] = { ...row, revokedAtMs: input.nowMs };
    return "revoked";
  }
  async listBySeller(sellerUserId: string): Promise<readonly SellerMembership[]> {
    return this.rows.filter((r) => r.sellerUserId === sellerUserId && r.revokedAtMs === null).map(strip);
  }
  async listByStore(storeId: string): Promise<readonly SellerMembership[]> {
    return this.rows.filter((r) => r.storeId === storeId && r.revokedAtMs === null).map(strip);
  }
}
const strip = (r: SellerMembership & { revokedAtMs: number | null }): SellerMembership => ({
  id: r.id,
  sellerUserId: r.sellerUserId,
  storeId: r.storeId,
  role: r.role,
  grantedBy: r.grantedBy,
  createdAtMs: r.createdAtMs,
});

export class InMemorySellerInviteRepository implements SellerInviteRepository {
  private readonly rows: (SellerInvite & { acceptedAtMs: number | null; revokedAtMs: number | null })[] = [];
  async upsertOpen(invite: SellerInvite): Promise<SellerInvite> {
    const i = this.rows.findIndex((r) => r.storeId === invite.storeId && r.phoneE164 === invite.phoneE164 && r.acceptedAtMs === null && r.revokedAtMs === null);
    const row = { ...invite, acceptedAtMs: null, revokedAtMs: null };
    if (i >= 0) {
      const prev = this.rows[i];
      row.id = prev?.id ?? invite.id;
      this.rows[i] = row;
    } else this.rows.push(row);
    return { ...invite, id: row.id };
  }
  async listOpenByPhone(phoneE164: string, nowMs: number): Promise<readonly SellerInvite[]> {
    return this.rows.filter((r) => r.phoneE164 === phoneE164 && r.acceptedAtMs === null && r.revokedAtMs === null && r.expiresAtMs > nowMs);
  }
  async markAccepted(id: string, nowMs: number): Promise<void> {
    const r = this.rows.find((x) => x.id === id);
    if (r !== undefined) r.acceptedAtMs = nowMs;
  }
  async revoke(storeId: string, phoneE164: string, nowMs: number): Promise<boolean> {
    const r = this.rows.find((x) => x.storeId === storeId && x.phoneE164 === phoneE164 && x.acceptedAtMs === null && x.revokedAtMs === null);
    if (r === undefined) return false;
    r.revokedAtMs = nowMs;
    return true;
  }
}

export class InMemorySellerAuthEvents implements SellerAuthEvents {
  readonly events: SellerAuthEvent[] = [];
  async publish(event: SellerAuthEvent): Promise<void> {
    this.events.push(event);
  }
}

export function createInMemorySellerStores(): SellerStores & { readonly usersImpl: InMemorySellerUserDirectory } {
  const users = new InMemorySellerUserDirectory();
  return {
    users,
    usersImpl: users,
    challenges: new InMemorySellerOtpChallengeRepository(),
    sendLog: new InMemorySellerOtpSendLog(),
    proofs: new InMemorySellerOtpProofStore(),
    passkeyChallenges: new InMemorySellerPasskeyChallengeStore(),
    passkeys: new InMemorySellerPasskeyRepository(),
    totp: new InMemorySellerTotpStore(),
    sessions: new InMemorySellerSessionRepository(),
    memberships: new InMemorySellerMembershipRepository(),
    invites: new InMemorySellerInviteRepository(),
  };
}
