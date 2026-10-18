import { sql, type Kysely, type Transaction } from "kysely";
import type { OtpChallenge, RefreshRecord, SendHistory, Session } from "@outlet/auth-core";
import { z } from "zod";
import type {
  AgeGateStore,
  AgePassInfo,
  AuthEvent,
  AuthEventPublisher,
  FieldCipher,
  NonceStore,
  OtpChallengeRecord,
  OtpChallengeRepository,
  OtpSendLog,
  PasskeyChallengeRecord,
  PasskeyChallengeStore,
  PasskeyCredentialRepository,
  SessionRepository,
  StoredPasskey,
  StoredSession,
  User,
  UserDirectory,
  UserLanguage,
} from "../domain/ports";
import { AccountUnavailableError } from "../domain/ports";

/** Raw SQL only, rows validated with Zod (same approach as the other Kysely adapters). */
export type AuthDb = Kysely<Record<string, never>>;
type Tx = Transaction<Record<string, never>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (ms: number): string => new Date(ms).toISOString();
const Int = z.string().regex(/^-?\d+$/);
const Ms = Int.transform((s) => Number(s));
const EPOCH_MS = (col: string) => sql.raw(`floor(extract(epoch from ${col}) * 1000)::text`);
const bytes = (v: unknown): Uint8Array => {
  if (v instanceof Uint8Array) return new Uint8Array(v);
  throw new Error("expected bytea");
};
const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

/** Every statement runs as the `system` role: the auth flows run before a user identity exists. */
async function asSystem<T>(db: AuthDb, fn: (trx: Tx) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`select set_config('app.role', 'system', true)`.execute(trx);
    return fn(trx);
  });
}

class RetryLookup extends Error {}

// ---- Users --------------------------------------------------------------------------------

const UserRow = z.object({
  id: z.string(),
  locale: z.enum(["ar", "en"]),
  status: z.literal("active"),
  created_ms: Ms,
  age_band: z.enum(["18_20", "21_plus"]).nullable(),
  limited_capacity: z.boolean(),
  email_ciphertext: z.instanceof(Uint8Array).nullable(),
  phone_ciphertext: z.instanceof(Uint8Array).nullable(),
});

const USER_SELECT = sql`u.id::text as id, u.locale, u.status, floor(extract(epoch from u.created_at) * 1000)::text as created_ms,
  u.age_band, u.limited_capacity, u.email_ciphertext,
  (select i.subject_ciphertext from identities i where i.user_id = u.id and i.provider = 'phone' limit 1) as phone_ciphertext`;

export class KyselyUserDirectory implements UserDirectory {
  constructor(
    private readonly db: AuthDb,
    private readonly cipher: FieldCipher,
  ) {}

  private async toUser(raw: unknown): Promise<User> {
    const r = UserRow.parse(raw);
    return {
      id: r.id,
      phoneE164: r.phone_ciphertext === null ? null : await this.cipher.decrypt(r.phone_ciphertext, "identities.subject"),
      email: r.email_ciphertext === null ? null : await this.cipher.decrypt(r.email_ciphertext, "users.email"),
      language: r.locale,
      status: r.status,
      createdAtMs: r.created_ms,
      ageBand: r.age_band,
      limitedCapacity: r.limited_capacity,
    };
  }

  async findById(id: string): Promise<User | null> {
    if (!UUID.test(id)) return null;
    const rows = await asSystem(this.db, async (trx) => (await sql`select ${USER_SELECT} from users u where u.id = ${id}::uuid and u.status = 'active'`.execute(trx)).rows);
    return rows[0] === undefined ? null : this.toUser(rows[0]);
  }

  private async findRowByIdentity(trx: Tx, provider: string, hash: Uint8Array): Promise<unknown> {
    const r = await sql`select ${USER_SELECT} from identities i join users u on u.id = i.user_id
      where i.provider = ${provider} and i.subject_hash = ${Buffer.from(hash)} and u.status = 'active'`.execute(trx);
    return r.rows[0];
  }

