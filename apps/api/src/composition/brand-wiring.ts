import {
  BrandReview,
  InMemoryBrandApplicationsAdmin,
  InMemoryBrandVerification,
  InMemoryReviewerIdentity,
  type AutoCheckReport,
  type BrandApplicationsAdminPort,
  type BrandVerificationPort,
  type DocumentMeta,
  type ReadUrlResult,
  type ReviewerIdentityPort,
} from "../modules/admin";
import type { AdminAuditPort } from "../modules/admin";
import type { BrandVerificationStore } from "../modules/brand-verification";
import { createHash } from "node:crypto";
import type { DynamicModule } from "@nestjs/common";
import { sql, type Kysely } from "kysely";
import type { BrandEventConsumerPort, ProvisioningRetryOutcome, ProvisioningRetryPort } from "../modules/admin";
import { SELLER_MEMBERSHIPS, type SellerMembershipService } from "../modules/auth";
import { SEND_NOTIFICATION, type SendNotification } from "../modules/notifications";
import { BRAND_VERIFICATION_STORE } from "../modules/brand-verification";
import { SELLERS_ADMIN_PORT } from "../modules/sellers";
import type { BrandApplicationsAdminPort as SellersAdminPort } from "../modules/sellers";
import {
  AuthSellerMemberships,
  InMemoryBrandReviewOverlay,
  SellersAutoChecks,
  SellersDocumentAccess,
  SellersReviewAdapter,
  type BrandReviewOverlay,
} from "./brand-adapters";
import {
  BrandApplicationEventConsumer,
  InMemoryConflictQueue,
  InMemoryInboxRunner,
  InMemoryProvisioningApplications,
  InMemoryProvisioningEvents,
  InMemorySellerMemberships,
  InMemoryStoreOnboarding,
  ProvisionStoreFromApproval,
  RecordingBrandNotifier,
  RetryFailedProvisioning,
  STORE_REPOSITORY,
  type AutoChecksPort,
  type BrandNotifierPort,
  type BrandTemplateKey,
  type ConflictQueuePort,
  type InboxRunner,
  type ProvisioningApplicationPort,
  type ProvisioningEventsPort,
  type SellerMembershipsPort,
  type StoreOnboardingPort,
  type StoreRepository,
} from "../modules/stores";

/**
 * Brand review + store provisioning composition (docs/specs/brand-review-and-provisioning.md).
 *
 * REAL today: BrandVerificationStore (reports from `brand-verification`), SendNotification
 * (notifications), the StoreRepository passed in (stores), the admin audit/store passed in.
 * FALLBACK (in-memory, loudly named): the sellers module's applications admin port, document
 * access, seller memberships, the onboarding checklist and the conflict queue. The fallbacks keep
 * the same contracts, so replacing one is passing it in `real`.
 */

/** Sends the brand templates through the notifications public API in the applicant locale. */
export class SendNotificationBrandNotifier implements BrandNotifierPort {
  constructor(private readonly send: Pick<SendNotification, "execute">) {}
  async notify(i: { userId: string; templateKey: BrandTemplateKey; ref: string; brandName: string; deepLink: string }): Promise<void> {
    const r = await this.send.execute({
      userId: i.userId,
      templateKey: i.templateKey,
      ref: i.ref,
      payload: { brand_name: i.brandName },
      deepLink: i.deepLink,
    });
    if (r.kind === "rejected") throw new Error(`brand notification rejected: ${r.reason}`);
  }
}

export interface DocumentAccess {
  documents: BrandVerificationPort["documents"];
  createReadUrl: BrandVerificationPort["createReadUrl"];
}

/**
 * BrandVerificationPort over the real verification store (auto-check report) and the sellers
 * module's document access. Fails closed: no stored report means dual approval is assumed.
 */
export class VerificationStoreAdapter implements BrandVerificationPort {
  constructor(
    private readonly store: Pick<BrandVerificationStore, "latestReport">,
    private readonly docs: DocumentAccess,
  ) {}

