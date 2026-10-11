import { err, ok, type Result } from "../lib/result";
import type { SessionFailure, SessionPort, SessionState } from "./port";

export interface FakeSessionOptions {
  readonly initial?: SessionState | null;
  readonly passkeyFails?: SessionFailure;
  readonly requireSecondFactor?: boolean;
  readonly now?: () => number;
}

const state = (token: string, now: number, second: boolean): SessionState => ({
  accessToken: token,
  refreshToken: `${token}-refresh`,
  accessExpiresAtMs: now + 10 * 60_000,
  secondFactorRequired: second,
});

/** In-memory SessionPort for tests and previews. Never talks to a network. */
export class FakeSession implements SessionPort {
  private cur: SessionState | null;
  public refreshCalls = 0;
  constructor(private readonly opts: FakeSessionOptions = {}) {
    this.cur = opts.initial ?? null;
  }
  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }
  async current(): Promise<SessionState | null> {
    return this.cur;
  }
  async signInWithPasskey(): Promise<Result<SessionState, SessionFailure>> {
    if (this.opts.passkeyFails !== undefined) return err(this.opts.passkeyFails);
    this.cur = state("fake-access", this.now(), this.opts.requireSecondFactor === true);
    return ok(this.cur);
  }
  async verifyTotp(code: string): Promise<Result<SessionState, SessionFailure>> {
    if (this.cur === null) return err("rejected");
    if (!/^\d{6}$/.test(code)) return err("rejected");
    this.cur = { ...this.cur, secondFactorRequired: false };
    return ok(this.cur);
  }
  async refresh(): Promise<Result<SessionState, SessionFailure>> {
    this.refreshCalls += 1;
    if (this.cur === null) return err("rejected");
    this.cur = state(`fake-access-${this.refreshCalls}`, this.now(), this.cur.secondFactorRequired);
    return ok(this.cur);
  }
  async signOut(): Promise<void> {
    this.cur = null;
  }
}