  private async findOrCreate(input: {
    provider: "phone" | "apple" | "google";
    subject: string;
    email: string | null;
    language: UserLanguage;
    newId: string;
    nowMs: number;
    age?: AgePassInfo | null;
  }): Promise<User> {
    const hash = await this.cipher.blindIndex(`identity:${input.provider}`, input.subject);
    const subjectCt = await this.cipher.encrypt(input.subject, "identities.subject");
    const emailCt = input.email === null ? null : await this.cipher.encrypt(input.email, "users.email");
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const raw = await asSystem(this.db, async (trx) => {
          const existing = await this.findRowByIdentity(trx, input.provider, hash);
          if (existing !== undefined) return existing;
          // An identity whose account is not active (suspended) is never re-created or reused.
          const blocked = await sql`select 1 from identities i join users u on u.id = i.user_id
            where i.provider = ${input.provider} and i.subject_hash = ${Buffer.from(hash)}`.execute(trx);
          if (blocked.rows.length > 0) throw new AccountUnavailableError();
          const band = input.age?.ageBand ?? null;
          await sql`insert into users (id, status, locale, age_band, limited_capacity, dob_ciphertext, email_ciphertext, created_at)
            values (${input.newId}::uuid, 'active', ${input.language}, ${band}, ${band === "18_20"},
              ${input.age?.dobCiphertext === undefined || input.age.dobCiphertext === null ? null : Buffer.from(input.age.dobCiphertext)},
              ${emailCt === null ? null : Buffer.from(emailCt)}, ${iso(input.nowMs)}::timestamptz)`.execute(trx);
          const ins = await sql`insert into identities (user_id, provider, subject_ciphertext, subject_hash, verified, last_authenticated_at)
            values (${input.newId}::uuid, ${input.provider}, ${Buffer.from(subjectCt)}, ${Buffer.from(hash)}, true, ${iso(input.nowMs)}::timestamptz)
            on conflict (provider, subject_hash) do nothing returning id`.execute(trx);
          // A concurrent sign-up for the same subject won: roll this user insert back and read the winner.
          if (ins.rows.length === 0) throw new RetryLookup();
          const created = await sql`select ${USER_SELECT} from users u where u.id = ${input.newId}::uuid`.execute(trx);
          return created.rows[0];
        });
        return this.toUser(raw);
      } catch (error) {
        if (!(error instanceof RetryLookup)) throw error;
      }
    }
    throw new Error("could not resolve identity");
  }

  async findByPhone(phoneE164: string): Promise<User | null> {
    const hash = await this.cipher.blindIndex("identity:phone", phoneE164);
    const row = await asSystem(this.db, (trx) => this.findRowByIdentity(trx, "phone", hash));
    return row === undefined ? null : this.toUser(row);
  }

  async findByIdentity(provider: "apple" | "google", subject: string): Promise<User | null> {
    const hash = await this.cipher.blindIndex(`identity:${provider}`, subject);
    const row = await asSystem(this.db, (trx) => this.findRowByIdentity(trx, provider, hash));
    return row === undefined ? null : this.toUser(row);
  }

  findOrCreateByPhone(input: { phoneE164: string; language: UserLanguage; newId: string; nowMs: number; age?: AgePassInfo | null }): Promise<User> {
    return this.findOrCreate({ provider: "phone", subject: input.phoneE164, email: null, ...input });
  }

  findOrCreateByIdentity(input: {
    provider: "apple" | "google";
    subject: string;
    email: string | null;
    language: UserLanguage;
    newId: string;
    nowMs: number;
    age?: AgePassInfo | null;
  }): Promise<User> {
    return this.findOrCreate(input);
  }
}

// ---- Sessions and refresh families --------------------------------------------------------

const SessionRow = z.object({
  id: z.string(),
  family_id: z.string(),
  user_id: z.string(),
  install_id: z.string(),
  platform: z.enum(["ios", "android", "web"]),
  uv: z.boolean(),
  install_secret_hash: z.instanceof(Uint8Array).nullable(),
  device_key_hash: z.instanceof(Uint8Array).nullable(),
  amr: z.array(z.string()),
  created_ms: Ms,
  used_ms: Ms,
  revoked_ms: Ms.nullable(),
  fam_revoked_ms: Ms.nullable(),
  revoke_reason: z.enum(["logout", "reuse_detected", "admin", "deletion", "device_mismatch"]).nullable(),
});
const RecordRow = z.object({
  id: z.string(),
  refresh_hash: z.instanceof(Uint8Array),
  issued_ms: Ms,
  expires_ms: Ms,
  used_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
});

