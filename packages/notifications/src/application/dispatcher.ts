import { contextClient, narrowContext } from "@outlet/db";
import type { Queryable, RoleSqlClient, SqlClient } from "@outlet/db";
import { isLocale } from "@outlet/i18n";
import type { Locale } from "@outlet/i18n";
import { uuidv7 } from "@outlet/ids";
import type { Logger } from "@outlet/logger";
import { InboxProcessor } from "@outlet/outbox";
import type { OutboxEvent, OutboxWriter } from "@outlet/outbox";
import type { ConsentPurpose } from "@outlet/privacy";
import { decide, DEFAULT_CAPS } from "../domain/decide.js";
import type { Decision, FrequencyCaps } from "../domain/decide.js";
import type { QuietHours } from "../domain/cairo-time.js";
import { renderTemplate } from "../domain/render.js";
import type { Template, TemplateVars } from "../domain/render.js";
import type { Category, Channel, SuppressionReason } from "../domain/types.js";
import { mapEvent } from "./event-map.js";
import type { ChannelKillSwitchPort, ChannelPort, ConsentReader, SendFailureCode } from "./ports.js";
import { pgStoreRecipients } from "./store-recipients.js";
import type { StoreRecipientResolver } from "./store-recipients.js";
import { loadTemplates } from "./template-store.js";

export const DISPATCH_JOB = "notifications.dispatch" as const;
const CONSUMER = "notifications.dispatch";
/** Transactional failover order: the first eligible channel is tried first; template rejection on WhatsApp lands on SMS. */
export const DEFAULT_TRANSACTIONAL_CHAIN: readonly Channel[] = ["push", "whatsapp", "sms", "email"];

/** Finds the recipient of an event. The default reads `user_id` from the event payload. */
export interface RecipientResolver {
  resolve(event: OutboxEvent, tx: Queryable): Promise<string | null>;
}
export const payloadRecipient: RecipientResolver = {
  resolve: (e) => {
    const u = e.payload.user_id;
    return Promise.resolve(typeof u === "string" ? u : null);
  },
};

export interface DispatcherDeps {
  readonly db: RoleSqlClient<"outlet_worker">;
  readonly outbox: OutboxWriter;
  readonly channels: Readonly<Record<Channel, readonly ChannelPort[]>>;
  readonly killSwitch: ChannelKillSwitchPort;
  /** Builds a consent reader on a client bound to the open transaction (e.g. `(db) => new ConsentService({ db, outbox })`). */
  readonly consentFor: (db: SqlClient) => ConsentReader;
  readonly recipients?: RecipientResolver;
  /** Store-level notices (audience `store_members`). Default: active owner, manager and warehouse members. */
  readonly storeRecipients?: StoreRecipientResolver;
  readonly logger?: Logger;
  readonly now?: () => Date;
  readonly newId?: () => string;
  /** Jitter in [0, 1); injected for tests. */
  readonly random?: () => number;
  readonly caps?: FrequencyCaps;
  readonly quietHours?: QuietHours;
  readonly transactionalChain?: readonly Channel[];
  /** Attempts per channel before failing over (default 3, backoff 30 s * 2^n with jitter). */
  readonly maxAttempts?: number;
}

export interface MarketingRequest {
  readonly userId: string;
  readonly marketId: string;
  readonly templateCode: string;
  /** Idempotency of the request (e.g. `price_drop:<sku>:<price>`). One row per (key, user, channel). */
  readonly dedupeKey: string;
  readonly vars: TemplateVars;
  /** Channels to try, each independently (marketing never fails over to another channel). Default push. */
  readonly channels?: readonly Channel[];
}

interface LogRow {
  id: string;
  user_id: string;
  market_id: string;
  template_code: string;
  category: Category;
  channel: Channel;
  fallback_channels: Channel[];
  vars: TemplateVars;
  attempts: number;
}

type Outcome = "processed" | "duplicate" | "ignored" | "unresolved";

const txClient = (tx: Queryable): SqlClient => ({ query: (s, p) => tx.query(s, p), transaction: (fn) => fn(tx) });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isoDate = (d: Date): string => d.toISOString();

/**
 * Event consumer plus due-queue sender (worker job `notifications.dispatch`, ADR-0011).
 * handle(event): inbox-deduplicated, writes the per-channel decisions (queued / suppressed) as notification_log rows.
 * runDue(): sends queued rows through the ChannelPorts with provider failover, then channel failover (transactional only).
 * Everything user-owned happens narrowed to one shopper. Message bodies are never logged or stored.
 */
export class Dispatcher {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly random: () => number;
  private readonly recipients: RecipientResolver;
  private readonly storeRecipients: StoreRecipientResolver;
  private readonly caps: FrequencyCaps;
  private readonly chain: readonly Channel[];
  private readonly maxAttempts: number;

