# Admin Console: brand application review (web)

Status: implemented in `apps/admin-web` (Phase 1). Contract: `docs/api/openapi.yaml` `adminListBrandApplications`, `adminGetBrandApplication`, `adminClaimBrandApplication`, `adminReleaseBrandApplication`, `adminDecideBrandApplication`, `adminCosignBrandApplication`, `adminCreateBrandDocumentReadUrl`, `adminRecordTrademarkLookup`, `adminResolveBrandClaimConflict`. Product spec: `docs/specs/brand-onboarding.md`.

## Flow
1. Home tile (counts) or nav "Brand applications" opens the queue `/brand-applications`. Filters (GET form, shareable URL): status, kind, country, assignee (any/me/unassigned), SLA breached. Keyset pagination via `page.next_cursor`; "First page" resets. `/brand-applications/mine` is the same queue with `assignee=me` forced.
2. Row shows brand, status, kind and country, decision-due countdown (SERVER clock from the HTTP `Date` header; device clock only if the header is missing), a consumed-window meter, risk band chip (`risk_score`: <30 low, 30-69 medium, >=70 high; presentation default), appeal and high-risk-country badges, assignee.
3. Detail `/brand-applications/{id}`: facts (masked server-side), requirements and documents, document viewer, auto-check report (worst result first), trademark evidence, duplicate claims with side-by-side comparison (`?compare={id}` loads the other application, which is an audited view, so it is opt-in), history timeline, internal notes, actions panel.
4. Actions (each opens a confirmation dialog with client validation and a submit lock; the server action revalidates with the same pure functions):
   - Claim / Release, Run trademark lookup (mode auto).
   - Approve: states what it does. Normal: creates the store, creates the owner account, notifies the applicant. When the application is GLOBAL from a high-risk country, or has a sanctions warn/fail: does not provision, waits for a second admin.
   - Reject: reason code (not `ok`), public message AR and EN (script-checked, <=1000), optional reapply days 0-365.
   - Needs info: reason code, multi-select of requested items (unaccepted documents, domain verification, clarification), message AR and EN (<=500, sent with each item).
   - Cosign: shows who requested (the assignee), internal note required.
   - Resolve claim conflict: outcome (keep_first, replace_with_this, both_valid, reject_all) and internal note; trust_safety only.
5. Keyboard: `j`/`k` move between rows, `Enter` opens, `g` my claimed, `q` queue, `c` claim, `l` release, `a` approve, `x` reject, `i` needs info, `?` help. Ignored while typing, with modifiers, or while a dialog is open. Shortcuts open the same dialogs; they never bypass a disabled action.

## Document viewer (P3 content)
- Viewing needs a reason code (`kyc_review`, `appeal_review`, `fraud_investigation`, `legal_request`) chosen in a dialog. The API audits before returning the URL.
- The request is a server action that RETURNS the result (no redirect, no flash code, no revalidation), so the signed URL lives only in React state. Never in a URL, storage, cache, log or the document title. Responses already carry `cache-control: no-store`.
- Rendered in `<img referrerpolicy="no-referrer">` or an `<iframe sandbox="">` (no scripts, no same-origin), with a tiled watermark overlay: reviewer id (first 8), application id (first 8), server time to the minute.
- Expiry countdown = `expires_at` minus (server time at receipt + monotonic time since receipt). At zero the document is removed from the DOM and a new reason is required. A URL that is already expired or longer than 15 minutes (+30 s skew) is refused.
- Only uploaded, clean-scanned documents are viewable; the API additionally restricts to the assignee.
- CSP: `img-src` and `frame-src` are widened to `ADMIN_DOCUMENT_ORIGIN` only (https, loopback http for local runs). Not configured: the viewer is disabled with an explanation. Never widened to a guess.

## RBAC and the API as authority
- Nav entry and tile: ops, trust_safety, super_admin. Conflict resolution: trust_safety, super_admin. Everything the role or state cannot do is disabled with the reason shown (not just hidden), but the API re-checks role, assignee, applicant link, JIT elevation and state on every call.
- 403, 404, 409 (`already_claimed`, `reviewer_is_applicant`, other conflicts = stale), 429, offline, unavailable and contract errors render as states. A 409 shows the current state after redirect (the page refetches), which is the optimistic-concurrency handling: the OpenAPI decision operation defines no `If-Match`, so the client sends none and relies on the server's state-machine check plus the idempotency key.
- Idempotency: every write carries a UUID `Idempotency-Key` minted when the page renders and posted as a hidden field. A double submit or retry replays the stored response. Document read URLs mint a fresh key per request.
- Privacy: no console logging anywhere in the feature; bodies, URLs and PII are never logged. Applicant data is masked by the API.

## Gaps and assumptions
- The list item has no `pending_cosign` or conflict flag, so the queue shows a "high-risk country" hint instead; the true "Pending cosign" and "Claim conflict" badges are on the detail page. Proposal: add `pending_cosign` and `duplicate_claim_count` to the list item.
- The admin payload has no requirement set, so the checklist lists uploaded files and requested items. A never-requested, never-uploaded required document is not shown as missing. Proposal: return the active requirement set version with the detail.
- The trademark evidence carries a tri-state `owner_matches_applicant`, not a score. The console shows an indicative token-overlap score (legal suffixes and Arabic variants normalised) labelled as such; the server verdict stays authoritative.
- Home tile counts come from three capped reads (limit 50) and show `50+`; an exact count needs an API count.
- Needs-info sends the same AR/EN message with every selected item. Per-item messages are a possible later refinement.
- PDFs in a fully sandboxed iframe do not render in some browsers (Chrome's PDF viewer). The viewer says so. Alternative if reviewers need PDFs: server-side rasterise pages to images behind the same audit.
- `Date` header based server time is one-second resolution and includes network latency; fine for day/hour SLA clocks and a 15 minute URL timer.
- Not verified in a browser (no servers started); see the test list below.

## Tests
`apps/admin-web/src/view-models/brand-review.test.ts`: filter parsing and query mapping (including URL round trip property), SLA countdown from server time, risk bands, queue ordering, action availability by status, role, assignee and cosign, decision form validation (reject, approve, needs-info, notes), checklist and document states, viewer clocks and URL sanity, CSP document origin, owner-name matching (property tests), conflict view model, keyboard shortcut resolution, 409 flash mapping, and that every client label key exists in the catalog. AR/EN parity is enforced by the typed catalog and `i18n.test.ts`.