/** sessions.amr is a single-valued legacy column; the full list lives in auth_sessions.amr. */
const legacyAmr = (amr: readonly string[]): string =>
  (["passkey", "apple", "google"] as const).find((a) => amr.includes(a)) ?? "otp";

export class KyselySessionRepository implements SessionRepository {
  constructor(private readonly db: AuthDb) {}

  private async load(trx: Tx, where: ReturnType<typeof sql>): Promise<StoredSession | null> {
    const res = await sql`select s.id::text as id, s.family_id::text as family_id, s.user_id::text as user_id, d.install_id, s.platform, s.uv, d.install_secret_hash, s.device_key_hash,
        s.amr, floor(extract(epoch from s.created_at) * 1000)::text as created_ms,
        floor(extract(epoch from s.last_used_at) * 1000)::text as used_ms,
        floor(extract(epoch from s.revoked_at) * 1000)::text as revoked_ms,
        floor(extract(epoch from f.revoked_at) * 1000)::text as fam_revoked_ms, f.revoke_reason
      from auth_sessions s join session_families f on f.id = s.family_id join devices d on d.id = s.device_id
      where ${where}`.execute(trx);
    const raw = res.rows[0];
    if (raw === undefined) return null;
    const r = SessionRow.parse(raw);
    const recs = await sql`select id::text as id, refresh_hash, floor(extract(epoch from created_at) * 1000)::text as issued_ms,
        floor(extract(epoch from expires_at) * 1000)::text as expires_ms, used_at::text as used_at, revoked_at::text as revoked_at
      from sessions where family_id = ${r.family_id}::uuid order by rotation_no`.execute(trx);
    const records: RefreshRecord[] = recs.rows.map((row) => {
      const x = RecordRow.parse(row);
      return {
        id: x.id,
        tokenHash: hex(x.refresh_hash),
        issuedAtMs: x.issued_ms,
        expiresAtMs: x.expires_ms,
        status: x.revoked_at !== null ? "revoked" : x.used_at !== null ? "rotated" : "active",
      };
    });
    const session: Session = {
      id: r.id,
      userId: r.user_id,
      deviceId: r.install_id,
      familyId: r.family_id,
      amr: r.amr as Session["amr"],
      createdAtMs: r.created_ms,
      lastUsedAtMs: r.used_ms,
      revokedAtMs: r.revoked_ms,
    };
    return {
      session,
      platform: r.platform,
      uv: r.uv,
      deviceKeyHash: r.device_key_hash === null ? null : hex(r.device_key_hash),
      ...(r.platform === "web" ? { installSecretHash: r.install_secret_hash === null ? null : hex(r.install_secret_hash) } : {}),
      family: {
        familyId: r.family_id,
        userId: r.user_id,
        deviceId: r.install_id,
        records,
        revokedAtMs: r.fam_revoked_ms,
        revokeReason: r.revoke_reason === "deletion" ? "admin" : r.revoke_reason,
      },
    };
  }

