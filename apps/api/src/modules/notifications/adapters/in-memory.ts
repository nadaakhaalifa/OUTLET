import type {
  AnalyticsEvent,
  AnalyticsPort,
  ChannelProvider,
  ConsentPort,
  Contact,
  ContactPort,
  DeliveryLogRepository,
  FrequencyStore,
  InboxProcessedPort,
  InboxRepository,
  NotificationEvent,
  NotificationEventPublisher,
  PreferenceRepository,
  ProviderMessage,
  ProviderRegistry,
  ProviderResult,
  PushToken,
  PushTokenRepository,
  RequestRepository,
  SuppressionRepository,
  TemplateRepository,
} from "../domain/ports";
import type {
  Channel,
  DeliveryLogEntry,
  ExternalChannel,
  InboxMessage,
  MarketingPurpose,
  NotificationRequest,
  NotificationTemplate,
  SuppressionReason,
} from "../domain/types";

export class InMemoryTemplateRepository implements TemplateRepository {
  private readonly rows = new Map<string, NotificationTemplate>();

  async activeFor(key: string, nowMs: number): Promise<readonly NotificationTemplate[]> {
    const best = new Map<Channel, NotificationTemplate>();
    for (const t of this.rows.values()) {
      if (t.key !== key || !t.active || t.validFromMs > nowMs) continue;
      const cur = best.get(t.channel);
      if (cur === undefined || t.version > cur.version) best.set(t.channel, t);
    }
    return [...best.values()];
  }
  async version(key: string, channel: Channel, version: number): Promise<NotificationTemplate | null> {
    for (const t of this.rows.values()) if (t.key === key && t.channel === channel && t.version === version) return t;
    return null;
  }
  async get(id: string): Promise<NotificationTemplate | null> {
    return this.rows.get(id) ?? null;
  }
  async save(template: NotificationTemplate): Promise<void> {
    this.rows.set(template.id, template);
  }
}

export class InMemoryRequestRepository implements RequestRepository {
  private readonly byId = new Map<string, NotificationRequest>();
  private readonly identity = new Map<string, string>();
  private key = (u: string, k: string, r: string): string => `${u}\u0000${k}\u0000${r}`;

  async insertIfAbsent(request: NotificationRequest): Promise<boolean> {
    const k = this.key(request.userId, request.templateKey, request.ref);
    if (this.identity.has(k)) return false;
    this.identity.set(k, request.id);
    this.byId.set(request.id, request);
    return true;
  }
  async find(userId: string, templateKey: string, ref: string): Promise<NotificationRequest | null> {
    const id = this.identity.get(this.key(userId, templateKey, ref));
    return id === undefined ? null : (this.byId.get(id) ?? null);
  }
  async save(request: NotificationRequest): Promise<void> {
    this.byId.set(request.id, request);
  }
  async claimDue(nowMs: number, limit: number): Promise<readonly NotificationRequest[]> {
    const due = [...this.byId.values()]
      .filter((r) => r.status === "SCHEDULED" && r.scheduledForMs !== null && r.scheduledForMs <= nowMs)
      .sort((a, b) => (a.scheduledForMs ?? 0) - (b.scheduledForMs ?? 0))
      .slice(0, limit);
    const claimed = due.map((r) => ({ ...r, status: "ACCEPTED" as const, scheduledForMs: null }));
    for (const c of claimed) this.byId.set(c.id, c);
    return claimed;
  }
  /** Test helper. */
  get(id: string): NotificationRequest | undefined {
    return this.byId.get(id);
  }
  all(): readonly NotificationRequest[] {
    return [...this.byId.values()];
  }
}

export class InMemoryDeliveryLog implements DeliveryLogRepository {
  private readonly rows: DeliveryLogEntry[] = [];
  async append(entry: DeliveryLogEntry): Promise<void> {
    this.rows.push(entry);
  }
  async forRequest(requestId: string): Promise<readonly DeliveryLogEntry[]> {
    return this.rows.filter((r) => r.requestId === requestId);
  }
  all(): readonly DeliveryLogEntry[] {
    return this.rows;
  }
}