  async autoCheckReport(applicationId: string): Promise<AutoCheckReport | null> {
    const rec = await this.store.latestReport(applicationId);
    if (rec === null) return null;
    const r = rec.report;
    return {
      dualApprovalRequired: r.dualApprovalRequired,
      riskScore: null,
      checks: r.checks.map((c) => ({
        code: c.code,
        result: c.result,
        detail: c.reasons.length === 0 ? null : c.reasons.join(","),
        ranAtMs: r.ranAtMs,
      })),
    };
  }
  documents(applicationId: string): Promise<readonly DocumentMeta[]> {
    return this.docs.documents(applicationId);
  }
  createReadUrl(
    applicationId: string,
    documentId: string,
    ttlMs: number,
    nowMs: number,
    ctx: { readonly adminId: string; readonly reasonCode: string },
  ): Promise<ReadUrlResult> {
    return this.docs.createReadUrl(applicationId, documentId, ttlMs, nowMs, ctx);
  }
}

export interface BrandWiringReal {
  /** The sellers module's public admin port (SELLERS_ADMIN_PORT). Builds review, documents and provisioning adapters. */
  readonly sellers?: SellersAdminPort;
  /** Cosign / parking state the sellers module does not hold. Needs persistence in production. */
  readonly overlay?: BrandReviewOverlay;
  /** Seller auth public service (SellerMembershipService). */
  readonly sellerAuth?: Pick<SellerMembershipService, "grantStoreRole">;
  readonly applications?: BrandApplicationsAdminPort;
  readonly documents?: DocumentAccess;
  readonly reviewers?: ReviewerIdentityPort;
  readonly memberships?: SellerMembershipsPort;
  readonly onboarding?: StoreOnboardingPort;
  readonly provisioningApplications?: ProvisioningApplicationPort;
  readonly conflicts?: ConflictQueuePort;
  readonly events?: ProvisioningEventsPort;
  readonly inbox?: InboxRunner;
  /** A complete BrandVerificationPort (report + documents + read url). Wins over verificationStore. */
  readonly verification?: BrandVerificationPort;
  readonly verificationStore?: Pick<BrandVerificationStore, "latestReport">;
  readonly notifier?: BrandNotifierPort;
  readonly autoChecks?: AutoChecksPort;
}

export interface BrandWiringOptions {
  readonly stores: StoreRepository;
  readonly audit: AdminAuditPort;
  readonly clock: { nowMs(): number };
  readonly send?: Pick<SendNotification, "execute">;
  readonly real?: BrandWiringReal;
}

export interface BrandWiring {
  readonly review: BrandReview;
  readonly consumer: BrandApplicationEventConsumer;
  readonly retry: RetryFailedProvisioning;
  readonly applications: BrandApplicationsAdminPort;
  readonly verification: BrandVerificationPort;
  readonly reviewers: ReviewerIdentityPort;
  /** Names of the ports that are still in-memory fallbacks (reported, never silent). */
  readonly fallbacks: readonly string[];
}

export function composeBrandOnboarding(o: BrandWiringOptions): BrandWiring {
  const given = o.real ?? {};
  const fallbacks: string[] = [];
  // A real sellers port derives review, document and provisioning adapters in one go.
  const sellersAdapter =
    given.sellers === undefined ? undefined : new SellersReviewAdapter(given.sellers, given.overlay ?? new InMemoryBrandReviewOverlay());
  if (given.sellers !== undefined && given.overlay === undefined) fallbacks.push("sellers.overlay(cosign+parking)");
  const real: BrandWiringReal = {
    ...given,
    ...(sellersAdapter !== undefined && given.applications === undefined ? { applications: sellersAdapter } : {}),
    ...(sellersAdapter !== undefined && given.provisioningApplications === undefined ? { provisioningApplications: sellersAdapter } : {}),
    ...(given.sellers !== undefined && given.documents === undefined ? { documents: new SellersDocumentAccess(given.sellers) } : {}),
    ...(given.sellerAuth !== undefined && given.memberships === undefined ? { memberships: new AuthSellerMemberships(given.sellerAuth) } : {}),
  };
  const pick = <T>(name: string, given: T | undefined, make: () => T): T => {
    if (given !== undefined) return given;
    fallbacks.push(name);
    return make();
  };

  const applications = pick<BrandApplicationsAdminPort>("sellers.BrandApplicationsAdminPort", real.applications, () => new InMemoryBrandApplicationsAdmin());
  const reviewers = pick<ReviewerIdentityPort>("admin.ReviewerIdentityPort", real.reviewers, () => new InMemoryReviewerIdentity());
  const docFallback = new InMemoryBrandVerification();
  const docs = pick<DocumentAccess>("sellers.DocumentAccess", real.documents, () => docFallback);
  const verification: BrandVerificationPort =
    real.verification !== undefined
      ? real.verification
      : real.verificationStore !== undefined
      ? new VerificationStoreAdapter(real.verificationStore, docs)
      : pick<BrandVerificationPort>("brand-verification.latestReport", undefined, () => docFallback);

  const notifier = real.notifier ?? (o.send !== undefined ? new SendNotificationBrandNotifier(o.send) : pick<BrandNotifierPort>("notifications.send", undefined, () => new RecordingBrandNotifier()));
  const provApps = pick<ProvisioningApplicationPort>("sellers.ProvisioningApplicationPort", real.provisioningApplications, () => new InMemoryProvisioningApplications());
  const provision = new ProvisionStoreFromApproval({
    stores: o.stores,
    memberships: pick<SellerMembershipsPort>("seller-auth.SellerMembershipsPort", real.memberships, () => new InMemorySellerMemberships()),
    onboarding: pick<StoreOnboardingPort>("sellers.StoreOnboardingPort", real.onboarding, () => new InMemoryStoreOnboarding()),
    applications: provApps,
    events: pick<ProvisioningEventsPort>("outbox.ProvisioningEventsPort", real.events, () => new InMemoryProvisioningEvents()),
    conflicts: pick<ConflictQueuePort>("admin.ConflictQueuePort", real.conflicts, () => new InMemoryConflictQueue()),
  });
  const inbox = pick<InboxRunner>("inbox.InboxRunner", real.inbox, () => new InMemoryInboxRunner());

  return {
    review: new BrandReview(applications, verification, reviewers, o.audit, o.clock),
    consumer: new BrandApplicationEventConsumer(
      inbox,
      provision,
      provApps,
      notifier,
      real.autoChecks ?? (given.sellers !== undefined ? new SellersAutoChecks(given.sellers) : undefined),
    ),
    retry: new RetryFailedProvisioning(provision, provApps, notifier),
    applications,
    verification,
    reviewers,
    fallbacks,
  };
}

