/**
 * Family and student Plus plans (phase 3 spec P3-03). Pure model, port and in-memory fake; no UI imports.
 * Seats, limits, age gates and prices all come from the server. The app never counts seats itself to decide an
 * outcome; it only displays what the server reports and maps the documented refusal codes to plain reasons.
 * Invite tokens are secrets: they are validated for shape, passed to the port once and never rendered or logged.
 */
import { normalizeEgyptianPhone } from "../phone";
import { PortError, type PortFailure } from "../worlds/model";

export { PortError };
export type { PortFailure };

export type DisplayLocale = "ar" | "en";
export type SeatStatus = "INVITED" | "ACTIVE" | "REMOVED" | "ENDED";

export interface FamilySeat {
  readonly id: string;
  readonly role: "owner" | "member";
  readonly status: SeatStatus;
  /** Chosen by the owner. The server shows names only when the owner enabled it, so it can be null. */
  readonly nickname: string | null;
  readonly seatNo: number;
  readonly seatEffectiveFromMs: number | null;
  readonly seatEndAtMs: number | null;
  readonly inviteExpiresAtMs: number | null;
}

export type FamilyView =
  | {
      readonly role: "owner";
      readonly groupId: string;
      readonly status: "ACTIVE" | "ENDED";
      readonly seatLimit: number;
      readonly seatsHeld: number;
      readonly seatsFree: number;
      readonly members: readonly FamilySeat[];
    }
  | {
      readonly role: "member";
      readonly groupId: string;
      readonly status: "ACTIVE" | "ENDED";
      readonly seatStatus: SeatStatus;
      readonly seatEndAtMs: number | null;
      readonly entitlementEndsAtMs: number | null;
    };

export type StudentState = "NONE" | "PENDING" | "VERIFIED" | "REJECTED" | "EXPIRED";

export interface StudentStatus {
  readonly status: StudentState;
  readonly validUntilMs: number | null;
  /** The server decides whether the student price applies right now. */
  readonly priceApplies: boolean;
  /** Verifier name when the contract carries it; null otherwise (then the copy says "our verification partner"). */
  readonly verifier: string | null;
}

export interface PlanInfo {
  readonly code: string;
  readonly price: bigint;
  readonly interval: "month" | "year";
  readonly seatLimit: number | null;
}

export interface FamilySnapshot {
  readonly family: FamilyView | null;
  readonly student: StudentStatus;
  readonly familyPlan: PlanInfo | null;
  readonly studentPlan: PlanInfo | null;
}

export type InviteRefusalReason =
  | "ageGate" | "seatsFull" | "seatChurnLimit" | "alreadyInFamily" | "selfInvite" | "alreadyInvited" | "ownerNotEntitled" | "groupEnded"
  | "deliveryFailed" | "unavailable" | "conflict";

export type InviteOutcome =
  | { readonly kind: "invited"; readonly expiresAtMs: number }
  | { readonly kind: "refused"; readonly reason: InviteRefusalReason; readonly minAge: number | null };

export type AcceptRefusalReason =
  | "expired" | "unavailable" | "ageGate" | "alreadyInFamily" | "ownerNotEntitled" | "unknown" | "conflict" | "serviceUnavailable";

export type AcceptOutcome =
  | { readonly kind: "accepted"; readonly ownPlanEnding: boolean }
  /** The shopper has their own Plus plan: they must choose to end it at its period end to join. */
  | { readonly kind: "choiceRequired" }
  | { readonly kind: "refused"; readonly reason: AcceptRefusalReason; readonly minAge: number | null };

export type StudentStartOutcome =
  | { readonly kind: "started"; readonly redirectUrl: string | null }
  | { readonly kind: "refused"; readonly reason: "domainNotAllowed" | "unavailable" };

export type StudentMethod = "universityEmail" | "verifierSession";

export interface FamilyPort {
  load(): Promise<FamilySnapshot>;
  invite(phoneE164: string, nickname: string | null, idempotencyKey: string): Promise<InviteOutcome>;
  revokeInvite(seatId: string, idempotencyKey: string): Promise<void>;
  removeMember(seatId: string, idempotencyKey: string): Promise<void>;
  leave(idempotencyKey: string): Promise<void>;
  acceptInvite(token: string, endOwnPlanAtPeriodEnd: boolean, idempotencyKey: string): Promise<AcceptOutcome>;
  startStudentVerification(method: StudentMethod, universityEmail: string | null, idempotencyKey: string): Promise<StudentStartOutcome>;
}

/* ---- pure rules ---- */

const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;

