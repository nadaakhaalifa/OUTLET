import { sql, type Kysely, type Transaction } from "kysely";
import type { OtpChallenge, RefreshRecord } from "@outlet/auth-core";
import type { BrandRole } from "@outlet/policy";
import { z } from "zod";
import type { FieldCipher, UserLanguage } from "../../domain/ports";
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
  SellerSessionRecord,
  SellerSessionRepository,
  SellerStores,
  SellerTotpRecord,
  SellerTotpStore,
  SellerUser,
  SellerUserDirectory,
  StoredSellerSession,
} from "../domain/ports";

export type SellerDb = Kysely<Record<string, never>>;
type Tx = Transaction<Record<string, never>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (ms: number): string => new Date(ms).toISOString();
const Ms = z.string().regex(/^-?\d+$/).transform((s) => Number(s));
const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const buf = (b: Uint8Array | null): Buffer | null => (b === null ? null : Buffer.from(b));

async function asSystem<T>(db: SellerDb, fn: (trx: Tx) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`select set_config('app.role', 'system', true)`.execute(trx);
    return fn(trx);
  });
}

class RetryLookup extends Error {}

// ---- Users --------------------------------------------------------------------------------

const UserRow = z.object({
  id: z.string(),
  phone_ciphertext: z.instanceof(Uint8Array),
  email_ciphertext: z.instanceof(Uint8Array).nullable(),
  locale: z.enum(["ar", "en"]),
  status: z.enum(["active", "suspended"]),
  strong_factor: z.boolean(),
  shopper_user_id: z.string().nullable(),
  created_ms: Ms,
});
const USER_COLS = sql`id::text as id, phone_ciphertext, email_ciphertext, locale, status, strong_factor, shopper_user_id::text as shopper_user_id,
  floor(extract(epoch from created_at) * 1000)::text as created_ms`;

export class KyselySellerUserDirectory implements SellerUserDirectory {
  constructor(
    private readonly db: SellerDb,
    private readonly cipher: FieldCipher,
  ) {}

  private async toUser(raw: unknown): Promise<SellerUser> {
    const r = UserRow.parse(raw);
    return {
      id: r.id,
      phoneE164: await this.cipher.decrypt(r.phone_ciphertext, "seller_users.phone"),
      email: r.email_ciphertext === null ? null : await this.cipher.decrypt(r.email_ciphertext, "seller_users.email"),
      language: r.locale,
      status: r.status,
      strongFactor: r.strong_factor,
      shopperUserId: r.shopper_user_id,
      createdAtMs: r.created_ms,
    };
  }

  async findById(id: string): Promise<SellerUser | null> {
    if (!UUID.test(id)) return null;
    const rows = await asSystem(this.db, async (trx) => (await sql`select ${USER_COLS} from seller_users where id = ${id}::uuid`.execute(trx)).rows);
    return rows[0] === undefined ? null : this.toUser(rows[0]);
  }

  async findByPhone(phoneE164: string): Promise<SellerUser | null> {
    const hash = await this.cipher.blindIndex("seller-phone", phoneE164);
    const rows = await asSystem(this.db, async (trx) => (await sql`select ${USER_COLS} from seller_users where phone_hash = ${Buffer.from(hash)}`.execute(trx)).rows);
    return rows[0] === undefined ? null : this.toUser(rows[0]);
  }

  async findOrCreateByPhone(input: { phoneE164: string; email: string | null; language: UserLanguage; newId: string; nowMs: number }): Promise<SellerUser> {
    const hash = await this.cipher.blindIndex("seller-phone", input.phoneE164);
    const phoneCt = await this.cipher.encrypt(input.phoneE164, "seller_users.phone");
    const emailCt = input.email === null ? null : await this.cipher.encrypt(input.email, "seller_users.email");
    const emailHash = input.email === null ? null : await this.cipher.blindIndex("seller-email", input.email.toLowerCase());
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const raw = await asSystem(this.db, async (trx) => {
          const existing = await sql`select ${USER_COLS} from seller_users where phone_hash = ${Buffer.from(hash)}`.execute(trx);
          if (existing.rows[0] !== undefined) return existing.rows[0];
          const ins = await sql`insert into seller_users (id, phone_hash, phone_ciphertext, email_ciphertext, email_hash, locale, status, strong_factor, created_at)
            values (${input.newId}::uuid, ${Buffer.from(hash)}, ${Buffer.from(phoneCt)}, ${buf(emailCt)}, ${buf(emailHash)}, ${input.language}, 'active', false, ${iso(input.nowMs)}::timestamptz)
            on conflict (phone_hash) do nothing returning id`.execute(trx);
          if (ins.rows.length === 0) throw new RetryLookup();
          return (await sql`select ${USER_COLS} from seller_users where id = ${input.newId}::uuid`.execute(trx)).rows[0];
        });
        return this.toUser(raw);
      } catch (error) {
        if (!(error instanceof RetryLookup)) throw error;
      }
    }
    throw new Error("could not resolve seller identity");
  }

  async markStrongFactor(id: string): Promise<void> {
    await asSystem(this.db, async (trx) => {
      await sql`update seller_users set strong_factor = true where id = ${id}::uuid`.execute(trx);
    });
  }

  async linkShopper(id: string, shopperUserId: string): Promise<void> {
    await asSystem(this.db, async (trx) => {
      await sql`update seller_users set shopper_user_id = ${shopperUserId}::uuid where id = ${id}::uuid`.execute(trx);
    });
  }
}

