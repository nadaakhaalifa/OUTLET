import { revokeFamily, revokeSession } from "@outlet/auth-core";
import type { SessionRepository, StoredSession } from "../domain/ports";
import type { Clock } from "./common";

export class GetSession {
  constructor(private readonly sessions: SessionRepository) {}

  async execute(sessionId: string): Promise<StoredSession | null> {
    const s = await this.sessions.find(sessionId);
    return s !== null && s.session.revokedAtMs === null ? s : null;
  }
}

/** Revokes the session and its refresh family so the refresh token dies with the access session. */
export class RevokeSession {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly clock: Clock,
  ) {}

  async execute(sessionId: string): Promise<boolean> {
    const s = await this.sessions.find(sessionId);
    if (s === null || s.session.revokedAtMs !== null) return false;
    const nowMs = this.clock.nowMs();
    await this.sessions.save({
      ...s,
      session: revokeSession(s.session, nowMs),
      family: revokeFamily(s.family, nowMs, "logout"),
    });
    return true;
  }
}
