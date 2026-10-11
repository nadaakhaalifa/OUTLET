import type { AdmissionClaims, ClaimsVerdict, DropState, DropType, JoinResult, Ticket } from "./bridge";

export interface Clock {
  nowMs(): number;
}
export interface IdPort {
  uuidV7(): string;
  hex(bytes: number): string;
}

// ---- ports owned by other modules (fakes live in adapters/in-memory.ts) ----------------------

/** What the waiting room needs to know about a drop. Implemented by the drops module. */
export interface GateDrop {
  readonly id: string;
  readonly storeId: string;
  readonly type: DropType;
  readonly state: DropState;
  readonly paused: boolean;
  readonly startsAtMs: number;
  readonly earlyAccessAtMs: number | null;
  readonly admitPerSec: number;
  /** "Definitely sold out" pre-filter. A hint only: inventory stays the source of truth. */
  readonly soldOutHint: boolean;
}

export interface DropGatePort {
  get(dropId: string): Promise<GateDrop | null>;
  /** Drops whose queue may hold tickets (SCHEDULED within the pre-queue window, EARLY_ACCESS, LIVE). */
  activeDropIds(): Promise<readonly string[]>;
}

/** Plus module: `commerce_benefits.early_access_24h`. Checked at join and again at admission. */
export interface EntitlementPort {
  hasEarlyAccess(userId: string): Promise<boolean>;
}

/** Security: App Attest (iOS) / Play Integrity. The token is never stored. */
export interface AttestationPort {
  verify(deviceId: string, token: string | null): Promise<boolean>;
}

/** Fraud: 0 (human) .. 100 (bot). Rejects when unavailable, which the caller treats as a block. */
export interface BotScorePort {
  score(input: { readonly userId: string; readonly deviceHash: string }): Promise<number>;
}

export interface SigningKey {
  readonly kid: string;
  readonly key: Uint8Array;
}
/** Secret manager. Keys are never in config or code. */
export interface SecretPort {
  current(): Promise<SigningKey>;
  byKid(kid: string): Promise<Uint8Array | null>;
}

/** Admission token codec (HS256 JWT). Pure; the module wires the adapter in adapters/jwt.ts. */
export type ParsedAdmissionToken =
  | { readonly ok: true; readonly claims: AdmissionClaims; readonly kid: string; readonly signingInput: string; readonly sig: Uint8Array }
  | { readonly ok: false; readonly code: "malformed" };
export interface AdmissionCodec {
  sign(claims: AdmissionClaims, kid: string, key: Uint8Array): string;
  parse(token: string): ParsedAdmissionToken;
  signatureValid(p: { readonly signingInput: string; readonly sig: Uint8Array }, key: Uint8Array): boolean;
}

/** Kill switches (spec 16): drops_all, drop_type_<type>, waiting_room, mystery_box. true = may run. */
export type SwitchKey = "drops_all" | "waiting_room" | "mystery_box" | `drop_type_${DropType}`;
export interface SwitchPort {
  allowed(key: SwitchKey): Promise<boolean>;
}

// ---- queue (Redis in production) -------------------------------------------------------------

/** Thrown by a QueuePort adapter when the backing store is unreachable. Callers fail closed. */
export class QueueUnavailableError extends Error {
  constructor(message = "waiting room queue is unavailable") {
    super(message);
    this.name = "QueueUnavailableError";
  }
}

export interface QueuePort {
  join(dropId: string, ticketId: string, userId: string, deviceHash: string, nowMs: number): Promise<JoinResult>;
  heartbeat(dropId: string, userId: string, nowMs: number): Promise<{ ticket: Ticket; position: number | null } | null>;
  /** The earliest `limit` waiting tickets, in arrival order. Read only. */
  peek(dropId: string, limit: number): Promise<readonly Ticket[]>;
  reject(dropId: string, ticketId: string, nowMs: number): Promise<Ticket | null>;
  admit(dropId: string, n: number, nowMs: number): Promise<readonly Ticket[]>;
  expire(dropId: string, nowMs: number): Promise<readonly Ticket[]>;
  finish(dropId: string, ticketId: string): Promise<void>;
  size(dropId: string): Promise<number>;
}

// ---- durable audit (Postgres) ---------------------------------------------------------------

export interface AdmissionRecord {
  readonly jti: string;
  readonly ticketId: string;
  readonly dropId: string;
  readonly userId: string;
  readonly deviceHash: string;
  readonly joinedAtMs: number;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly usedAtMs: number | null;
}

export interface EndedTicket {
  readonly ticketId: string;
  readonly dropId: string;
  readonly userId: string;
  readonly deviceHash: string;
  readonly joinedAtMs: number;
  readonly state: "abandoned" | "rejected";
  readonly atMs: number;
}

export type WaitingRoomEvent =
  | { readonly type: "queue.joined"; readonly dropId: string; readonly ticketId: string }
  | { readonly type: "queue.admitted"; readonly dropId: string; readonly ticketId: string; readonly waitedMs: number }
  | { readonly type: "queue.abandoned"; readonly dropId: string; readonly ticketId: string; readonly reason: "heartbeat" | "rejected" };

export interface AdmissionStore {
  /** Writes the audit row, the single-use token row and the outbox event in one transaction. */
  recordAdmission(rec: AdmissionRecord, events: readonly WaitingRoomEvent[]): Promise<void>;
  recordEnded(t: EndedTicket, events: readonly WaitingRoomEvent[]): Promise<void>;
  recordJoined(dropId: string, ticketId: string, events: readonly WaitingRoomEvent[]): Promise<void>;
  latestAdmission(dropId: string, userId: string): Promise<AdmissionRecord | null>;
  /** Single use: the first call wins. */
  consume(jti: string, nowMs: number): Promise<"used" | "already_used" | "unknown" | "expired">;
}

export type VerifyResult =
  | { readonly ok: true; readonly claims: AdmissionClaims }
  | { readonly ok: false; readonly code: "malformed" | "bad_signature" | ClaimsVerdictCode };
type ClaimsVerdictCode = Exclude<ClaimsVerdict, { ok: true }>["code"];