// ---- OTP ----------------------------------------------------------------------------------

const ChallengeRow = z.object({
  id: z.string(),
  phone_ciphertext: z.instanceof(Uint8Array),
  email_ciphertext: z.instanceof(Uint8Array).nullable(),
  locale: z.enum(["ar", "en"]),
  channel: z.enum(["sms", "whatsapp"]),
  client_key_hash: z.instanceof(Uint8Array),
  salt: z.string(),
  code_hash: z.string(),
  issued_ms: Ms,
  expires_ms: Ms,
  attempts: z.number().int(),
  status: z.enum(["pending", "consumed", "locked"]),
});

export class KyselySellerOtpChallengeRepository implements SellerOtpChallengeRepository {
  constructor(
    private readonly db: SellerDb,
    private readonly cipher: FieldCipher,
  ) {}

  async clientKeyOf(clientKey: string): Promise<string> {
    return hex(await this.cipher.blindIndex("seller-otp-client-bind", clientKey.startsWith("ip:") ? "web" : clientKey));
  }

  async find(id: string): Promise<SellerOtpRecord | null> {
    if (!UUID.test(id)) return null;
    const rows = await asSystem(this.db, async (trx) =>
      (await sql`select id::text as id, phone_ciphertext, email_ciphertext, locale, channel, client_key_hash, salt, code_hash,
          floor(extract(epoch from issued_at) * 1000)::text as issued_ms, floor(extract(epoch from expires_at) * 1000)::text as expires_ms, attempts, status
        from seller_otp_challenges where id = ${id}::uuid`.execute(trx)).rows,
    );
    if (rows[0] === undefined) return null;
    const r = ChallengeRow.parse(rows[0]);
    return {
      challenge: {
        id: r.id,
        phoneE164: await this.cipher.decrypt(r.phone_ciphertext, "seller_otp_challenges.phone"),
        salt: r.salt,
        codeHash: r.code_hash,
        issuedAtMs: r.issued_ms,
        expiresAtMs: r.expires_ms,
        attempts: r.attempts,
        status: r.status,
      },
      channel: r.channel,
      clientKey: hex(r.client_key_hash),
      email: r.email_ciphertext === null ? null : await this.cipher.decrypt(r.email_ciphertext, "seller_otp_challenges.email"),
      language: r.locale,
    };
  }

  async insert(record: SellerOtpRecord): Promise<void> {
    const c = record.challenge;
    const phoneHash = await this.cipher.blindIndex("seller-phone", c.phoneE164);
    const phoneCt = await this.cipher.encrypt(c.phoneE164, "seller_otp_challenges.phone");
    const emailCt = record.email === null ? null : await this.cipher.encrypt(record.email, "seller_otp_challenges.email");
    const clientHash = Buffer.from(await this.clientKeyOf(record.clientKey), "hex");
    await asSystem(this.db, async (trx) => {
      await sql`insert into seller_otp_challenges (id, phone_hash, phone_ciphertext, email_ciphertext, locale, channel, client_key_hash, salt, code_hash,
          issued_at, expires_at, attempts, status)
        values (${c.id}::uuid, ${Buffer.from(phoneHash)}, ${Buffer.from(phoneCt)}, ${buf(emailCt)}, ${record.language}, ${record.channel}, ${Buffer.from(clientHash)},
          ${c.salt}, ${c.codeHash}, ${iso(c.issuedAtMs)}::timestamptz, ${iso(c.expiresAtMs)}::timestamptz, ${c.attempts}, ${c.status})`.execute(trx);
    });
  }

  async compareAndSet(previous: OtpChallenge, next: SellerOtpRecord): Promise<boolean> {
    return asSystem(this.db, async (trx) => {
      const r = await sql`update seller_otp_challenges set attempts = ${next.challenge.attempts}, status = ${next.challenge.status}
        where id = ${previous.id}::uuid and attempts = ${previous.attempts} and status = ${previous.status} returning id`.execute(trx);
      return r.rows.length === 1;
    });
  }
}

const Count = z.object({ n: z.coerce.number() });

export class KyselySellerOtpSendLog implements SellerOtpSendLog {
  constructor(
    private readonly db: SellerDb,
    private readonly cipher: FieldCipher,
  ) {}

  async history(phoneE164: string, clientKey: string, prefix: string, nowMs: number, prefixWindowMs: number): Promise<SellerOtpSendHistory> {
    const ph = Buffer.from(await this.cipher.blindIndex("seller-phone", phoneE164));
    const ch = Buffer.from(await this.cipher.blindIndex("seller-otp-client", clientKey));
    return asSystem(this.db, async (trx) => {
      const since = iso(nowMs - 86_400_000);
      const phone = await sql`select floor(extract(epoch from sent_at) * 1000)::text as t from seller_otp_send_log where phone_hash = ${ph} and sent_at > ${since}::timestamptz`.execute(trx);
      const client = await sql`select floor(extract(epoch from sent_at) * 1000)::text as t from seller_otp_send_log where client_hash = ${ch} and sent_at > ${since}::timestamptz`.execute(trx);
      const pfx = await sql`select count(*)::int as n, count(*) filter (where verified)::int as v from seller_otp_send_log
        where prefix = ${prefix} and sent_at > ${iso(nowMs - prefixWindowMs)}::timestamptz`.execute(trx);
      const row = z.object({ n: z.number(), v: z.number() }).parse(pfx.rows[0]);
      return {
        phoneSendTimes: phone.rows.map((r) => Ms.parse((r as { t: string }).t)),
        clientSendTimes: client.rows.map((r) => Ms.parse((r as { t: string }).t)),
        prefixSends: row.n,
        prefixVerified: row.v,
      };
    });
  }

