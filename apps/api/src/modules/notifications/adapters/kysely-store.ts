import { sql, type Kysely } from "kysely";
import { z } from "zod";
import { cairoParts, trailingDateKeys } from "../domain/cairo-time";
import type {
  DeliveryLogRepository,
  FrequencyStore,
  InboxRepository,
  PreferenceRepository,
  PushToken,
  PushTokenRepository,
  RequestRepository,
  SuppressionRepository,
  TemplateRepository,
} from "../domain/ports";
import {
  CATEGORIES,
  type Channel,
  type DeliveryLogEntry,
  type ExternalChannel,
  type InboxMessage,
  type NotificationRequest,
  type NotificationTemplate,
  type SuppressionReason,
} from "../domain/types";

/** Raw SQL only (same approach as the inventory adapter): tables are owned by migration 0018. */
export type NotificationsDb = Kysely<Record<string, never>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** One transaction under the `system` role (ADR-0020; the notification workers act for users). */
async function inTx<T>(db: NotificationsDb, run: (trx: NotificationsDb) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`select set_config('app.role', 'system', true)`.execute(trx);
    return run(trx as unknown as NotificationsDb);
  });
}

const ts = (m: number): string => new Date(m).toISOString();
const ms = (n: unknown): number => Math.round(Number(n));
const optMs = (n: unknown): number | null => (n === null || n === undefined ? null : ms(n));
const parseJson = (v: unknown): unknown => (typeof v === "string" ? (JSON.parse(v) as unknown) : v);

const CHANNEL = z.enum(["push", "whatsapp", "sms", "email", "in_app"]);
const EXTERNAL = z.enum(["push", "whatsapp", "sms", "email"]);
const CATEGORY = z.enum(CATEGORIES);
const TYPE = z.enum(["ORDER_UPDATES", "REFUNDS", "ACCOUNT_SECURITY", "PRICE_DROPS", "BACK_IN_SIZE", "STYLIST", "BUDGET", "PROMOTIONS", "REWARDS", "PLUS"]);

// ---- templates ---------------------------------------------------------------------------------

const TemplateRow = z.object({
  id: z.string(),
  key: z.string(),
  version: z.number().int(),
  channel: CHANNEL,
  category: CATEGORY,
  type: TYPE,
  subject_ar: z.string().nullable(),
  subject_en: z.string().nullable(),
  body_ar: z.string(),
  body_en: z.string().nullable(),
  provider_template_id: z.string().nullable(),
  approval_status: z.enum(["DRAFT", "SUBMITTED", "APPROVED", "REJECTED"]),
  active: z.boolean(),
  alert_type: z.enum(["price_drop", "back_in_size", "low_stock", "date_approaching"]).nullable(),
  valid_ms: z.coerce.number(),
});
const TEMPLATE_COLS = sql`id::text as id, key, version, channel, category, type, subject_ar, subject_en, body_ar, body_en,
  provider_template_id, approval_status, active, alert_type, extract(epoch from valid_from) * 1000 as valid_ms`;

function toTemplate(raw: unknown): NotificationTemplate {
  const r = TemplateRow.parse(raw);
  return {
    id: r.id,
    key: r.key,
    version: r.version,
    channel: r.channel,
    category: r.category,
    type: r.type,
    subjectAr: r.subject_ar,
    subjectEn: r.subject_en,
    bodyAr: r.body_ar,
    bodyEn: r.body_en,
    providerTemplateId: r.provider_template_id,
    approval: r.approval_status,
    active: r.active,
    alertType: r.alert_type,
    validFromMs: ms(r.valid_ms),
  };
}

export class KyselyTemplateRepository implements TemplateRepository {
  constructor(private readonly db: NotificationsDb) {}

  async activeFor(key: string, nowMs: number): Promise<readonly NotificationTemplate[]> {
    return inTx(this.db, async (trx) => {
      const r = await sql<unknown>`
        select distinct on (channel) ${TEMPLATE_COLS} from notification_templates
         where key = ${key} and active and valid_from <= ${ts(nowMs)}::timestamptz
         order by channel, version desc`.execute(trx);
      return r.rows.map(toTemplate);
    });
  }

