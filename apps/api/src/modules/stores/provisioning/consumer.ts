import { z } from "zod";
import type { ProvisionStoreFromApproval, ProvisionResult } from "./provision-store";
import {
  ApprovedPayload,
  type AutoChecksPort,
  type BrandNotifierPort,
  type BrandTemplateKey,
  type InboxRunner,
  type ProvisioningApplicationPort,
} from "./domain";

export const BRAND_CONSUMER_NAME = "brand-onboarding";

export interface BrandEvent {
  /** Outbox message id (UUID): the inbox dedupe key. */
  readonly messageId: string;
  readonly type: string;
  readonly payload: unknown;
}

export type BrandEventResult =
  | { readonly kind: "provisioned"; readonly result: ProvisionResult }
  | { readonly kind: "provisioning_failed"; readonly code: "store_name_conflict" | "provisioning_error" }
  | { readonly kind: "notified"; readonly template: BrandTemplateKey }
  | { readonly kind: "duplicate" }
  | { readonly kind: "ignored" }
  | { readonly kind: "invalid" };

const RefPayload = z.object({ application_id: z.uuid() }).passthrough();

const NOTIFY_TEMPLATE: Readonly<Record<string, BrandTemplateKey>> = {
  "brand_application.submitted": "brand_application_received",
  "brand_application.needs_info": "brand_application_needs_info",
  "brand_application.rejected": "brand_application_rejected",
  "brand_application.appeal_decided": "brand_application_appeal_result",
};

/**
 * Inbox consumer of the brand application events. Idempotent by message id; the store itself is
 * idempotent by application id (deterministic store id), so even a re-delivery under a NEW message
 * id cannot create a second store. A provisioning failure parks the application in
 * PROVISIONING_FAILED (retryable, visible to admins) and the message is still marked processed.
 */
export class BrandApplicationEventConsumer {
  constructor(
    private readonly inbox: InboxRunner,
    private readonly provision: ProvisionStoreFromApproval,
    private readonly applications: ProvisioningApplicationPort,
    private readonly notifier: BrandNotifierPort,
    private readonly autoChecks?: AutoChecksPort,
  ) {}

  async handle(e: BrandEvent): Promise<BrandEventResult> {
    if (!z.uuid().safeParse(e.messageId).success) return { kind: "invalid" };
    if (e.type !== "brand_application.approved" && NOTIFY_TEMPLATE[e.type] === undefined) return { kind: "ignored" };
    const r = await this.inbox.runOnce(BRAND_CONSUMER_NAME, e.messageId, () => this.dispatch(e));
    return r.kind === "duplicate" ? { kind: "duplicate" } : r.value;
  }

  /**
   * Identity facts come from the application (ProvisioningApplicationPort.payloadFor), never from the
   * event, so a forged or thin event cannot choose the owner or the legal identity. An event that
   * already carries the full facts is accepted only when the application cannot be read.
   */
  private async facts(e: BrandEvent): Promise<ApprovedPayload | null> {
    const ref = RefPayload.safeParse(e.payload);
    if (!ref.success) return null;
    const fromApp = await this.applications.payloadFor(ref.data.application_id);
    if (fromApp !== null) return fromApp;
    const full = ApprovedPayload.safeParse(e.payload);
    return full.success ? full.data : null;
  }

  private async dispatch(e: BrandEvent): Promise<BrandEventResult> {
    const facts = await this.facts(e);
    if (facts === null) return { kind: "invalid" };
    if (e.type === "brand_application.approved") return this.provisionAndNotify(facts);
    const template = NOTIFY_TEMPLATE[e.type];
    if (template === undefined) return { kind: "ignored" };
    // Submitted applications must reach IN_REVIEW: run the checks (throws => message not marked, retried).
    if (e.type === "brand_application.submitted" && this.autoChecks !== undefined) await this.autoChecks.run(facts.application_id);
    await this.notifySafely(facts.applicant_seller_user_id, template, facts.application_id, facts.brand_name);
    return { kind: "notified", template };
  }

  private async provisionAndNotify(p: ApprovedPayload): Promise<BrandEventResult> {
    let result: ProvisionResult;
    try {
      result = await this.provision.execute(p);
    } catch {
      // Park, never double-create: the next attempt reuses the same deterministic store id.
      await this.applications.markProvisioningFailed(p.application_id, "provisioning_error");
      return { kind: "provisioning_failed", code: "provisioning_error" };
    }
    if (result.kind === "conflict") return { kind: "provisioning_failed", code: "store_name_conflict" };
    // The applicant is told "approved" only after the store exists.
    await this.notifySafely(p.applicant_seller_user_id, "brand_application_approved", p.application_id, p.brand_name);
    return { kind: "provisioned", result };
  }

  private async notifySafely(userId: string, templateKey: BrandTemplateKey, applicationId: string, brandName: string): Promise<void> {
    try {
      await this.notifier.notify({
        userId,
        templateKey,
        ref: applicationId,
        brandName,
        deepLink: `/seller/applications/${applicationId}`,
      });
    } catch {
      // Notification failure must not undo or block provisioning; the in-app inbox is retried by the
      // notifications module and the applicant can always read the status.
    }
  }
}

/** Admin retry of parked applications (also run by a sweeper). Idempotent per application. */
export class RetryFailedProvisioning {
  constructor(
    private readonly provision: ProvisionStoreFromApproval,
    private readonly applications: ProvisioningApplicationPort,
    private readonly notifier: BrandNotifierPort,
  ) {}

  async retry(applicationId: string): Promise<BrandEventResult> {
    const payload = await this.applications.payloadFor(applicationId);
    if (payload === null) return { kind: "ignored" };
    let result: ProvisionResult;
    try {
      result = await this.provision.execute(payload);
    } catch {
      await this.applications.markProvisioningFailed(applicationId, "provisioning_error");
      return { kind: "provisioning_failed", code: "provisioning_error" };
    }
    if (result.kind === "conflict") return { kind: "provisioning_failed", code: "store_name_conflict" };
    try {
      await this.notifier.notify({
        userId: payload.applicant_seller_user_id,
        templateKey: "brand_application_approved",
        ref: applicationId,
        brandName: payload.brand_name,
        deepLink: `/seller/applications/${applicationId}`,
      });
    } catch {
      // see BrandApplicationEventConsumer.notifySafely
    }
    return { kind: "provisioned", result };
  }

  async sweep(limit = 20): Promise<readonly BrandEventResult[]> {
    const ids = await this.applications.listFailed(limit);
    const out: BrandEventResult[] = [];
    for (const id of ids) out.push(await this.retry(id));
    return out;
  }
}
