/** Drops and waiting room (spec §16, phase2/07). All timing is server-anchored; nothing is invented. */
import { PortError, type PortFailure } from "../worlds/model";
import { clockFromServer, countdownParts, serverNow, type CountdownParts, type ServerClock } from "./serverClock";

export { PortError, clockFromServer, countdownParts, serverNow };
export type { PortFailure, ServerClock, CountdownParts };

export type DropType = "public" | "members" | "flash" | "mystery" | "ladder" | "lastChance";
export type DropState = "scheduled" | "earlyAccess" | "live" | "soldOut" | "ended" | "paused";

/** Spec 16/20.2: real remaining stock is shown only when it is 5 or fewer. */
export const STOCK_DISPLAY_MAX = 5;
/** Status endpoint is rate limited to 1/s (spec 07); never poll faster. */
export const MIN_POLL_MS = 1000;

export interface DropSnapshot {
  readonly id: string;
  readonly title: string;
  readonly storeName: string;
  readonly type: DropType;
  readonly state: DropState;
  readonly startsAtMs: number;
  readonly earlyAccessAtMs: number | null;
  readonly endsAtMs: number;
  readonly perUserLimit: number;
  /** Real units left, or null when the server does not disclose. */
  readonly remainingStock: number | null;
  /** Server timestamp at the moment this snapshot was produced. */
  readonly serverNowMs: number;
}

export type RejectReason = "perUserLimit" | "membersOnly" | "soldOut" | "notLive" | "paused" | "underAge";

export interface AdmissionToken {
  /** Opaque signed token; held in memory only and handed to checkout, never displayed or logged. */
  readonly value: string;
  readonly expiresAtMs: number;
}

export type QueueStatus =
  | { readonly state: "idle" }
  | { readonly state: "waiting"; readonly position: number | null; readonly etaSeconds: number | null; readonly pollAfterMs: number }
  | { readonly state: "admitted"; readonly token: AdmissionToken; readonly serverNowMs: number }
  | { readonly state: "rejected"; readonly reason: RejectReason }
  | { readonly state: "expired" };

export interface DropsPort {
  getDrop(id: string): Promise<DropSnapshot | null>;
  join(id: string, idempotencyKey: string): Promise<QueueStatus>;
  status(id: string): Promise<QueueStatus>;
  leave(id: string): Promise<void>;
  waitlist(id: string, idempotencyKey: string): Promise<void>;
}

export type DropPhase =
  | { readonly kind: "upcoming"; readonly untilMs: number }
  | { readonly kind: "earlyAccess"; readonly untilMs: number }
  | { readonly kind: "live"; readonly untilMs: number }
  | { readonly kind: "soldOut" }
  | { readonly kind: "ended" }
  | { readonly kind: "paused" };

/**
 * Phase is derived from the server state, with the countdown target from the server schedule
 * measured against server time. A countdown that reaches zero keeps its phase until the server
 * says otherwise (no optimistic flip to "live").
 */
export function dropPhase(d: DropSnapshot, nowServerMs: number): DropPhase {
  switch (d.state) {
    case "soldOut": return { kind: "soldOut" };
    case "ended": return { kind: "ended" };
    case "paused": return { kind: "paused" };
    case "live": return { kind: "live", untilMs: Math.max(0, d.endsAtMs - nowServerMs) };
    case "earlyAccess": return { kind: "earlyAccess", untilMs: Math.max(0, d.startsAtMs - nowServerMs) };
    case "scheduled": {
      const target = d.earlyAccessAtMs ?? d.startsAtMs;
      return { kind: "upcoming", untilMs: Math.max(0, target - nowServerMs) };
    }
  }
}

export function stockLabelCount(d: Pick<DropSnapshot, "remainingStock">): number | null {
  const n = d.remainingStock;
  return n !== null && n > 0 && n <= STOCK_DISPLAY_MAX ? n : null;
}

export function canJoin(phase: DropPhase, status: QueueStatus): boolean {
  if (phase.kind !== "live" && phase.kind !== "earlyAccess") return false;
  return status.state === "idle" || status.state === "expired" || status.state === "rejected" && status.reason === "paused";
}

/** Token validity is judged on server time. Expired means rejoin at the back, no reuse. */
export type TokenState = { readonly kind: "valid"; readonly remainingMs: number } | { readonly kind: "expired" };
export function tokenState(t: AdmissionToken, nowServerMs: number): TokenState {
  const remaining = t.expiresAtMs - nowServerMs;
  return remaining > 0 ? { kind: "valid", remainingMs: remaining } : { kind: "expired" };
}

/** Position and ETA come only from the server; zero or missing values are not shown. */
export interface WaitingView {
  readonly position: number | null;
  readonly etaMinutes: number | null;
}
export function waitingView(s: Extract<QueueStatus, { state: "waiting" }>): WaitingView {
  const position = s.position !== null && s.position > 0 ? s.position : null;
  const etaMinutes = s.etaSeconds !== null && s.etaSeconds > 0 ? Math.max(1, Math.ceil(s.etaSeconds / 60)) : null;
  return { position, etaMinutes };
}

export function nextPollDelay(s: Extract<QueueStatus, { state: "waiting" }>): number {
  return Math.max(MIN_POLL_MS, s.pollAfterMs);
}

export type DropScreenState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly offline: boolean }
  | { readonly status: "notFound" }
  | { readonly status: "ready"; readonly drop: DropSnapshot; readonly clock: ServerClock };

export function dropFailureState(e: unknown): DropScreenState {
  return { status: "error", offline: e instanceof PortError && e.kind === "offline" };
}

/* ---- in-memory fakes (development and tests only; synthetic data) ---- */

export const FIXTURE_DROP: DropSnapshot = {
  id: "d1",
  title: "Autumn clearance",
  storeName: "Cairo Denim",
  type: "flash",
  state: "live",
  startsAtMs: 1_800_000_000_000,
  earlyAccessAtMs: null,
  endsAtMs: 1_800_003_600_000,
  perUserLimit: 2,
  remainingStock: 4,
  serverNowMs: 1_800_000_600_000,
};

export class InMemoryDropsPort implements DropsPort {
  readonly joined: string[] = [];
  private queue: QueueStatus = { state: "idle" };
  constructor(
    private drop: DropSnapshot | null = FIXTURE_DROP,
    private readonly script: readonly QueueStatus[] = [],
    private failure: PortFailure | null = null,
  ) {}
  setFailure(f: PortFailure | null): void {
    this.failure = f;
  }
  setDrop(d: DropSnapshot | null): void {
    this.drop = d;
  }
  private check(): void {
    if (this.failure !== null) throw new PortError(this.failure);
  }
  private pos = 0;
  async getDrop(): Promise<DropSnapshot | null> {
    this.check();
    return this.drop;
  }
  async join(id: string): Promise<QueueStatus> {
    this.check();
    this.joined.push(id);
    this.pos = 0;
    this.queue = this.script[0] ?? { state: "waiting", position: null, etaSeconds: null, pollAfterMs: 2000 };
    return this.queue;
  }
  async status(): Promise<QueueStatus> {
    this.check();
    this.pos = Math.min(this.pos + 1, Math.max(0, this.script.length - 1));
    this.queue = this.script[this.pos] ?? this.queue;
    return this.queue;
  }
  async leave(): Promise<void> {
    this.check();
    this.queue = { state: "idle" };
  }
  async waitlist(): Promise<void> {
    this.check();
  }
}