  async version(key: string, channel: Channel, version: number): Promise<NotificationTemplate | null> {
    return inTx(this.db, async (trx) => {
      const r = await sql<unknown>`select ${TEMPLATE_COLS} from notification_templates
        where key = ${key} and channel = ${channel} and version = ${version}`.execute(trx);
      const row = r.rows[0];
      return row === undefined ? null : toTemplate(row);
    });
  }

  async get(id: string): Promise<NotificationTemplate | null> {
    if (!UUID.test(id)) return null;
    return inTx(this.db, async (trx) => {
      const r = await sql<unknown>`select ${TEMPLATE_COLS} from notification_templates where id = ${id}::uuid`.execute(trx);
      const row = r.rows[0];
      return row === undefined ? null : toTemplate(row);
    });
  }

  /**
   * Upsert by id. At most one version of (key, channel) is active (partial unique index, asserted
   * by migration.test.ts), so activating a version retires the previously active one in the same
   * transaction; queued messages keep rendering with their pinned version through `version()`.
   * Consequence: a future-dated `valid_from` on an active version cannot coexist with the current
   * one (see docs/specs/notifications.md, Wave 2).
   */
  async save(t: NotificationTemplate): Promise<void> {
    await inTx(this.db, async (trx) => {
      if (t.active) {
        await sql`update notification_templates set active = false
          where key = ${t.key} and channel = ${t.channel} and active and id <> ${t.id}::uuid`.execute(trx);
      }
      await sql`
        insert into notification_templates (id, key, version, channel, category, type, subject_ar, subject_en, body_ar, body_en,
                                            provider_template_id, approval_status, active, alert_type, valid_from)
        values (${t.id}::uuid, ${t.key}, ${t.version}, ${t.channel}, ${t.category}, ${t.type}, ${t.subjectAr}, ${t.subjectEn},
                ${t.bodyAr}, ${t.bodyEn}, ${t.providerTemplateId}, ${t.approval}, ${t.active}, ${t.alertType}, ${ts(t.validFromMs)}::timestamptz)
        on conflict (id) do update set
          subject_ar = excluded.subject_ar, subject_en = excluded.subject_en, body_ar = excluded.body_ar, body_en = excluded.body_en,
          provider_template_id = excluded.provider_template_id, approval_status = excluded.approval_status,
          active = excluded.active, alert_type = excluded.alert_type, valid_from = excluded.valid_from,
          category = excluded.category, type = excluded.type`.execute(trx);
    });
  }
}

// ---- requests ----------------------------------------------------------------------------------

const RequestRow = z.object({
  id: z.string(),
  user_id: z.string(),
  template_key: z.string(),
  ref: z.string(),
  category: CATEGORY,
  type: z.string(),
  payload: z.unknown(),
  template_versions: z.unknown(),
  status: z.enum(["ACCEPTED", "SUPPRESSED", "SCHEDULED", "SENT", "FAILED", "CANCELLED"]),
  suppressed_reason: z.enum(["NO_CONSENT", "FREQUENCY_CAP", "QUIET_HOURS", "PREFERENCE", "SUPPRESSION_LIST"]).nullable(),
  pending_channel: EXTERNAL.nullable(),
  scheduled_ms: z.unknown(),
  attempts: z.number().int(),
  expires_ms: z.coerce.number(),
  deep_link: z.string().nullable(),
  locale: z.enum(["ar", "en"]),
  created_ms: z.coerce.number(),
});
const PayloadSchema = z.record(z.string(), z.union([z.string(), z.number()]));
const VersionsSchema = z.record(z.string(), z.number().int());
const REQUEST_COLS = sql`id::text as id, user_id::text as user_id, template_key, ref, category, type, payload, template_versions,
  status, suppressed_reason, pending_channel, extract(epoch from scheduled_for) * 1000 as scheduled_ms, attempts,
  extract(epoch from expires_at) * 1000 as expires_ms, deep_link, locale, extract(epoch from created_at) * 1000 as created_ms`;