  constructor(private readonly d: DispatcherDeps) {
    this.now = d.now ?? (() => new Date());
    this.newId = d.newId ?? uuidv7;
    this.random = d.random ?? Math.random;
    this.recipients = d.recipients ?? payloadRecipient;
    this.storeRecipients = d.storeRecipients ?? pgStoreRecipients;
    this.caps = d.caps ?? DEFAULT_CAPS;
    this.chain = d.transactionalChain ?? DEFAULT_TRANSACTIONAL_CHAIN;
    this.maxAttempts = d.maxAttempts ?? 3;
  }

  private workerDb(marketId: string, userId?: string): SqlClient {
    return contextClient(this.d.db, userId === undefined ? { kind: "worker", job: DISPATCH_JOB, marketId } : { kind: "worker", job: DISPATCH_JOB, marketId, userId });
  }

  /** Consumes one outbox event (at-least-once safe: the inbox row and the log rows commit together). */
  async handle(event: OutboxEvent): Promise<Outcome> {
    const n = mapEvent(event);
    if (n === null) return "ignored";
    const state = { unresolved: false };
    const outcome = await new InboxProcessor(this.workerDb(event.marketId)).process(CONSUMER, event.id, async (tx) => {
      const userIds = await this.resolveAudience(n.audience, event, tx);
      if (userIds.length === 0) {
        state.unresolved = true;
        return;
      }
      const templates = await loadTemplates(tx, event.marketId, n.templateCode);
      const storeId = typeof event.payload.store_id === "string" ? event.payload.store_id : null;
      for (const userId of userIds) {
        await narrowContext(tx, { userId });
        const locale = await this.userLocale(tx, userId);
        const extra = n.needsStoreName === true && storeId !== null ? { store_name: await this.storeName(tx, storeId, locale) } : {};
        // dedupe_key carries the user id, so a redelivery (or a second member) can never duplicate a row.
        await this.plan(tx, { userId, marketId: event.marketId, code: n.templateCode, category: "transactional", dedupeBase: event.id, eventId: event.id, vars: { ...n.vars(locale), ...extra }, channels: this.chain, templates });
      }
    });
    if (state.unresolved) {
      this.d.logger?.warn("notification recipient unresolved", { eventType: event.type, eventId: event.id });
      return "unresolved";
    }
    return outcome;
  }

  private async resolveAudience(audience: "payload_user" | "store_members", event: OutboxEvent, tx: Queryable): Promise<readonly string[]> {
    if (audience === "payload_user") {
      const u = await this.recipients.resolve(event, tx);
      return u === null ? [] : [u];
    }
    const s = event.payload.store_id;
    return typeof s === "string" && UUID.test(s) ? this.storeRecipients.resolve(s, event.marketId, tx) : [];
  }

  /** Store display name in the reader's language (Arabic when the English name is missing). Never fails the notice. */
  private async storeName(tx: Queryable, storeId: string, locale: Locale): Promise<string> {
    const fallback = locale === "en-EG" ? "the store" : "المتجر";
    if (!UUID.test(storeId)) return fallback;
    const r = await tx.query<{ ar: string | null; en: string | null }>("SELECT display_name_ar AS ar, display_name_en AS en FROM stores WHERE id = $1", [storeId]);
    const row = r.rows[0];
    const name = locale === "en-EG" ? (row?.en ?? row?.ar) : row?.ar;
    return name !== undefined && name !== null && name.length > 0 ? name : fallback;
  }

  /** Marketing trigger (verified price drop, back in size ...). Consent, caps and quiet hours are applied, never skipped. */
  async enqueueMarketing(req: MarketingRequest): Promise<void> {
    await this.workerDb(req.marketId).transaction(async (tx) => {
      await narrowContext(tx, { userId: req.userId });
      const templates = await loadTemplates(tx, req.marketId, req.templateCode);
      await this.plan(tx, { userId: req.userId, marketId: req.marketId, code: req.templateCode, category: "marketing", dedupeBase: req.dedupeKey, eventId: null, vars: req.vars, channels: req.channels ?? ["push"], templates });
    });
  }

  /** Sends due queued rows of one market. Returns the number of rows handled. */
  async runDue(marketId: string, limit = 50): Promise<number> {
    const due = await this.workerDb(marketId).query<{ id: string; user_id: string }>(
      "SELECT id, user_id FROM notification_log WHERE status = 'queued' AND scheduled_for <= $1 AND market_id = $2 ORDER BY scheduled_for, id LIMIT $3",
      [isoDate(this.now()), marketId, limit],
    );
    let n = 0;
    for (const r of due.rows) {
      await this.workerDb(marketId, r.user_id).transaction((tx) => this.deliver(tx, r.id, marketId, r.user_id)).then((done) => {
        if (done) n += 1;
      });
    }
    return n;
  }

