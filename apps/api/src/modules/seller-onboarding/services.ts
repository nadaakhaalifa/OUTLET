import type { SellerOnboardingService, StoreMembershipService } from "@outlet/seller-accounts";

/** Small SQL reads the packages do not offer. */
export interface OnboardingLookupPort {
  /** The caller's most recent onboarding application (user context), or null. */
  sellerOf(userId: string): Promise<string | null>;
  /** When an open invite lapses (store context), or null. */
  inviteExpiry(storeId: string, memberId: string): Promise<Date | null>;
}

export interface SellerOnboardingServices {
  readonly onboarding: Pick<SellerOnboardingService, "createDraft" | "addDocument" | "setBankAccount" | "getCase" | "submit">;
  readonly membership: Pick<StoreMembershipService, "invite" | "listMembers">;
  readonly lookup: OnboardingLookupPort;
}
