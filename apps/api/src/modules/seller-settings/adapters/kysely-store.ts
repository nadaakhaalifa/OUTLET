import { sellerSettings as ss } from "@outlet/domain";
import { sql, type Kysely } from "kysely";
import { z } from "zod";
import type {
  EtaRecord,
  InviteRecord,
  NotificationPrefs,
  PayoutAccountRecord,
  ProfileRecord,
  SettingsArea,
  SettingsEvent,
  SettingsRepository,
  ShippingRecord,
  UploadRecord,
} from "../domain/ports";

export type SettingsDb = Kysely<Record<string, never>>;

const Ms = z.union([z.string(), z.number()]).transform((v) => Number(v));
const Bytes = z.instanceof(Uint8Array);
const ts = (ms: number) => sql`to_timestamp(${ms}::double precision / 1000.0)`;
const msOf = (col: string): string => `floor(extract(epoch from ${col}) * 1000)::text`;
const buf = (b: Uint8Array): Buffer => Buffer.from(b);

const ProfileRow = z.object({
  store_id: z.string(),
  display_name_ar: z.string(),
  display_name_en: z.string().nullable(),
  description_ar: z.string().nullable(),
  description_en: z.string().nullable(),
  logo_key: z.string().nullable(),
  cover_key: z.string().nullable(),
  social_links: z.record(z.string(), z.string()),
  return_change_of_mind_days: z.number(),
  return_defect_days: z.number(),
  return_policy_ar: z.string().nullable(),
  return_policy_en: z.string().nullable(),
  threshold: z.string(),
  vacation_enabled: z.boolean(),
  vacation_ms: Ms.nullable(),
  vacation_eta_extra_days: z.number(),
  version: z.number(),
  updated_by: z.string().nullable(),
  updated_ms: Ms,
});

