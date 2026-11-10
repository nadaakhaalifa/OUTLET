import { withDbContext } from "@outlet/db";
import type { RoleSqlClient } from "@outlet/db";
import type { OnboardingLookupPort } from "./services.js";

export class PgOnboardingLookup implements OnboardingLookupPort {
  constructor(private readonly client: RoleSqlClient<"outlet_app">, private readonly marketId: string) {}

  async sellerOf(userId: string): Promise<string | null> {
    const r = await withDbContext(this.client, { kind: "user", marketId: this.marketId, userId }, async (tx) =>
      (await tx.query<{ seller_id: string }>("SELECT seller_id FROM kyc_cases WHERE kind = 'onboarding' AND applicant_user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1", [userId])).rows[0],
    );
    return r?.seller_id ?? null;
  }

  async inviteExpiry(storeId: string, memberId: string): Promise<Date | null> {
    const r = await withDbContext(this.client, { kind: "store", marketId: this.marketId, storeId }, async (tx) =>
      (await tx.query<{ invite_expires_at: Date | null }>("SELECT invite_expires_at FROM store_members WHERE id = $1 AND store_id = $2", [memberId, storeId])).rows[0],
    );
    return r?.invite_expires_at == null ? null : new Date(r.invite_expires_at);
  }
}
