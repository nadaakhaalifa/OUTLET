import type { EvidencePort, KillSwitchPort, ProviderRefundPort, ProviderRefundResult, ReturnPolicyPort } from "@outlet/returns";
import { Problems } from "../../platform/problem.js";
import type { OrderCancellationPort } from "./services.js";

/** No cancellation saga exists (see OrderCancellationPort): fail closed, change nothing. */
export class UnconfiguredOrderCancellation implements OrderCancellationPort {
  cancel(): Promise<void> {
    return Promise.reject(Problems.unavailable("order-cancellation-unconfigured"));
  }
}

/** Shopper return photos are not a media kind yet: no evidence can be verified, so defect returns stay refused (422 evidence-invalid). */
export class UnconfiguredEvidence implements EvidencePort {
  allReady(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

/**
 * Category exclusions (hygiene, personalised; V7) are not modelled in the catalog yet: no sku is marked non-returnable, no size swap is
 * offered and nobody is a Plus member. The seller still inspects every return, so nothing is refunded without a human check.
 */
export class NoCategoryReturnPolicy implements ReturnPolicyPort {
  nonReturnable(): Promise<ReadonlySet<string>> {
    return Promise.resolve(new Set<string>());
  }
  sizeSwapAvailable(): Promise<boolean> {
    return Promise.resolve(false);
  }
  isPlusMember(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

/** The API process never moves refund money (worker job finance.refunds does): refuse and report. */
export class ApiProcessProvider implements ProviderRefundPort {
  canReverse(): boolean {
    return false;
  }
  refund(): Promise<ProviderRefundResult> {
    return Promise.resolve({ outcome: "rejected", code: "not_in_api_process" });
  }
}

export const refundsKilledInApi: KillSwitchPort = { isEngaged: () => Promise.resolve(true) };
