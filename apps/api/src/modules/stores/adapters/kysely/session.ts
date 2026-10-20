import type { RlsSession } from "../../../../platform/db";

export type SessionProvider = () => RlsSession;

/** Worker identity (`app.role = 'system'`). The directory read model is served under it, see stores spec Wave 2. */
export const SYSTEM_SESSION: RlsSession = { userId: null, role: "system" };

export const fixedSession =
  (s: RlsSession): SessionProvider =>
  () =>
    s;