  private async write(trx: Tx, s: StoredSession): Promise<void> {
    const f = s.family;
    await sql`update session_families set revoked_at = ${f.revokedAtMs === null ? null : iso(f.revokedAtMs)}::timestamptz,
        revoke_reason = ${f.revokeReason} where id = ${f.familyId}::uuid`.execute(trx);
    await sql`update auth_sessions set last_used_at = ${iso(s.session.lastUsedAtMs)}::timestamptz,
        revoked_at = ${s.session.revokedAtMs === null ? null : iso(s.session.revokedAtMs)}::timestamptz where id = ${s.session.id}::uuid`.execute(trx);
    // Web only: revoking a device (a newer login) clears the install-token hash. Never set from here, only cleared.
    if (s.platform === "web" && s.installSecretHash === null) {
      await sql`update devices set install_secret_hash = null where id = (select device_id from auth_sessions where id = ${s.session.id}::uuid)`.execute(trx);
    }
    const legacy = legacyAmr(s.session.amr);
    const stamp = iso(Math.max(s.session.lastUsedAtMs, s.family.records.reduce((m, r) => Math.max(m, r.issuedAtMs), 0)));
    for (const [i, r] of f.records.entries()) {
      await sql`insert into sessions (id, family_id, user_id, device_id, refresh_hash, rotation_no, amr, expires_at, used_at, revoked_at, created_at)
        select ${r.id}::uuid, ${f.familyId}::uuid, ${s.session.userId}::uuid, a.device_id, ${Buffer.from(r.tokenHash, "hex")}, ${i}, ${legacy},
          ${iso(r.expiresAtMs)}::timestamptz, ${r.status === "rotated" ? stamp : null}::timestamptz,
          ${r.status === "revoked" ? stamp : null}::timestamptz, ${iso(r.issuedAtMs)}::timestamptz
        from auth_sessions a where a.id = ${s.session.id}::uuid
        on conflict (id) do update set used_at = coalesce(sessions.used_at, excluded.used_at),
          revoked_at = coalesce(sessions.revoked_at, excluded.revoked_at)`.execute(trx);
    }
  }

  async insert(stored: StoredSession): Promise<void> {
    await asSystem(this.db, async (trx) => {
      const { session, family, platform } = stored;
      const secret = platform === "web" && stored.installSecretHash !== undefined && stored.installSecretHash !== null ? Buffer.from(stored.installSecretHash, "hex") : null;
      // A web row's install_id is server-minted and unique; the conflict branch is for mobile installs only
      // and never touches install_secret_hash.
      const dev = await sql<{ id: string }>`insert into devices (user_id, platform, install_id, last_seen, install_secret_hash)
        values (${session.userId}::uuid, ${platform}, ${family.deviceId}, ${iso(session.createdAtMs)}::timestamptz, ${secret})
        on conflict (install_id) do update set user_id = excluded.user_id, platform = excluded.platform, last_seen = excluded.last_seen
        returning id::text as id`.execute(trx);
      const deviceUuid = dev.rows[0]?.id;
      if (deviceUuid === undefined) throw new Error("device upsert failed");
      await sql`insert into session_families (id, user_id, device_id, created_at)
        values (${family.familyId}::uuid, ${session.userId}::uuid, ${deviceUuid}::uuid, ${iso(session.createdAtMs)}::timestamptz)`.execute(trx);
      await sql`insert into auth_sessions (id, family_id, user_id, device_id, platform, uv, device_key_hash, amr, created_at, last_used_at)
        values (${session.id}::uuid, ${family.familyId}::uuid, ${session.userId}::uuid, ${deviceUuid}::uuid, ${platform}, ${stored.uv === true},
          ${stored.deviceKeyHash === undefined || stored.deviceKeyHash === null ? null : Buffer.from(stored.deviceKeyHash, "hex")},
          ${sql.raw("ARRAY[")}${sql.join(session.amr.map((a) => sql`${a}`))}${sql.raw("]::text[]")},
          ${iso(session.createdAtMs)}::timestamptz, ${iso(session.lastUsedAtMs)}::timestamptz)`.execute(trx);
      await this.write(trx, stored);
    });
  }

  async find(sessionId: string): Promise<StoredSession | null> {
    if (!UUID.test(sessionId)) return null;
    return asSystem(this.db, (trx) => this.load(trx, sql`s.id = ${sessionId}::uuid`));
  }

  async save(stored: StoredSession): Promise<void> {
    await asSystem(this.db, (trx) => this.write(trx, stored));
  }

  async findByRefreshHash(tokenHash: string): Promise<StoredSession | null> {
    if (!/^[0-9a-f]{64}$/.test(tokenHash)) return null;
    return asSystem(this.db, (trx) =>
      this.load(trx, sql`s.family_id = (select family_id from sessions where refresh_hash = ${Buffer.from(tokenHash, "hex")})`),
    );
  }