  async record(phoneE164: string, clientKey: string, prefix: string, nowMs: number): Promise<void> {
    const ph = Buffer.from(await this.cipher.blindIndex("seller-phone", phoneE164));
    const ch = Buffer.from(await this.cipher.blindIndex("seller-otp-client", clientKey));
    await asSystem(this.db, async (trx) => {
      await sql`insert into seller_otp_send_log (phone_hash, client_hash, prefix, sent_at) values (${ph}, ${ch}, ${prefix}, ${iso(nowMs)}::timestamptz)`.execute(trx);
    });
  }

  async markVerified(phoneE164: string): Promise<void> {
    const ph = Buffer.from(await this.cipher.blindIndex("seller-phone", phoneE164));
    await asSystem(this.db, async (trx) => {
      await sql`update seller_otp_send_log set verified = true where id = (select id from seller_otp_send_log where phone_hash = ${ph} order by sent_at desc, id desc limit 1)`.execute(trx);
    });
  }
}

export class KyselySellerOtpProofStore implements SellerOtpProofStore {
  constructor(private readonly db: SellerDb) {}

  async put(proofHash: string, proof: OtpProof, expiresAtMs: number): Promise<void> {
    await asSystem(this.db, async (trx) => {
      await sql`insert into seller_otp_proofs (proof_hash, seller_user_id, otp_channel, expires_at)
        values (${proofHash}, ${proof.sellerUserId}::uuid, ${proof.channel}, ${iso(expiresAtMs)}::timestamptz)`.execute(trx);
    });
  }

  private parse(rows: readonly unknown[]): OtpProof | null {
    const r = rows[0];
    if (r === undefined) return null;
    const p = z.object({ seller_user_id: z.string(), otp_channel: z.enum(["sms", "whatsapp"]) }).parse(r);
    return { sellerUserId: p.seller_user_id, channel: p.otp_channel };
  }

  async consume(proofHash: string, nowMs: number): Promise<OtpProof | null> {
    return this.parse(
      await asSystem(this.db, async (trx) =>
        (await sql`update seller_otp_proofs set consumed_at = ${iso(nowMs)}::timestamptz
          where proof_hash = ${proofHash} and consumed_at is null and expires_at > ${iso(nowMs)}::timestamptz
          returning seller_user_id::text as seller_user_id, otp_channel`.execute(trx)).rows,
      ),
    );
  }

  async peek(proofHash: string, nowMs: number): Promise<OtpProof | null> {
    return this.parse(
      await asSystem(this.db, async (trx) =>
        (await sql`select seller_user_id::text as seller_user_id, otp_channel from seller_otp_proofs
          where proof_hash = ${proofHash} and consumed_at is null and expires_at > ${iso(nowMs)}::timestamptz`.execute(trx)).rows,
      ),
    );
  }
}

// ---- Passkeys -----------------------------------------------------------------------------

const PkChallengeRow = z.object({
  id: z.string(),
  challenge: z.string(),
  purpose: z.enum(["register", "assert"]),
  seller_user_id: z.string(),
  otp_channel: z.enum(["sms", "whatsapp"]).nullable(),
  expires_ms: Ms,
});
const toPkChallenge = (raw: unknown): SellerPasskeyChallenge => {
  const r = PkChallengeRow.parse(raw);
  return { id: r.id, challenge: r.challenge, purpose: r.purpose, sellerUserId: r.seller_user_id, otpChannel: r.otp_channel, expiresAtMs: r.expires_ms };
};

export class KyselySellerPasskeyChallengeStore implements SellerPasskeyChallengeStore {
  constructor(private readonly db: SellerDb) {}

  async put(r: SellerPasskeyChallenge): Promise<void> {
    await asSystem(this.db, async (trx) => {
      await sql`insert into seller_passkey_challenges (id, challenge, purpose, seller_user_id, otp_channel, expires_at)
        values (${r.id}::uuid, ${r.challenge}, ${r.purpose}, ${r.sellerUserId}::uuid, ${r.otpChannel}, ${iso(r.expiresAtMs)}::timestamptz)`.execute(trx);
    });
  }

  async take(id: string, nowMs: number): Promise<SellerPasskeyChallenge | null> {
    if (!UUID.test(id)) return null;
    const rows = await asSystem(this.db, async (trx) =>
      (await sql`delete from seller_passkey_challenges where id = ${id}::uuid
        returning id::text as id, challenge, purpose, seller_user_id::text as seller_user_id, otp_channel, floor(extract(epoch from expires_at) * 1000)::text as expires_ms`.execute(trx)).rows,
    );
    if (rows[0] === undefined) return null;
    const c = toPkChallenge(rows[0]);
    return nowMs < c.expiresAtMs ? c : null;
  }

