# ADR-0048: Admin identity endpoint and posture signals

- Status: **Proposed.** The endpoint shape and the "capabilities from gate predicates" rule are an engineering default and may be built; the posture signal sources (edge IP allow-list attestation, device trust model), the attestation-free admin web sign-in (decision 6) and attestation on analytics ingest (decision 8) are Security and Infra decisions tied to VR-AC-02, VR-AC-04 and VR-DASH-07. Amended 2026-10-16 after the chief-reviewer security and privacy review (H1, H2, M6, M7).
- Date: 2026-10-16
- Deciders: Security, Infra, Architect
- Spec refs: `docs/specs/dashboard-foundations.md` track 1 and section 0.1 (findings F2, F3, F5); master prompt 23 (Admin security), T5; VR-AC-01, VR-AC-02, VR-AC-04, VR-DASH-07; `apps/api/src/modules/admin/domain/access.ts`; `apps/admin-web/src/view-models/posture.ts`

## Context and problem statement
The Admin Console needs the caller's effective roles, assurance and posture. Without `GET /v1/admin/me` every sensitive write is disabled and the nav shows everything. Posture needs two facts the API does not have today: whether the request came through the IP allow-list (enforced at the edge) and whether the device is trusted.

The review and the code check found that the draft's device-trust rule cannot be implemented on the current schema and flow:
- admin-web sends `platform: "web"`, but the API accepts only `ios, android` (`auth/adapters/http-common.ts:9-16`) and the passkey assertion requires App Attest or Play Integrity (`auth/application/passkeys.ts:126-127`), so an admin cannot sign in against the real API at all; `devices.platform` and `auth_sessions.platform` CHECKs admit only mobile platforms.
- No session column records user verification separately from `amr`.
- A per-browser install id that the browser creates lives in the same cookie jar as the session, so it proves nothing the session cookie does not.
- `ctx.requestId` keeps a well-formed client `X-Request-Id` (`platform/request-context.ts:37-45`), so a MAC bound to it is bound to a client value.
- The payout approve route checks the finance role inside the handler (`payouts.controller.ts:197-200, 237`), so a capability test at predicate level cannot detect drift.

## Decision
1. `GET /v1/admin/me` returns effective and standing roles (`computeAccess`), assurance and `amr` from the token, live elevations, posture, a closed capability map and server time. No role or posture input is accepted from the client.
2. Each capability is computed by the same exported predicate the matching route gate calls (modules export the predicates through `index.ts`: `isFinanceActor`, `canReadTax`, `canReadReconciliation`, `canReadPrivacyConsole`, `canReadBrandReview`). **Equality is tested at the HTTP route**: for random actors, a capability is true iff the mirrored route on the booted app does not answer 403. The attention queue uses the same predicates.
3. `ip_allowlisted` is true only with a valid `X-Outlet-Edge-Posture` header: `v1.<kid>.<payload>.<mac>`, HMAC-SHA256 with a key selected by `kid` from Secrets Manager (two active kids for rotation), compared in constant time, timestamp within 60 s, bound to a request id **minted by the edge** (the edge overwrites `X-Request-Id`), single use (replay set, fail closed). The API listener is reachable only from the edge, and the edge strips any inbound posture header; production boot refuses posture keys without the infra pipeline's private-ingress attestation. Otherwise false, with a source code (`not_configured`, `invalid`).
4. **`device_trusted` is false for every session in Phase A** (`device_source: not_configured`) and becomes true only when a real posture source named under VR-AC-04 (MDM, posture vendor, or mTLS) attests the device. Console writes gated on device trust stay disabled until then.
5. **`session_binding`** reports honestly what Phase A can prove: `passkey_uv_browser_bound` when the session was opened by a WebAuthn assertion with user verification (persisted as `auth_sessions.uv`) and the request presents the **server-minted** install token (stored hashed on the device row, returned once at sign-in, kept by admin-web in `__Host-admin-install`, rotated at every login); otherwise `passkey_uv_unbound`, `not_passkey` or `revoked`. It is not device trust and enables no write by itself.
6. **Admin web sign-in without device attestation** (closes the technical part of VR-AC-02): `POST /v1/auth/passkey/assert` accepts `platform: "web"` only for users holding an unexpired standing admin grant; the WebAuthn origin check against the admin origin replaces App Attest; migration 0092 adds `web` to the platform CHECKs, `auth_sessions.uv` and `devices.install_secret_hash`. CR checkpoint before staging.
7. A development override exists and is refused at production boot.
8. **Analytics ingest requires App Attest or Play Integrity** before it is allowed for real users. The verifier still passes an empty challenge (`auth/application/common.ts:25-30`); a server-issued challenge is a Security prerequisite (VR-DASH-07).

## Options compared
- Signed edge header (chosen) vs trusting `X-Forwarded-For` against an allow-list in the app vs mTLS client certificates. `X-Forwarded-For` is spoofable unless every hop is controlled; mTLS is strong but needs device certificate management that does not exist; a signed header is cheap and fails closed when the edge is absent, provided the API is reachable only through the edge.
- Device trust: passkey session plus client install id (draft, rejected: same cookie jar, not implementable today) vs passkey UV plus server-minted, rotated install token reported as **binding, not trust** (chosen for Phase A) vs an MDM or posture vendor (the real answer, a provider contract under VR-AC-04).
- Capability equality: predicate-level property test (draft) vs HTTP-route-level test (chosen). Only the route-level test sees checks made inside handlers.

## Consequences
- Until an edge that signs the header is deployed and a posture source exists, Finance and super_admin sensitive writes stay disabled in the console (the API still enforces its own gates). That is the intended fail-closed state.
- Admins can sign in against the real API for the first time once migration 0092 and decision 6 ship.
- Four capabilities are added to version 1 (`privacy.read`, `recon.read`, `tax.read`, `brand_review.read`) so every attention item has a named predicate.

## Owner decision required
- Security and Infra: choose the edge (vendor, region), confirm the header scheme and the private-ingress topology, and name a device-posture source (VR-AC-04). Safe default: as above (`ip_allowlisted` false without the edge; `device_trusted` false).
- Security: accept the attestation-free admin web sign-in (decision 6, VR-AC-02). Safe default: built behind `release.admin_console.identity`, blocked until the CR checkpoint.
- Security: attestation with a server challenge before ingest is allowed (VR-DASH-07). Safe default: `kill.analytics.ingest` blocked.