function toRequest(raw: unknown): NotificationRequest {
  const r = RequestRow.parse(raw);
  return {
    id: r.id,
    userId: r.user_id,
    templateKey: r.template_key,
    ref: r.ref,
    category: r.category,
    type: TYPE.parse(r.type),
    payload: PayloadSchema.parse(parseJson(r.payload)),
    templateVersions: VersionsSchema.parse(parseJson(r.template_versions)) as NotificationRequest["templateVersions"],
    status: r.status,
    suppressedReason: r.suppressed_reason,
    pendingChannel: r.pending_channel,
    scheduledForMs: optMs(r.scheduled_ms),
    attempts: r.attempts,
    expiresAtMs: ms(r.expires_ms),
    deepLink: r.deep_link,
    locale: r.locale,
    createdAtMs: ms(r.created_ms),
  };
}

const optTs = (m: number | null): string | null => (m === null ? null : ts(m));

export class KyselyRequestRepository implements RequestRepository {
  constructor(private readonly db: NotificationsDb) {}

  async insertIfAbsent(r: NotificationRequest): Promise<boolean> {
    return inTx(this.db, async (trx) => {
      const out = await sql<{ id: string }>`
        insert into notification_requests (id, user_id, template_key, ref, category, type, payload, template_versions, status,
                                           suppressed_reason, pending_channel, scheduled_for, attempts, expires_at, deep_link, locale, created_at)
        values (${r.id}::uuid, ${r.userId}::uuid, ${r.templateKey}, ${r.ref}, ${r.category}, ${r.type},
                ${JSON.stringify(r.payload)}::jsonb, ${JSON.stringify(r.templateVersions)}::jsonb, ${r.status},
                ${r.suppressedReason}, ${r.pendingChannel}, ${optTs(r.scheduledForMs)}::timestamptz, ${r.attempts},
                ${ts(r.expiresAtMs)}::timestamptz, ${r.deepLink}, ${r.locale}, ${ts(r.createdAtMs)}::timestamptz)
        on conflict (user_id, template_key, ref) do nothing
        returning id::text as id`.execute(trx);
      return out.rows.length > 0;
    });
  }

  async find(userId: string, templateKey: string, ref: string): Promise<NotificationRequest | null> {
    return inTx(this.db, async (trx) => {
      const r = await sql<unknown>`select ${REQUEST_COLS} from notification_requests
        where user_id = ${userId}::uuid and template_key = ${templateKey} and ref = ${ref}`.execute(trx);
      const row = r.rows[0];
      return row === undefined ? null : toRequest(row);
    });
  }

  /** Persists the mutable fields. Identity (user, key, ref), payload and creation time never change. */
  async save(r: NotificationRequest): Promise<void> {
    await inTx(this.db, async (trx) => {
      await sql`
        insert into notification_requests (id, user_id, template_key, ref, category, type, payload, template_versions, status,
                                           suppressed_reason, pending_channel, scheduled_for, attempts, expires_at, deep_link, locale, created_at)
        values (${r.id}::uuid, ${r.userId}::uuid, ${r.templateKey}, ${r.ref}, ${r.category}, ${r.type},
                ${JSON.stringify(r.payload)}::jsonb, ${JSON.stringify(r.templateVersions)}::jsonb, ${r.status},
                ${r.suppressedReason}, ${r.pendingChannel}, ${optTs(r.scheduledForMs)}::timestamptz, ${r.attempts},
                ${ts(r.expiresAtMs)}::timestamptz, ${r.deepLink}, ${r.locale}, ${ts(r.createdAtMs)}::timestamptz)
        on conflict (id) do update set
          template_versions = excluded.template_versions, status = excluded.status, suppressed_reason = excluded.suppressed_reason,
          pending_channel = excluded.pending_channel, scheduled_for = excluded.scheduled_for, attempts = excluded.attempts,
          expires_at = excluded.expires_at, deep_link = excluded.deep_link`.execute(trx);
    });
  }

