import type { RoleSqlClient } from "@outlet/db";
import { uuidv7 } from "@outlet/ids";
import type { Currency } from "@outlet/money";
import { OutboxWriter, pgTransactionalWriter } from "@outlet/outbox";
import { DEFAULT_THRESHOLD_MINOR } from "../domain/bag.js";
import { listingStatusAvailability } from "./availability.js";
import type { AvailabilityPort } from "./availability.js";

/** Port: AuditChain satisfies it structurally. Required for the admin threshold path (fails closed without it). */
export interface AuditPort {
  append(input: {
    marketId: string; actorType: "staff"; actorId: string | null; action: string; targetType: string; targetId: string;
    diff: { before?: unknown; after?: unknown } | null; ipHash: string | null; deviceId: string | null; requestId: string | null;
  }): Promise<unknown>;
}

export interface CartDeps {
  readonly audit?: AuditPort;
  /** Connection as outlet_app (ADR-0011). Every call binds its own user context. */
  readonly client: RoleSqlClient<"outlet_app">;
  readonly marketId: string;
  readonly currency?: Currency;
  readonly outbox?: OutboxWriter;
  readonly now?: () => Date;
  readonly newId?: () => string;
  /** Stock check. Default: the published listing status only. Use pgInventoryAvailability for the inventory levels. */
  readonly availability?: AvailabilityPort;
  /** Admin default free-delivery threshold in minor units (default EGP 2,000). */
  readonly defaultThresholdMinor?: bigint;
}

export interface Env {
  readonly audit: AuditPort | undefined;
  readonly client: RoleSqlClient<"outlet_app">;
  readonly marketId: string;
  readonly currency: Currency;
  readonly outbox: OutboxWriter;
  readonly now: () => Date;
  readonly newId: () => string;
  readonly availability: AvailabilityPort;
  readonly defaultThresholdMinor: bigint;
}

export const makeEnv = (d: CartDeps): Env => ({
  audit: d.audit,
  client: d.client,
  marketId: d.marketId,
  currency: d.currency ?? "EGP",
  outbox: d.outbox ?? new OutboxWriter(pgTransactionalWriter),
  now: d.now ?? (() => new Date()),
  newId: d.newId ?? (() => uuidv7()),
  availability: d.availability ?? listingStatusAvailability,
  defaultThresholdMinor: d.defaultThresholdMinor ?? DEFAULT_THRESHOLD_MINOR,
});