  async compareAndSave(previous: StoredSession, next: StoredSession): Promise<boolean> {
    return asSystem(this.db, async (trx) => {
      // Row lock on the family serialises concurrent rotations; the loser sees the winner's state.
      await sql`select 1 from session_families where id = ${previous.family.familyId}::uuid for update`.execute(trx);
      const cur = await this.load(trx, sql`s.id = ${previous.session.id}::uuid`);
      if (
        cur === null ||
        cur.family.records.length !== previous.family.records.length ||
        cur.family.revokedAtMs !== previous.family.revokedAtMs ||
        cur.session.revokedAtMs !== previous.session.revokedAtMs
      ) {
        return false;
      }
      await this.write(trx, next);
      return true;
    });
  }

  async listByUser(userId: string): Promise<readonly StoredSession[]> {
    if (!UUID.test(userId)) return [];
    return asSystem(this.db, async (trx) => {
      const ids = await sql<{ id: string }>`select id::text as id from auth_sessions where user_id = ${userId}::uuid order by created_at desc limit 200`.execute(trx);
      const out: StoredSession[] = [];
      for (const { id } of ids.rows) {
        const s = await this.load(trx, sql`s.id = ${id}::uuid`);
        if (s !== null) out.push(s);
      }
      return out;
    });
  }
}

// ---- OTP --------------------------------------------------------------------------------

const ChallengeRow = z.object({
  id: z.string(),
  phone_ciphertext: z.instanceof(Uint8Array),
  channel: z.enum(["sms", "whatsapp"]),
  device_key_hash: z.instanceof(Uint8Array),
  salt: z.string(),
  code_hash: z.string(),
  issued_ms: Ms,
  expires_ms: Ms,
  attempts: z.number().int(),
  status: z.enum(["pending", "consumed", "locked"]),
});

export class KyselyOtpChallengeRepository implements OtpChallengeRepository {
  constructor(
    private readonly db: AuthDb,
    private readonly cipher: FieldCipher,
  ) {}

  async deviceKeyOf(deviceKey: string): Promise<string> {
    return hex(await this.cipher.blindIndex("otp-device", deviceKey));
  }

  async find(id: string): Promise<OtpChallengeRecord | null> {
    if (!UUID.test(id)) return null;
    const rows = await asSystem(this.db, async (trx) =>
      (await sql`select id::text as id, phone_ciphertext, channel, device_key_hash, salt, code_hash,
        floor(extract(epoch from issued_at) * 1000)::text as issued_ms, floor(extract(epoch from expires_at) * 1000)::text as expires_ms,
        attempts, status from otp_challenges where id = ${id}::uuid`.execute(trx)).rows,
    );
    if (rows[0] === undefined) return null;
    const r = ChallengeRow.parse(rows[0]);
    return {
      channel: r.channel,
      deviceKey: hex(r.device_key_hash),
      challenge: {
        id: r.id,
        phoneE164: await this.cipher.decrypt(r.phone_ciphertext, "otp_challenges.phone"),
        salt: r.salt,
        codeHash: r.code_hash,
        issuedAtMs: r.issued_ms,
        expiresAtMs: r.expires_ms,
        attempts: r.attempts,
        status: r.status,
      },
    };
  }

  async insert(record: OtpChallengeRecord): Promise<void> {
    const c = record.challenge;
    const phoneCt = await this.cipher.encrypt(c.phoneE164, "otp_challenges.phone");
    const phoneHash = await this.cipher.blindIndex("phone", c.phoneE164);
    const deviceHash = await this.cipher.blindIndex("otp-device", record.deviceKey);
    await asSystem(this.db, async (trx) => {
      await sql`insert into otp_challenges (id, phone_hash, phone_ciphertext, channel, device_key_hash, salt, code_hash, issued_at, expires_at, attempts, status)
        values (${c.id}::uuid, ${Buffer.from(phoneHash)}, ${Buffer.from(phoneCt)}, ${record.channel}, ${Buffer.from(deviceHash)}, ${c.salt}, ${c.codeHash},
          ${iso(c.issuedAtMs)}::timestamptz, ${iso(c.expiresAtMs)}::timestamptz, ${c.attempts}, ${c.status})`.execute(trx);
      // Opportunistic purge keeps the table small without a scheduler (retention job also covers it).
      await sql`delete from otp_challenges where expires_at < now() - interval '1 day'`.execute(trx);
    });
  }