  /** One statement: due rows are locked with SKIP LOCKED, so two workers never claim the same request. */
  async claimDue(nowMs: number, limit: number): Promise<readonly NotificationRequest[]> {
    return inTx(this.db, async (trx) => {
      const r = await sql<unknown>`
        with due as (
          select id as due_id, scheduled_for as due_at from notification_requests
           where status = 'SCHEDULED' and scheduled_for <= ${ts(nowMs)}::timestamptz
           order by scheduled_for, id limit ${limit} for update skip locked),
        claimed as (
          update notification_requests n set status = 'ACCEPTED', scheduled_for = null
            from due where n.id = due.due_id
          returning n.*)
        select ${REQUEST_COLS} from claimed join due on due.due_id = claimed.id
         order by due.due_at, claimed.id`.execute(trx);
      return r.rows.map(toRequest);
    });
  }
}

// ---- delivery log ------------------------------------------------------------------------------

const LogRow = z.object({
  id: z.string(),
  request_id: z.string(),
  user_id: z.string(),
  channel: CHANNEL,
  template_key: z.string(),
  template_version: z.number().int(),
  category: CATEGORY,
  provider_code: z.string(),
  provider_ref: z.string().nullable(),
  status: z.enum(["QUEUED", "SENT", "DELIVERED", "READ", "FAILED", "BOUNCED"]),
  failure_code: z.string().nullable(),
  sent_ms: z.coerce.number(),
});

export class KyselyDeliveryLogRepository implements DeliveryLogRepository {
  constructor(private readonly db: NotificationsDb) {}

  async append(e: DeliveryLogEntry): Promise<void> {
    await inTx(this.db, async (trx) => {
      await sql`
        insert into notification_log (id, request_id, user_id, channel, template_key, template_version, category, provider_code,
                                      provider_ref, status, failure_code, sent_at)
        values (${e.id}::uuid, ${e.requestId}::uuid, ${e.userId}::uuid, ${e.channel}, ${e.templateKey}, ${e.templateVersion},
                ${e.category}, ${e.providerCode}, ${e.providerRef}, ${e.status}, ${e.failureCode}, ${ts(e.sentAtMs)}::timestamptz)`.execute(trx);
    });
  }

  async forRequest(requestId: string): Promise<readonly DeliveryLogEntry[]> {
    if (!UUID.test(requestId)) return [];
    return inTx(this.db, async (trx) => {
      const r = await sql<unknown>`
        select id::text as id, request_id::text as request_id, user_id::text as user_id, channel, template_key, template_version,
               category, provider_code, provider_ref, status, failure_code, extract(epoch from sent_at) * 1000 as sent_ms
          from notification_log where request_id = ${requestId}::uuid order by sent_at, id`.execute(trx);
      return r.rows.map((raw) => {
        const x = LogRow.parse(raw);
        return {
          id: x.id,
          requestId: x.request_id,
          userId: x.user_id,
          channel: x.channel,
          templateKey: x.template_key,
          templateVersion: x.template_version,
          category: x.category,
          providerCode: x.provider_code,
          providerRef: x.provider_ref,
          status: x.status,
          failureCode: x.failure_code,
          sentAtMs: ms(x.sent_ms),
        };
      });
    });
  }
}

// ---- frequency ---------------------------------------------------------------------------------

/** Channels that have a counter row. SMS never carries marketing (ADR-0018), so it is not counted. */
const COUNTED: ReadonlySet<ExternalChannel> = new Set<ExternalChannel>(["push", "whatsapp", "email"]);
/** Window the cap policy looks at: today plus the trailing 7 Cairo days (domain/policy.frequencyUsage). */
const WINDOW_DAYS = 7;

/** A UTC instant guaranteed to fall on the given Cairo calendar day (Cairo is UTC+2/+3, noon UTC is 14:00/15:00). */
const noonOf = (dateKey: string): number => Date.parse(`${dateKey}T12:00:00Z`);

/**
 * Day-granular store: one counter per (user, channel, Cairo day). `admit` and `sentTimes` receive
 * synthetic instants at noon UTC of each counted day, which is exact for the only consumer
 * (`frequencyUsage` buckets by Cairo date key).
 *
 * Atomicity: `reserve` takes a transaction scoped advisory lock keyed by (user, channel) before it
 * reads the counters, so the check and the increment are one critical section across API
 * instances. A row lock would not do: the counter row for today may not exist yet.
 */
