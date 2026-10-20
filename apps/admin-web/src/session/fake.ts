import { err, ok, type Result } from "../lib/result";
import type { SessionFailure, SessionPort, SessionState } from "./port";

export interface FakeSessionOptions {
  readonly initial?: SessionState | null;
  readonly passkeyFails?: SessionFailure;
  readonly now?: () => number;
}

/** In-memory SessionPort for tests and previews. Never touches a network. */
export class FakeSession implements SessionPort {
  private cur: SessionState | null;
  public refreshCalls = 0;
  constructor(private readonly opts: FakeSessionOptions = {}) {
    this.cur = opts.initial ?? null;
  }
  private mint(token: string): SessionState {
    return { accessToken: token, refreshToken: `${token}-refresh`, accessExpiresAtMs: (this.opts.now?.() ?? Date.now()) + 600_000 };
  }
  async current(): Promise<SessionState | null> {
    return this.cur;
  }
  async signInWithPasskey(): Promise<Result<SessionState, SessionFailure>> {
    if (this.opts.passkeyFails !== undefined) return err(this.opts.passkeyFails);
    this.cur = this.mint("fake-access");
    return ok(this.cur);
  }
  async refresh(): Promise<Result<SessionState, SessionFailure>> {
    this.refreshCalls += 1;
    if (this.cur === null) return err("rejected");
    this.cur = this.mint(`fake-access-${this.refreshCalls}`);
    return ok(this.cur);
  }
  async signOut(): Promise<void> {
    this.cur = null;
  }
}