export class InMemoryFrequencyStore implements FrequencyStore {
  private readonly sent = new Map<string, number[]>();
  async record(userId: string, channel: ExternalChannel, atMs: number): Promise<void> {
    const k = `${userId}:${channel}`;
    this.sent.set(k, [...(this.sent.get(k) ?? []), atMs]);
  }
  /** Fully synchronous body: no await between the check and the write, so it is atomic. */
  async reserve(
    userId: string,
    channel: ExternalChannel,
    atMs: number,
    admit: (sentTimes: readonly number[]) => boolean,
  ): Promise<boolean> {
    const k = `${userId}:${channel}`;
    const cur = this.sent.get(k) ?? [];
    if (!admit(cur)) return false;
    this.sent.set(k, [...cur, atMs]);
    return true;
  }
  async release(userId: string, channel: ExternalChannel, atMs: number): Promise<void> {
    const k = `${userId}:${channel}`;
    const cur = this.sent.get(k) ?? [];
    const i = cur.indexOf(atMs);
    if (i >= 0) this.sent.set(k, [...cur.slice(0, i), ...cur.slice(i + 1)]);
  }
  async sentTimes(userId: string, channel: ExternalChannel, sinceMs: number): Promise<readonly number[]> {
    return (this.sent.get(`${userId}:${channel}`) ?? []).filter((t) => t >= sinceMs);
  }
}

export class InMemoryPreferenceRepository implements PreferenceRepository {
  private readonly rows = new Map<string, Map<string, boolean>>();
  async all(userId: string): Promise<ReadonlyMap<string, boolean>> {
    return new Map(this.rows.get(userId) ?? []);
  }
  async setMany(userId: string, entries: ReadonlyMap<string, boolean>): Promise<void> {
    const cur = this.rows.get(userId) ?? new Map<string, boolean>();
    for (const [k, v] of entries) cur.set(k, v);
    this.rows.set(userId, cur);
  }
}

export class InMemorySuppressionRepository implements SuppressionRepository {
  private readonly rows = new Map<string, Set<SuppressionReason>>();
  private k = (u: string, c: ExternalChannel): string => `${u}:${c}`;
  async active(userId: string, channel: ExternalChannel): Promise<ReadonlySet<SuppressionReason>> {
    return new Set(this.rows.get(this.k(userId, channel)) ?? []);
  }
  async add(userId: string, channel: ExternalChannel, reason: SuppressionReason): Promise<void> {
    const s = this.rows.get(this.k(userId, channel)) ?? new Set<SuppressionReason>();
    s.add(reason);
    this.rows.set(this.k(userId, channel), s);
  }
  async remove(userId: string, channel: ExternalChannel, reason: SuppressionReason): Promise<void> {
    this.rows.get(this.k(userId, channel))?.delete(reason);
  }
}

export class InMemoryInboxRepository implements InboxRepository {
  private readonly rows = new Map<string, InboxMessage>();
  async insert(message: InboxMessage): Promise<void> {
    this.rows.set(message.id, message);
  }
  async list(
    userId: string,
    after: { createdAtMs: number; id: string } | null,
    limit: number,
    nowMs: number,
  ): Promise<readonly InboxMessage[]> {
    return [...this.rows.values()]
      .filter((m) => m.userId === userId && m.expiresAtMs > nowMs)
      .sort((a, b) => b.createdAtMs - a.createdAtMs || (a.id < b.id ? 1 : -1))
      .filter((m) => after === null || m.createdAtMs < after.createdAtMs || (m.createdAtMs === after.createdAtMs && m.id < after.id))
      .slice(0, limit);
  }
  async markRead(userId: string, ids: readonly string[], nowMs: number): Promise<boolean> {
    for (const id of ids) {
      const m = this.rows.get(id);
      if (m === undefined || m.userId !== userId) return false;
    }
    for (const id of ids) {
      const m = this.rows.get(id);
      if (m !== undefined && m.readAtMs === null) this.rows.set(id, { ...m, readAtMs: nowMs });
    }
    return true;
  }
  all(): readonly InboxMessage[] {
    return [...this.rows.values()];
  }
}

