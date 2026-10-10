# ADR-0007: Certificate pinning for the mobile app: SPKI pinning with backup pins and a kill switch versus CT plus App Attest

- Status: **Proposed**
- Date: 2026-10-10
- Deciders: Tech Lead, Security reviewer (founder informed)
- Spec refs: §T5 (mobile security), §T2, §B8; OWASP MASVS v2 NETWORK group (see `docs/security/masvs.md`); threat model `docs/security/threat-models/mobile-app.md`; `docs/security/crypto-inventory.md`
- Related: ADR-0006 (mobile foundation: Expo SDK 57, EAS builds, no backend yet)

## Context and problem statement

The mobile app talks to the Outlet NK API over TLS. A network attacker who can present a certificate that the device trusts (a mis-issued public CA certificate, a user-installed or enterprise root, a malicious Wi-Fi captive proxy with an installed profile) can read or alter traffic unless the client constrains which keys it accepts. Traffic carries session tokens, addresses, order data and, later, payment redirects.

The decision is whether the app should pin the server's public key (SPKI pinning) or rely on the platform default trust store plus Certificate Transparency (CT) enforcement and App Attest or Play Integrity at the application layer.

Constraints specific to this project:

- No backend, domain or certificate exists yet. There is nothing to pin today, and no TLS code in the repository exercises pinning.
- Expo managed workflow with EAS cloud builds (ADR-0006). Pinning needs native code, so it requires a config plugin or a development build; Expo Go cannot pin.
- A small team with no 24/7 operations. A pin mistake bricks every installed client until users update, and app store review adds delay for the fix.
- Egyptian users commonly run old devices and update slowly (market data not verified; treat as an assumption). Some networks use TLS-intercepting middleboxes (assumption, not verified here).
- Platform facts that influence the options and must be re-checked: iOS enforces CT for TLS connections by default through App Transport Security; Android supports Network Security Config pinning with expiry and, in recent versions, CT enforcement is opt-in per app. **VERIFY BEFORE LAUNCH** against current Apple and Android documentation.

## Decision drivers

1. Resistance to a mis-issued or maliciously trusted CA certificate.
2. Operational risk: probability and blast radius of self-inflicted outage.
3. Ability to recover from a key compromise or CA change without a store release.
4. Fit with Expo managed builds and small-team operations.
5. Consistency with MASVS v2 NETWORK requirements and the L2 target.
6. Interaction with third-party hosts (payment provider pages, analytics, image CDN) that we do not control.

## Considered options

### Option A: SPKI pinning with backup pins and a remote kill switch

Pin the SHA-256 of the SubjectPublicKeyInfo of our API's keys, not the leaf certificate. Ship at least two backup pins: a key held offline that is not yet deployed, and optionally the intermediate CA key for a fallback. Pin only first-party API hosts. A signed remote configuration (fetched over a channel that is itself not blocked by the pin, with a bundled safe default) can disable pinning or rotate the pin set.

- Good: defeats a mis-issued public CA certificate and a user-installed root against the API host.
- Good: with backup pins and rotation procedure, key rotation does not require a store release.
- Bad: highest operational risk. A lost key without a deployed backup pin makes the app unusable until a release lands.
- Bad: the kill switch is itself an attack surface. If it is fetched through the pinned channel it fails exactly when needed; if fetched through an unpinned channel an attacker may strip it, so its signature must be verified offline with a key shipped in the binary (a new key to manage, see the crypto inventory).
- Bad: needs a native library or config plugin; the maintained status of the Expo-compatible options must be checked. **VERIFY BEFORE LAUNCH.**
- Bad: breaks behind corporate or school TLS-inspection proxies, which produces support load.
- Neutral: pinning does not stop an attacker who controls the device (jailbreak, Frida); it is a network control only.

### Option B: Platform trust store plus CT enforcement plus App Attest or Play Integrity, no pinning

Rely on the platform trust store. Require CT (iOS default; Android through Network Security Config or equivalent if supported). Authenticate the client at the application layer with App Attest or Play Integrity and short-lived tokens, so that a person in the middle cannot mint requests the server will accept, and bind sensitive actions to step-up.

- Good: no self-inflicted outage class; certificate renewal and CA changes are routine.
- Good: CT makes a mis-issued public certificate publicly detectable and, where enforced, unusable without log inclusion; combined with CT log monitoring on our domains we gain detection.
- Good: App Attest does not defend the transport itself, but token replay and forged clients are rejected at the application layer.
- Bad: does not stop an attacker with a **user-installed or MDM root** (CT enforcement is generally skipped for user-added roots on both platforms; **VERIFY BEFORE LAUNCH**). Such an attacker can still read the victim's own traffic, which limits impact to that victim, but also enables live manipulation of that session.
- Bad: detection depends on someone watching CT logs; this requires a monitor we have to build or buy.
- Bad: App Attest and Play Integrity are availability-dependent third-party services with their own quotas and failure modes (see `docs/security/threat-models/auth.md`).