  // ---------------------------------------------------------------- planning

  private async userLocale(tx: Queryable, userId: string): Promise<Locale> {
    const r = await tx.query<{ locale: string }>("SELECT locale FROM users WHERE id = $1", [userId]);
    const l = r.rows[0]?.locale;
    return l !== undefined && isLocale(l) ? l : "ar-EG";
  }

  private async userState(tx: Queryable, userId: string, category: Category, now: Date) {
    const consents = await this.d.consentFor(txClient(tx)).current(userId);
    const granted = new Set<ConsentPurpose>(consents.filter((c) => c.granted).map((c) => c.purpose));
    const prefs = await tx.query<{ channel: Channel; enabled: boolean }>("SELECT channel, enabled FROM notification_preferences WHERE user_id = $1 AND category = $2", [userId, category]);
    const sends = await tx.query<{ channel: Channel; sent_at: Date }>(
      "SELECT channel, sent_at FROM notification_log WHERE user_id = $1 AND category = 'marketing' AND status = 'sent' AND sent_at > $2",
      [userId, isoDate(new Date(now.getTime() - 7 * 86_400_000))],
    );
    return { granted, prefs: new Map(prefs.rows.map((p) => [p.channel, p.enabled])), sends: sends.rows.map((s) => ({ channel: s.channel, at: new Date(s.sent_at) })) };
  }

  private async decideFor(category: Category, channel: Channel, now: Date, st: Awaited<ReturnType<Dispatcher["userState"]>>): Promise<Decision> {
    return decide({
      category,
      channel,
      grantedConsents: st.granted,
      preferenceEnabled: st.prefs.get(channel),
      now,
      recentSends: st.sends.filter((s) => s.channel === channel).map((s) => s.at),
      killed: await this.d.killSwitch.isKilled(channel),
      caps: this.caps,
      ...(this.d.quietHours ? { quietHours: this.d.quietHours } : {}),
    });
  }

  private async plan(
    tx: Queryable,
    p: { userId: string; marketId: string; code: string; category: Category; dedupeBase: string; eventId: string | null; vars: TemplateVars; channels: readonly Channel[]; templates: readonly Template[] },
  ): Promise<void> {
    const now = this.now();
    const st = await this.userState(tx, p.userId, p.category, now);
    const decided: { channel: Channel; d: Decision }[] = [];
    for (const channel of p.channels) {
      decided.push({ channel, d: await this.decideFor(p.category, channel, now, st) });
    }
    const insert = (channel: Channel, fallback: readonly Channel[], d: Decision): Promise<unknown> => {
      const status = d.kind === "suppress" ? "suppressed" : "queued";
      const scheduled = d.kind === "defer" ? d.until : now;
      return tx.query(
        `INSERT INTO notification_log (id, user_id, market_id, template_code, category, channel, fallback_channels, event_id, dedupe_key, vars, status, suppression_reason, scheduled_for, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14) ON CONFLICT (dedupe_key) DO NOTHING`,
        [this.newId(), p.userId, p.marketId, p.code, p.category, channel, fallback, p.eventId, `${p.dedupeBase}:${p.userId}:${channel}`, JSON.stringify(p.vars), status, d.kind === "suppress" ? d.reason : null, isoDate(scheduled), isoDate(now)],
      );
    };
    if (p.category === "marketing") {
      // Independent rows per requested channel; no cross-channel failover for marketing.
      for (const { channel, d } of decided) await insert(channel, [], d);
      return;
    }
    // Transactional: the in-app inbox copy always; one outbound row with the eligible rest of the chain as failover.
    await insert("in_app", [], await this.decideFor(p.category, "in_app", now, st));
    const eligible = decided.filter((x) => x.d.kind !== "suppress");
    const primary = eligible[0];
    if (primary) await insert(primary.channel, eligible.slice(1).map((x) => x.channel), primary.d);
    else if (decided[0]) await insert(decided[0].channel, [], decided[0].d);
  }

  // ---------------------------------------------------------------- delivery

