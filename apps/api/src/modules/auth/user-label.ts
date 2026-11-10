import { withDbContext } from "@outlet/db";
import type { RoleSqlClient } from "@outlet/db";
import type { FieldCipher } from "@outlet/auth-core";

/** "+20 1** *** **89": enough for the user to recognise the account in the authenticator, never the full number. */
export const maskPhone = (e164: string): string => (e164.length < 6 ? "Outlex account" : `${e164.slice(0, 3)}${"*".repeat(e164.length - 5)}${e164.slice(-2)}`);

/** WebAuthn userName source: the owner's masked phone (decrypted in the owner's context); any failure falls back to the generic label upstream. */
export const pgPhoneLabel =
  (client: RoleSqlClient<"outlet_app">, marketId: string, cipher: FieldCipher) =>
  (userId: string): Promise<string> =>
    withDbContext(client, { kind: "user", marketId, userId }, async (tx) => {
      const r = await tx.query<{ phone_ct: Uint8Array | null }>("SELECT phone_ct FROM users WHERE id = $1", [userId]);
      const ct = r.rows[0]?.phone_ct;
      if (ct === null || ct === undefined) return "Outlex account";
      return maskPhone(await cipher.decrypt(ct, "users.phone_ct"));
    });