  async compareAndSet(previous: OtpChallenge, next: OtpChallengeRecord): Promise<boolean> {
    const res = await asSystem(this.db, async (trx) =>
      sql`update otp_challenges set attempts = ${next.challenge.attempts}, status = ${next.challenge.status}
        where id = ${previous.id}::uuid and attempts = ${previous.attempts} and status = ${previous.status} returning id`.execute(trx),
    );
    return res.rows.length === 1;
  }
}

export class KyselyOtpSendLog implements OtpSendLog {
  constructor(
    private readonly db: AuthDb,
    private readonly cipher: FieldCipher,
  ) {}

  async history(phoneE164: string, deviceKey: string, nowMs: number): Promise<SendHistory> {
    const phoneHash = Buffer.from(await this.cipher.blindIndex("phone", phoneE164));
    const deviceHash = Buffer.from(await this.cipher.blindIndex("otp-device", deviceKey));
    const since = iso(nowMs - 86_400_000);
    return asSystem(this.db, async (trx) => {
      const p = await sql`select ${EPOCH_MS("sent_at")} as t from otp_send_log where phone_hash = ${phoneHash} and sent_at > ${since}::timestamptz`.execute(trx);
      const d = await sql`select ${EPOCH_MS("sent_at")} as t from otp_send_log where device_hash = ${deviceHash} and sent_at > ${since}::timestamptz`.execute(trx);
      const times = (rows: readonly unknown[]): number[] => rows.map((x) => Ms.parse((x as { t: unknown }).t));
      return { phoneSendTimes: times(p.rows), deviceSendTimes: times(d.rows) };
    });
  }

  async record(phoneE164: string, deviceKey: string, nowMs: number): Promise<void> {
    const phoneHash = Buffer.from(await this.cipher.blindIndex("phone", phoneE164));
    const deviceHash = Buffer.from(await this.cipher.blindIndex("otp-device", deviceKey));
    await asSystem(this.db, async (trx) => {
      await sql`insert into otp_send_log (phone_hash, device_hash, sent_at) values (${phoneHash}, ${deviceHash}, ${iso(nowMs)}::timestamptz)`.execute(trx);
      await sql`delete from otp_send_log where sent_at < ${iso(nowMs - 2 * 86_400_000)}::timestamptz`.execute(trx);
    });
  }
}

// ---- Age gate, nonces, passkeys, events ------------------------------------------------------

export class KyselyAgeGateStore implements AgeGateStore {
  constructor(private readonly db: AuthDb) {}

  async activeBlock(keys: readonly string[], nowMs: number): Promise<number | null> {
    if (keys.length === 0) return null;
    const rows = await asSystem(this.db, async (trx) =>
      (await sql`select floor(extract(epoch from max(blocked_until)) * 1000)::text as t from age_gate_blocks
        where key_hash in (${sql.join(keys.map((k) => sql`${k}`))}) and blocked_until > ${iso(nowMs)}::timestamptz`.execute(trx)).rows,
    );
    const t = (rows[0] as { t: string | null } | undefined)?.t;
    return t === null || t === undefined ? null : Number(t);
  }

  async block(keys: readonly string[], untilMs: number): Promise<void> {
    await asSystem(this.db, async (trx) => {
      for (const k of keys) {
        await sql`insert into age_gate_blocks (key_hash, blocked_until) values (${k}, ${iso(untilMs)}::timestamptz)
          on conflict (key_hash) do update set blocked_until = greatest(age_gate_blocks.blocked_until, excluded.blocked_until)`.execute(trx);
      }
    });
  }

  async markPassed(key: string, expiresAtMs: number, info?: AgePassInfo): Promise<void> {
    // Unknown band (no info) is recorded as the more restrictive one.
    const band = info?.ageBand ?? "18_20";
    await asSystem(this.db, async (trx) => {
      await sql`insert into age_gate_passes (key_hash, expires_at, age_band, dob_ciphertext)
        values (${key}, ${iso(expiresAtMs)}::timestamptz, ${band}, ${info?.dobCiphertext === undefined || info.dobCiphertext === null ? null : Buffer.from(info.dobCiphertext)})
        on conflict (key_hash) do update set expires_at = excluded.expires_at, age_band = excluded.age_band, dob_ciphertext = excluded.dob_ciphertext`.execute(trx);
      await sql`delete from age_gate_passes where expires_at < now() - interval '1 day'`.execute(trx);
    });
  }

