import type { SqlClient } from "@outlet/db";
import { uuidv7 } from "@outlet/ids";
import type { OutboxWriter } from "@outlet/outbox";

export interface PrivacyDeps {
  readonly db: SqlClient;
  readonly outbox: OutboxWriter;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

export interface ResolvedDeps {
  readonly db: SqlClient;
  readonly outbox: OutboxWriter;
  readonly now: () => Date;
  readonly newId: () => string;
}

export const resolveDeps = (d: PrivacyDeps): ResolvedDeps => ({
  db: d.db,
  outbox: d.outbox,
  now: d.now ?? (() => new Date()),
  newId: d.newId ?? uuidv7,
});

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