  private async deliver(tx: Queryable, id: string, marketId: string, userId: string): Promise<boolean> {
    const found = await tx.query<LogRow>(
      "SELECT id, user_id, market_id, template_code, category, channel, fallback_channels, vars, attempts FROM notification_log WHERE id = $1 AND status = 'queued' FOR UPDATE SKIP LOCKED",
      [id],
    );
    let row: LogRow | undefined = found.rows[0];
    if (!row) return false;
    const locale = await this.userLocale(tx, userId);
    const templates = (await loadTemplates(tx, marketId, row.template_code)).filter((t) => t.category === row?.category);
    for (;;) {
      const now = this.now();
      const st = await this.userState(tx, userId, row.category, now);
      // The row itself is queued, never sent, so it is not part of recentSends.
      const decision = await this.decideFor(row.category, row.channel, now, st);
      if (decision.kind === "defer") {
        await tx.query("UPDATE notification_log SET scheduled_for = $2 WHERE id = $1", [row.id, isoDate(decision.until)]);
        return true;
      }
      let failure: SendFailureCode | "suppressed";
      let suppressed: SuppressionReason | undefined;
      if (decision.kind === "suppress") {
        failure = "suppressed";
        suppressed = decision.reason;
      } else {
        const sent = await this.send(row, locale, templates);
        if (sent.ok) {
          await tx.query("UPDATE notification_log SET status = 'sent', provider = $2, provider_msg_id = $3, attempts = attempts + 1, sent_at = $4 WHERE id = $1", [row.id, sent.provider, sent.providerMsgId, isoDate(now)]);
          await this.emit(tx, "notification.delivered", row, marketId, now, {});
          this.d.logger?.info("notification sent", { notificationId: row.id, channel: row.channel, provider: sent.provider });
          return true;
        }
        failure = sent.code;
      }
      // Retry the same channel on transient provider failures, with exponential backoff and jitter.
      if (failure === "provider_error" || failure === "rate_limited") {
        const attempts = row.attempts + 1;
        if (attempts < this.maxAttempts) {
          const backoff = 30_000 * 2 ** (attempts - 1) * (1 + this.random());
          await tx.query("UPDATE notification_log SET attempts = $2, error_code = $3, scheduled_for = $4 WHERE id = $1", [row.id, attempts, failure, isoDate(new Date(now.getTime() + backoff))]);
          return true;
        }
      }
      const chain: readonly Channel[] = row.category === "transactional" ? row.fallback_channels : [];
      const [next, ...rest] = chain;
      if (next !== undefined) {
        this.d.logger?.warn("notification failover", { notificationId: row.id, from: row.channel, to: next, cause: failure });
        await tx.query("UPDATE notification_log SET channel = $2, fallback_channels = $3, attempts = 0, error_code = $4 WHERE id = $1", [row.id, next, rest, failure]);
        row = { ...row, channel: next, fallback_channels: rest, attempts: 0 };
        continue;
      }
      if (suppressed !== undefined) {
        await tx.query("UPDATE notification_log SET status = 'suppressed', suppression_reason = $2 WHERE id = $1", [row.id, suppressed]);
        return true;
      }
      await tx.query("UPDATE notification_log SET status = 'failed', error_code = $2, attempts = $3 WHERE id = $1", [row.id, failure, row.attempts + 1]);
      await this.emit(tx, "notification.failed", row, marketId, now, { error_code: failure });
      this.d.logger?.warn("notification failed", { notificationId: row.id, channel: row.channel, errorCode: failure });
      return true;
    }
  }

  private async send(row: LogRow, locale: Locale, templates: readonly Template[]): Promise<{ ok: true; provider: string; providerMsgId: string } | { ok: false; code: SendFailureCode }> {
    const r = renderTemplate(templates, row.template_code, row.channel, locale, row.vars);
    if (!r.ok) return { ok: false, code: "template_rejected" };
    let last: SendFailureCode = "provider_error";
    for (const port of this.d.channels[row.channel]) {
      const res = await port.send({
        userId: row.user_id,
        channel: row.channel,
        templateCode: row.template_code,
        locale: r.value.locale,
        title: r.value.title,
        body: r.value.body,
        providerTemplateName: r.value.providerTemplateName,
        vars: row.vars,
        idempotencyKey: `${row.id}:${row.channel}`,
      });
      if (res.ok) return { ok: true, provider: port.provider, providerMsgId: res.providerMsgId };
      last = res.code;
      // Channel-level failures (rejected template, no destination) do not improve with another provider of the same channel.
      if (res.code === "template_rejected" || res.code === "no_destination") break;
    }
    return { ok: false, code: last };
  }

  private async emit(tx: Queryable, type: "notification.delivered" | "notification.failed", row: LogRow, marketId: string, now: Date, extra: Record<string, string>): Promise<void> {
    await this.d.outbox.append(tx, {
      id: this.newId(),
      type,
      aggregateType: "notification",
      aggregateId: row.id,
      marketId,
      occurredAt: isoDate(now),
      payload: { notification_id: row.id, channel: row.channel, template_code: row.template_code, transactional: row.category === "transactional", ...extra },
    });
  }
}
