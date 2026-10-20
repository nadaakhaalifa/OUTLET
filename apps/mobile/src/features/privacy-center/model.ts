/** Privacy Center (spec §2, §B1). Pure model, port and in-memory fake. */
import { PortError, type PortFailure } from "../worlds/model";

export { PortError };
export type { PortFailure };

export interface ConsentItem {
  readonly purpose: string;
  readonly granted: boolean;
}

export type ExportStatus =
  | { readonly state: "none" }
  | { readonly state: "requested"; readonly dueAt: string }
  | { readonly state: "ready"; readonly expiresAt: string; readonly url: string | null };

export type DeletionBlockerKind = "open_orders" | "open_returns" | "open_disputes";
export interface Blocker {
  readonly kind: DeletionBlockerKind;
  readonly count: number;
}

export type DeletionState =
  | { readonly state: "blocked"; readonly blockers: readonly Blocker[] }
  | { readonly state: "eligible"; readonly coolingDays: number; readonly forfeiture: bigint | null }
  | { readonly state: "cooling"; readonly endsAt: string };

export interface SessionInfo {
  readonly id: string;
  readonly deviceLabel: string;
  readonly lastUsedAt: string;
  readonly current: boolean;
}

export interface PrivacySnapshot {
  readonly consents: readonly ConsentItem[];
  readonly export: ExportStatus;
  readonly deletion: DeletionState;
  readonly sessions: readonly SessionInfo[];
  /** Consent changes not yet acknowledged by the server. */
  readonly pendingSync: number;
}

export interface PrivacyPort {
  load(): Promise<PrivacySnapshot>;
  /** Effective locally at once; the server catches up (never blocks withdrawal). */
  setConsent(purpose: string, granted: boolean): Promise<void>;
  requestExport(idempotencyKey: string): Promise<ExportStatus>;
  requestDeletion(input: { acknowledgedForfeiture: boolean; idempotencyKey: string }): Promise<DeletionState>;
  cancelDeletion(): Promise<DeletionState>;
  /** Optional: absent where the API has no revoke endpoint yet. */
  revokeSession?(id: string): Promise<void>;
}

export function applyConsent(items: readonly ConsentItem[], purpose: string, granted: boolean): readonly ConsentItem[] {
  return items.map((c) => (c.purpose === purpose ? { ...c, granted } : c));
}

/** Delete is enabled only for an eligible account, and with acknowledgement when credit is forfeited. */
export function canRequestDeletion(d: DeletionState, acknowledged: boolean): boolean {
  if (d.state !== "eligible") return false;
  return d.forfeiture === null || acknowledged;
}

/** Blockers in a fixed, exact order with exact counts. */
export function orderedBlockers(d: DeletionState): readonly Blocker[] {
  if (d.state !== "blocked") return [];
  const order: DeletionBlockerKind[] = ["open_orders", "open_returns", "open_disputes"];
  return [...d.blockers].filter((b) => b.count > 0).sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
}

export function cancellable(d: DeletionState): boolean {
  return d.state === "cooling";
}

/** Current session first, then most recently used. */
export function sortSessions(s: readonly SessionInfo[]): readonly SessionInfo[] {
  return [...s].sort((a, b) => (a.current === b.current ? (a.lastUsedAt < b.lastUsedAt ? 1 : a.lastUsedAt > b.lastUsedAt ? -1 : a.id.localeCompare(b.id)) : a.current ? -1 : 1));
}

export type PrivacyScreenState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly offline: boolean }
  | { readonly status: "ready"; readonly snapshot: PrivacySnapshot };

export function privacyFailureState(e: unknown): PrivacyScreenState {
  return { status: "error", offline: e instanceof PortError && e.kind === "offline" };
}

export const FIXTURE_PRIVACY: PrivacySnapshot = {
  consents: ["marketing_push", "marketing_whatsapp", "marketing_email", "analytics", "personalization", "budget_insights", "measurements", "location_precise", "cross_border_ml"]
    .map((purpose) => ({ purpose, granted: false })),
  export: { state: "none" },
  deletion: { state: "eligible", coolingDays: 14, forfeiture: 15_000n },
  sessions: [
    { id: "s1", deviceLabel: "iPhone", lastUsedAt: "2026-10-11T08:00:00Z", current: true },
    { id: "s2", deviceLabel: "iPad", lastUsedAt: "2026-09-30T08:00:00Z", current: false },
  ],
  pendingSync: 0,
};

export class InMemoryPrivacyPort implements PrivacyPort {
  private snap: PrivacySnapshot;
  keys: string[] = [];
  constructor(initial: PrivacySnapshot = FIXTURE_PRIVACY, private failure: PortFailure | null = null) { this.snap = initial; }
  setFailure(f: PortFailure | null): void { this.failure = f; }
  private check(): void { if (this.failure !== null) throw new PortError(this.failure); }
  async load(): Promise<PrivacySnapshot> { this.check(); return this.snap; }
  async setConsent(purpose: string, granted: boolean): Promise<void> {
    this.snap = { ...this.snap, consents: applyConsent(this.snap.consents, purpose, granted) };
  }
  async requestExport(key: string): Promise<ExportStatus> {
    this.check();
    this.keys.push(key);
    const s: ExportStatus = { state: "requested", dueAt: "2026-10-14T08:00:00Z" };
    this.snap = { ...this.snap, export: s };
    return s;
  }
  async requestDeletion(input: { acknowledgedForfeiture: boolean; idempotencyKey: string }): Promise<DeletionState> {
    this.check();
    this.keys.push(input.idempotencyKey);
    const d: DeletionState = { state: "cooling", endsAt: "2026-10-25T08:00:00Z" };
    this.snap = { ...this.snap, deletion: d };
    return d;
  }
  async cancelDeletion(): Promise<DeletionState> {
    this.check();
    const d: DeletionState = { state: "eligible", coolingDays: 14, forfeiture: null };
    this.snap = { ...this.snap, deletion: d };
    return d;
  }
  async revokeSession(id: string): Promise<void> {
    this.check();
    this.snap = { ...this.snap, sessions: this.snap.sessions.filter((s) => s.id !== id) };
  }
}