/** Shape check before the token goes anywhere. The value itself is never logged or shown. */
export function isPlausibleInviteToken(token: string): boolean {
  return TOKEN_RE.test(token);
}

export type InviteInputError = "phoneEmpty" | "phoneInvalid" | "countryNotSupported" | "nicknameTooLong";
export const NICKNAME_MAX = 40;

export function validateInvite(phoneRaw: string, nicknameRaw: string): { readonly ok: true; readonly phone: string; readonly nickname: string | null } | { readonly ok: false; readonly error: InviteInputError } {
  const p = normalizeEgyptianPhone(phoneRaw);
  if (!p.ok) return { ok: false, error: p.reason === "empty" ? "phoneEmpty" : p.reason === "country_not_supported" ? "countryNotSupported" : "phoneInvalid" };
  const nick = nicknameRaw.trim();
  if (nick.length > NICKNAME_MAX) return { ok: false, error: "nicknameTooLong" };
  return { ok: true, phone: p.e164, nickname: nick.length === 0 ? null : nick };
}

/** Only a plain https URL is ever opened for the verifier. Anything else is treated as "no redirect". */
export function safeVerifierUrl(url: string | null | undefined): string | null {
  if (url === null || url === undefined) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname !== "" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** A university email shape check only; the server owns the domain allow-list. */
export function isPlausibleEmail(raw: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(raw.trim());
}

export interface SeatRowView {
  readonly seat: FamilySeat;
  readonly canRevoke: boolean;
  readonly canRemove: boolean;
}

export interface OwnerView {
  readonly seatsHeld: number;
  readonly seatLimit: number;
  readonly seatsFree: number;
  readonly rows: readonly SeatRowView[];
  readonly canInvite: boolean;
}

/** Owner seat list: the owner's own seat first, then invited and active members; ended and removed seats are dropped. */
export function buildOwnerView(f: Extract<FamilyView, { role: "owner" }>): OwnerView {
  const rank = (s: FamilySeat): number => (s.role === "owner" ? 0 : s.status === "ACTIVE" ? 1 : 2);
  const rows = f.members
    .filter((s) => s.status === "ACTIVE" || s.status === "INVITED")
    .sort((a, b) => rank(a) - rank(b) || a.seatNo - b.seatNo)
    .map((seat): SeatRowView => ({
      seat,
      canRevoke: seat.role === "member" && seat.status === "INVITED",
      canRemove: seat.role === "member" && seat.status === "ACTIVE" && f.status === "ACTIVE",
    }));
  return { seatsHeld: f.seatsHeld, seatLimit: f.seatLimit, seatsFree: f.seatsFree, rows, canInvite: f.status === "ACTIVE" && f.seatsFree > 0 };
}

export type StudentView =
  | { readonly kind: "none" }
  | { readonly kind: "pending" }
  | { readonly kind: "verified"; readonly validUntilMs: number | null; readonly priceApplies: boolean; readonly verifier: string | null }
  | { readonly kind: "rejected" }
  | { readonly kind: "expired" };

export function buildStudentView(s: StudentStatus): StudentView {
  switch (s.status) {
    case "VERIFIED": return { kind: "verified", validUntilMs: s.validUntilMs, priceApplies: s.priceApplies, verifier: s.verifier };
    case "PENDING": return { kind: "pending" };
    case "REJECTED": return { kind: "rejected" };
    case "EXPIRED": return { kind: "expired" };
    default: return { kind: "none" };
  }
}

/** A start (or restart) of verification is offered unless one is already running or the status is verified. */
export function canStartStudent(s: StudentStatus): boolean {
  return s.status === "NONE" || s.status === "REJECTED" || s.status === "EXPIRED";
}

export type FamilyScreenState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly offline: boolean }
  | { readonly status: "ready"; readonly snapshot: FamilySnapshot };

export function familyFailureState(e: unknown): FamilyScreenState {
  return { status: "error", offline: e instanceof PortError && e.kind === "offline" };
}

/* ---- in-memory fake (development and tests only; synthetic data) ---- */

export const FIXTURE_FAMILY_SNAPSHOT: FamilySnapshot = {
  family: null,
  student: { status: "NONE", validUntilMs: null, priceApplies: false, verifier: null },
  familyPlan: { code: "plus_family", price: 120_000n, interval: "year", seatLimit: 4 },
  studentPlan: { code: "plus_student", price: 40_000n, interval: "year", seatLimit: null },
};