### Option C: Pin to the CA or intermediate only

Constrain trust to a named CA chain through Network Security Config or equivalent, without pinning our own keys.

- Good: lower outage risk than Option A; rotation of our leaf keys is free.
- Bad: only limits which CAs can attack us; any mis-issuance by that CA is still accepted, and intermediate rotation by the CA still bricks clients.
- Neutral: usable as the fallback tier within Option A.

### Option D: Mutual TLS with a device certificate

- Bad: certificate provisioning and revocation at consumer scale is a large build; does not add value beyond Option B plus App Attest for this threat model. Rejected for Phase 1.

## Decision outcome (proposed)

Adopt **Option B for Phase 1** (CT plus App Attest or Play Integrity, short-lived tokens, step-up on sensitive actions, CT log monitoring on owned domains), and **defer SPKI pinning (Option A) behind a feature flag with a defined activation gate**, rather than shipping hard pinning on day one.

Reasons:

- There is no backend or domain yet, so pins cannot be generated, and the team has no operational experience of the rotation procedure. A pin error is the single most damaging self-inflicted failure available, and the mitigation (kill switch and backup pins) introduces its own key management.
- The residual risk Option B leaves (user-installed or MDM root, i.e. an attacker who already controls the victim's device trust) is limited to that user's own session and is partly addressed by short-lived tokens, step-up for sensitive actions and server-side authorization. It is accepted for Phase 1 and recorded in the risk register.
- Pinning remains available. The client design must keep an HTTP client seam (one place where the TLS configuration lives) so pinning can be added without touching feature code.

### Activation gate for Option A (any one triggers a re-decision)

- Payments go live with card data or wallet funds flowing through the app, and the security reviewer judges the residual risk above acceptable.
- Evidence of TLS interception against our users, or a CT-log alert for a certificate we did not request.
- A regulator, acquirer or payment provider requires pinning. **VERIFY BEFORE LAUNCH** whether the Egyptian payment provider or CBE rules impose this.

### Preconditions if Option A is activated

1. Pin SPKI hashes (not leaf certificates), at least three: current key, offline backup key, and one pre-generated next key. Store the offline key in the KMS or an HSM-backed process documented in `crypto-inventory.md`.
2. Pin only first-party API hosts. Never pin third-party hosts (payment provider pages, analytics, CDN).
3. A signed remote pin-set configuration with a bundled fallback and a verification key shipped in the binary; the configuration fetch must work without the pinned channel.
4. A kill switch that falls back to Option B behaviour (not to "no TLS validation"), exercised in a staging drill before release.
5. Pin expiry (for example 12 months from build) so an abandoned client eventually fails open to the platform default rather than closed forever, if the platform mechanism supports it. **VERIFY BEFORE LAUNCH.**
6. Release process: no certificate or key rotation within the window in which a store review for the previous build is pending.
7. Telemetry (no personal data) for pin-validation failures by app version, so a bad rotation is visible within minutes.

## Consequences

- Positive: no pin-induced outage risk in Phase 1; the Expo managed workflow stays simple; consistent with the small team.
- Negative: a user-installed-root attacker is not stopped at the transport layer in Phase 1. MASVS NETWORK coverage for pinning is recorded as `planned` and a documented, risk-accepted gap, not a claim of compliance.
- Follow-up work: CT log monitoring for owned domains; client HTTP seam; a staging pin-rotation drill before any activation; revisit this ADR at the Phase 1 payments gate.

## Verification

None of this is implemented. The mobile app has no API client and no backend domain exists, so no test can prove either option today. Planned tests are tracked in `docs/security/masvs.md` (NETWORK rows) and `docs/security/threat-models/mobile-app.md`:

- Option B: an integration test that an attested request succeeds and a request with a replayed assertion counter is rejected; an ATS or Network Security Config check in CI that cleartext is disabled.
- Option A, only if activated: a test harness with a certificate signed by a trusted but unpinned root must fail; a rotation drill using the backup pin must succeed without a release.

## Open points for the owner

- Accept the deferral of pinning for Phase 1 and the user-installed-root residual risk?
- Who owns CT log monitoring and the pin-rotation runbook?
- Confirm with the payment provider and legal whether any contractual pinning requirement exists. **VERIFY BEFORE LAUNCH.**