  async hasPassed(key: string, nowMs: number): Promise<boolean> {
    const rows = await asSystem(this.db, async (trx) =>
      (await sql`select 1 as x from age_gate_passes where key_hash = ${key} and expires_at > ${iso(nowMs)}::timestamptz`.execute(trx)).rows,
    );
    return rows.length > 0;
  }

  async passInfo(key: string, nowMs: number): Promise<AgePassInfo | null> {
    const rows = await asSystem(this.db, async (trx) =>
      (await sql`select age_band, dob_ciphertext from age_gate_passes where key_hash = ${key} and expires_at > ${iso(nowMs)}::timestamptz`.execute(trx)).rows,
    );
    if (rows[0] === undefined) return null;
    const r = z.object({ age_band: z.enum(["18_20", "21_plus"]), dob_ciphertext: z.instanceof(Uint8Array).nullable() }).parse(rows[0]);
    return { ageBand: r.age_band, dobCiphertext: r.dob_ciphertext === null ? null : bytes(r.dob_ciphertext) };
  }
}

export class KyselyNonceStore implements NonceStore {
  constructor(private readonly db: AuthDb) {}

  async consume(key: string, expiresAtMs: number, nowMs: number): Promise<boolean> {
    return asSystem(this.db, async (trx) => {
      await sql`delete from auth_nonces where expires_at <= ${iso(nowMs)}::timestamptz`.execute(trx);
      const r = await sql`insert into auth_nonces (key_hash, expires_at) values (${key}, ${iso(expiresAtMs)}::timestamptz)
        on conflict (key_hash) do nothing returning key_hash`.execute(trx);
      return r.rows.length === 1;
    });
  }
}

const ChallengeStoreRow = z.object({
  id: z.string(),
  challenge: z.string(),
  purpose: z.enum(["register", "assert"]),
  user_id: z.string().nullable(),
  expires_ms: Ms,
});

export class KyselyPasskeyChallengeStore implements PasskeyChallengeStore {
  constructor(private readonly db: AuthDb) {}

  private static toRecord(raw: unknown): PasskeyChallengeRecord {
    const r = ChallengeStoreRow.parse(raw);
    return { id: r.id, challenge: r.challenge, purpose: r.purpose, userId: r.user_id, expiresAtMs: r.expires_ms };
  }

  async put(record: PasskeyChallengeRecord): Promise<void> {
    await asSystem(this.db, async (trx) => {
      await sql`insert into passkey_challenges (id, challenge, purpose, user_id, expires_at)
        values (${record.id}::uuid, ${record.challenge}, ${record.purpose}, ${record.userId}::uuid, ${iso(record.expiresAtMs)}::timestamptz)`.execute(trx);
      await sql`delete from passkey_challenges where expires_at < now() - interval '1 hour'`.execute(trx);
    });
  }

  /** DELETE ... RETURNING is the atomic read-and-delete: two concurrent takes cannot both get the row. */
  async take(id: string, nowMs: number): Promise<PasskeyChallengeRecord | null> {
    if (!UUID.test(id)) return null;
    const rows = await asSystem(this.db, async (trx) =>
      (await sql`delete from passkey_challenges where id = ${id}::uuid
        returning id::text as id, challenge, purpose, user_id::text as user_id, floor(extract(epoch from expires_at) * 1000)::text as expires_ms`.execute(trx)).rows,
    );
    if (rows[0] === undefined) return null;
    const rec = KyselyPasskeyChallengeStore.toRecord(rows[0]);
    return rec.expiresAtMs > nowMs ? rec : null;
  }

  async peek(id: string, nowMs: number): Promise<PasskeyChallengeRecord | null> {
    if (!UUID.test(id)) return null;
    const rows = await asSystem(this.db, async (trx) =>
      (await sql`select id::text as id, challenge, purpose, user_id::text as user_id, floor(extract(epoch from expires_at) * 1000)::text as expires_ms
        from passkey_challenges where id = ${id}::uuid`.execute(trx)).rows,
    );
    if (rows[0] === undefined) return null;
    const rec = KyselyPasskeyChallengeStore.toRecord(rows[0]);
    return rec.expiresAtMs > nowMs ? rec : null;
  }
}

