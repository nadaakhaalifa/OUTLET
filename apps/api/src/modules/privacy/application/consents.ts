import {
  CONSENT_PURPOSES,
  consentStatus,
  latestConsent,
  grantConsent,
  withdrawConsent,
  type Clock as PrivacyClock,
  type ConsentHistory,
  type ConsentPurpose,
  type Hasher,
} from "@outlet/privacy";
import type { IdGenerator } from "../../../platform/ports";
import { privacyEvents } from "../domain/events";
import type { ConsentRepository } from "../domain/ports";

export interface ConsentEntry {
  readonly purpose: ConsentPurpose;
  readonly granted: boolean;
  readonly updatedAt: string;
  readonly policyVersion: number;
}

export interface ConsentState {
  /** Only purposes the user has ever decided on. Absence means never asked, which is not consent. */
  readonly consents: readonly ConsentEntry[];
}

export interface ConsentChange {
  readonly purpose: ConsentPurpose;
  readonly granted: boolean;
  readonly version: number;
}

export type UpdateConsentsResult =
  | { readonly kind: "ok"; readonly state: ConsentState }
  | { readonly kind: "duplicate_purpose"; readonly purpose: ConsentPurpose }
  | { readonly kind: "stale_version"; readonly purpose: ConsentPurpose; readonly currentVersion: number }
  | { readonly kind: "unknown_version"; readonly purpose: ConsentPurpose; readonly currentVersion: number };

function stateOf(
  history: ConsentHistory,
  userId: string,
  currentVersions: Readonly<Record<ConsentPurpose, number>>,
): ConsentState {
  const consents: ConsentEntry[] = [];
  for (const purpose of CONSENT_PURPOSES) {
    // Append order decides, never the wall clock (a lagging node must not resurrect a grant).
    const latest = latestConsent(history, userId, purpose);
    if (latest === undefined) continue;
    consents.push({
      purpose,
      // Effective consent only: withdrawn, or granted on an outdated text, both read as false.
      granted: consentStatus(history, userId, purpose, currentVersions[purpose]) === "granted",
      updatedAt: latest.at,
      policyVersion: latest.version,
    });
  }
  return { consents };
}

export class GetConsents {
  constructor(
    private readonly repo: ConsentRepository,
    private readonly versions: Readonly<Record<ConsentPurpose, number>>,
  ) {}

  async execute(userId: string): Promise<ConsentState> {
    return stateOf(await this.repo.history(userId), userId, this.versions);
  }
}

export class UpdateConsents {
  constructor(
    private readonly repo: ConsentRepository,
    private readonly versions: Readonly<Record<ConsentPurpose, number>>,
    private readonly clock: PrivacyClock,
    private readonly hashIp: Hasher,
    private readonly ids: IdGenerator,
  ) {}

  /**
   * All-or-nothing: the whole batch is validated before anything is appended. A grant must carry
   * the current text version; a withdrawal is accepted at any version (B1: withdrawal is always allowed).
   */
  async execute(input: {
    userId: string;
    changes: readonly ConsentChange[];
    ip: string;
  }): Promise<UpdateConsentsResult> {
    const seen = new Set<ConsentPurpose>();
    for (const c of input.changes) {
      if (seen.has(c.purpose)) return { kind: "duplicate_purpose", purpose: c.purpose };
      seen.add(c.purpose);
      const current = this.versions[c.purpose];
      if (c.granted && c.version > current) {
        return { kind: "unknown_version", purpose: c.purpose, currentVersion: current };
      }
      if (c.granted && c.version < current) {
        return { kind: "stale_version", purpose: c.purpose, currentVersion: current };
      }
    }
    const before = await this.repo.history(input.userId);
    let history: ConsentHistory = before;
    const ipHash = this.hashIp(input.ip);
    for (const c of input.changes) {
      const consentInput = {
        userId: input.userId,
        purpose: c.purpose,
        version: c.version,
        // Wire has no capture method yet; every change from this endpoint is a settings toggle.
        method: "settings_toggle" as const,
        ipHash,
      };
      history = c.granted
        ? grantConsent(history, consentInput, this.clock)
        : withdrawConsent(history, consentInput, this.clock);
    }
    const appended = history.slice(before.length);
    const at = Date.parse(appended[appended.length - 1]?.at ?? new Date(0).toISOString());
    // consent.changed is written in the same transaction as the append-only records (spec 1 Events).
    const events =
      appended.length === 0
        ? []
        : [privacyEvents.consentChanged(this.ids.uuidV7(), input.userId, appended, at)];
    await this.repo.append(appended, events);
    return { kind: "ok", state: stateOf(history, input.userId, this.versions) };
  }
}