export class KyselyFrequencyStore implements FrequencyStore {
  constructor(private readonly db: NotificationsDb) {}

  private async counts(trx: NotificationsDb, userId: string, channel: ExternalChannel, fromKey: string): Promise<{ day: string; n: number }[]> {
    const r = await sql<{ day: string; n: number }>`
      select day::text as day, marketing_count as n from notification_frequency_counters
       where user_id = ${userId}::uuid and channel = ${channel} and day >= ${fromKey}::date and marketing_count > 0
       order by day`.execute(trx);
    return r.rows;
  }

  private synth(rows: readonly { day: string; n: number }[]): number[] {
    return rows.flatMap((x) => Array.from({ length: x.n }, () => noonOf(x.day)));
  }

  private async bump(trx: NotificationsDb, userId: string, channel: ExternalChannel, dayKey: string): Promise<void> {
    await sql`
      insert into notification_frequency_counters (user_id, channel, day, marketing_count)
      values (${userId}::uuid, ${channel}, ${dayKey}::date, 1)
      on conflict (user_id, channel, day) do update set marketing_count = notification_frequency_counters.marketing_count + 1`.execute(trx);
  }

  async record(userId: string, channel: ExternalChannel, atMs: number): Promise<void> {
    if (!COUNTED.has(channel)) return;
    await inTx(this.db, (trx) => this.bump(trx, userId, channel, cairoParts(atMs).dateKey));
  }

  async reserve(
    userId: string,
    channel: ExternalChannel,
    atMs: number,
    admit: (sentTimes: readonly number[]) => boolean,
  ): Promise<boolean> {
    if (!COUNTED.has(channel)) return admit([]);
    return inTx(this.db, async (trx) => {
      await sql`select pg_advisory_xact_lock(hashtextextended(${`notification_frequency:${userId}:${channel}`}, 0))`.execute(trx);
      const keys = trailingDateKeys(atMs, WINDOW_DAYS);
      const oldest = keys[keys.length - 1] ?? cairoParts(atMs).dateKey;
      const times = this.synth(await this.counts(trx, userId, channel, oldest));
      if (!admit(times)) return false;
      await this.bump(trx, userId, channel, cairoParts(atMs).dateKey);
      return true;
    });
  }

  async release(userId: string, channel: ExternalChannel, atMs: number): Promise<void> {
    if (!COUNTED.has(channel)) return;
    await inTx(this.db, async (trx) => {
      await sql`
        update notification_frequency_counters set marketing_count = marketing_count - 1
         where user_id = ${userId}::uuid and channel = ${channel} and day = ${cairoParts(atMs).dateKey}::date and marketing_count > 0`.execute(trx);
    });
  }

  /** Includes every counted day from the Cairo day of `sinceMs` on (day granularity). */
  async sentTimes(userId: string, channel: ExternalChannel, sinceMs: number): Promise<readonly number[]> {
    if (!COUNTED.has(channel)) return [];
    return inTx(this.db, async (trx) => this.synth(await this.counts(trx, userId, channel, cairoParts(sinceMs).dateKey)));
  }
}

// ---- preferences, suppressions -----------------------------------------------------------------

export class KyselyPreferenceRepository implements PreferenceRepository {
  constructor(private readonly db: NotificationsDb) {}

  async all(userId: string): Promise<ReadonlyMap<string, boolean>> {
    return inTx(this.db, async (trx) => {
      const r = await sql<{ type: string; channel: string; enabled: boolean }>`
        select type, channel, enabled from notification_preferences where user_id = ${userId}::uuid`.execute(trx);
      return new Map(r.rows.map((x) => [x.channel === "*" ? x.type : `${x.type}.${x.channel}`, x.enabled]));
    });
  }