  async peek(id: string, nowMs: number): Promise<SellerPasskeyChallenge | null> {
    if (!UUID.test(id)) return null;
    const rows = await asSystem(this.db, async (trx) =>
      (await sql`select id::text as id, challenge, purpose, seller_user_id::text as seller_user_id, otp_channel, floor(extract(epoch from expires_at) * 1000)::text as expires_ms
        from seller_passkey_challenges where id = ${id}::uuid`.execute(trx)).rows,
    );
    if (rows[0] === undefined) return null;
    const c = toPkChallenge(rows[0]);
    return nowMs < c.expiresAtMs ? c : null;
  }
}

const PkRow = z.object({
  credential_id: z.string(),
  seller_user_id: z.string(),
  public_key: z.string(),
  sign_count: z.string().regex(/^\d+$/).transform(Number),
  status: z.enum(["active", "suspected_clone"]),
  backup_eligible: z.boolean(),
  backed_up: z.boolean(),
  label: z.string().nullable(),
  created_ms: Ms,
});
const PK_COLS = sql`credential_id, seller_user_id::text as seller_user_id, public_key, sign_count::text as sign_count, status, backup_eligible, backed_up, label,
  floor(extract(epoch from created_at) * 1000)::text as created_ms`;
const toPk = (raw: unknown): SellerPasskey => {
  const r = PkRow.parse(raw);
  return {
    sellerUserId: r.seller_user_id,
    credentialId: r.credential_id,
    publicKey: r.public_key,
    signCount: r.sign_count,
    backupEligible: r.backup_eligible,
    backedUp: r.backed_up,
    status: r.status,
    label: r.label,
    createdAtMs: r.created_ms,
  };
};

export class KyselySellerPasskeyRepository implements SellerPasskeyRepository {
  constructor(private readonly db: SellerDb) {}

  async insert(p: SellerPasskey): Promise<boolean> {
    return asSystem(this.db, async (trx) => {
      const r = await sql`insert into seller_passkey_credentials (credential_id, seller_user_id, public_key, sign_count, status, backup_eligible, backed_up, label, created_at)
        values (${p.credentialId}, ${p.sellerUserId}::uuid, ${p.publicKey}, ${p.signCount}, ${p.status}, ${p.backupEligible}, ${p.backedUp}, ${p.label}, ${iso(p.createdAtMs)}::timestamptz)
        on conflict (credential_id) do nothing returning credential_id`.execute(trx);
      return r.rows.length === 1;
    });
  }
  async find(credentialId: string): Promise<SellerPasskey | null> {
    const rows = await asSystem(this.db, async (trx) => (await sql`select ${PK_COLS} from seller_passkey_credentials where credential_id = ${credentialId}`.execute(trx)).rows);
    return rows[0] === undefined ? null : toPk(rows[0]);
  }
  async update(p: SellerPasskey): Promise<void> {
    await asSystem(this.db, async (trx) => {
      await sql`update seller_passkey_credentials set sign_count = ${p.signCount}, status = ${p.status}, backed_up = ${p.backedUp} where credential_id = ${p.credentialId}`.execute(trx);
    });
  }
  async listActive(sellerUserId: string): Promise<readonly SellerPasskey[]> {
    const rows = await asSystem(this.db, async (trx) =>
      (await sql`select ${PK_COLS} from seller_passkey_credentials where seller_user_id = ${sellerUserId}::uuid and status = 'active' order by created_at`.execute(trx)).rows,
    );
    return rows.map(toPk);
  }
}

// ---- TOTP ---------------------------------------------------------------------------------

const TotpRow = z.object({
  seller_user_id: z.string(),
  secret_ciphertext: z.instanceof(Uint8Array),
  status: z.enum(["pending", "active"]),
  last_used_step: z.string().nullable(),
  failed_count: z.number().int(),
  lock_count: z.number().int(),
  locked_ms: Ms.nullable(),
  created_ms: Ms,
});

export class KyselySellerTotpStore implements SellerTotpStore {
  constructor(
    private readonly db: SellerDb,
    private readonly cipher: FieldCipher,
  ) {}

  async find(sellerUserId: string): Promise<SellerTotpRecord | null> {
    const rows = await asSystem(this.db, async (trx) =>
      (await sql`select seller_user_id::text as seller_user_id, secret_ciphertext, status, last_used_step::text as last_used_step, failed_count, lock_count,
          floor(extract(epoch from locked_until) * 1000)::text as locked_ms, floor(extract(epoch from created_at) * 1000)::text as created_ms
        from seller_totp where seller_user_id = ${sellerUserId}::uuid`.execute(trx)).rows,
    );
    if (rows[0] === undefined) return null;
    const r = TotpRow.parse(rows[0]);
    return {
      sellerUserId: r.seller_user_id,
      secretBase32: await this.cipher.decrypt(r.secret_ciphertext, "seller_totp.secret"),
      status: r.status,
      lastUsedStep: r.last_used_step === null ? null : Number(r.last_used_step),
      failedCount: r.failed_count,
      lockCount: r.lock_count,
      lockedUntilMs: r.locked_ms,
      createdAtMs: r.created_ms,
    };
  }

