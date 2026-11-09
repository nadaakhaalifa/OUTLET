import { createAdminAccess } from "@outlet/admin-access";
import type { FieldCipher, Hasher } from "@outlet/auth-core";
import { brandClient, withDbContext } from "@outlet/db";
import type { AddressPort } from "@outlet/checkout";
import type { RoleSqlClient } from "@outlet/db";
import { ReturnService, InventoryRestock } from "@outlet/returns";
import { SellerOnboardingService, StoreMembershipService, UnconfiguredKycCheck, UnconfiguredStrongAuth } from "@outlet/seller-accounts";
import { AddressService, CourierWebhookProcessor } from "@outlet/shipping";
import type { DeliveryPort } from "@outlet/shipping";
import { GeoReader } from "./modules/addresses/index.js";
import type { AddressesServices } from "./modules/addresses/index.js";
import { ApiProcessProvider, NoCategoryReturnPolicy, ReturnReader, UnconfiguredEvidence, UnconfiguredOrderCancellation, refundsKilledInApi } from "./modules/returns/index.js";
import type { OrderCancellationPort, ReturnsServices } from "./modules/returns/index.js";
import { PgOnboardingLookup } from "./modules/seller-onboarding/index.js";
import type { SellerOnboardingServices } from "./modules/seller-onboarding/index.js";
import { UnconfiguredCourier } from "./modules/seller-orders/index.js";
import { TrackingReader, UnconfiguredCourierWebhook } from "./modules/tracking/index.js";
import type { TrackingServices } from "./modules/tracking/index.js";
import { Problems } from "./platform/problem.js";

/**
 * Checkout's AddressPort over the owner's saved addresses (RLS and an explicit owner filter). The deepest known area (district, city, governorate) is the delivery
 * area; `version` is the same content version the address service exposes (changes on every edit), bound into the quote token so an edit answers price-changed {address}.
 */
export class PgAddressPort implements AddressPort {
  constructor(private readonly client: RoleSqlClient<"outlet_app">, private readonly marketId: string) {}

  resolve(userId: string, addressRef: string): ReturnType<AddressPort["resolve"]> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(addressRef)) return Promise.resolve(null);
    return withDbContext(this.client, { kind: "user", marketId: this.marketId, userId }, async (tx) => {
      const r = (await tx.query<{ area: string; country: string; cod: boolean; v: string }>(
        `SELECT COALESCE(district_area_id, city_area_id, governorate_area_id)::text AS area, country_code AS country, cod_eligible AS cod,
                (extract(epoch from updated_at) * 1000000)::bigint::text AS v
           FROM addresses WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`, [addressRef, userId])).rows[0];
      return r === undefined ? null : { geoAreaId: r.area, countryCode: r.country.trim(), codEligible: r.cod, version: r.v };
    });
  }
}

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
  /** Real OrderCancellation (README 9.3); undefined while the payments provider is Unconfigured: the route then fails closed (503). */
  readonly cancellation?: OrderCancellationPort | undefined;
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
 * no courier (V33/V43), no return evidence store, no cancellation saga unless the payments provider is configured, no KYC provider. Money never moves from the API process.
 */
export const postOrderServices = (i: PostOrderInputs): PostOrderServices => {
  const worker = i.workerClient ?? noWorker;
  const returnsDeps = {
    app: i.appClient, worker, marketId: i.marketId, policy: new NoCategoryReturnPolicy(), evidence: new UnconfiguredEvidence(), restock: new InventoryRestock(i.appClient, i.marketId),
    provider: new ApiProcessProvider(), kill: refundsKilledInApi,
    // Never exercised here (approvals belong to the Admin Console, which owns its own audit sink): an audit sink that always fails keeps it unusable.
    admin: createAdminAccess({ db: i.appClient, audit: { appendIn: () => Promise.reject(Problems.unavailable("audit-unconfigured")) }, clock: () => new Date(), thresholdMinor: 0n }),
  };
  const sellerDeps = { app: i.appClient, auth: i.authClient, worker, marketId: i.marketId, cipher: i.cipher, hasher: i.hasher };
  return {
    addresses: { addresses: new AddressService({ client: i.appClient, marketId: i.marketId }, i.cipher), geo: new GeoReader(i.appClient, i.marketId) },
    returns: { returns: new ReturnService(returnsDeps), reader: new ReturnReader(i.appClient, i.marketId), cancellation: i.cancellation ?? new UnconfiguredOrderCancellation() },
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