  async setMany(userId: string, entries: ReadonlyMap<string, boolean>, nowMs: number): Promise<void> {
    if (entries.size === 0) return;
    await inTx(this.db, async (trx) => {
      for (const [key, enabled] of entries) {
        const dot = key.indexOf(".");
        const type = dot < 0 ? key : key.slice(0, dot);
        const channel = dot < 0 ? "*" : key.slice(dot + 1);
        await sql`
          insert into notification_preferences (user_id, type, channel, enabled, updated_at)
          values (${userId}::uuid, ${type}, ${channel}, ${enabled}, ${ts(nowMs)}::timestamptz)
          on conflict (user_id, type, channel) do update set enabled = excluded.enabled, updated_at = excluded.updated_at`.execute(trx);
      }
    });
  }
}

export class KyselySuppressionRepository implements SuppressionRepository {
  constructor(private readonly db: NotificationsDb) {}

  async active(userId: string, channel: ExternalChannel): Promise<ReadonlySet<SuppressionReason>> {
    if (channel === "sms") return new Set();
    return inTx(this.db, async (trx) => {
      const r = await sql<{ reason: SuppressionReason }>`
        select reason from notification_suppressions where user_id = ${userId}::uuid and channel = ${channel}`.execute(trx);
      return new Set(r.rows.map((x) => x.reason));
    });
  }

  async add(userId: string, channel: ExternalChannel, reason: SuppressionReason, nowMs: number): Promise<void> {
    await inTx(this.db, async (trx) => {
      await sql`insert into notification_suppressions (user_id, channel, reason, created_at)
        values (${userId}::uuid, ${channel}, ${reason}, ${ts(nowMs)}::timestamptz)
        on conflict (user_id, channel, reason) do nothing`.execute(trx);
    });
  }

  async remove(userId: string, channel: ExternalChannel, reason: SuppressionReason): Promise<void> {
    await inTx(this.db, async (trx) => {
      await sql`delete from notification_suppressions
        where user_id = ${userId}::uuid and channel = ${channel} and reason = ${reason}`.execute(trx);
    });
  }
}

// ---- inbox, push tokens ------------------------------------------------------------------------

const InboxRow = z.object({
  id: z.string(),
  user_id: z.string(),
  request_id: z.string(),
  type: z.string(),
  title_ar: z.string(),
  title_en: z.string().nullable(),
  body_ar: z.string(),
  body_en: z.string().nullable(),
  deep_link: z.string().nullable(),
  read_ms: z.unknown(),
  expires_ms: z.coerce.number(),
  created_ms: z.coerce.number(),
});

export class KyselyInboxRepository implements InboxRepository {
  constructor(private readonly db: NotificationsDb) {}

  async insert(m: InboxMessage): Promise<void> {
    await inTx(this.db, async (trx) => {
      await sql`
        insert into inbox_messages (id, user_id, request_id, type, title_ar, title_en, body_ar, body_en, deep_link, read_at, expires_at, created_at)
        values (${m.id}::uuid, ${m.userId}::uuid, ${m.requestId}::uuid, ${m.type}, ${m.titleAr}, ${m.titleEn}, ${m.bodyAr}, ${m.bodyEn},
                ${m.deepLink}, ${optTs(m.readAtMs)}::timestamptz, ${ts(m.expiresAtMs)}::timestamptz, ${ts(m.createdAtMs)}::timestamptz)`.execute(trx);
    });
  }