export class InMemoryFamilyPort implements FamilyPort {
  readonly accepted: string[] = [];
  private readonly seenInvite = new Map<string, InviteOutcome>();
  private readonly seenAccept = new Map<string, AcceptOutcome>();
  private readonly seenStudent = new Map<string, StudentStartOutcome>();
  private n = 0;
  constructor(
    private snapshot: FamilySnapshot = FIXTURE_FAMILY_SNAPSHOT,
    private failure: PortFailure | null = null,
    private readonly clock: () => number = Date.now,
    private readonly minAge = 21,
  ) {}
  setFailure(f: PortFailure | null): void {
    this.failure = f;
  }
  set(snapshot: FamilySnapshot): void {
    this.snapshot = snapshot;
  }
  private check(): void {
    if (this.failure !== null) throw new PortError(this.failure);
  }
  private once<T>(seen: Map<string, T>, key: string, f: () => T): T {
    const prior = seen.get(key);
    if (prior !== undefined) return prior;
    const v = f();
    seen.set(key, v);
    return v;
  }
  private owner(): Extract<FamilyView, { role: "owner" }> | null {
    return this.snapshot.family !== null && this.snapshot.family.role === "owner" ? this.snapshot.family : null;
  }
  async load(): Promise<FamilySnapshot> {
    this.check();
    return this.snapshot;
  }
  async invite(phone: string, nickname: string | null, key: string): Promise<InviteOutcome> {
    this.check();
    return this.once(this.seenInvite, key, (): InviteOutcome => {
      const f = this.owner();
      if (f === null) return { kind: "refused", reason: "unavailable", minAge: null };
      if (f.seatsFree <= 0) return { kind: "refused", reason: "seatsFull", minAge: null };
      if (f.members.some((m) => m.status === "INVITED" && m.nickname === nickname && nickname !== null)) return { kind: "refused", reason: "alreadyInvited", minAge: null };
      const seat: FamilySeat = {
        id: `seat-${++this.n}`, role: "member", status: "INVITED", nickname: nickname ?? phone.slice(-4), seatNo: f.members.length + 1,
        seatEffectiveFromMs: null, seatEndAtMs: null, inviteExpiresAtMs: this.clock() + 7 * 86_400_000,
      };
      this.snapshot = { ...this.snapshot, family: { ...f, members: [...f.members, seat], seatsHeld: f.seatsHeld + 1, seatsFree: f.seatsFree - 1 } };
      return { kind: "invited", expiresAtMs: seat.inviteExpiresAtMs ?? this.clock() };
    });
  }
  async revokeInvite(seatId: string): Promise<void> {
    this.check();
    const f = this.owner();
    if (f === null) throw new PortError("failed");
    this.snapshot = { ...this.snapshot, family: { ...f, members: f.members.filter((m) => m.id !== seatId), seatsHeld: f.seatsHeld - 1, seatsFree: f.seatsFree + 1 } };
  }
  async removeMember(seatId: string): Promise<void> {
    this.check();
    const f = this.owner();
    if (f === null) throw new PortError("failed");
    this.snapshot = { ...this.snapshot, family: { ...f, members: f.members.map((m) => (m.id === seatId ? { ...m, status: "REMOVED" as const } : m)) } };
  }
  async leave(): Promise<void> {
    this.check();
    this.snapshot = { ...this.snapshot, family: null };
  }
  async acceptInvite(token: string, endOwnPlan: boolean, key: string): Promise<AcceptOutcome> {
    this.check();
    return this.once(this.seenAccept, key, (): AcceptOutcome => {
      if (!isPlausibleInviteToken(token)) return { kind: "refused", reason: "unknown", minAge: null };
      if (token.startsWith("expired")) return { kind: "refused", reason: "expired", minAge: null };
      if (token.startsWith("young")) return { kind: "refused", reason: "ageGate", minAge: this.minAge };
      if (token.startsWith("hasplan") && !endOwnPlan) return { kind: "choiceRequired" };
      this.accepted.push(key);
      return { kind: "accepted", ownPlanEnding: token.startsWith("hasplan") };
    });
  }
  async startStudentVerification(_method: StudentMethod, email: string | null, key: string): Promise<StudentStartOutcome> {
    this.check();
    return this.once(this.seenStudent, key, (): StudentStartOutcome => {
      if (email !== null && !email.endsWith(".edu.eg")) return { kind: "refused", reason: "domainNotAllowed" };
      this.snapshot = { ...this.snapshot, student: { status: "PENDING", validUntilMs: null, priceApplies: false, verifier: "Fixture Verifier" } };
      return { kind: "started", redirectUrl: "https://verifier.example/session/fixture" };
    });
  }
}
