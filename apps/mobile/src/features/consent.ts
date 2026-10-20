import { z } from "zod";
import {
  CONSENT_PURPOSES,
  ConsentRecordSchema,
  consentStatus,
  consentView,
  grantConsent,
  withdrawConsent,
  type ConsentHistory,
  type ConsentMethod,
  type ConsentPurpose,
  type ConsentRecord,
  type PrivacyClock,
} from "../workspace";
import type { OutletApi } from "../api/port";

/**
 * Version of the consent text per purpose. "Proposed": the real text and versions are owned by the
 * privacy notice (docs/privacy). A bump forces re-consent through consentStatus().
 */
export const CONSENT_VERSIONS: Readonly<Record<ConsentPurpose, number>> = Object.fromEntries(
  CONSENT_PURPOSES.map((p) => [p, 1]),
) as Record<ConsentPurpose, number>;

/**
 * The device has no IP knowledge. The server derives the real ipHash when it receives a change;
 * this constant only satisfies the shared record schema and is never sent.
 */
const CLIENT_IP_HASH_PLACEHOLDER = "0".repeat(32);
const LOCAL_SUBJECT = "local";

const CompactRecordSchema = z
  .object({
    p: z.enum(CONSENT_PURPOSES),
    g: z.boolean(),
    v: z.number().int().positive(),
    m: z.enum(["onboarding_toggle", "settings_toggle", "permission_dialog", "web_banner", "support_agent_on_request"]),
    at: z.iso.datetime(),
  })
  .strict();

export const PersistedConsentSchema = z
  .object({
    records: z.array(CompactRecordSchema).max(CONSENT_PURPOSES.length),
    pending: z.array(z.enum(CONSENT_PURPOSES)),
  })
  .strict();
export type PersistedConsent = z.infer<typeof PersistedConsentSchema>;

export interface ConsentPersistence {
  read(): Promise<PersistedConsent | null>;
  write(data: PersistedConsent): Promise<void>;
}

export interface ConsentControllerDeps {
  readonly userId?: string;
  readonly clock: PrivacyClock;
  readonly persistence: ConsentPersistence;
  readonly api: Pick<OutletApi, "recordConsent">;
  /** False for a guest: decisions stay on the device (pending) and sync once, after sign-in. Default: always. */
  readonly canSync?: () => Promise<boolean>;
}

/**
 * Holds the shopper's consent. Nothing is ever pre-ticked: an unknown purpose is "never asked" and
 * therefore not granted. A change takes effect in memory synchronously, before any network call,
 * so a withdrawal can never be undone by a failing request. Only the latest record per purpose is
 * persisted and synced (secure store values are small); the server keeps the append-only history.
 */
export class ConsentController {
  private records: ConsentHistory = [];
  private pending = new Set<ConsentPurpose>();
  private readonly listeners = new Set<() => void>();
  readonly userId: string;

  constructor(private readonly deps: ConsentControllerDeps) {
    this.userId = deps.userId ?? LOCAL_SUBJECT;
  }

  async load(): Promise<void> {
    const data = await this.deps.persistence.read();
    if (data === null) return;
    this.records = data.records.map(
      (r): ConsentRecord =>
        ConsentRecordSchema.parse({
          userId: this.userId,
          purpose: r.p,
          version: r.v,
          granted: r.g,
          method: r.m,
          at: r.at,
          ipHash: CLIENT_IP_HASH_PLACEHOLDER,
        }),
    );
    this.pending = new Set(data.pending);
    this.emit();
  }

  history(): ConsentHistory {
    return this.records;
  }

  /** Synchronous, uncached read for the analytics gate. */
  isGranted(purpose: ConsentPurpose): boolean {
    return consentStatus(this.records, this.userId, purpose, CONSENT_VERSIONS[purpose]) === "granted";
  }

  view(): Readonly<Record<ConsentPurpose, boolean>> {
    return consentView(this.records, this.userId, CONSENT_VERSIONS);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const l of [...this.listeners]) {
      try {
        l();
      } catch {
        // A listener failure must never block consent changes.
      }
    }
  }

  private append(purpose: ConsentPurpose, granted: boolean, method: ConsentMethod): void {
    const input = {
      userId: this.userId,
      purpose,
      version: CONSENT_VERSIONS[purpose],
      method,
      ipHash: CLIENT_IP_HASH_PLACEHOLDER,
    };
    this.records = granted
      ? grantConsent(this.records, input, this.deps.clock)
      : withdrawConsent(this.records, input, this.deps.clock);
    this.pending.add(purpose);
  }

  /** One tap to grant or withdraw. Effective immediately; persistence and sync follow. */
  async set(purpose: ConsentPurpose, granted: boolean, method: ConsentMethod): Promise<void> {
    this.append(purpose, granted, method);
    this.emit();
    await this.persistAndSync();
  }

  /**
   * Onboarding screen: grants exactly the purposes the shopper ticked. Unticked purposes get no
   * record at all (they stay "never asked") and skipping the screen passes an empty selection.
   */
  async saveOnboardingChoices(selection: Readonly<Partial<Record<ConsentPurpose, boolean>>>): Promise<void> {
    for (const purpose of CONSENT_PURPOSES) {
      if (selection[purpose] === true) this.append(purpose, true, "onboarding_toggle");
    }
    this.emit();
    await this.persistAndSync();
  }

  async flushPending(): Promise<void> {
    await this.persistAndSync();
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  private async persistAndSync(): Promise<void> {
    await this.persist();
    if (this.deps.canSync !== undefined && !(await this.deps.canSync())) return;
    for (const purpose of [...this.pending]) {
      const latest = this.latest(purpose);
      if (latest === undefined) {
        this.pending.delete(purpose);
        continue;
      }
      const result = await this.deps.api.recordConsent({
        purpose,
        granted: latest.granted,
        version: latest.version,
        method: latest.method,
        at: latest.at,
      });
      if (!result.ok) break; // stays pending; retried by the next flush
      this.pending.delete(purpose);
    }
    await this.persist();
  }

  private latest(purpose: ConsentPurpose): ConsentRecord | undefined {
    let found: ConsentRecord | undefined;
    for (const r of this.records) if (r.purpose === purpose) found = r;
    return found;
  }

  private async persist(): Promise<void> {
    const records = CONSENT_PURPOSES.flatMap((p) => {
      const r = this.latest(p);
      return r === undefined ? [] : [{ p: r.purpose, g: r.granted, v: r.version, m: r.method, at: r.at }];
    });
    try {
      await this.deps.persistence.write({ records, pending: [...this.pending] });
    } catch {
      // In-memory state stays authoritative for this session; the next change retries the write.
    }
  }
}
