import type { RlsSession } from "../../../../platform/db";

/** Identity for the NEXT transaction. Production resolves it per request; tests use a mutable holder. */
export type SessionProvider = () => RlsSession;

/** Worker identity: bypasses tenant filters by policy (`app.role = 'system'`). Never use for request paths. */
export const SYSTEM_SESSION: RlsSession = { userId: null, role: "system" };

export const fixedSession =
  (s: RlsSession): SessionProvider =>
  () =>
    s;
