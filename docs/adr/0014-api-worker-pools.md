# ADR-0014: Which API paths still use outlet_worker jobs

Status: Proposed. Date: 2026-11-09. Relates to ADR-0011 (no RLS-bypassing client).

## Context
The API request path should run under the caller's own `outlet_app` context (user or store, market pinned, RLS applies). `outlet_worker` jobs exist for background work, but some request-path reads and writes still use them because no per-row policy can express the rule yet.

## Decision
1. Applicant draft creation moves to the applicant's own `outlet_app` context (migration 0029): the case is inserted under `kyc_cases_user_isolation` (INSERT re-granted on insert-time columns only) and the seller row through `create_seller_draft()` (SECURITY DEFINER, status forced to `draft`, market and user taken from the DB context), because `sellers` has no RLS (ADR-0010).
2. These request-path reads keep using worker jobs, for the reasons given:
   - Admin KYC queue and decisions (`apps/api/src/modules/admin/pg-readers.ts`, job `seller.kyc`): staff are not row owners of applicants' cases; the guard proves the staff principal and reason code first, the job pins the market.
   - Admin reconciliation runs and open items (same file, job `finance.reconcile`): finance data is cross-seller by nature and has no user or store key.
   - Applicant KYC state transitions, submit, and admin decisions (`SellerOnboardingService.move`, job `seller.kyc`): transitions touch `kyc_decisions` and `sellers.status`, which the applicant must never write.
   - Document pointer check (`media.platform`): platform-owned media has `store_id` NULL and is invisible to `outlet_app`.
3. Open item: KYC document upload still ingests media through a `system` principal with `media.platform_write` bound to the applicant (`onboarding.controller.ts`). Replacing it needs a media-module change (an applicant-owned document kind) and is not part of 0029.

## Consequences
Fewer worker-pool entries on shopper requests; remaining ones are enumerated above and guarded in code. Revisit when admin RLS contexts (ADR-0011 follow-up) exist.