const UploadRow = z.object({
  id: z.string(),
  store_id: z.string(),
  slot: z.enum(ss.IMAGE_SLOTS),
  object_key: z.string(),
  content_type: z.enum(ss.IMAGE_TYPES),
  declared_bytes: z.number(),
  status: z.enum(["issued", "confirmed", "rejected", "expired"]),
  reject_code: z.string().nullable(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  created_by: z.string(),
  created_ms: Ms,
  expires_ms: Ms,
});

const AccountRow = z.object({
  id: z.string(),
  store_id: z.string(),
  account_token: z.string(),
  iban_enc: Bytes,
  iban_last4: z.string(),
  holder_name_enc: Bytes,
  legal_name_score: z.number(),
  status: z.enum(["ACTIVE", "SUPERSEDED"]),
  created_by: z.string(),
  created_ms: Ms,
  activates_ms: Ms,
});

const ShippingRow = z.object({
  store_id: z.string(),
  origin_governorate_code: z.string(),
  origin_city_code: z.string(),
  origin_street: z.string(),
  origin_building: z.string().nullable(),
  origin_landmark: z.string(),
  origin_contact_name: z.string(),
  origin_contact_phone_enc: Bytes,
  origin_lat: z.number().nullable(),
  origin_lng: z.number().nullable(),
  handling_time_hours: z.number(),
  courier_preferences: z.record(z.string(), z.array(z.string())),
  packaging_options: z.array(z.string()),
  version: z.number(),
  updated_by: z.string().nullable(),
});

const InviteRow = z.object({
  id: z.string(),
  store_id: z.string(),
  role: z.enum(ss.SELLER_TEAM_ROLES),
  phone_blind: Bytes,
  phone_enc: Bytes,
  phone_masked: z.string(),
  token_hash: z.string(),
  status: z.enum(ss.INVITE_STATES),
  invited_by: z.string(),
  responded_by: z.string().nullable(),
  created_ms: Ms,
  expires_ms: Ms,
  responded_ms: Ms.nullable(),
});

const EtaRow = z.object({
  store_id: z.string(),
  status: z.enum(ss.ETA_STATUSES),
  failure_code: z.string().nullable(),
  requested_ms: Ms.nullable(),
  checked_ms: Ms.nullable(),
  verified_ms: Ms.nullable(),
});

const EventRow = z.object({
  id: z.string(),
  store_id: z.string(),
  area: z.enum(["profile", "media", "payout_account", "shipping", "notifications", "team", "eta"]),
  kind: z.string(),
  actor_id: z.string().nullable(),
  occurred_ms: Ms,
  detail: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
});

/**
 * Postgres adapter. Every call runs in a transaction under the `system` RLS identity: the use case
 * has already authorised the actor against the central policy (store-scoped), exactly like payouts.
 */
export class KyselySettingsRepository implements SettingsRepository {
  constructor(
    private readonly db: SettingsDb,
    private readonly applicationRole: string | null = "app_user",
  ) {}

  private async tx<T>(run: (t: SettingsDb) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      const t = trx as unknown as SettingsDb;
      if (this.applicationRole !== null) {
        if (!/^[a-z_][a-z0-9_]*$/.test(this.applicationRole)) throw new RangeError("invalid role name");
        await sql`SET LOCAL ROLE ${sql.id(this.applicationRole)}`.execute(t);
      }
      await sql`select set_config('app.role', 'system', true), set_config('app.user_id', '', true), set_config('app.store_ids', '', true)`.execute(t);
      return run(t);
    });
  }

  // ----------------------------------------------------------------- profile
  async getProfile(storeId: string): Promise<ProfileRecord | null> {
    const r = await this.tx((t) =>
      sql<unknown>`select store_id::text, display_name_ar, display_name_en, description_ar, description_en, logo_key, cover_key,
        social_links, return_change_of_mind_days, return_defect_days, return_policy_ar, return_policy_en,
        free_delivery_threshold_amount::text as threshold, vacation_enabled, ${sql.raw(msOf("vacation_until"))} as vacation_ms,
        vacation_eta_extra_days, version, updated_by::text, ${sql.raw(msOf("updated_at"))} as updated_ms
        from seller_store_profiles where store_id = ${storeId}::uuid`.execute(t),
    );
    const row = r.rows[0];
    if (row === undefined) return null;
    const p = ProfileRow.parse(row);
    return {
      storeId: p.store_id,
      nameAr: p.display_name_ar,
      nameEn: p.display_name_en,
      descriptionAr: p.description_ar,
      descriptionEn: p.description_en,
      logoKey: p.logo_key,
      coverKey: p.cover_key,
      socialLinks: p.social_links,
      returnPolicy: {
        changeOfMindDays: p.return_change_of_mind_days,
        defectDays: p.return_defect_days,
        textAr: p.return_policy_ar,
        textEn: p.return_policy_en,
      },
      freeDeliveryThreshold: BigInt(p.threshold),
      vacation: { enabled: p.vacation_enabled, untilMs: p.vacation_ms, etaExtraDays: p.vacation_eta_extra_days },
      version: p.version,
      updatedBy: p.updated_by,
      updatedAtMs: p.updated_ms,
    };
  }

  async saveProfile(rec: ProfileRecord, expectedVersion: number | null): Promise<boolean> {
    return this.tx(async (t) => {
      const vals = {
        until: rec.vacation.untilMs === null ? sql`null` : ts(rec.vacation.untilMs),
        social: JSON.stringify(rec.socialLinks),
      };
      if (expectedVersion === null) {
        const r = await sql`insert into seller_store_profiles (store_id, display_name_ar, display_name_en, description_ar, description_en,
          logo_key, cover_key, social_links, return_change_of_mind_days, return_defect_days, return_policy_ar, return_policy_en,
          free_delivery_threshold_amount, vacation_enabled, vacation_until, vacation_eta_extra_days, version, updated_by)
          values (${rec.storeId}::uuid, ${rec.nameAr}, ${rec.nameEn}, ${rec.descriptionAr}, ${rec.descriptionEn}, ${rec.logoKey}, ${rec.coverKey},
          ${vals.social}::jsonb, ${rec.returnPolicy.changeOfMindDays}, ${rec.returnPolicy.defectDays}, ${rec.returnPolicy.textAr},
          ${rec.returnPolicy.textEn}, ${rec.freeDeliveryThreshold.toString()}::bigint, ${rec.vacation.enabled}, ${vals.until},
          ${rec.vacation.etaExtraDays}, ${rec.version}, ${rec.updatedBy}::uuid)
          on conflict (store_id) do nothing returning store_id`.execute(t);
        return r.rows.length === 1;
      }
      const r = await sql`update seller_store_profiles set display_name_ar = ${rec.nameAr}, display_name_en = ${rec.nameEn},
        description_ar = ${rec.descriptionAr}, description_en = ${rec.descriptionEn}, logo_key = ${rec.logoKey}, cover_key = ${rec.coverKey},
        social_links = ${vals.social}::jsonb, return_change_of_mind_days = ${rec.returnPolicy.changeOfMindDays},
        return_defect_days = ${rec.returnPolicy.defectDays}, return_policy_ar = ${rec.returnPolicy.textAr}, return_policy_en = ${rec.returnPolicy.textEn},
        free_delivery_threshold_amount = ${rec.freeDeliveryThreshold.toString()}::bigint, vacation_enabled = ${rec.vacation.enabled},
        vacation_until = ${vals.until}, vacation_eta_extra_days = ${rec.vacation.etaExtraDays}, version = ${rec.version}, updated_by = ${rec.updatedBy}::uuid
        where store_id = ${rec.storeId}::uuid and version = ${expectedVersion} returning store_id`.execute(t);
      return r.rows.length === 1;
    });
  }

  // ----------------------------------------------------------------- uploads
  async createUpload(u: UploadRecord): Promise<void> {
    await this.tx((t) =>
      sql`insert into seller_media_uploads (id, store_id, slot, object_key, content_type, declared_bytes, status, created_by, created_at, expires_at)
        values (${u.id}::uuid, ${u.storeId}::uuid, ${u.slot}, ${u.objectKey}, ${u.contentType}, ${u.declaredBytes}, ${u.status},
        ${u.createdBy}::uuid, ${ts(u.createdAtMs)}, ${ts(u.expiresAtMs)})`.execute(t),
    );
  }

  async getUpload(storeId: string, id: string): Promise<UploadRecord | null> {
    const r = await this.tx((t) =>
      sql<unknown>`select id::text, store_id::text, slot, object_key, content_type, declared_bytes, status, reject_code, width, height,
        created_by::text, ${sql.raw(msOf("created_at"))} as created_ms, ${sql.raw(msOf("expires_at"))} as expires_ms
        from seller_media_uploads where store_id = ${storeId}::uuid and id = ${id}::uuid`.execute(t),
    );
    const row = r.rows[0];
    if (row === undefined) return null;
    const u = UploadRow.parse(row);
    return {
      id: u.id,
      storeId: u.store_id,
      slot: u.slot,
      objectKey: u.object_key,
      contentType: u.content_type,
      declaredBytes: u.declared_bytes,
      status: u.status,
      rejectCode: u.reject_code,
      width: u.width,
      height: u.height,
      createdBy: u.created_by,
      createdAtMs: u.created_ms,
      expiresAtMs: u.expires_ms,
    };
  }

  async markUpload(
    storeId: string,
    id: string,
    patch: { status: "confirmed" | "rejected"; rejectCode?: string; width?: number; height?: number; atMs: number },
  ): Promise<void> {
    await this.tx((t) =>
      sql`update seller_media_uploads set status = ${patch.status}, reject_code = ${patch.rejectCode ?? null}, width = ${patch.width ?? null},
        height = ${patch.height ?? null}, confirmed_at = ${patch.status === "confirmed" ? ts(patch.atMs) : sql`null`}
        where store_id = ${storeId}::uuid and id = ${id}::uuid`.execute(t),
    );
  }

  // ----------------------------------------------------------------- payout account
  async activeAccount(storeId: string): Promise<PayoutAccountRecord | null> {
    const r = await this.tx((t) =>
      sql<unknown>`select id::text, store_id::text, account_token, iban_enc, iban_last4, holder_name_enc, legal_name_score, status,
        created_by::text, ${sql.raw(msOf("created_at"))} as created_ms, ${sql.raw(msOf("activates_at"))} as activates_ms
        from seller_payout_accounts where store_id = ${storeId}::uuid and status = 'ACTIVE'`.execute(t),
    );
    const row = r.rows[0];
    if (row === undefined) return null;
    const a = AccountRow.parse(row);
    return {
      id: a.id,
      storeId: a.store_id,
      accountToken: a.account_token,
      ibanEnc: a.iban_enc,
      ibanLast4: a.iban_last4,
      holderNameEnc: a.holder_name_enc,
      legalNameScore: a.legal_name_score,
      status: a.status,
      createdBy: a.created_by,
      createdAtMs: a.created_ms,
      activatesAtMs: a.activates_ms,
    };
  }

  async replaceAccount(n: PayoutAccountRecord): Promise<void> {
    await this.tx(async (t) => {
      await sql`update seller_payout_accounts set status = 'SUPERSEDED', superseded_at = ${ts(n.createdAtMs)}
        where store_id = ${n.storeId}::uuid and status = 'ACTIVE'`.execute(t);
      await sql`insert into seller_payout_accounts (id, store_id, account_token, iban_enc, iban_last4, holder_name_enc, legal_name_score,
        status, created_by, created_at, activates_at)
        values (${n.id}::uuid, ${n.storeId}::uuid, ${n.accountToken}, ${buf(n.ibanEnc)}, ${n.ibanLast4}, ${buf(n.holderNameEnc)},
        ${n.legalNameScore}, 'ACTIVE', ${n.createdBy}::uuid, ${ts(n.createdAtMs)}, ${ts(n.activatesAtMs)})`.execute(t);
    });
  }

  // ----------------------------------------------------------------- shipping
  async getShipping(storeId: string): Promise<ShippingRecord | null> {
    const r = await this.tx((t) =>
      sql<unknown>`select store_id::text, origin_governorate_code, origin_city_code, origin_street, origin_building, origin_landmark,
        origin_contact_name, origin_contact_phone_enc, origin_lat, origin_lng, handling_time_hours, courier_preferences,
        packaging_options, version, updated_by::text from seller_shipping_profiles where store_id = ${storeId}::uuid`.execute(t),
    );
    const row = r.rows[0];
    if (row === undefined) return null;
    const s = ShippingRow.parse(row);
    return {
      storeId: s.store_id,
      governorateCode: s.origin_governorate_code,
      cityCode: s.origin_city_code,
      street: s.origin_street,
      building: s.origin_building,
      landmark: s.origin_landmark,
      contactName: s.origin_contact_name,
      contactPhoneEnc: s.origin_contact_phone_enc,
      pin: s.origin_lat !== null && s.origin_lng !== null ? { lat: s.origin_lat, lng: s.origin_lng } : null,
      handlingHours: s.handling_time_hours,
      courierPreferences: ss.validateCourierPreferences(s.courier_preferences),
      packaging: ss.validatePackaging(s.packaging_options),
      version: s.version,
      updatedBy: s.updated_by,
    };
  }

  async saveShipping(rec: ShippingRecord, expectedVersion: number | null): Promise<boolean> {
    return this.tx(async (t) => {
      const prefs = JSON.stringify(rec.courierPreferences);
      const pack = JSON.stringify(rec.packaging);
      if (expectedVersion === null) {
        const r = await sql`insert into seller_shipping_profiles (store_id, origin_governorate_code, origin_city_code, origin_street,
          origin_building, origin_landmark, origin_contact_name, origin_contact_phone_enc, origin_lat, origin_lng, handling_time_hours,
          courier_preferences, packaging_options, version, updated_by)
          values (${rec.storeId}::uuid, ${rec.governorateCode}, ${rec.cityCode}, ${rec.street}, ${rec.building}, ${rec.landmark},
          ${rec.contactName}, ${buf(rec.contactPhoneEnc)}, ${rec.pin?.lat ?? null}, ${rec.pin?.lng ?? null}, ${rec.handlingHours},
          ${prefs}::jsonb, ${pack}::jsonb, ${rec.version}, ${rec.updatedBy}::uuid)
          on conflict (store_id) do nothing returning store_id`.execute(t);
        return r.rows.length === 1;
      }
      const r = await sql`update seller_shipping_profiles set origin_governorate_code = ${rec.governorateCode}, origin_city_code = ${rec.cityCode},
        origin_street = ${rec.street}, origin_building = ${rec.building}, origin_landmark = ${rec.landmark}, origin_contact_name = ${rec.contactName},
        origin_contact_phone_enc = ${buf(rec.contactPhoneEnc)}, origin_lat = ${rec.pin?.lat ?? null}, origin_lng = ${rec.pin?.lng ?? null},
        handling_time_hours = ${rec.handlingHours}, courier_preferences = ${prefs}::jsonb, packaging_options = ${pack}::jsonb,
        version = ${rec.version}, updated_by = ${rec.updatedBy}::uuid, updated_at = now()
        where store_id = ${rec.storeId}::uuid and version = ${expectedVersion} returning store_id`.execute(t);
      return r.rows.length === 1;
    });
  }

  // ----------------------------------------------------------------- notification prefs
  async getPrefs(storeId: string): Promise<NotificationPrefs> {
    const r = await this.tx((t) =>
      sql<unknown>`select event_type, channel, enabled from seller_notification_prefs where store_id = ${storeId}::uuid`.execute(t),
    );
    const out: Record<string, Record<string, boolean>> = {};
    for (const [e, c] of Object.entries(ss.defaultPrefs())) out[e] = { ...c };
    for (const raw of r.rows) {
      const row = z.object({ event_type: z.string(), channel: z.string(), enabled: z.boolean() }).parse(raw);
      const ev = out[row.event_type];
      if (ev !== undefined) ev[row.channel] = row.enabled;
    }
    return out as unknown as NotificationPrefs;
  }

  async savePrefs(storeId: string, prefs: NotificationPrefs, actorId: string, atMs: number): Promise<void> {
    await this.tx(async (t) => {
      for (const [event, chans] of Object.entries(prefs)) {
        for (const [channel, enabled] of Object.entries(chans)) {
          await sql`insert into seller_notification_prefs (store_id, event_type, channel, enabled, updated_by, updated_at)
            values (${storeId}::uuid, ${event}, ${channel}, ${enabled}, ${actorId}::uuid, ${ts(atMs)})
            on conflict (store_id, event_type, channel) do update set enabled = excluded.enabled, updated_by = excluded.updated_by,
            updated_at = excluded.updated_at`.execute(t);
        }
      }
    });
  }

  // ----------------------------------------------------------------- invites
  private static invite(raw: unknown): InviteRecord {
    const i = InviteRow.parse(raw);
    return {
      id: i.id,
      storeId: i.store_id,
      role: i.role,
      phoneBlind: i.phone_blind,
      phoneEnc: i.phone_enc,
      phoneMasked: i.phone_masked,
      tokenHash: i.token_hash,
      status: i.status,
      invitedBy: i.invited_by,
      respondedBy: i.responded_by,
      createdAtMs: i.created_ms,
      expiresAtMs: i.expires_ms,
      respondedAtMs: i.responded_ms,
    };
  }
  private static readonly INVITE_COLS = sql.raw(`id::text, store_id::text, role, phone_blind, phone_enc, phone_masked, token_hash, status,
    invited_by::text, responded_by::text, ${msOf("created_at")} as created_ms, ${msOf("expires_at")} as expires_ms,
    ${msOf("responded_at")} as responded_ms`);

  async insertInvite(inv: InviteRecord): Promise<"ok" | "duplicate_pending"> {
    return this.tx(async (t) => {
      const r = await sql`insert into seller_team_invites (id, store_id, role, phone_blind, phone_enc, phone_masked, token_hash, status,
        invited_by, created_at, expires_at)
        values (${inv.id}::uuid, ${inv.storeId}::uuid, ${inv.role}, ${buf(inv.phoneBlind)}, ${buf(inv.phoneEnc)}, ${inv.phoneMasked},
        ${inv.tokenHash}, 'PENDING', ${inv.invitedBy}::uuid, ${ts(inv.createdAtMs)}, ${ts(inv.expiresAtMs)})
        on conflict do nothing returning id`.execute(t);
      return r.rows.length === 1 ? ("ok" as const) : ("duplicate_pending" as const);
    });
  }
  async getInvite(storeId: string, id: string): Promise<InviteRecord | null> {
    const r = await this.tx((t) =>
      sql<unknown>`select ${KyselySettingsRepository.INVITE_COLS} from seller_team_invites where store_id = ${storeId}::uuid and id = ${id}::uuid`.execute(t),
    );
    return r.rows[0] === undefined ? null : KyselySettingsRepository.invite(r.rows[0]);
  }
  async getInviteByTokenHash(tokenHash: string): Promise<InviteRecord | null> {
    const r = await this.tx((t) =>
      sql<unknown>`select ${KyselySettingsRepository.INVITE_COLS} from seller_team_invites where token_hash = ${tokenHash}`.execute(t),
    );
    return r.rows[0] === undefined ? null : KyselySettingsRepository.invite(r.rows[0]);
  }
  async listInvites(storeId: string): Promise<readonly InviteRecord[]> {
    const r = await this.tx((t) =>
      sql<unknown>`select ${KyselySettingsRepository.INVITE_COLS} from seller_team_invites where store_id = ${storeId}::uuid
        order by created_at desc, id desc limit 100`.execute(t),
    );
    return r.rows.map((x) => KyselySettingsRepository.invite(x));
  }
  async countPendingInvites(storeId: string, nowMs: number): Promise<number> {
    const r = await this.tx((t) =>
      sql<{ n: string }>`select count(*)::text as n from seller_team_invites
        where store_id = ${storeId}::uuid and status = 'PENDING' and expires_at > ${ts(nowMs)}`.execute(t),
    );
    return Number(r.rows[0]?.n ?? 0);
  }
  async closeInvite(id: string, status: Exclude<ss.InviteState, "PENDING">, by: string | null, atMs: number): Promise<boolean> {
    const r = await this.tx((t) =>
      sql`update seller_team_invites set status = ${status}, responded_by = ${by}::uuid, responded_at = ${ts(atMs)}
        where id = ${id}::uuid and status = 'PENDING' returning id`.execute(t),
    );
    return r.rows.length === 1;
  }

  // ----------------------------------------------------------------- eta
  async getEta(storeId: string): Promise<EtaRecord | null> {
    const r = await this.tx((t) =>
      sql<unknown>`select store_id::text, status, failure_code, ${sql.raw(msOf("requested_at"))} as requested_ms,
        ${sql.raw(msOf("last_checked_at"))} as checked_ms, ${sql.raw(msOf("last_verified_at"))} as verified_ms
        from seller_eta_enrolments where store_id = ${storeId}::uuid`.execute(t),
    );
    const row = r.rows[0];
    if (row === undefined) return null;
    const e = EtaRow.parse(row);
    return {
      storeId: e.store_id,
      status: e.status,
      failureCode: e.failure_code,
      requestedAtMs: e.requested_ms,
      lastCheckedAtMs: e.checked_ms,
      lastVerifiedAtMs: e.verified_ms,
    };
  }
  async saveEta(rec: EtaRecord, actorId: string, atMs: number): Promise<void> {
    const nul = sql`null`;
    const t1 = (v: number | null) => (v === null ? nul : ts(v));
    await this.tx((t) =>
      sql`insert into seller_eta_enrolments (store_id, status, failure_code, requested_at, last_checked_at, last_verified_at, updated_by, updated_at)
        values (${rec.storeId}::uuid, ${rec.status}, ${rec.failureCode}, ${t1(rec.requestedAtMs)}, ${t1(rec.lastCheckedAtMs)},
        ${t1(rec.lastVerifiedAtMs)}, ${actorId}::uuid, ${ts(atMs)})
        on conflict (store_id) do update set status = excluded.status, failure_code = excluded.failure_code, requested_at = excluded.requested_at,
        last_checked_at = excluded.last_checked_at, last_verified_at = excluded.last_verified_at, updated_by = excluded.updated_by,
        updated_at = excluded.updated_at`.execute(t),
    );
  }

  // ----------------------------------------------------------------- events
  async addEvent(e: SettingsEvent): Promise<void> {
    await this.tx((t) =>
      sql`insert into seller_settings_events (id, store_id, area, kind, actor_id, occurred_at, detail)
        values (${e.id}::uuid, ${e.storeId}::uuid, ${e.area}, ${e.kind}, ${e.actorId}::uuid, ${ts(e.occurredAtMs)}, ${JSON.stringify(e.detail)}::jsonb)`.execute(t),
    );
  }
  async listEvents(storeId: string, area: SettingsArea, limit: number): Promise<readonly SettingsEvent[]> {
    const r = await this.tx((t) =>
      sql<unknown>`select id::text, store_id::text, area, kind, actor_id::text, ${sql.raw(msOf("occurred_at"))} as occurred_ms, detail
        from seller_settings_events where store_id = ${storeId}::uuid and area = ${area}
        order by occurred_at desc, id desc limit ${limit}`.execute(t),
    );
    return r.rows.map((raw) => {
      const e = EventRow.parse(raw);
      return { id: e.id, storeId: e.store_id, area: e.area, kind: e.kind, actorId: e.actor_id, occurredAtMs: e.occurred_ms, detail: e.detail };
    });
  }
}
