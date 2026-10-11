# Admin Console web app (spec section 23, Admin security, T5)

Status: implemented in `apps/admin-web` (Next.js 16 App Router, React 19). No tables of its own. It is a client of the Admin API; **the API is the authority on every decision**. Everything the UI hides or disables is a convenience, never a control.

## Flow
1. `/login`: passkey only. `beginPasskeyAction` fetches a challenge, the browser runs WebAuthn (`userVerification: required`), `finishPasskeyAction` exchanges the assertion. Tokens live in an httpOnly, Secure, SameSite=Strict `__Host-` cookie. No token touches JS, localStorage or sessionStorage.
2. Every request passes `src/proxy.ts` (Next 16 name for middleware): fresh CSP nonce, security headers, and session rotation before render.
3. The console layout reads `GET /v1/admin/me` (proposed, see Gaps) for effective roles and posture, builds role-filtered navigation and a posture banner.
4. Screens read through the typed client (Zod at the boundary) and render pure view-models. Mutations are server actions that re-validate with Zod, call the API with an `Idempotency-Key`, and redirect with a flash code.

## Screens
| Route | Content | API |
|---|---|---|
| `/sellers` | KYC queue first, then suspended; suspend and reinstate each need a reason code; opens a 5-business-day human review | `GET /v1/admin/kyc/queue`, `POST .../suspend`, `.../reinstate` |
| `/suspensions` | Reviews, overdue first, server-clock countdown, progress meter; uphold or reinstate | `GET /v1/admin/kyc/suspension-reviews`, `POST .../{id}/uphold` |
| `/price-integrity` | Auto-action log and the list awaiting human review | `GET /v1/admin/price-integrity/actions` |
| `/approvals` | Dual-approval inbox. Requester cannot approve (computed with the domain `decideApproval`), each row shows the `approvalCovers` binding (kind, subject, up-to amount, expiry) | `GET /v1/admin/approvals`, `POST .../approve`, `.../reject` |
| `/elevation` | JIT elevation and break-glass; reason code mandatory; form pre-checked with domain `newElevation`/`newBreakGlass` | `GET /v1/admin/elevations/mine`, `POST /v1/admin/elevations`, `.../activate`, `.../revoke` |
| `/flags` | The 14 kill switches (+ release flags). `enabled=true` means the capability is running; default is stopped. Reason-coded, audited | `GET /v1/admin/flags`, `PUT /v1/admin/flags/{key}` |
| `/privacy` | DSAR queue overdue first; breach register with PDPC 72 h and subject 3-day clocks and the next legal step | `GET /v1/admin/privacy/requests`, `/breaches`, `POST .../triage`, `pdpc-notified`, `subjects-notified`, `close` |
| `/tax` | Submission queue (dead letters first, requeue), daily reconciliation for the previous Cairo day | `GET /v1/admin/tax/documents`, `/reconciliation`, `POST .../requeue` |
| `/finance` | Trial balance per currency from `raw` postings (labelled partial if the page is truncated), reconciliation tickets (aging > 3 days escalates), payout approvals | `GET /v1/admin/ledger/balances`, `/v1/admin/reconciliation/breaks`, approvals |
| `/returns` | Refund approvals; honest note that the dispute list has no read endpoint | approvals |
| `/promotions` | Read-only list; flags funding that does not total 100% | `GET /v1/admin/promotions` |
| `/moderation` | Held UGC, oldest first, publish or reject | `GET /v1/admin/moderation/queue`, `POST .../decision` |
| `/pii` | Reason-coded lookup dialog; values vanish after 60 s or on demand | `POST /v1/admin/pii-views` |

## Rules
- Passkey mandatory: the `SessionPort` has no TOTP, OTP or password method; a token that wants a second factor is refused and never stored.
- Posture: sensitive controls (approve, reject, elevation, flags, requeue) are disabled unless `posture.device_trusted` and, for finance or super_admin, `posture.ip_allowlisted`, and assurance is passkey. Unknown posture disables them (fail closed). The server still enforces its own allow-list.
- RBAC navigation: links are filtered by effective roles from `/v1/admin/me`. If roles are unavailable all links show and a notice says the server decides. A direct URL gets the API's 403/404, rendered as an error state.
- Reason codes are an enumerated select (`ADMIN_REASON_CODES`); there is no free-text path. The break-glass code is offered only on the elevation form.
- Deadlines and clocks use the server `Date` header, never the device clock (device clock only when the header is missing).
- Money is `bigint` piastres end to end; wire strings parse with a strict integer regex; display formatting splits whole and fraction.
- No fake data: a missing endpoint is an explicit note or error state, never sample rows.

## Edge cases
Unreported kill switches are listed as "not reported" (never silently dropped). A trial balance that returns a full page is shown as partial. Expired approvals are shown as EXPIRED before the server persists it (expiry is exclusive). An ACTIVE elevation past its end is shown as lapsed. Arabic RTL default with logical CSS properties; EN mirrors.

## Failure handling
Network failure: offline state. 401: one refresh then sign-in. Unexpected response shape: contract error, nothing rendered. 503 from audit-before-action: "action was not performed". Refresh rejected in the proxy: cookie cleared, never retried (a replayed rotating token revokes the family).

## Security and abuse
STRIDE: spoofing (passkey, `__Host-` cookie), tampering (CSRF by SameSite=Strict plus Next server-action origin checks, Zod on every action input), repudiation (reason codes, server audit), disclosure (CSP with nonce and strict-dynamic, no inline script, `frame-ancestors 'none'`, `Cache-Control: no-store`, PII values time-boxed in memory), DoS (API rate limits surfaced as 429 state), elevation of privilege (API authority, dual approval, break-glass). ASVS: V3.4 CSP and headers, V7 session, V8 data protection, V4 access control (API). Untrusted text (review content, store names) is rendered as React text only.

## Metrics
Approval time to decision, suspension reviews decided inside 5 business days, DSAR overdue count, breach clock misses, DLQ depth, kill-switch changes per week. Emitted by the API audit stream, not by this app (no analytics SDK is loaded).

## Acceptance
Covered in `apps/admin-web/src/**/*.test.ts`: requester cannot approve (property over all kinds and roles), covers binding shown, expiry boundary, reason code required for elevation and PII, break-glass needs standing super_admin and 30 min cap, overdue-first ordering for suspensions and DSAR, breach clock ordering, kill switch list pinned to `packages/feature-flags`, trial balance property, nav hides by role, posture fails closed, CSP has nonce and no unsafe-inline, fetch only in `api/transport.ts`, client sends idempotency keys and validates shapes.

## Gaps (also in the final report)
1. `GET /v1/admin/me` (effective roles, standing roles, assurance, posture) does not exist. The client schema is proposed. Without it the console shows all links and disables sensitive writes (posture unknown).
2. Passkey endpoints are not admin-audience and DeviceInfo.platform has no `web`; sign-in will be rejected until the contract adds both.
3. No endpoints (read) for: price-integrity actions and reconciliation breaks have OpenAPI drafts but no controller; returns and disputes list; admin promotion writes (PATCH needs `If-Match`, so the screen is read-only); payout approval screen reuses the approvals inbox.
4. The suspension review wire has no `suspended_by`, so "you cannot review your own suspension" is enforced by the API (403) and not pre-checked.
5. No browser E2E (Playwright) was run: nothing in the sandbox can drive a WebAuthn authenticator or reach an API.
