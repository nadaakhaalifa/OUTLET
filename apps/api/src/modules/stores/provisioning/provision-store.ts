import type { StoreRepository } from "../domain/ports";
import type { Store, StoreStats } from "../domain/store";
import {
  ONBOARDING_CHECKLIST,
  baseSlug,
  deterministicStoreId,
  normalizeBrandName,
  uniqueSlug,
  type ApprovedPayload,
  type ConflictQueuePort,
  type ProvisioningApplicationPort,
  type ProvisioningEventsPort,
  type SellerMembershipsPort,
  type StoreOnboardingPort,
} from "./domain";

const NO_STATS: StoreStats = {
  maxVerifiedDiscountPct: null,
  ratingAvg: null,
  ratingCount: 0,
  liveDrop: false,
  trendingScore: 0,
  lastDropAtMs: null,
  p80DeliveryHours: null,
};

/** 2,000 EGP in piastres, the launch default (master prompt section 6); the store may change it. */
const DEFAULT_FREE_DELIVERY_THRESHOLD = 200_000n;

export type ProvisionResult =
  | { readonly kind: "created"; readonly storeId: string; readonly slug: string }
  | { readonly kind: "already_provisioned"; readonly storeId: string }
  | { readonly kind: "conflict"; readonly conflictingStoreId: string };

export interface ProvisionDeps {
  readonly stores: StoreRepository;
  readonly memberships: SellerMembershipsPort;
  readonly onboarding: StoreOnboardingPort;
  readonly applications: ProvisioningApplicationPort;
  readonly events: ProvisioningEventsPort;
  readonly conflicts: ConflictQueuePort;
}

/**
 * Creates the store for an approved application. The store id is derived from the application id,
 * so a replay, a retry after a partial failure and a concurrent duplicate can only ever address the
 * same row: a second store is impossible. Every follow-up step is idempotent and is re-run on the
 * `already_provisioned` path, which is how a retry completes a half-finished provisioning.
 */
export class ProvisionStoreFromApproval {
  constructor(private readonly d: ProvisionDeps) {}

  async execute(p: ApprovedPayload): Promise<ProvisionResult> {
    const storeId = deterministicStoreId(p.application_id);
    const existing = await this.d.stores.findById(storeId);
    if (existing !== null) {
      await this.finish(p, existing.id);
      return { kind: "already_provisioned", storeId: existing.id };
    }

    const all = await this.d.stores.all();
    const wanted = new Set([normalizeBrandName(p.brand_name), ...(p.brand_name_ar ? [normalizeBrandName(p.brand_name_ar)] : [])]);
    const clash = all.find(
      (s) => wanted.has(normalizeBrandName(s.nameAr)) || (s.nameEn !== null && wanted.has(normalizeBrandName(s.nameEn))),
    );
    if (clash !== undefined) {
      await this.d.conflicts.enqueue({ applicationId: p.application_id, reason: "store_name_conflict", conflictingStoreId: clash.id });
      await this.d.applications.markProvisioningFailed(p.application_id, "store_name_conflict");
      return { kind: "conflict", conflictingStoreId: clash.id };
    }

    const slug = uniqueSlug(baseSlug(p.brand_name, p.slug_hint, p.application_id), new Set(all.map((s) => s.slug)));
    const store: Store = {
      id: storeId,
      sellerId: p.applicant_seller_user_id,
      kind: p.brand_kind,
      slug,
      nameAr: p.brand_name_ar ?? p.brand_name,
      nameEn: p.brand_name_ar ? p.brand_name : null,
      descriptionAr: null,
      descriptionEn: null,
      status: "ACTIVE",
      sellerKycState: "APPROVED",
      healthScore: null,
      // Earned later from price integrity, never granted by onboarding.
      verifiedBadge: false,
      logoUrl: null,
      coverUrl: null,
      freeDeliveryThresholdAmount: DEFAULT_FREE_DELIVERY_THRESHOLD,
      stats: NO_STATS,
      // B5 projection: supplier identity shown on every listing. Global brands use the country code
      // where a governorate does not apply.
      legalIdentity: {
        legalNameAr: p.legal_name_ar ?? p.legal_name_en ?? p.brand_name,
        legalNameEn: p.legal_name_en ?? null,
        commercialRegisterNo: p.registration_no ?? null,
        taxCardNo: p.tax_card_no ?? null,
        governorate: p.governorate ?? p.country,
      },
    };
    await this.d.stores.save(store);
    await this.finish(p, storeId);
    return { kind: "created", storeId, slug };
  }

  private async finish(p: ApprovedPayload, storeId: string): Promise<void> {
    await this.d.memberships.grantOwner({ sellerUserId: p.applicant_seller_user_id, storeId });
    await this.d.onboarding.seedChecklist(storeId, ONBOARDING_CHECKLIST);
    if (p.country === "EG") await this.d.onboarding.setEtaRegistration(storeId, p.eta_registration ?? "unknown");
    await this.d.applications.markProvisioned(p.application_id, storeId);
    await this.d.events.publish({
      type: "store.provisioned",
      key: storeId,
      payload: {
        store_id: storeId,
        application_id: p.application_id,
        seller_user_id: p.applicant_seller_user_id,
        kind: p.brand_kind,
        country: p.country,
        restricted_listing: p.restricted_listing,
      },
    });
  }
}