  async startEnrolment(record: SellerTotpRecord, recoveryHashes: readonly string[]): Promise<boolean> {
    const ct = await this.cipher.encrypt(record.secretBase32, "seller_totp.secret");
    return asSystem(this.db, async (trx) => {
      const active = await sql`select 1 from seller_totp where seller_user_id = ${record.sellerUserId}::uuid and status = 'active' for update`.execute(trx);
      if (active.rows.length > 0) return false;
      await sql`delete from seller_recovery_codes where seller_user_id = ${record.sellerUserId}::uuid`.execute(trx);
      await sql`insert into seller_totp (seller_user_id, secret_ciphertext, status, last_used_step, failed_count, lock_count, locked_until, created_at)
        values (${record.sellerUserId}::uuid, ${Buffer.from(ct)}, 'pending', null, 0, 0, null, ${iso(record.createdAtMs)}::timestamptz)
        on conflict (seller_user_id) do update set secret_ciphertext = excluded.secret_ciphertext, status = 'pending', last_used_step = null,
          failed_count = 0, lock_count = 0, locked_until = null, created_at = excluded.created_at, confirmed_at = null`.execute(trx);
      for (const h of recoveryHashes) {
        await sql`insert into seller_recovery_codes (seller_user_id, code_hash) values (${record.sellerUserId}::uuid, ${h})`.execute(trx);
      }
      return true;
    });
  }

  async acceptStep(sellerUserId: string, step: number, previousStep: number | null, activate: boolean, nowMs: number): Promise<boolean> {
    return asSystem(this.db, async (trx) => {
      const r = await sql`update seller_totp set last_used_step = ${step},
          status = case when ${activate} then 'active' else status end,
          confirmed_at = case when ${activate} then ${iso(nowMs)}::timestamptz else confirmed_at end
        where seller_user_id = ${sellerUserId}::uuid and last_used_step is not distinct from ${previousStep}::bigint returning seller_user_id`.execute(trx);
      return r.rows.length === 1;
    });
  }

  async recordFailure(sellerUserId: string, failedCount: number, lockCount: number, lockedUntilMs: number | null): Promise<void> {
    await asSystem(this.db, async (trx) => {
      await sql`update seller_totp set failed_count = ${failedCount}, lock_count = ${lockCount},
        locked_until = ${lockedUntilMs === null ? null : iso(lockedUntilMs)}::timestamptz where seller_user_id = ${sellerUserId}::uuid`.execute(trx);
    });
  }

  async resetFailures(sellerUserId: string): Promise<void> {
    await asSystem(this.db, async (trx) => {
      await sql`update seller_totp set failed_count = 0, lock_count = 0, locked_until = null where seller_user_id = ${sellerUserId}::uuid`.execute(trx);
    });
  }

  async consumeRecoveryCode(sellerUserId: string, codeHash: string, nowMs: number): Promise<boolean> {
    return asSystem(this.db, async (trx) => {
      const r = await sql`update seller_recovery_codes set used_at = ${iso(nowMs)}::timestamptz
        where seller_user_id = ${sellerUserId}::uuid and code_hash = ${codeHash} and used_at is null returning code_hash`.execute(trx);
      return r.rows.length === 1;
    });
  }

  async remainingRecoveryCodes(sellerUserId: string): Promise<number> {
    const rows = await asSystem(this.db, async (trx) =>
      (await sql`select count(*)::int as n from seller_recovery_codes where seller_user_id = ${sellerUserId}::uuid and used_at is null`.execute(trx)).rows,
    );
    return Count.parse(rows[0]).n;
  }
}

// ---- Sessions -----------------------------------------------------------------------------

const SessRow = z.object({
  id: z.string(),
  seller_user_id: z.string(),
  kind: z.enum(["enrol", "full"]),
  restricted: z.boolean(),
  install_id: z.string(),
  amr: z.array(z.string()),
  strong_ms: Ms.nullable(),
  created_ms: Ms,
  used_ms: Ms,
  expires_ms: Ms.nullable(),
  revoked_ms: Ms.nullable(),
  revoke_reason: z.string().nullable(),
});
const TokRow = z.object({
  id: z.string(),
  refresh_hash: z.instanceof(Uint8Array),
  issued_ms: Ms,
  expires_ms: Ms,
  used_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
});
const SESS_COLS = sql`id::text as id, seller_user_id::text as seller_user_id, kind, restricted, install_id, amr,
  floor(extract(epoch from strong_at) * 1000)::text as strong_ms, floor(extract(epoch from created_at) * 1000)::text as created_ms,
  floor(extract(epoch from last_used_at) * 1000)::text as used_ms, floor(extract(epoch from expires_at) * 1000)::text as expires_ms,
  floor(extract(epoch from revoked_at) * 1000)::text as revoked_ms, revoke_reason`;

type FamilyReason = NonNullable<StoredSellerSession["family"]>["revokeReason"];
const FAMILY_REASONS: readonly string[] = ["reuse_detected", "device_mismatch", "logout", "admin"];

export class KyselySellerSessionRepository implements SellerSessionRepository {
  constructor(private readonly db: SellerDb) {}

