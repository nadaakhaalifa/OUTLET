import { createAdminAccess } from "@outlet/admin-access";
import type { FieldCipher, Hasher } from "@outlet/auth-core";
import { brandClient } from "@outlet/db";
import type { RoleSqlClient } from "@outlet/db";
import { ReturnService, InventoryRestock } from "@outlet/returns";
import { SellerOnboardingService, StoreMembershipService, UnconfiguredKycCheck, UnconfiguredStrongAuth } from "@outlet/seller-accounts";
import { AddressService, CourierWebhookProcessor } from "@outlet/shipping";
import type { DeliveryPort } from "@outlet/shipping";
import { GeoReader } from "./modules/addresses/index.js";
import type { AddressesServices } from "./modules/addresses/index.js";
import { ApiProcessProvider, NoCategoryReturnPolicy, ReturnReader, UnconfiguredEvidence, UnconfiguredOrderCancellation, refundsKilledInApi } from "./modules/returns/index.js";
import type { ReturnsServices } from "./modules/returns/index.js";
import { PgOnboardingLookup } from "./modules/seller-onboarding/index.js";
import type { SellerOnboardingServices } from "./modules/seller-onboarding/index.js";
import { UnconfiguredCourier } from "./modules/seller-orders/index.js";
import { TrackingReader, UnconfiguredCourierWebhook } from "./modules/tracking/index.js";
import type { TrackingServices } from "./modules/tracking/index.js";
import { Problems } from "./platform/problem.js";

export interface PostOrderInputs {
  readonly marketId: string;
  readonly appClient: RoleSqlClient<"outlet_app">;
  readonly authClient: RoleSqlClient<"outlet_auth">;
  /** Undefined without DATABASE_URL_WORKER: everything that needs a named worker job then answers 503. */
  readonly workerClient: RoleSqlClient<"outlet_worker"> | undefined;
  readonly cipher: FieldCipher;
  readonly hasher: Hasher;
  /** Delivered-marker for the courier webhook (OrderCloseJob); undefined when there is no worker pool. */
  readonly delivery: DeliveryPort | undefined;
}

export interface PostOrderServices {
  readonly addresses: AddressesServices;
  readonly returns: ReturnsServices;
  readonly tracking: TrackingServices;
  readonly sellerOnboarding: SellerOnboardingServices;
}

const noWorker = brandClient<"outlet_worker">({ query: () => Promise.reject(Problems.unavailable("worker-pool-unconfigured")), transaction: () => Promise.reject(Problems.unavailable("worker-pool-unconfigured")) });

/**
 * Production composition of addresses, returns, tracking and seller onboarding. Every provider boundary stays unconfigured (ADR-0029):
 * no courier (V33/V43), no return evidence store, no cancellation saga, no KYC provider. Money never moves from the API process.
 */
export const postOrderServices = (i: PostOrderInputs): PostOrderServices => {
  const worker = i.workerClient ?? noWorker;
  const returnsDeps = {
    app: i.appClient, worker, marketId: i.marketId, policy: new NoCategoryReturnPolicy(), evidence: new UnconfiguredEvidence(), restock: new InventoryRestock(i.appClient, i.marketId),
    provider: new ApiProcessProvider(), kill: refundsKilledInApi,
    // Never exercised here (approvals belong to the Admin Console, which owns its own audit sink): an audit sink that always fails keeps it unusable.
    admin: createAdminAccess({ db: i.appClient, audit: { append: () => Promise.reject(Problems.unavailable("audit-unconfigured")) }, clock: () => new Date(), thresholdMinor: 0n }),
  };
  const sellerDeps = { app: i.appClient, auth: i.authClient, worker, marketId: i.marketId, cipher: i.cipher, hasher: i.hasher };
  return {
    addresses: { addresses: new AddressService({ client: i.appClient, marketId: i.marketId }, i.cipher), geo: new GeoReader(i.appClient, i.marketId) },
    returns: { returns: new ReturnService(returnsDeps), reader: new ReturnReader(i.appClient, i.marketId), cancellation: new UnconfiguredOrderCancellation() },
    tracking: {
      tracking: new TrackingReader(i.appClient, i.marketId),
      courierCode: "bosta",
      webhooks:
        i.workerClient === undefined || i.delivery === undefined
          ? { handle: () => Promise.reject(Problems.unavailable("webhooks-unavailable")) }
          : new CourierWebhookProcessor({ client: i.workerClient, marketId: i.marketId, courierCode: "bosta", courier: new UnconfiguredCourier(), webhook: new UnconfiguredCourierWebhook(), cipher: i.cipher, orders: i.delivery }),
    },
    sellerOnboarding: {
      onboarding: new SellerOnboardingService(sellerDeps, new UnconfiguredKycCheck()),
      membership: new StoreMembershipService(sellerDeps, new UnconfiguredStrongAuth()),
      lookup: new PgOnboardingLookup(i.appClient, i.marketId),
    },
  };
};