export class InMemoryPushTokenRepository implements PushTokenRepository {
  private readonly rows = new Map<string, PushToken & { userId: string; active: boolean }>();
  async upsert(userId: string, token: PushToken): Promise<void> {
    // A token is active for at most one user: hand-over deactivates every other active row.
    for (const [k, r] of this.rows) {
      if (r.active && r.token === token.token && k !== `${userId}:${token.installId}`) this.rows.set(k, { ...r, active: false });
    }
    this.rows.set(`${userId}:${token.installId}`, { ...token, userId, active: true });
  }
  async active(userId: string): Promise<readonly PushToken[]> {
    return [...this.rows.values()]
      .filter((r) => r.userId === userId && r.active)
      .map(({ installId, platform, token }) => ({ installId, platform, token }));
  }
  async deactivate(userId: string, token: string): Promise<void> {
    for (const [k, r] of this.rows) if (r.userId === userId && r.token === token) this.rows.set(k, { ...r, active: false });
  }
}

/** Fake consent store: tests grant explicitly, nothing is ever pre-granted. */
export class InMemoryConsentPort implements ConsentPort {
  private readonly granted = new Set<string>();
  async isGranted(userId: string, purpose: MarketingPurpose): Promise<boolean> {
    return this.granted.has(`${userId}:${purpose}`);
  }
  async withdraw(userId: string, purpose: MarketingPurpose): Promise<void> {
    this.granted.delete(`${userId}:${purpose}`);
  }
  grant(userId: string, purpose: MarketingPurpose): void {
    this.granted.add(`${userId}:${purpose}`);
  }
}

export class InMemoryContactPort implements ContactPort {
  private readonly rows = new Map<string, Contact>();
  /** `fallback` answers for users with no explicit entry (development convenience; null in tests). */
  constructor(private readonly fallback: Contact | null = null) {}
  async contact(userId: string): Promise<Contact | null> {
    return this.rows.get(userId) ?? this.fallback;
  }
  set(userId: string, contact: Contact): void {
    this.rows.set(userId, contact);
  }
  remove(userId: string): void {
    this.rows.delete(userId);
  }
}

export interface RecordedSend {
  readonly provider: string;
  readonly message: ProviderMessage;
}

/** Programmable fake provider. Records sends for assertions. Never touches the network. */
export class FakeProvider<C extends ExternalChannel = ExternalChannel> implements ChannelProvider<C> {
  readonly sent: ProviderMessage[] = [];
  private script: ProviderResult[] = [];
  private counter = 0;
  constructor(
    readonly code: string,
    readonly channel: C,
    private fallback: ProviderResult | null = null,
  ) {}
  /** Results consumed in order, then the default (a `sent`). */
  enqueue(...results: ProviderResult[]): this {
    this.script.push(...results);
    return this;
  }
  setDefault(result: ProviderResult | null): this {
    this.fallback = result;
    return this;
  }
  async send(message: ProviderMessage & { readonly channel: C }): Promise<ProviderResult> {
    const next = this.script.shift() ?? this.fallback;
    this.counter += 1;
    const result: ProviderResult = next ?? { kind: "sent", providerRef: `${this.code}-${this.counter}` };
    if (result.kind === "sent") this.sent.push(message);
    return result;
  }
}

export class StaticProviderRegistry implements ProviderRegistry {
  constructor(private readonly byChannel: Readonly<Record<ExternalChannel, readonly ChannelProvider[]>>) {}
  providersFor(channel: ExternalChannel): readonly ChannelProvider[] {
    return this.byChannel[channel];
  }
}

export class InMemoryNotificationEvents implements NotificationEventPublisher {
  readonly events: NotificationEvent[] = [];
  async publish(event: NotificationEvent): Promise<void> {
    this.events.push(event);
  }
}

export class InMemoryAnalytics implements AnalyticsPort {
  readonly events: AnalyticsEvent[] = [];
  async track(event: AnalyticsEvent): Promise<void> {
    this.events.push(event);
  }
}

export class InMemoryInboxProcessed implements InboxProcessedPort {
  private readonly done = new Set<string>();
  async runOnce<T>(consumer: string, messageId: string, fn: () => Promise<T>) {
    const k = `${consumer}:${messageId}`;
    if (this.done.has(k)) return { kind: "duplicate" as const };
    this.done.add(k);
    try {
      return { kind: "done" as const, value: await fn() };
    } catch (e) {
      this.done.delete(k); // same transaction in the real adapter: the mark rolls back with the effect
      throw e;
    }
  }
}