  async list(
    userId: string,
    after: { readonly createdAtMs: number; readonly id: string } | null,
    limit: number,
    nowMs: number,
  ): Promise<readonly InboxMessage[]> {
    if (after !== null && !UUID.test(after.id)) return [];
    return inTx(this.db, async (trx) => {
      const afterTs = after === null ? null : ts(after.createdAtMs);
      const afterId = after === null ? null : after.id;
      const r = await sql<unknown>`
        select id::text as id, user_id::text as user_id, request_id::text as request_id, type, title_ar, title_en, body_ar, body_en,
               deep_link, extract(epoch from read_at) * 1000 as read_ms, extract(epoch from expires_at) * 1000 as expires_ms,
               extract(epoch from created_at) * 1000 as created_ms
          from inbox_messages
         where user_id = ${userId}::uuid and expires_at > ${ts(nowMs)}::timestamptz
           and (${afterTs}::timestamptz is null
                or created_at < ${afterTs}::timestamptz
                or (created_at = ${afterTs}::timestamptz and id < ${afterId}::uuid))
         order by created_at desc, id desc limit ${limit}`.execute(trx);
      return r.rows.map((raw): InboxMessage => {
        const x = InboxRow.parse(raw);
        return {
          id: x.id,
          userId: x.user_id,
          requestId: x.request_id,
          type: TYPE.parse(x.type),
          titleAr: x.title_ar,
          titleEn: x.title_en,
          bodyAr: x.body_ar,
          bodyEn: x.body_en,
          deepLink: x.deep_link,
          readAtMs: optMs(x.read_ms),
          expiresAtMs: ms(x.expires_ms),
          createdAtMs: ms(x.created_ms),
        };
      });
    });
  }

  /** All or nothing: every id must be the user's, else nothing changes. */
  async markRead(userId: string, ids: readonly string[], nowMs: number): Promise<boolean> {
    const unique = [...new Set(ids)];
    if (unique.some((id) => !UUID.test(id))) return false;
    if (unique.length === 0) return true;
    return inTx(this.db, async (trx) => {
      const owned = await sql<{ n: number }>`select count(*)::int as n from inbox_messages
        where user_id = ${userId}::uuid and id::text = any (${unique as string[]})`.execute(trx);
      if ((owned.rows[0]?.n ?? 0) !== unique.length) return false;
      await sql`update inbox_messages set read_at = ${ts(nowMs)}::timestamptz
        where user_id = ${userId}::uuid and id::text = any (${unique as string[]}) and read_at is null`.execute(trx);
      return true;
    });
  }
}

export class KyselyPushTokenRepository implements PushTokenRepository {
  constructor(private readonly db: NotificationsDb) {}

  /** Keyed by (user, install): one user can never overwrite another user's registration. */
  async upsert(userId: string, t: PushToken, nowMs: number): Promise<void> {
    await inTx(this.db, async (trx) => {
      // Serialise registrations of the same token: under READ COMMITTED two installs racing for one
      // token would both pass the hand-over update and the loser would hit the unique index (23505).
      await sql`select pg_advisory_xact_lock(hashtextextended(${t.token}, 0))`.execute(trx);
      // Hand-over: deactivate the token for any other registration in the same transaction.
      await sql`update notification_push_tokens set deactivated_at = ${ts(nowMs)}::timestamptz, updated_at = ${ts(nowMs)}::timestamptz
        where token = ${t.token} and deactivated_at is null
          and not (user_id = ${userId}::uuid and install_id = ${t.installId}::uuid)`.execute(trx);
      await sql`
        insert into notification_push_tokens (user_id, install_id, platform, token, updated_at)
        values (${userId}::uuid, ${t.installId}::uuid, ${t.platform}, ${t.token}, ${ts(nowMs)}::timestamptz)
        on conflict (user_id, install_id) do update
          set platform = excluded.platform, token = excluded.token, deactivated_at = null, updated_at = excluded.updated_at`.execute(trx);
    });
  }

  async active(userId: string): Promise<readonly PushToken[]> {
    return inTx(this.db, async (trx) => {
      const r = await sql<{ install_id: string; platform: "ios" | "android"; token: string }>`
        select install_id::text as install_id, platform, token from notification_push_tokens
         where user_id = ${userId}::uuid and deactivated_at is null order by updated_at, id`.execute(trx);
      return r.rows.map((x) => ({ installId: x.install_id, platform: x.platform, token: x.token }));
    });
  }

  async deactivate(userId: string, token: string, nowMs: number): Promise<void> {
    await inTx(this.db, async (trx) => {
      await sql`update notification_push_tokens set deactivated_at = ${ts(nowMs)}::timestamptz, updated_at = ${ts(nowMs)}::timestamptz
        where user_id = ${userId}::uuid and token = ${token} and deactivated_at is null`.execute(trx);
    });
  }
}