/**
 * `composed` option for BrandReviewModule: the REAL sellers admin port (SELLERS_ADMIN_PORT) and the
 * brand-verification store (BRAND_VERIFICATION_STORE) are injected from their Nest modules, which
 * must be the same dynamic module objects the application imports. Cosign/parking state uses
 * `overlay` (in-memory unless a persistent one is passed).
 */
export function brandReviewComposition(
  sellersModule: DynamicModule,
  verificationModule: DynamicModule,
  overlay: BrandReviewOverlay = new InMemoryBrandReviewOverlay(),
) {
  return {
    imports: [sellersModule, verificationModule],
    inject: [SELLERS_ADMIN_PORT, BRAND_VERIFICATION_STORE],
    useFactory: (...deps: unknown[]) => {
      const sellers = deps[0] as SellersAdminPort;
      const store = deps[1] as Pick<BrandVerificationStore, "latestReport">;
      return {
        applications: new SellersReviewAdapter(sellers, overlay),
        verification: new VerificationStoreAdapter(store, new SellersDocumentAccess(sellers)),
      };
    },
  };
}

// ---- Production composition -----------------------------------------------------------------------

/**
 * The outer outbox relay (`BrandEventsPublisher`) already dedupes each message through `inbox_processed`
 * in one transaction with the handler, so the consumer's own inbox step is a pass-through. Provisioning
 * is idempotent by application id regardless, so a re-delivery cannot create a second store.
 */
export class PassThroughInboxRunner implements InboxRunner {
  async runOnce<T>(_consumer: string, _messageId: string, fn: () => Promise<T>) {
    return { kind: "done" as const, value: await fn() };
  }
}

