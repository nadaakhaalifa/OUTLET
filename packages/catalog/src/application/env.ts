import { randomUUID } from "node:crypto";
import { withDbContext } from "@outlet/db";
import type { Queryable, RoleSqlClient } from "@outlet/db";
import { uuidv7 } from "@outlet/ids";
import type { Currency } from "@outlet/money";
import { OutboxWriter, pgTransactionalWriter } from "@outlet/outbox";
import { authorize } from "@outlet/policy";
import type { Action, Principal } from "@outlet/policy";
import { CatalogError } from "../domain/errors.js";

export interface CatalogDeps {
  /** Connection as outlet_app (ADR-0011). Every call binds its own database context. */
  readonly client: RoleSqlClient<"outlet_app">;
  readonly marketId: string;
  /** Market currency; variant prices must use it. Default EGP. */
  readonly currency?: Currency;
  readonly outbox?: OutboxWriter;
  readonly now?: () => Date;
  readonly newId?: () => string;
  /** Builds the public URL of a media asset (CDN concern; the default is a relative /media path). */
  readonly mediaUrl?: (mediaId: string) => string;
}

export interface Env {
  readonly client: RoleSqlClient<"outlet_app">;
  readonly marketId: string;
  readonly currency: Currency;
  readonly outbox: OutboxWriter;
  readonly now: () => Date;
  readonly newId: () => string;
  readonly mediaUrl: (mediaId: string) => string;
}

export const makeEnv = (d: CatalogDeps): Env => ({
  client: d.client,
  marketId: d.marketId,
  currency: d.currency ?? "EGP",
  outbox: d.outbox ?? new OutboxWriter(pgTransactionalWriter),
  now: d.now ?? (() => new Date()),
  newId: d.newId ?? (() => uuidv7()),
  mediaUrl: d.mediaUrl ?? ((id) => `/media/${id}`),
});

/** Deny-by-default check through @outlet/policy: a foreign store is not_found (404), a wrong role is forbidden (403). */
export const requireAccess = (env: Env, actor: Principal, action: Action, storeId: string): void => {
  // store.read is also a public/shopper action in @outlet/policy; seller-scoped operations are for seller staff only.
  if (actor.kind !== "seller_staff") throw new CatalogError("forbidden", "forbidden");
  const d = authorize(actor, action, { type: "catalog", storeId, marketId: env.marketId });
  if (d.effect === "deny") throw new CatalogError(d.reason, d.reason === "not_found" ? "not found" : "forbidden");
};

/** Authorizes, then runs fn in one transaction bound to the seller store context (RLS pins store and market). */
export const asStore = <T>(env: Env, actor: Principal, action: Action, storeId: string, fn: (tx: Queryable) => Promise<T>): Promise<T> => {
  requireAccess(env, actor, action, storeId);
  return withDbContext(env.client, { kind: "store", marketId: env.marketId, storeId, ...(actor.userId === undefined ? {} : { userId: actor.userId }) }, fn);
};

/** Public (shopper or anonymous) read context: only the published read model and reference data are reachable. */
export const asPublic = <T>(env: Env, fn: (tx: Queryable) => Promise<T>): Promise<T> => withDbContext(env.client, { kind: "user", marketId: env.marketId }, fn);

export const randomId = (): string => randomUUID();

export const toIso = (v: Date | string): string => (v instanceof Date ? v : new Date(v)).toISOString();

export const pgCode = (e: unknown): string | undefined => {
  if (typeof e === "object" && e !== null && "code" in e && typeof e.code === "string") return e.code;
  return undefined;
};

export const isUniqueViolation = (e: unknown): boolean => pgCode(e) === "23505";
