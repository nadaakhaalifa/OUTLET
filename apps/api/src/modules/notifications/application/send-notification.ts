import { decideChannel, frequencyUsage, retryDelayMs, type ChannelDecision } from "../domain/policy";
import type {
  AnalyticsPort,
  Clock,
  Contact,
  ContactPort,
  ConsentPort,
  DeliveryLogRepository,
  FrequencyStore,
  IdPort,
  InboxRepository,
  NotificationEventPublisher,
  PreferenceRepository,
  ProviderMessage,
  ProviderRegistry,
  PushTokenRepository,
  RequestRepository,
  SuppressionRepository,
  TemplateRepository,
} from "../domain/ports";
import { checkPayload, isSafeDeepLink, renderTemplate } from "../domain/templates";
import {
  CHANNEL_ORDER,
  DEFAULT_CAPS,
  DEFAULT_INBOX_TTL_MS,
  DEFAULT_QUIET_HOURS,
  DEFAULT_TTL_MS,
  MARKETING_PURPOSE,
  isSwitchable,
  type Channel,
  type ExternalChannel,
  type FrequencyCaps,
  type LogStatus,
  type NotificationRequest,
  type NotificationTemplate,
  type Payload,
  type QuietHours,
  type SuppressedReason,
} from "../domain/types";

export interface SendInput {
  readonly userId: string;
  readonly templateKey: string;
  /** Idempotency scope with the user and key, for example an order id. */
  readonly ref: string;
  readonly payload: Payload;
  readonly deepLink?: string | null;
  readonly expiresAtMs?: number;
}

export type SendRejection = "invalid_input" | "unknown_template" | "invalid_payload" | "recipient_unknown";

export type SendResult =
  | { readonly kind: "rejected"; readonly reason: SendRejection }
  | { readonly kind: "duplicate"; readonly requestId: string; readonly status: NotificationRequest["status"] }
  | {
      readonly kind: "accepted";
      readonly requestId: string;
      readonly status: NotificationRequest["status"];
      readonly channel: Channel | null;
      readonly suppressedReason: SuppressedReason | null;
      readonly inbox: boolean;
      /** Why external channels were skipped (metrics). Empty when the first channel was used. */
      readonly reasons: readonly SuppressedReason[];
    };

export interface SendNotificationDeps {
  readonly templates: TemplateRepository;
  readonly requests: RequestRepository;
  readonly log: DeliveryLogRepository;
  readonly frequency: FrequencyStore;
  readonly preferences: PreferenceRepository;
  readonly suppressions: SuppressionRepository;
  readonly inbox: InboxRepository;
  readonly tokens: PushTokenRepository;
  readonly consent: ConsentPort;
  readonly contacts: ContactPort;
  readonly providers: ProviderRegistry;
  readonly events: NotificationEventPublisher;
  readonly analytics: AnalyticsPort;
  readonly clock: Clock;
  readonly ids: IdPort;
  readonly caps?: FrequencyCaps;
  readonly quiet?: QuietHours;
}

const REF = /^[A-Za-z0-9:_\-.]{1,128}$/;
const KEY = /^[a-z][a-z0-9_]{1,63}$/;
const WEEK_MS = 7 * 86_400_000;

type Outcome =
  | { readonly kind: "sent"; readonly channel: ExternalChannel }
  | { readonly kind: "retry"; readonly channel: ExternalChannel }
  | { readonly kind: "failed"; readonly channel: ExternalChannel | null; readonly code: string };

/** Sends one logical notification: consent, preference, caps, quiet hours, failover, log, inbox. */
export class SendNotification {
  readonly caps: FrequencyCaps;
  readonly quiet: QuietHours;

  constructor(private readonly d: SendNotificationDeps) {
    this.caps = d.caps ?? DEFAULT_CAPS;
    this.quiet = d.quiet ?? DEFAULT_QUIET_HOURS;
  }

