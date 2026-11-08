import { createHash } from "node:crypto";
import { withDbContext } from "@outlet/db";
import type { RoleSqlClient } from "@outlet/db";
import { Problems } from "../../platform/problem.js";
import type { PasskeyCredentialRecord, PasskeyStore } from "./passkeys.js";

interface Row {
  id: string;
  user_id: string;
  market_id: string;
  credential_id: string;
  public_key: Uint8Array;
  counter: string | number;
  transports: string[];
  aaguid: string | null;
  backed_up: boolean;
  created_at: Date | string;
  last_used_at: Date | string | null;
}

const COLUMNS = "id, user_id, market_id, credential_id, public_key, counter, transports, aaguid, backed_up, created_at, last_used_at";

const toRecord = (r: Row): PasskeyCredentialRecord => ({
  id: r.id,
  marketId: r.market_id,
  userId: r.user_id,
  credentialId: r.credential_id,
  publicKey: new Uint8Array(r.public_key),
  counter: Number(r.counter),
  transports: r.transports,
  backupEligible: r.backed_up,
  aaguid: r.aaguid,
  createdAt: new Date(r.created_at),
  lastUsedAt: r.last_used_at === null ? null : new Date(r.last_used_at),
});

/** Domain-separated lookup key; is stored in credential_id_hash (migration 0020). Travels in the `tokenHash` auth key. */
export const passkeyLookupKey = (credentialId: string): string => createHash("sha256").update(`passkey:${credentialId}`, "utf8").digest("hex");

/**
 * `passkey_credentials` as the outlet_auth role under FORCE RLS. Enrolment and listing run in the owner's user context; the pre-auth
 * assertion lookup and counter update run in the auth context keyed on the credential hash (policies passkey_credentials__auth_*).
 * Revoked credentials are invisible to both.
 */
export class PgPasskeyStore implements PasskeyStore {
  constructor(private readonly client: RoleSqlClient<"outlet_auth">) {}

  listByUser(marketId: string, userId: string): Promise<readonly PasskeyCredentialRecord[]> {
    return withDbContext(this.client, { kind: "user", marketId, userId }, async (tx) => {
      const r = await tx.query<Row>(`SELECT ${COLUMNS} FROM passkey_credentials WHERE market_id = $1 AND revoked_at IS NULL ORDER BY created_at, id`, [marketId]);
      return r.rows.map(toRecord);
    });
  }

  findByCredentialId(marketId: string, credentialId: string): Promise<PasskeyCredentialRecord | null> {
    return withDbContext(this.client, { kind: "auth", marketId, auth: { tokenHash: passkeyLookupKey(credentialId) } }, async (tx) => {
      const r = await tx.query<Row>(`SELECT ${COLUMNS} FROM passkey_credentials WHERE credential_id = $1`, [credentialId]);
      const row = r.rows[0];
      return row === undefined ? null : toRecord(row);
    });
  }

  insert(c: PasskeyCredentialRecord): Promise<void> {
    return withDbContext(this.client, { kind: "user", marketId: c.marketId, userId: c.userId }, async (tx) => {
      await tx.query(
        `INSERT INTO passkey_credentials (id, user_id, market_id, credential_id, credential_id_hash, public_key, counter, transports, aaguid, backed_up, created_at, last_used_at)
         VALUES ($1, $2, $3, $4, decode($12, 'hex'), $5, $6, $7, $8, $9, $10, $11)`,
        [c.id, c.userId, c.marketId, c.credentialId, c.publicKey, c.counter, [...c.transports], c.aaguid, c.backupEligible, c.createdAt.toISOString(), c.lastUsedAt === null ? null : c.lastUsedAt.toISOString(), passkeyLookupKey(c.credentialId)],
      );
    });
  }

  /** The counter must strictly increase (a replayed or cloned authenticator is rejected); 0 -> 0 is allowed for authenticators that never count. */
  async recordUse(c: PasskeyCredentialRecord, counter: number, now: Date): Promise<void> {
    const updated = await withDbContext(this.client, { kind: "auth", marketId: c.marketId, auth: { tokenHash: passkeyLookupKey(c.credentialId) } }, async (tx) => {
      const r = await tx.query(
        `UPDATE passkey_credentials SET counter = $2, last_used_at = $3
          WHERE id = $1 AND (counter < $2 OR (counter = 0 AND $2 = 0)) RETURNING id`,
        [c.id, counter, now.toISOString()],
      );
      return r.rows.length;
    });
    if (updated === 0) throw Problems.unauthenticated("passkey-rejected");
  }
}