const PasskeyRow = z.object({
  user_id: z.string(),
  credential_id: z.string(),
  public_key: z.string(),
  sign_count: Ms,
  status: z.enum(["active", "suspected_clone"]),
  backup_eligible: z.boolean(),
  backed_up: z.boolean(),
  created_ms: Ms,
});

export class KyselyPasskeyCredentialRepository implements PasskeyCredentialRepository {
  constructor(private readonly db: AuthDb) {}

  async insert(p: StoredPasskey): Promise<boolean> {
    const r = await asSystem(this.db, async (trx) =>
      sql`insert into passkey_credentials (credential_id, user_id, public_key, sign_count, status, backup_eligible, backed_up, created_at)
        values (${p.credentialId}, ${p.userId}::uuid, ${p.publicKey}, ${p.signCount}, ${p.status}, ${p.backupEligible ?? false}, ${p.backedUp ?? false}, ${iso(p.createdAtMs)}::timestamptz)
        on conflict (credential_id) do nothing returning credential_id`.execute(trx),
    );
    return r.rows.length === 1;
  }

  async find(credentialId: string): Promise<StoredPasskey | null> {
    if (credentialId.length === 0 || credentialId.length > 1024) return null;
    const rows = await asSystem(this.db, async (trx) =>
      (await sql`select user_id::text as user_id, credential_id, public_key, sign_count::text as sign_count, status, backup_eligible, backed_up,
        floor(extract(epoch from created_at) * 1000)::text as created_ms from passkey_credentials where credential_id = ${credentialId}`.execute(trx)).rows,
    );
    if (rows[0] === undefined) return null;
    const r = PasskeyRow.parse(rows[0]);
    return {
      userId: r.user_id,
      credentialId: r.credential_id,
      publicKey: r.public_key,
      signCount: r.sign_count,
      status: r.status,
      backupEligible: r.backup_eligible,
      backedUp: r.backed_up,
      createdAtMs: r.created_ms,
    };
  }

  async update(p: StoredPasskey): Promise<void> {
    await asSystem(this.db, async (trx) => {
      await sql`update passkey_credentials set sign_count = ${p.signCount}, status = ${p.status}, backed_up = ${p.backedUp ?? false}
        where credential_id = ${p.credentialId}`.execute(trx);
    });
  }
}

/**
 * Writes domain events to the transactional outbox (A2.7). Known gap: the row is committed in its
 * own transaction right after the state change, not inside it (the SessionRepository port has no
 * event parameter yet), so a crash between the two loses a notification. See ADR-0030.
 */
export class KyselyAuthEventPublisher implements AuthEventPublisher {
  constructor(
    private readonly db: AuthDb,
    private readonly newId: () => string,
  ) {}

  async publish(event: AuthEvent): Promise<void> {
    const id = this.newId();
    const row =
      event.type === "session.revoked"
        ? {
            aggregate: "session",
            aggregateId: event.sessionId,
            payload: {
              session_id: event.sessionId,
              user_id: event.userId,
              family_id: event.familyId,
              reason: event.reason,
              notify_user: event.notifyUser,
              occurred_at: iso(event.occurredAtMs),
            },
          }
        : event.type === "auth.step_up_required" || event.type === "auth.step_up_completed"
          ? {
              aggregate: "auth_step_up",
              aggregateId: id,
              payload: { user_id: event.userId, install_id_hash: event.installIdHash, occurred_at: iso(event.occurredAtMs) },
            }
          : { aggregate: "age_gate", aggregateId: id, payload: { occurred_at: iso(event.occurredAtMs) } };
    await asSystem(this.db, async (trx) => {
      await sql`insert into outbox_events (id, occurred_at, aggregate_type, aggregate_id, event_type, ordering_key, payload)
        values (${id}::uuid, ${iso(event.occurredAtMs)}::timestamptz, ${row.aggregate}, ${row.aggregateId}::uuid, ${event.type},
          ${`${row.aggregate}:${row.aggregateId}`}, ${JSON.stringify(row.payload)}::jsonb)`.execute(trx);
    });
  }
}
