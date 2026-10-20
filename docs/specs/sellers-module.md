# Sellers module: brand applications (applicant side)

Status: implemented. Code: `apps/api/src/modules/sellers`, pure rules in `packages/domain/src/sellers`, migration `0051_sellers_applications.sql`. Contract: `docs/specs/brand-onboarding-contract.md` (Applicant section). Parent spec and ADR (`brand-onboarding.md`, ADR-0031) were not on disk when this module was written; this file records the decisions taken from the contract, `docs/api/openapi.yaml` and master prompt 19 / B5. Domain verification routes belong to `brand-verification`; admin decision routes belong to the admin module and call `BrandApplicationsAdminPort`.

## Flow
DRAFT -> (submit) SUBMITTED -> AUTO_CHECKS -> IN_REVIEW -> APPROVED | REJECTED | NEEDS_INFO. NEEDS_INFO -> (resubmit) SUBMITTED. REJECTED -> (appeal, once, within 30 days) IN_REVIEW. Withdraw from DRAFT to IN_REVIEW. APPROVED <-> SUSPENDED is driven by admin.

## State machine
`applicationMachine` in `packages/domain/src/sellers/machine.ts` is layered over `kycMachine`: IN_REVIEW maps to KYC AUTO_CHECKS, WITHDRAWN to DRAFT; WITHDRAW, APPEAL and FINISH_CHECKS are application-only edges (a test proves every other edge that changes KYC state is a valid `kycMachine` edge). APPROVE reuses the KYC guard (documents valid, sanctions clear, signatory 21+). RESUBMIT is guarded by "all requested items satisfied", APPEAL by "unused and inside 30 days". Errors are the shared typed `InvalidTransitionError` / `GuardRejectedError`.

## Requirements as data
`getRequirements(kind, country)` (pure). Egypt local: commercial register, tax card, signatory ID (21+), one of trademark certificate / brand authorization / proof of purchase. Global: company registration extract, signatory ID, one of trademark registration / distributor letter, website ownership verification required. Validators (VERIFY-marked patterns): Egypt commercial register `^[0-9]{3,12}(/[0-9]{1,4})?$`, tax card 9 digits (3-3-3 allowed), 14-digit national id with century, valid date and governorate code (age from it must be >= 21), E.164 phone, public registrable domain (no IP, localhost or internal TLD).

## Rules
- One active application per (applicant, normalised brand name); a REJECTED one blocks re-creation for 30 days (409 `reapply_cooldown`).
- Submit: complete checklist, full seller session with a recent strong factor (seller-auth `assertRecentStrongFactor`, 15 min, else the token's amr), domain verified by brand-verification when required. Enrol tokens are refused by the platform on every route without `@AllowSellerEnrol()`.
- Documents: pdf/jpg/png <= 10 MB, key `kyc/yyyy/mm/<uuid>` (no PII), signed PUT, magic-byte and size check on confirm, scan via `ScanPort` (infected objects are deleted), 20 uploads/hour/application (429), delete only while editable, original file name encrypted.
- Personal data: legal name, contact, signatory name and dob in one field-encrypted blob; national id encrypted with an HMAC blind index; registration numbers plain (B5 public identity) and masked to the last four on the applicant view; the national id is never returned.
- Decision SLA: 5 business days (Friday and Saturday off, holidays not modelled, VERIFY).
- Events in the same transaction as the state change: `brand_application.submitted|needs_info|approved|rejected|withdrawn|appealed` (ids and enums only). Funnel analytics go through `FunnelAnalyticsPort` (enums only; Null sink until a consent-aware sink is composed).

## Authorization
Audience `seller_api`; the subject is the owner; the repository is scoped by applicant id and RLS (`app.role = seller`, `app.user_id`), so another applicant's application or document is 404. Buyer token 401, no token 401, enrol token on submit/resubmit/withdraw/appeal/checklist 403.

## Integration
- brand-verification: sellers supplies `SellersApplicationOwnership` (ApplicationOwnershipPort) and reads domain state and runs checks through `LazyBrandVerificationLink` (module-ref lookup). `runAutoChecks` on the admin port does SUBMITTED -> AUTO_CHECKS -> `BrandVerificationPort.runAutoChecks(snapshot)` -> IN_REVIEW; the outbox consumer of `brand_application.submitted` calls it.
- Production: Postgres repository; KYC bucket and scanner are Unconfigured (503 `provider_not_configured`).

## BrandApplicationsAdminPort (public, `modules/sellers/index.ts`)
```ts
interface BrandApplicationsAdminPort {
  list(q: ReviewQueueQuery): Promise<Page<AdminApplicationSummary>>;
  get(id: string): Promise<AdminApplicationDetail | null>;
  claim(i: { id; adminId; expectedVersion }): Promise<AdminResult>;
  release(i: { id; adminId; expectedVersion }): Promise<AdminResult>;
  advanceChecks(i: { id; event: "START_CHECKS" | "FINISH_CHECKS"; expectedVersion }): Promise<AdminResult>;
  runAutoChecks(i: { id; expectedVersion }): Promise<AdminResult>;
  applyDecision(i: { id; adminId; expectedVersion; input: AdminDecisionInput }): Promise<AdminResult>;
  readDocumentUrl(i: { id; documentId; adminId; reasonCode }): Promise<{ kind: "ok"; url; expiresAtMs } | { kind: "not_found" } | { kind: "not_scanned_clean" }>;
  markProvisioned(i: { id; storeId; expectedVersion }): Promise<AdminResult>;
}
type AdminResult = ok{application} | not_found | version_conflict{currentVersion} | invalid_transition{from} | guard_rejected{guard}
  | conflict_of_interest | not_claimed_by_actor | already_claimed{assigneeId} | invalid_input{code};
```
Every mutation compares `expectedVersion` (optimistic CAS). Decisions need the reviewer to hold the claim and never the applicant; `approved` needs `sanctionsClear: true` and a complete, scanned, non-rejected document set. The admin module authorises the admin (passkey, ops/trust_safety, dual approval) before calling.

## Open items (VERIFY)
Trademark/company/tax register formats; business-day calendar; whether an appeal should be a KYC-visible event (currently application-only); funnel event names are not yet in `packages/analytics`.