  async execute(input: SendInput): Promise<SendResult> {
    const now = this.d.clock.nowMs();
    if (!KEY.test(input.templateKey) || !REF.test(input.ref)) return { kind: "rejected", reason: "invalid_input" };
    const deepLink = input.deepLink ?? null;
    if (deepLink !== null && !isSafeDeepLink(deepLink)) return { kind: "rejected", reason: "invalid_input" };

    const templates = await this.d.templates.activeFor(input.templateKey, now);
    const first = templates[0];
    if (first === undefined) return { kind: "rejected", reason: "unknown_template" };
    if (templates.some((t) => checkPayload(t, input.payload) !== null)) return { kind: "rejected", reason: "invalid_payload" };

    const expiresAtMs = input.expiresAtMs ?? now + DEFAULT_TTL_MS[first.category];
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) return { kind: "rejected", reason: "invalid_input" };

    const existing = await this.d.requests.find(input.userId, input.templateKey, input.ref);
    if (existing !== null) return { kind: "duplicate", requestId: existing.id, status: existing.status };

    const contact = await this.d.contacts.contact(input.userId);
    if (contact === null) return { kind: "rejected", reason: "recipient_unknown" };

    const request: NotificationRequest = {
      id: this.d.ids.uuidV7(),
      userId: input.userId,
      templateKey: input.templateKey,
      ref: input.ref,
      category: first.category,
      type: first.type,
      payload: input.payload,
      templateVersions: Object.fromEntries(templates.map((t) => [t.channel, t.version])),
      status: "ACCEPTED",
      suppressedReason: null,
      pendingChannel: null,
      scheduledForMs: null,
      attempts: 0,
      expiresAtMs,
      deepLink,
      locale: contact.locale,
      createdAtMs: now,
    };
    const inserted = await this.d.requests.insertIfAbsent(request);
    if (!inserted) {
      const again = await this.d.requests.find(input.userId, input.templateKey, input.ref);
      return { kind: "duplicate", requestId: again?.id ?? request.id, status: again?.status ?? "ACCEPTED" };
    }
    return this.process(request, templates, contact, now);
  }

  // ---- first pass ---------------------------------------------------------------------------

  private async process(
    request: NotificationRequest,
    templates: readonly NotificationTemplate[],
    contact: Contact,
    now: number,
  ): Promise<SendResult> {
    const prefs = await this.d.preferences.all(request.userId);
    const byChannel = new Map<Channel, NotificationTemplate>(templates.map((t) => [t.channel, t]));
    const marketing = request.category === "marketing";
    const enabledOn = (channel: Channel): boolean => this.typeEnabled(prefs, request, channel);

    let chosen: { channel: ExternalChannel; template: NotificationTemplate; decision: ChannelDecision } | null = null;
    const reasons: SuppressedReason[] = [];
    for (const channel of CHANNEL_ORDER) {
      const template = byChannel.get(channel);
      if (template === undefined) continue;
      if (!(await this.hasAddress(channel, request.userId, contact))) continue;
      const decision = await this.decide(request, channel, enabledOn(channel), now);
      if (decision.kind === "suppress") {
        reasons.push(decision.reason);
        continue;
      }
      if (decision.kind === "send" && marketing && !(await this.reserveSlot(request, channel, now))) {
        reasons.push("FREQUENCY_CAP");
        continue;
      }
      chosen = { channel, template, decision };
      break;
    }

    // Inbox mirror: not for security, and for marketing only when the user has not switched the type off.
    let inbox = false;
    if (request.category !== "security" && (!marketing || (enabledOn("in_app") && this.baseEnabled(prefs, request)))) {
      inbox = await this.writeInbox(request, byChannel, now);
    }

    const withReasons = (r: SendResult): SendResult => (r.kind === "accepted" ? { ...r, reasons } : r);
    if (chosen === null) {
      if (inbox) return withReasons(await this.finish(request, "SENT", null, null, true));
      const reason = reasons[0];
      if (reason !== undefined) {
        await this.d.events.publish({ type: "notification.suppressed", requestId: request.id, category: request.category, reason });
        return withReasons(await this.finish(request, "SUPPRESSED", reason, null, false));
      }
      await this.d.events.publish({ type: "notification.failed", requestId: request.id, category: request.category, channel: null, code: "no_address" });
      return withReasons(await this.finish(request, "FAILED", null, null, false));
    }

    if (chosen.decision.kind === "defer") {
      const scheduled: NotificationRequest = {
        ...request,
        status: "SCHEDULED",
        pendingChannel: chosen.channel,
        scheduledForMs: chosen.decision.untilMs,
      };
      await this.d.requests.save(scheduled);
      return withReasons(this.result(scheduled, chosen.channel, null, inbox));
    }

    const outcome = await this.deliver(request, chosen.channel, byChannel, contact, now);
    return withReasons(await this.applyOutcome(request, outcome, inbox, now, marketing));
  }

  // ---- release ------------------------------------------------------------------------------

  /** Re-evaluates and sends one claimed request (quiet-hours release or retry). */
  async release(request: NotificationRequest): Promise<SendResult> {
    const now = this.d.clock.nowMs();
    const channel = request.pendingChannel;
    if (channel === null) return this.finish(request, "FAILED", null, null, false);
    const contact = await this.d.contacts.contact(request.userId);
    if (contact === null) return this.finish(request, "CANCELLED", null, null, false);

    const templates = await this.versions(request);
    const byChannel = new Map<Channel, NotificationTemplate>(templates.map((t) => [t.channel, t]));
    const prefs = await this.d.preferences.all(request.userId);

    if (now >= request.expiresAtMs) {
      await this.d.events.publish({ type: "notification.failed", requestId: request.id, category: request.category, channel, code: "ttl_expired" });
      return this.finish(request, "FAILED", null, channel, false);
    }
    // Consent, preference, suppression and quiet hours are re-evaluated at release time.
    const decision = await this.decide(request, channel, this.typeEnabled(prefs, request, channel), now);
    if (decision.kind === "suppress") {
      await this.d.events.publish({ type: "notification.suppressed", requestId: request.id, category: request.category, reason: decision.reason });
      return this.finish(request, "SUPPRESSED", decision.reason, channel, false);
    }
    if (decision.kind === "defer") {
      const again: NotificationRequest = { ...request, status: "SCHEDULED", scheduledForMs: decision.untilMs };
      await this.d.requests.save(again);
      return this.result(again, channel, null, false);
    }
    const reserved = request.category === "marketing";
    if (reserved && !(await this.reserveSlot(request, channel, now))) {
      await this.d.events.publish({ type: "notification.suppressed", requestId: request.id, category: request.category, reason: "FREQUENCY_CAP" });
      return this.finish(request, "SUPPRESSED", "FREQUENCY_CAP", channel, false);
    }
    const outcome = await this.deliver(request, channel, byChannel, contact, now);
    return this.applyOutcome(request, outcome, false, now, reserved);
  }

  private async versions(request: NotificationRequest): Promise<NotificationTemplate[]> {
    const out: NotificationTemplate[] = [];
    for (const [channel, version] of Object.entries(request.templateVersions) as [Channel, number][]) {
      const t = await this.d.templates.version(request.templateKey, channel, version);
      if (t !== null) out.push(t);
    }
    return out;
  }

  // ---- decisions ----------------------------------------------------------------------------

  private typeEnabled(prefs: ReadonlyMap<string, boolean>, r: NotificationRequest, channel: Channel): boolean {
    if (r.category !== "marketing" || !isSwitchable(r.type)) return true;
    return prefs.get(`${r.type}.${channel}`) ?? prefs.get(r.type) ?? true;
  }

  private baseEnabled(prefs: ReadonlyMap<string, boolean>, r: NotificationRequest): boolean {
    return !isSwitchable(r.type) || (prefs.get(r.type) ?? true);
  }

  private async decide(r: NotificationRequest, channel: ExternalChannel, typeEnabled: boolean, nowMs: number): Promise<ChannelDecision> {
    const purpose = MARKETING_PURPOSE[channel];
    const marketing = r.category === "marketing";
    const [suppressions, consentGranted, sent] = await Promise.all([
      this.d.suppressions.active(r.userId, channel),
      marketing && purpose !== undefined ? this.d.consent.isGranted(r.userId, purpose) : Promise.resolve(false),
      marketing ? this.d.frequency.sentTimes(r.userId, channel, nowMs - WEEK_MS - 86_400_000) : Promise.resolve([] as number[]),
    ]);
    return decideChannel({
      category: r.category,
      channel,
      nowMs,
      suppressions,
      consentGranted,
      typeEnabled,
      marketingSentAtMs: sent,
      caps: this.caps,
      quiet: this.quiet,
      expiresAtMs: r.expiresAtMs,
    });
  }

  /** Atomically takes a marketing send slot; the cap check and the reservation are one step. */
  private reserveSlot(r: NotificationRequest, channel: ExternalChannel, now: number): Promise<boolean> {
    return this.d.frequency.reserve(r.userId, channel, now, (times) => {
      const u = frequencyUsage(times, now);
      return u.day < this.caps.perDay && u.week < this.caps.perWeek;
    });
  }

  private async hasAddress(channel: ExternalChannel, userId: string, c: Contact): Promise<boolean> {
    switch (channel) {
      case "push":
        return (await this.d.tokens.active(userId)).length > 0;
      case "whatsapp":
      case "sms":
        return c.phone !== null;
      case "email":
        return c.email !== null;
    }
  }

  // ---- delivery -----------------------------------------------------------------------------

  private async deliver(
    request: NotificationRequest,
    channel: ExternalChannel,
    byChannel: ReadonlyMap<Channel, NotificationTemplate>,
    contact: Contact,
    now: number,
  ): Promise<Outcome> {
    const template = byChannel.get(channel);
    if (template === undefined) return { kind: "failed", channel, code: "template_missing" };

    if (channel === "whatsapp" && (template.approval !== "APPROVED" || template.providerTemplateId === null)) {
      await this.logAttempt(request, template, "whatsapp", "template_gate", null, "FAILED", "template_not_approved", now);
    } else {
      const r = await this.attempt(request, template, channel, contact, now);
      if (r.kind !== "template_rejected") return r.outcome;
    }

    // WhatsApp template rejection: SMS fallback for transactional and security only (spec N8).
    const sms = byChannel.get("sms");
    if (channel === "whatsapp" && request.category !== "marketing" && sms !== undefined && contact.phone !== null) {
      const r = await this.attempt(request, sms, "sms", contact, now);
      return r.kind === "template_rejected" ? { kind: "failed", channel: "sms", code: "template_rejected" } : r.outcome;
    }
    return { kind: "failed", channel, code: "template_rejected" };
  }

  /** Tries every enabled provider of a channel in priority order (every token for push). */
  private async attempt(
    request: NotificationRequest,
    template: NotificationTemplate,
    channel: ExternalChannel,
    contact: Contact,
    now: number,
  ): Promise<{ kind: "template_rejected" } | { kind: "done"; outcome: Outcome }> {
    const rendered = renderTemplate(template, request.payload, request.locale);
    const base = (to: string): ProviderMessage => ({
      requestId: request.id,
      channel,
      to,
      subject: rendered.subject,
      body: rendered.body,
      providerTemplateId: template.providerTemplateId,
      locale: request.locale,
    });
    const addresses: { to: string; token: string | null }[] = [];
    if (channel === "push") {
      for (const t of await this.d.tokens.active(request.userId)) addresses.push({ to: t.token, token: t.token });
    } else if (channel === "email" && contact.email !== null) {
      addresses.push({ to: contact.email, token: null });
    } else if ((channel === "sms" || channel === "whatsapp") && contact.phone !== null) {
      addresses.push({ to: contact.phone, token: null });
    }
    if (addresses.length === 0) return { kind: "done", outcome: { kind: "failed", channel, code: "no_address" } };

    let sent = false;
    let unavailable = false;
    let permanent: string | null = null;
    let templateRejected = false;
    let invalid = 0;
    for (const a of addresses) {
      const r = await this.tryProviders(request, template, channel, base(a.to), now);
      if (r.kind === "sent") sent = true;
      else if (r.kind === "unavailable") unavailable = true;
      else if (r.kind === "template_rejected") templateRejected = true;
      else if (r.kind === "invalid_recipient") {
        invalid += 1;
        if (a.token !== null) await this.d.tokens.deactivate(request.userId, a.token, now);
      } else permanent = r.code;
    }
    if (sent) return { kind: "done", outcome: { kind: "sent", channel } };
    if (templateRejected) return { kind: "template_rejected" };
    if (unavailable) return { kind: "done", outcome: { kind: "retry", channel } };
    if (permanent !== null) return { kind: "done", outcome: { kind: "failed", channel, code: permanent } };
    if (invalid > 0 && channel === "push" && (await this.d.tokens.active(request.userId)).length === 0) {
      await this.d.suppressions.add(request.userId, "push", "INVALID_TOKEN", now);
    }
    return { kind: "done", outcome: { kind: "failed", channel, code: "invalid_recipient" } };
  }

  private async tryProviders(
    request: NotificationRequest,
    template: NotificationTemplate,
    channel: ExternalChannel,
    message: ProviderMessage,
    now: number,
  ): Promise<TryResult> {
    const providers = this.d.providers.providersFor(channel);
    for (const p of providers) {
      let result;
      try {
        result = await p.send(message);
      } catch {
        // A throwing adapter is an outage, never a crash of the dispatcher. No message text is logged.
        result = { kind: "unavailable" } as const;
      }
      switch (result.kind) {
        case "sent":
          await this.logAttempt(request, template, channel, p.code, result.providerRef, "SENT", null, now);
          return { kind: "sent" };
        case "unavailable":
          await this.logAttempt(request, template, channel, p.code, null, "FAILED", "provider_unavailable", now);
          continue;
        case "template_rejected":
          await this.logAttempt(request, template, channel, p.code, null, "FAILED", "template_rejected", now);
          return { kind: "template_rejected" };
        case "invalid_recipient":
          await this.logAttempt(request, template, channel, p.code, null, "BOUNCED", "invalid_recipient", now);
          return { kind: "invalid_recipient" };
        case "failed":
          await this.logAttempt(request, template, channel, p.code, null, "FAILED", safeCode(result.code), now);
          return { kind: "failed", code: safeCode(result.code) };
      }
    }
    return { kind: "unavailable" };
  }

  private async logAttempt(
    request: NotificationRequest,
    template: NotificationTemplate,
    channel: Channel,
    providerCode: string,
    providerRef: string | null,
    status: LogStatus,
    failureCode: string | null,
    now: number,
  ): Promise<void> {
    await this.d.log.append({
      id: this.d.ids.uuidV7(),
      requestId: request.id,
      userId: request.userId,
      channel,
      templateKey: request.templateKey,
      templateVersion: template.version,
      category: request.category,
      providerCode,
      providerRef,
      status,
      failureCode,
      sentAtMs: now,
    });
  }

  // ---- outcome ------------------------------------------------------------------------------

  private async applyOutcome(request: NotificationRequest, o: Outcome, inbox: boolean, now: number, reserved = false): Promise<SendResult> {
    const attempts = request.attempts + 1;
    const withAttempts: NotificationRequest = { ...request, attempts };
    switch (o.kind) {
      case "sent": {
        await this.d.events.publish({ type: "notification.sent", requestId: request.id, category: request.category, channel: o.channel });
        await this.trackAlert(request, o.channel);
        return this.finish(withAttempts, "SENT", null, o.channel, inbox);
      }
      case "retry": {
        if (reserved) await this.d.frequency.release(request.userId, o.channel, now);
        const at = now + retryDelayMs(attempts, request.id);
        if (at >= request.expiresAtMs) {
          await this.d.events.publish({ type: "notification.failed", requestId: request.id, category: request.category, channel: o.channel, code: "ttl_expired" });
          return this.finish(withAttempts, "FAILED", null, o.channel, inbox);
        }
        const scheduled: NotificationRequest = { ...withAttempts, status: "SCHEDULED", pendingChannel: o.channel, scheduledForMs: at };
        await this.d.requests.save(scheduled);
        return this.result(scheduled, o.channel, null, inbox);
      }
      case "failed": {
        if (reserved && o.channel !== null) await this.d.frequency.release(request.userId, o.channel, now);
        await this.d.events.publish({ type: "notification.failed", requestId: request.id, category: request.category, channel: o.channel, code: o.code });
        return this.finish(withAttempts, "FAILED", null, o.channel, inbox);
      }
    }
  }

  private async finish(
    request: NotificationRequest,
    status: NotificationRequest["status"],
    suppressedReason: SuppressedReason | null,
    channel: ExternalChannel | null,
    inbox: boolean,
  ): Promise<SendResult> {
    const done: NotificationRequest = {
      ...request,
      status,
      suppressedReason,
      pendingChannel: null,
      scheduledForMs: null,
    };
    await this.d.requests.save(done);
    const shown: Channel | null = status === "SENT" ? (channel ?? (inbox ? "in_app" : null)) : channel;
    return this.result(done, shown, suppressedReason, inbox);
  }

  private result(r: NotificationRequest, channel: Channel | null, reason: SuppressedReason | null, inbox: boolean): SendResult {
    return { kind: "accepted", requestId: r.id, status: r.status, channel, suppressedReason: reason, inbox, reasons: [] };
  }

  private async trackAlert(request: NotificationRequest, channel: ExternalChannel): Promise<void> {
    const t = (await this.versions(request)).find((x) => x.channel === channel);
    if (t?.alertType === null || t === undefined) return;
    await this.d.analytics.track({ name: "wishlist_alert_sent", properties: { alert_type: t.alertType, channel } });
  }

  private async writeInbox(
    request: NotificationRequest,
    byChannel: ReadonlyMap<Channel, NotificationTemplate>,
    now: number,
  ): Promise<boolean> {
    const order: Channel[] = ["in_app", ...CHANNEL_ORDER];
    const template = order.map((c) => byChannel.get(c)).find((t) => t !== undefined);
    if (template === undefined) return false;
    const r = renderTemplate(template, request.payload, request.locale);
    const clip = (s: string): string => (s.length > 80 ? `${s.slice(0, 77)}...` : s);
    const titleAr = r.subjectAr ?? clip(r.bodyAr);
    const titleEn = r.subjectEn ?? (r.bodyEn !== null ? clip(r.bodyEn) : null);
    const expires = request.category === "marketing" ? Math.min(request.expiresAtMs, now + DEFAULT_INBOX_TTL_MS) : now + DEFAULT_INBOX_TTL_MS;
    await this.d.inbox.insert({
      id: this.d.ids.uuidV7(),
      userId: request.userId,
      requestId: request.id,
      type: request.type,
      titleAr,
      titleEn,
      bodyAr: r.bodyAr,
      bodyEn: r.bodyEn,
      deepLink: request.deepLink,
      readAtMs: null,
      expiresAtMs: expires,
      createdAtMs: now,
    });
    await this.logAttempt(request, template, "in_app", "inbox", null, "DELIVERED", null, now);
    return true;
  }
}

type TryResult =
  | { readonly kind: "sent" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "template_rejected" }
  | { readonly kind: "invalid_recipient" }
  | { readonly kind: "failed"; readonly code: string };

const safeCode = (c: string): string => (/^[a-z][a-z0-9_]{1,47}$/.test(c) ? c : "provider_error");

/** Releases deferred and retried requests whose time has come. */
export class ProcessDue {
  constructor(
    private readonly requests: RequestRepository,
    private readonly sender: SendNotification,
    private readonly clock: Clock,
  ) {}

  async execute(limit = 100): Promise<{ readonly processed: number; readonly sent: number; readonly rescheduled: number }> {
    const due = await this.requests.claimDue(this.clock.nowMs(), limit);
    let sent = 0;
    let rescheduled = 0;
    for (const r of due) {
      const res = await this.sender.release(r);
      if (res.kind === "accepted" && res.status === "SENT") sent += 1;
      if (res.kind === "accepted" && res.status === "SCHEDULED") rescheduled += 1;
    }
    return { processed: due.length, sent, rescheduled };
  }
}