  private async hydrate(trx: Tx, raw: unknown): Promise<StoredSellerSession> {
    const r = SessRow.parse(raw);
    const session: SellerSessionRecord = {
      id: r.id,
      sellerUserId: r.seller_user_id,
      kind: r.kind,
      restricted: r.restricted,
      installId: r.install_id,
      amr: r.amr as SellerSessionRecord["amr"],
      strongAtMs: r.strong_ms,
      createdAtMs: r.created_ms,
      lastUsedAtMs: r.used_ms,
      expiresAtMs: r.expires_ms,
      revokedAtMs: r.revoked_ms,
    };
    if (r.kind === "enrol") return { session, family: null };
    const toks = await sql`select id::text as id, refresh_hash, floor(extract(epoch from issued_at) * 1000)::text as issued_ms,
        floor(extract(epoch from expires_at) * 1000)::text as expires_ms, used_at::text as used_at, revoked_at::text as revoked_at
      from seller_refresh_tokens where session_id = ${r.id}::uuid order by rotation_no`.execute(trx);
    const records: RefreshRecord[] = toks.rows.map((row) => {
      const x = TokRow.parse(row);
      return {
        id: x.id,
        tokenHash: hex(x.refresh_hash),
        issuedAtMs: x.issued_ms,
        expiresAtMs: x.expires_ms,
        status: x.revoked_at !== null ? "revoked" : x.used_at !== null ? "rotated" : "active",
      };
    });
    const reason: FamilyReason = r.revoke_reason !== null && FAMILY_REASONS.includes(r.revoke_reason) ? (r.revoke_reason as FamilyReason) : r.revoke_reason === null ? null : "admin";
    return {
      session,
      family: { familyId: r.id, userId: r.seller_user_id, deviceId: r.install_id, records, revokedAtMs: r.revoked_ms, revokeReason: reason },
    };
  }

  private async write(trx: Tx, s: StoredSellerSession): Promise<void> {
    const reason = s.session.revokedAtMs === null ? null : s.family?.revokeReason ?? "logout";
    await sql`update seller_sessions set last_used_at = ${iso(s.session.lastUsedAtMs)}::timestamptz,
        revoked_at = ${s.session.revokedAtMs === null ? null : iso(s.session.revokedAtMs)}::timestamptz,
        revoke_reason = ${reason === null ? null : reason === "admin" ? "admin" : reason} where id = ${s.session.id}::uuid`.execute(trx);
    if (s.family === null) return;
    const stamp = iso(Math.max(s.session.lastUsedAtMs, s.family.records.reduce((m, r) => Math.max(m, r.issuedAtMs), 0)));
    for (const [i, r] of s.family.records.entries()) {
      await sql`insert into seller_refresh_tokens (id, session_id, refresh_hash, rotation_no, issued_at, expires_at, used_at, revoked_at)
        values (${r.id}::uuid, ${s.session.id}::uuid, ${Buffer.from(r.tokenHash, "hex")}, ${i}, ${iso(r.issuedAtMs)}::timestamptz, ${iso(r.expiresAtMs)}::timestamptz,
          ${r.status === "rotated" ? stamp : null}::timestamptz, ${r.status === "revoked" ? stamp : null}::timestamptz)
        on conflict (id) do update set used_at = coalesce(seller_refresh_tokens.used_at, excluded.used_at),
          revoked_at = coalesce(seller_refresh_tokens.revoked_at, excluded.revoked_at)`.execute(trx);
    }
  }

  async insert(s: StoredSellerSession): Promise<void> {
    await asSystem(this.db, async (trx) => {
      const x = s.session;
      await sql`insert into seller_sessions (id, seller_user_id, kind, restricted, install_id, amr, strong_at, created_at, last_used_at, expires_at)
        values (${x.id}::uuid, ${x.sellerUserId}::uuid, ${x.kind}, ${x.restricted}, ${x.installId}, ${sql.raw("ARRAY[")}${sql.join(x.amr.map((a) => sql`${a}`))}${sql.raw("]::text[]")},
          ${x.strongAtMs === null ? null : iso(x.strongAtMs)}::timestamptz, ${iso(x.createdAtMs)}::timestamptz, ${iso(x.lastUsedAtMs)}::timestamptz,
          ${x.expiresAtMs === null ? null : iso(x.expiresAtMs)}::timestamptz)`.execute(trx);
      await this.write(trx, s);
    });
  }

  async find(sessionId: string): Promise<StoredSellerSession | null> {
    if (!UUID.test(sessionId)) return null;
    return asSystem(this.db, async (trx) => {
      const r = await sql`select ${SESS_COLS} from seller_sessions where id = ${sessionId}::uuid`.execute(trx);
      return r.rows[0] === undefined ? null : this.hydrate(trx, r.rows[0]);
    });
  }

  async save(s: StoredSellerSession): Promise<void> {
    await asSystem(this.db, async (trx) => this.write(trx, s));
  }

  async findByRefreshHash(tokenHash: string): Promise<StoredSellerSession | null> {
    if (!/^[0-9a-f]{64}$/.test(tokenHash)) return null;
    return asSystem(this.db, async (trx) => {
      const r = await sql`select ${SESS_COLS} from seller_sessions where id = (select session_id from seller_refresh_tokens where refresh_hash = ${Buffer.from(tokenHash, "hex")})`.execute(trx);
      return r.rows[0] === undefined ? null : this.hydrate(trx, r.rows[0]);
    });
  }

