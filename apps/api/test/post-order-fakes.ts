import { createAdminAccess } from "@outlet/admin-access";
import type { FieldCipher, Hasher } from "@outlet/auth-core";
import { OrderCloseJob } from "@outlet/checkout";
import type { RoleSqlClient } from "@outlet/db";
import { ReturnService } from "@outlet/returns";
import { FakeEvidence, FakeKill, FakePolicy, FakeProvider, FakeRestock } from "@outlet/returns/testing";
import { SellerOnboardingService, StoreMembershipService } from "@outlet/seller-accounts";
import { FakeKycCheck, FakeStrongAuth } from "@outlet/seller-accounts/testing";
import { AddressService, CourierWebhookProcessor } from "@outlet/shipping";
import { FakeCipher as ShippingCipher, FakeCourier, FakeWebhook } from "@outlet/shipping/testing";
import { GeoReader } from "../src/modules/addresses/index.js";
import type { AddressesServices } from "../src/modules/addresses/index.js";
import { ReturnReader } from "../src/modules/returns/index.js";
import type { OrderCancellationPort, ReturnsServices } from "../src/modules/returns/index.js";
import { PgOnboardingLookup } from "../src/modules/seller-onboarding/index.js";
import type { SellerOnboardingServices } from "../src/modules/seller-onboarding/index.js";
import { TrackingReader } from "../src/modules/tracking/index.js";
import type { TrackingServices } from "../src/modules/tracking/index.js";
import { Problems } from "../src/platform/problem.js";

/** Records calls; `unconfigured` mimics production (503) so the eligibility checks in front of the port are tested on their own. */
export class RecordingCancellation implements OrderCancellationPort {
  readonly calls: { userId: string; orderGroupId: string; reasonCode: string; refundPreference: string | undefined }[] = [];
  unconfigured = true;
  cancel(i: { userId: string; orderGroupId: string; reasonCode: string; refundPreference: "original" | "store_credit" | undefined }): Promise<void> {
    if (this.unconfigured) return Promise.reject(Problems.unavailable("order-cancellation-unconfigured"));
    this.calls.push(i);
    return Promise.resolve();
  }
}

export interface PostOrderFakes {
  readonly policy: FakePolicy;
  readonly evidence: FakeEvidence;
  readonly restock: FakeRestock;
  readonly provider: FakeProvider;
  readonly kill: FakeKill;
  readonly cancellation: RecordingCancellation;
  readonly kyc: FakeKycCheck;
  /** The courier adapter behind the tracking webhook (status map is the generic one). */
  readonly courier: FakeCourier;
  readonly delivered: string[];
}

export interface PostOrderBuild {
  readonly services: { addresses: AddressesServices; returns: ReturnsServices; tracking: TrackingServices; sellerOnboarding: SellerOnboardingServices };
  readonly fakes: PostOrderFakes;
}

export const buildPostOrder = (i: {
  marketId: string; now: () => Date; app: RoleSqlClient<"outlet_app">; auth: RoleSqlClient<"outlet_auth">; worker: RoleSqlClient<"outlet_worker">; cipher: FieldCipher; hasher: Hasher; closer: OrderCloseJob; courier: FakeCourier;
}): PostOrderBuild => {
  const fakes: PostOrderFakes = { policy: new FakePolicy(), evidence: new FakeEvidence(), restock: new FakeRestock(), provider: new FakeProvider(), kill: new FakeKill(), cancellation: new RecordingCancellation(), kyc: new FakeKycCheck(), courier: i.courier, delivered: [] };
  const returnsDeps = {
    app: i.app, worker: i.worker, marketId: i.marketId, policy: fakes.policy, evidence: fakes.evidence, restock: fakes.restock, provider: fakes.provider, kill: fakes.kill, now: i.now,
    admin: createAdminAccess({ db: i.app, audit: { append: () => Promise.resolve() }, clock: i.now, thresholdMinor: 500_000n }),
  };
  const sellerDeps = { app: i.app, auth: i.auth, worker: i.worker, marketId: i.marketId, cipher: i.cipher, hasher: i.hasher, now: i.now };
  const orders = { markDelivered: (id: string, at: Date): Promise<unknown> => { fakes.delivered.push(id); return i.closer.markDelivered(id, at); } };
  return {
    fakes,
    services: {
      addresses: { addresses: new AddressService({ client: i.app, marketId: i.marketId, now: i.now }, new ShippingCipher()), geo: new GeoReader(i.app, i.marketId) },
      returns: { returns: new ReturnService(returnsDeps), reader: new ReturnReader(i.app, i.marketId), cancellation: fakes.cancellation },
      tracking: {
        tracking: new TrackingReader(i.app, i.marketId),
        courierCode: "fake",
        webhooks: new CourierWebhookProcessor({ client: i.worker, marketId: i.marketId, courierCode: "fake", courier: i.courier, webhook: new FakeWebhook(), cipher: new ShippingCipher(), orders, now: i.now }),
      },
      sellerOnboarding: {
        onboarding: new SellerOnboardingService(sellerDeps, fakes.kyc),
        membership: new StoreMembershipService(sellerDeps, new FakeStrongAuth()),
        lookup: new PgOnboardingLookup(i.app, i.marketId),
      },
    },
  };
};