/** UUID-shaped, deterministic: publishing the same (type, key) twice can only ever address one outbox row. */
export function deterministicEventId(type: string, key: string): string {
  const h = createHash("sha256").update(`z-outlet.outbox.${type}:${key}`).digest();
  h[6] = ((h[6] ?? 0) & 0x0f) | 0x50;
  h[8] = ((h[8] ?? 0) & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/** `store.provisioned` into the transactional outbox, idempotent per store id. */
export class KyselyProvisioningEvents implements ProvisioningEventsPort {
  constructor(private readonly db: Kysely<Record<string, never>>) {}
  async publish(e: Parameters<ProvisioningEventsPort["publish"]>[0]): Promise<void> {
    const id = deterministicEventId(e.type, e.key);
    await this.db.transaction().execute(async (trx) => {
      await sql`select set_config('app.role', 'system', true)`.execute(trx);
      await sql`
        insert into outbox_events (id, aggregate_type, aggregate_id, event_type, ordering_key, payload)
        values (${id}::uuid, 'store', ${e.key}::uuid, ${e.type}, ${`store:${e.key}`}, ${JSON.stringify(e.payload)}::jsonb)
        on conflict (id) do nothing`.execute(trx);
    });
  }
}

/** Duplicate store name: the conflicting store id is kept on the overlay row the admin list reads. */
export class OverlayConflictQueue implements ConflictQueuePort {
  constructor(private readonly overlay: BrandReviewOverlay) {}
  enqueue(c: Parameters<ConflictQueuePort["enqueue"]>[0]): Promise<void> {
    return this.overlay.recordConflict(c.applicationId, c.conflictingStoreId);
  }
}

/**
 * The seller onboarding checklist is DERIVED from the application and the seller settings state (sellers
 * `getChecklist`), so there is nothing to seed. ETA registration is read from the application's declared
 * `eta_registration`. Both calls are intentional no-ops, kept so the provisioning use case stays unchanged.
 */
export class DerivedStoreOnboarding implements StoreOnboardingPort {
  async seedChecklist(): Promise<void> {}
  async setEtaRegistration(): Promise<void> {}
}

/** Admin retry: counts the attempt on the overlay, then re-runs the idempotent provisioning. */
export class OverlayRecordingRetry implements ProvisioningRetryPort {
  constructor(
    private readonly uc: Pick<RetryFailedProvisioning, "retry">,
    private readonly overlay: Pick<BrandReviewOverlay, "recordRetry">,
  ) {}
  async retry(applicationId: string): Promise<ProvisioningRetryOutcome> {
    await this.overlay.recordRetry(applicationId);
    const r = await this.uc.retry(applicationId);
    switch (r.kind) {
      case "provisioned":
        return { kind: "provisioned" };
      case "provisioning_failed":
        return { kind: "provisioning_failed", code: r.code };
      default:
        return { kind: "ignored" };
    }
  }
}

export interface BrandProductionOptions {
  readonly sellersModule: DynamicModule;
  readonly verificationModule: DynamicModule;
  readonly storesModule: DynamicModule;
  readonly authModule: DynamicModule;
  readonly notificationsModule: DynamicModule;
  readonly overlay: BrandReviewOverlay;
  /** Same pool the outbox relay drains, for `store.provisioned`. */
  readonly db: Kysely<Record<string, never>>;
}

/**
 * `composed` option for BrandReviewModule in production: every real port comes from its Nest module
 * (sellers, brand-verification, stores, seller auth, notifications) plus the persistent overlay. Returns
 * the review ports, the admin retry port and the consumer the worker's relay delivers
 * `brand_application.*` events to.
 */
export function brandReviewProduction(o: BrandProductionOptions) {
  return {
    imports: [o.sellersModule, o.verificationModule, o.storesModule, o.authModule, o.notificationsModule],
    inject: [SELLERS_ADMIN_PORT, BRAND_VERIFICATION_STORE, STORE_REPOSITORY, SELLER_MEMBERSHIPS, SEND_NOTIFICATION],
    useFactory: (...deps: unknown[]) => {
      const sellers = deps[0] as SellersAdminPort;
      const store = deps[1] as Pick<BrandVerificationStore, "latestReport">;
      const stores = deps[2] as StoreRepository;
      const memberships = deps[3] as Pick<SellerMembershipService, "grantStoreRole">;
      const send = deps[4] as Pick<SendNotification, "execute">;
      const adapter = new SellersReviewAdapter(sellers, o.overlay);
      const provision = new ProvisionStoreFromApproval({
        stores,
        memberships: new AuthSellerMemberships(memberships),
        onboarding: new DerivedStoreOnboarding(),
        applications: adapter,
        events: new KyselyProvisioningEvents(o.db),
        conflicts: new OverlayConflictQueue(o.overlay),
      });
      const notifier = new SendNotificationBrandNotifier(send);
      const consumer = new BrandApplicationEventConsumer(new PassThroughInboxRunner(), provision, adapter, notifier, new SellersAutoChecks(sellers));
      const retry = new RetryFailedProvisioning(provision, adapter, notifier);
      const recording = new OverlayRecordingRetry(retry, o.overlay);
      return {
        applications: adapter,
        verification: new VerificationStoreAdapter(store, new SellersDocumentAccess(sellers)),
        provisioning: recording satisfies ProvisioningRetryPort,
        events: consumer satisfies BrandEventConsumerPort,
      };
    },
  };
}