  async compareAndSave(previous: StoredSellerSession, next: StoredSellerSession): Promise<boolean> {
    return asSystem(this.db, async (trx) => {
      const lock = await sql`select ${SESS_COLS} from seller_sessions where id = ${previous.session.id}::uuid for update`.execute(trx);
      if (lock.rows[0] === undefined) return false;
      const cur = await this.hydrate(trx, lock.rows[0]);
      const sig = (s: StoredSellerSession): string =>
        JSON.stringify([s.session.revokedAtMs, s.family?.revokedAtMs ?? null, s.family?.records.map((r) => [r.id, r.status]) ?? []]);
      if (sig(cur) !== sig(previous)) return false;
      await this.write(trx, next);
      return true;
    });
  }

  async listBySeller(sellerUserId: string): Promise<readonly StoredSellerSession[]> {
    return asSystem(this.db, async (trx) => {
      const r = await sql`select ${SESS_COLS} from seller_sessions where seller_user_id = ${sellerUserId}::uuid order by created_at desc`.execute(trx);
      const out: StoredSellerSession[] = [];
      for (const row of r.rows) out.push(await this.hydrate(trx, row));
      return out;
    });
  }
}

// ---- Memberships and invites --------------------------------------------------------------

const MemRow = z.object({
  id: z.string(),
  seller_user_id: z.string(),
  store_id: z.string(),
  role: z.enum(["owner", "manager", "catalog", "warehouse", "finance", "support"]),
  granted_by: z.string().nullable(),
  created_ms: Ms,
});
const MEM_COLS = sql`id::text as id, seller_user_id::text as seller_user_id, store_id::text as store_id, role, granted_by::text as granted_by,
  floor(extract(epoch from created_at) * 1000)::text as created_ms`;
const toMem = (raw: unknown): SellerMembership => {
  const r = MemRow.parse(raw);
  return { id: r.id, sellerUserId: r.seller_user_id, storeId: r.store_id, role: r.role, grantedBy: r.granted_by, createdAtMs: r.created_ms };
};

export class KyselySellerMembershipRepository implements SellerMembershipRepository {
  constructor(private readonly db: SellerDb) {}

  async upsert(input: { id: string; sellerUserId: string; storeId: string; role: BrandRole; grantedBy: string | null; nowMs: number }): Promise<SellerMembership> {
    return asSystem(this.db, async (trx) => {
      const upd = await sql`update seller_memberships set role = ${input.role}, granted_by = ${input.grantedBy}::uuid
        where seller_user_id = ${input.sellerUserId}::uuid and store_id = ${input.storeId}::uuid and revoked_at is null returning ${MEM_COLS}`.execute(trx);
      if (upd.rows[0] !== undefined) return toMem(upd.rows[0]);
      const ins = await sql`insert into seller_memberships (id, seller_user_id, store_id, role, granted_by, created_at)
        values (${input.id}::uuid, ${input.sellerUserId}::uuid, ${input.storeId}::uuid, ${input.role}, ${input.grantedBy}::uuid, ${iso(input.nowMs)}::timestamptz) returning ${MEM_COLS}`.execute(trx);
      return toMem(ins.rows[0]);
    });
  }

  async revoke(input: { sellerUserId: string; storeId: string; nowMs: number }): Promise<"revoked" | "not_found" | "last_owner"> {
    return asSystem(this.db, async (trx) => {
      // Lock the store's active owner rows so two concurrent removals cannot both pass the last-owner check.
      await sql`select 1 from seller_memberships where store_id = ${input.storeId}::uuid and revoked_at is null for update`.execute(trx);
      const mine = await sql`select role from seller_memberships where seller_user_id = ${input.sellerUserId}::uuid and store_id = ${input.storeId}::uuid and revoked_at is null`.execute(trx);
      const role = (mine.rows[0] as { role: string } | undefined)?.role;
      if (role === undefined) return "not_found";
      if (role === "owner") {
        const owners = await sql`select count(*)::int as n from seller_memberships where store_id = ${input.storeId}::uuid and role = 'owner' and revoked_at is null`.execute(trx);
        if (Count.parse(owners.rows[0]).n <= 1) return "last_owner";
      }
      await sql`update seller_memberships set revoked_at = ${iso(input.nowMs)}::timestamptz
        where seller_user_id = ${input.sellerUserId}::uuid and store_id = ${input.storeId}::uuid and revoked_at is null`.execute(trx);
      return "revoked";
    });
  }

  async listBySeller(sellerUserId: string): Promise<readonly SellerMembership[]> {
    const rows = await asSystem(this.db, async (trx) =>
      (await sql`select ${MEM_COLS} from seller_memberships where seller_user_id = ${sellerUserId}::uuid and revoked_at is null order by created_at`.execute(trx)).rows,
    );
    return rows.map(toMem);
  }

  async listByStore(storeId: string): Promise<readonly SellerMembership[]> {
    const rows = await asSystem(this.db, async (trx) =>
      (await sql`select ${MEM_COLS} from seller_memberships where store_id = ${storeId}::uuid and revoked_at is null order by created_at`.execute(trx)).rows,
    );
    return rows.map(toMem);
  }
}

