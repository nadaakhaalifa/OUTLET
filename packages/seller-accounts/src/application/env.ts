import type { Hasher, FieldCipher } from "@outlet/auth-core";
import type { RoleSqlClient } from "@outlet/db";
import { uuidv7 } from "@outlet/ids";
import { OutboxWriter, pgTransactionalWriter } from "@outlet/outbox";
import type { OutboxEventInput, Queryable } from "@outlet/outbox";
import { withDbContext } from "@outlet/db";
import { SellerAccountsError } from "../domain/errors.js";

export interface SellerAccountsDeps {
  /** outlet_app: applicant and store-staff reads/writes, always under a bound user or store context. */
  readonly app: RoleSqlClient<"outlet_app">;
  /** outlet_auth: only the "my memberships" read (policy store_members__auth_my_memberships). */
  readonly auth: RoleSqlClient<"outlet_auth">;
  /**
   * outlet_worker, only ever bound to job 'seller.kyc' (and 'media.platform' for the KYC document pointer check): seller
   * creation, KYC transitions, admin decisions and the first-owner bootstrap (ADR-0011 named exception policies
   * <tbl>__worker_seller_kyc). The service enforces the caller's authority in code before it uses this client.
   */
  readonly worker: RoleSqlClient<"outlet_worker">;
  readonly marketId: string;
  readonly cipher: FieldCipher;
  readonly hasher: Hasher;
  readonly outbox?: OutboxWriter;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

export interface Env {
  readonly app: RoleSqlClient<"outlet_app">;
  readonly auth: RoleSqlClient<"outlet_auth">;
  readonly worker: RoleSqlClient<"outlet_worker">;
  readonly marketId: string;
  readonly cipher: FieldCipher;
  readonly hasher: Hasher;
  readonly outbox: OutboxWriter;
  readonly now: () => Date;
  readonly newId: () => string;
}

export const makeEnv = (d: SellerAccountsDeps): Env => ({
  app: d.app,
  auth: d.auth,
  worker: d.worker,
  marketId: d.marketId,
  cipher: d.cipher,
  hasher: d.hasher,
  outbox: d.outbox ?? new OutboxWriter(pgTransactionalWriter),
  now: d.now ?? (() => new Date()),
  newId: d.newId ?? (() => uuidv7()),
});

/** Appends a PII-free outbox event in the caller's transaction. */
export const emit = async (env: Env, tx: Queryable, type: string, aggregateType: string, aggregateId: string, payload: OutboxEventInput["payload"]): Promise<void> => {
  await env.outbox.append(tx, {
    id: env.newId(),
    type,
    aggregateType,
    aggregateId,
    marketId: env.marketId,
    occurredAt: env.now().toISOString(),
    payload,
  });
};

export const pgCode = (e: unknown): string | undefined => (typeof e === "object" && e !== null && "code" in e && typeof e.code === "string" ? e.code : undefined);
export const isUniqueViolation = (e: unknown): boolean => pgCode(e) === "23505";

export const conflict = (message: string): SellerAccountsError => new SellerAccountsError("conflict", message);

/** Runs fn as the 'seller.kyc' worker job; pass userId to narrow to the applicant (applicant-driven writes), omit for admin/system work. */
export const kycJob = <T>(env: Env, userId: string | undefined, fn: (tx: Queryable) => Promise<T>): Promise<T> =>
  withDbContext(env.worker, { kind: "worker", marketId: env.marketId, job: "seller.kyc", ...(userId === undefined ? {} : { userId }) }, fn);
