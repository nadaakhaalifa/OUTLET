import { Module, type DynamicModule } from "@nestjs/common";
import type { AppConfig } from "../../../config/env";
import { NoProductionAdaptersError } from "../../../platform/platform.module";
import type { Clock } from "../../../platform/ports";
import { CLOCK } from "../../../platform/tokens";
import { InMemoryAdminAudit, InMemoryAdminStore } from "../adapters/in-memory";
import { ADMIN_AUDIT, ADMIN_STORE } from "../adapters/tokens";
import type { AdminAuditPort, AdminStore } from "../domain/ports";
import { BrandReview } from "./application";
import { BrandReviewController } from "./brand-review.controller";
import type { BrandApplicationsAdminPort, BrandEventConsumerPort, BrandVerificationPort, ProvisioningRetryPort, ReviewerIdentityPort } from "./domain";
import { InMemoryBrandApplicationsAdmin, InMemoryBrandVerification, InMemoryReviewerIdentity } from "./in-memory";
import { BRAND_APPLICATIONS_ADMIN, BRAND_EVENT_CONSUMER, BRAND_PROVISIONING_RETRY, BRAND_REVIEW, BRAND_REVIEWER_IDENTITY, BRAND_VERIFICATION } from "./tokens";

export interface BrandReviewModuleOptions {
  /** Same instances the AdminModule uses, so live elevations and the audit chain are shared. */
  readonly adminStore?: AdminStore;
  readonly audit?: AdminAuditPort;
  readonly applications?: BrandApplicationsAdminPort;
  readonly verification?: BrandVerificationPort;
  readonly reviewers?: ReviewerIdentityPort;
  /** Admin retry of a parked provisioning. Absent: the retry route answers 503 provisioning_unavailable. */
  readonly provisioning?: ProvisioningRetryPort;
  /** Consumer of `brand_application.*` outbox events; the worker's relay resolves it by BRAND_EVENT_CONSUMER. */
  readonly events?: BrandEventConsumerPort;
  /**
   * Composition hook: modules whose exports the factory injects (sellers, brand-verification) and a
   * factory building the applications and verification ports from them. Used when the real ports
   * live in other Nest modules (composition/brand-wiring.ts), instead of passing instances.
   */
  readonly composed?: {
    readonly imports: readonly DynamicModule[];
    readonly inject: readonly symbol[];
    readonly useFactory: (...deps: unknown[]) => {
      readonly applications: BrandApplicationsAdminPort;
      readonly verification: BrandVerificationPort;
      readonly provisioning?: ProvisioningRetryPort;
      readonly events?: BrandEventConsumerPort;
    };
  };
}

@Module({})
export class BrandReviewModule {
  static forRoot(config: AppConfig, options: BrandReviewModuleOptions = {}): DynamicModule {
    const production = config.adapters !== "in-memory-dev";
    const composed = options.composed;
    if (
      production &&
      composed === undefined &&
      (options.adminStore === undefined ||
        options.audit === undefined ||
        options.applications === undefined ||
        options.verification === undefined ||
        options.reviewers === undefined)
    ) {
      throw new NoProductionAdaptersError();
    }
    const COMPOSED = Symbol("admin.brandReview.composed");
    return {
      module: BrandReviewModule,
      imports: [...(composed?.imports ?? [])],
      controllers: [BrandReviewController],
      providers: [
        ...(composed === undefined
          ? []
          : [{ provide: COMPOSED, inject: [...composed.inject], useFactory: composed.useFactory }]),
        { provide: ADMIN_STORE, useValue: options.adminStore ?? new InMemoryAdminStore() },
        { provide: ADMIN_AUDIT, useValue: options.audit ?? new InMemoryAdminAudit() },
        composed === undefined
          ? { provide: BRAND_APPLICATIONS_ADMIN, useValue: options.applications ?? new InMemoryBrandApplicationsAdmin() }
          : { provide: BRAND_APPLICATIONS_ADMIN, inject: [COMPOSED], useFactory: (c: { applications: BrandApplicationsAdminPort }) => c.applications },
        composed === undefined
          ? { provide: BRAND_VERIFICATION, useValue: options.verification ?? new InMemoryBrandVerification() }
          : { provide: BRAND_VERIFICATION, inject: [COMPOSED], useFactory: (c: { verification: BrandVerificationPort }) => c.verification },
        composed === undefined
          ? { provide: BRAND_PROVISIONING_RETRY, useValue: options.provisioning ?? null }
          : { provide: BRAND_PROVISIONING_RETRY, inject: [COMPOSED], useFactory: (c: { provisioning?: ProvisioningRetryPort }) => c.provisioning ?? null },
        composed === undefined
          ? { provide: BRAND_EVENT_CONSUMER, useValue: options.events ?? null }
          : { provide: BRAND_EVENT_CONSUMER, inject: [COMPOSED], useFactory: (c: { events?: BrandEventConsumerPort }) => c.events ?? null },
        { provide: BRAND_REVIEWER_IDENTITY, useValue: options.reviewers ?? new InMemoryReviewerIdentity() },
        {
          provide: BRAND_REVIEW,
          inject: [BRAND_APPLICATIONS_ADMIN, BRAND_VERIFICATION, BRAND_REVIEWER_IDENTITY, ADMIN_AUDIT, CLOCK, BRAND_PROVISIONING_RETRY],
          useFactory: (
            a: BrandApplicationsAdminPort,
            v: BrandVerificationPort,
            r: ReviewerIdentityPort,
            audit: AdminAuditPort,
            c: Clock,
            retry: ProvisioningRetryPort | null,
          ) => new BrandReview(a, v, r, audit, c, retry ?? undefined),
        },
      ],
      exports: [BRAND_REVIEW, BRAND_APPLICATIONS_ADMIN, BRAND_VERIFICATION, BRAND_REVIEWER_IDENTITY, BRAND_PROVISIONING_RETRY, BRAND_EVENT_CONSUMER],
    };
  }
}