export class KyselySellerInviteRepository implements SellerInviteRepository {
  constructor(
    private readonly db: SellerDb,
    private readonly cipher: FieldCipher,
  ) {}

  async upsertOpen(invite: SellerInvite): Promise<SellerInvite> {
    const hash = Buffer.from(await this.cipher.blindIndex("seller-phone", invite.phoneE164));
    const ct = Buffer.from(await this.cipher.encrypt(invite.phoneE164, "seller_staff_invites.phone"));
    return asSystem(this.db, async (trx) => {
      const upd = await sql`update seller_staff_invites set role = ${invite.role}, invited_by = ${invite.invitedBy}::uuid, expires_at = ${iso(invite.expiresAtMs)}::timestamptz
        where store_id = ${invite.storeId}::uuid and phone_hash = ${hash} and accepted_at is null and revoked_at is null returning id::text as id`.execute(trx);
      const existing = (upd.rows[0] as { id: string } | undefined)?.id;
      if (existing !== undefined) return { ...invite, id: existing };
      await sql`insert into seller_staff_invites (id, store_id, role, phone_hash, phone_ciphertext, invited_by, created_at, expires_at)
        values (${invite.id}::uuid, ${invite.storeId}::uuid, ${invite.role}, ${hash}, ${ct}, ${invite.invitedBy}::uuid, ${iso(invite.createdAtMs)}::timestamptz, ${iso(invite.expiresAtMs)}::timestamptz)`.execute(trx);
      return invite;
    });
  }

  async listOpenByPhone(phoneE164: string, nowMs: number): Promise<readonly SellerInvite[]> {
    const hash = Buffer.from(await this.cipher.blindIndex("seller-phone", phoneE164));
    const rows = await asSystem(this.db, async (trx) =>
      (await sql`select id::text as id, store_id::text as store_id, role, invited_by::text as invited_by, floor(extract(epoch from created_at) * 1000)::text as created_ms,
          floor(extract(epoch from expires_at) * 1000)::text as expires_ms
        from seller_staff_invites where phone_hash = ${hash} and accepted_at is null and revoked_at is null and expires_at > ${iso(nowMs)}::timestamptz`.execute(trx)).rows,
    );
    return rows.map((raw) => {
      const r = z.object({ id: z.string(), store_id: z.string(), role: z.enum(["owner", "manager", "catalog", "warehouse", "finance", "support"]), invited_by: z.string(), created_ms: Ms, expires_ms: Ms }).parse(raw);
      return { id: r.id, storeId: r.store_id, role: r.role, phoneE164, invitedBy: r.invited_by, createdAtMs: r.created_ms, expiresAtMs: r.expires_ms };
    });
  }

  async markAccepted(id: string, nowMs: number): Promise<void> {
    await asSystem(this.db, async (trx) => {
      await sql`update seller_staff_invites set accepted_at = ${iso(nowMs)}::timestamptz where id = ${id}::uuid and accepted_at is null`.execute(trx);
    });
  }

  async revoke(storeId: string, phoneE164: string, nowMs: number): Promise<boolean> {
    const hash = Buffer.from(await this.cipher.blindIndex("seller-phone", phoneE164));
    return asSystem(this.db, async (trx) => {
      const r = await sql`update seller_staff_invites set revoked_at = ${iso(nowMs)}::timestamptz
        where store_id = ${storeId}::uuid and phone_hash = ${hash} and accepted_at is null and revoked_at is null returning id`.execute(trx);
      return r.rows.length > 0;
    });
  }
}

// ---- Events (outbox) ----------------------------------------------------------------------

export class KyselySellerAuthEvents implements SellerAuthEvents {
  constructor(
    private readonly db: SellerDb,
    private readonly newId: () => string,
  ) {}

  async publish(event: SellerAuthEvent): Promise<void> {
    const id = this.newId();
    const aggregateId = "sellerUserId" in event ? event.sellerUserId : id;
    const { type, occurredAtMs, ...rest } = event;
    const payload = { ...Object.fromEntries(Object.entries(rest).map(([k, v]) => [k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`), v])), occurred_at: iso(occurredAtMs) };
    await asSystem(this.db, async (trx) => {
      await sql`insert into outbox_events (id, occurred_at, aggregate_type, aggregate_id, event_type, ordering_key, payload)
        values (${id}::uuid, ${iso(occurredAtMs)}::timestamptz, 'seller_user', ${aggregateId}::uuid, ${type}, ${`seller_user:${aggregateId}`}, ${JSON.stringify(payload)}::jsonb)`.execute(trx);
    });
  }
}

export function createKyselySellerStores(db: SellerDb, cipher: FieldCipher): SellerStores {
  return {
    users: new KyselySellerUserDirectory(db, cipher),
    challenges: new KyselySellerOtpChallengeRepository(db, cipher),
    sendLog: new KyselySellerOtpSendLog(db, cipher),
    proofs: new KyselySellerOtpProofStore(db),
    passkeyChallenges: new KyselySellerPasskeyChallengeStore(db),
    passkeys: new KyselySellerPasskeyRepository(db),
    totp: new KyselySellerTotpStore(db, cipher),
    sessions: new KyselySellerSessionRepository(db),
    memberships: new KyselySellerMembershipRepository(db),
    invites: new KyselySellerInviteRepository(db, cipher),
  };
}
