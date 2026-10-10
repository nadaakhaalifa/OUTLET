# Cryptographic inventory and key management plan

Status: Draft for review · Date: 2026-10-10 · Spec refs: §T5 (crypto, post-quantum), §B8, §A2.9, `docs/data-model/platform.md` (`crypto_key_registry`) · Owner: CTO · Review: yearly and on any new provider

## Purpose and state

This is the single list of every place Outlet NK uses cryptography, the algorithm chosen, where the key lives, who owns it, how it rotates and what proves it. It also holds the post-quantum migration plan that spec §T5 requires at ASVS Level 3.

**State on 2026-10-10.** Almost nothing is implemented. No KMS, no key registry table and no envelope-encryption code exist. What exists in the repository:

| Evidence | What it shows |
|---|---|
| `packages/db/migrations/0005_audit_log.sql` | SHA-256 hash chain over audit rows using PostgreSQL `sha256()`; checkpoint table with a `signature` column that nothing fills yet |
| `packages/db/migrations/0006_identity_consent.sql` | `subject_hash` and `refresh_hash` columns constrained to 32 bytes (HMAC or SHA-256 outputs), `subject_ciphertext bytea` for application-side envelope encryption, consent text `body_hash` |
| `docs/data-model/platform.md` | Design of `crypto_key_registry(key_ref, version, purpose, kms_arn, activated_at, retired_at)`; not yet a migration |
| `packages/analytics/src/pii.ts` | Detects token-like values in analytics properties; not a cryptographic control |

Status values: `planned`, `partial`, `implemented` with the same meaning as `asvs-5.0-matrix.md`. Nothing below is `implemented`.

## Principles

1. **No custom cryptography.** Only vetted platform and library primitives, behind one internal wrapper module so algorithms can change in one place (algorithm agility).
2. **No key in code, images or the mobile bundle.** Root keys live in a managed KMS or HSM; application keys are data keys wrapped by a KMS key.
3. **Purpose separation.** One key per purpose and environment; the same key is never used for encryption and for MAC or signing.
4. **Identifier for every ciphertext.** Each envelope carries `key_ref` and `version` so rotation never needs a flag day.
5. **Domain code stays pure.** Randomness, time and key access are injected; `packages/domain` imports no crypto I/O (enforced by `.dependency-cruiser.cjs` rule set, which blocks Node `crypto` in domain paths).
6. **Provider-specific facts are not assumed.** Webhook signature algorithms, KMS feature support and CDN post-quantum support are marked **VERIFY BEFORE LAUNCH** until read from the chosen provider's documentation.

## Inventory

| ID | Purpose | Algorithm and size (proposed default) | Key location and custodian | Rotation | Data class protected | Status |
|---|---|---|---|---|---|---|
| CR-01 | TLS between clients and edge | TLS 1.3 preferred, 1.2 minimum, AEAD suites only, ECDSA P-256 or RSA 2048+ certificate from a public CA, HSTS preload | Managed edge or load balancer; private key held by provider | Certificate lifetime per CA policy; automated renewal; alert 30 days before expiry | All | planned |
| CR-02 | Service to database and cache | TLS 1.2+ with server certificate validation | Managed database CA | Provider schedule | P1 to P3 | planned |
| CR-03 | Disk, backup and object storage encryption | AES-256 (provider managed, KMS key) | KMS | Annual KMS key rotation; provider data keys per object | All at rest | planned |
| CR-04 | Field-level envelope encryption of P3 (phone, DOB when allowed, addresses, measurements, national IDs, IBAN, budget) | AES-256-GCM, 96-bit random nonce, DEK per field class and tenant scope, wrapped by KMS key; AAD binds table, column and row ID | KMS key encryption key; DEKs cached in memory only, never logged | Yearly KEK rotation with re-wrap; DEK rotation by re-encrypt job when a DEK is retired or suspected exposed | P3 | planned (`subject_ciphertext bytea` in `0006_identity_consent.sql`) |
| CR-05 | Blind index for lookup (phone, email) | HMAC-SHA-256, 32-byte key, purpose `blind_index`, input normalised before hashing (E.164 phone) | KMS-wrapped key, separate from CR-04 | Yearly; dual-index period while backfilling (two columns or versioned `key_ref`) | P3 lookup values | partial (32-byte `subject_hash` column in `0006_identity_consent.sql`; no code computes it) |
| CR-06 | OTP storage and verification | HMAC-SHA-256 of code with per-challenge salt and server key; constant-time compare; CSPRNG code generation | KMS-wrapped key | Yearly; rotation tolerates the 5 minute TTL by accepting current and previous version | P1 | planned |
| CR-07 | Refresh token | 256-bit CSPRNG opaque token; stored as SHA-256 (or HMAC) hash; device bound | Hash only in database; token never stored | Per use (rotation on every refresh); family revoked on reuse | P1 | partial (`refresh_hash` 32-byte hash-only column and rotation uniqueness in `0006_identity_consent.sql`) |
| CR-08 | Access token signing (JWT) | ES256 (ECDSA P-256) proposed, algorithm pinned in verifier, `kid` header, 10 minute lifetime; HS256 and `none` forbidden | KMS asymmetric signing key, or a key in the secret manager if KMS signing latency is unacceptable (decision below) | Quarterly rolling: publish new `kid`, sign with new, keep old verify-only for 24 hours | P1 | planned |
| CR-09 | Passkeys (WebAuthn) | Authenticator public keys stored server side (COSE ES256 or RS256 as presented), signature counter | Public keys in database; private keys on user device | User-driven | P1 | planned |
| CR-10 | Apple and Google ID-token verification | Verify RS256 or ES256 signatures against cached JWKS | Provider public keys; cache with refresh on unknown `kid` | Provider-driven | P1 | planned |
| CR-11 | App Attest and Play Integrity | Device keys in secure hardware (ECDSA P-256 for App Attest); server verifies attestation chain and assertion counters; Play Integrity verdict decoded per Google guidance | Private keys never leave device; Apple and Google roots held in config | Roots: on provider announcement; per-install keys: on reinstall | Risk signal | planned. Provider-specific verification details **VERIFY BEFORE LAUNCH** |
| CR-12 | PSP webhook authentication | HMAC over raw body with provider-defined algorithm and a per-provider secret; timestamp window | Secret manager; per-environment | At provider's capability, at least yearly and on staff change | Payment events | planned. Algorithm and header names are provider specific, **VERIFY BEFORE LAUNCH** |
| CR-13 | Outbound webhooks and signed URLs | HMAC-SHA-256 with key ID; URL expiry 15 minutes or less | Secret manager | Yearly; overlapping verify window equal to URL lifetime | P1 to P2 | planned |
| CR-14 | Audit log hash chain | SHA-256 over `prev_hash || canonical(row)` | None (unkeyed, tamper evidence only) | n/a | P2 | partial (`packages/db/migrations/0005_audit_log.sql`, no test executes it) |
| CR-15 | Audit chain checkpoint and daily ledger snapshot signature | ECDSA P-256 or Ed25519 signature by KMS asymmetric key; verification key published to a separate account | KMS in a separate account from the application | Yearly; old verification keys retained for the retention period | P1 | planned (`signature` column in `0005_audit_log.sql`, never populated) |
| CR-16 | Pseudonymous analytics ID | HMAC-SHA-256 of user ID with a salt held in KMS, rotated yearly (spec §T6) | KMS; never in the warehouse | Yearly (breaks linkage by design) | P1 | planned |
| CR-17 | IP address and device-ID hashing in logs and consent | HMAC-SHA-256 with a server key (plain hashes of low-entropy inputs are brute-forceable) | KMS-wrapped key | Yearly | P2 | partial (`ip_hash` columns documented as HMAC in `0005_audit_log.sql` and `0006_identity_consent.sql`; no code) |
| CR-18 | Mobile token storage | Platform keystore (iOS Keychain `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, Android Keystore) via `expo-secure-store`; MMKV encryption key held in keystore | Device | On logout and reinstall | P1 | planned (`expo-secure-store` declared in `apps/mobile/package.json`, not imported) |
| CR-19 | OTA update signing (EAS Update) | Code-signing key pair as required by the Expo tooling; app embeds the certificate | Private key in CI secret manager with restricted access; public certificate in the app | On compromise or personnel change; document procedure before first release | Integrity of JS bundle | planned. Algorithm and size per Expo documentation, **VERIFY BEFORE LAUNCH** |
| CR-20 | Release signing (iOS distribution, Android upload and app signing keys) | Platform defined | Apple and Google programs, EAS credentials service | On compromise; Play upload key reset procedure | Integrity of binaries | planned |
| CR-21 | Container and artifact signing, provenance | Sigstore cosign (keyless OIDC identity or KMS key), SLSA provenance attestations | CI identity; transparency log | Keyless: per signature | Supply chain | planned |
| CR-22 | Certificate pinning material (if ADR-0007 chooses pinning) | SHA-256 SPKI hashes of two or more CA intermediates or keys, plus backup pins; signed remote pin configuration | Pin set in the app and in a signed remote config; signing key in KMS | Pin set reviewed at every CA or certificate change and at least twice a year; rehearsed rotation | Transport integrity | planned (ADR-0007 Proposed) |
| CR-23 | ETA e-receipt signing (if the delegated signing adapter is built) | Seller's ETA signing token or HSM; Outlet NK does not hold the seller's private key unless the delegation rules allow it | Seller HSM or token | Seller-driven | Tax documents | planned, **VERIFY BEFORE LAUNCH** (delegation rules) |
| CR-24 | Seller channel OAuth tokens | Stored by reference: encrypted with CR-04 class key, KMS ARN in `channel_connections.oauth_token_ref` | KMS | On reconnect; yearly re-wrap | P2 | planned |
| CR-25 | LLM and third-party provider API keys | Provider secrets | Secret manager, gateway scope only | 90 days or on staff change | Secrets | planned |

## Key hierarchy

```
KMS root (per environment, separate account for signing keys)
 |- KEK: pii-p3             -> wraps DEKs (CR-04), per field class
 |- KEK: blind-index        -> wraps CR-05 HMAC key
 |- KEK: hmac-misc          -> wraps CR-06, CR-13, CR-16, CR-17 keys
 |- SIGN: access-jwt        -> CR-08 (or secret manager, see decision)
 |- SIGN: audit-checkpoint  -> CR-15 (separate account, separate admins)
 |- SIGN: ota-pin-config    -> CR-19 / CR-22 signing
```

Each key is a row in `crypto_key_registry` (`key_ref`, `version`, `purpose`, `kms_arn`, `activated_at`, `retired_at`). Metadata is kept for as long as any ciphertext references it.

## Rotation procedure (envelope keys)

1. Create `version n+1`, set `activated_at`; new writes use it immediately.
2. Reads select the key from the envelope's `key_ref` and `version`, so old data stays readable.
3. A background re-wrap job (idempotent, throttled, resumable) re-wraps or re-encrypts old data; progress is a metric.
4. After zero rows reference `version n`, set `retired_at`; keep the key disabled but recoverable for the retention window; only then schedule deletion.
5. Record each step in the audit log with two-person approval for P3 and ledger keys.

Compromise response: disable the version, rotate immediately, re-encrypt affected classes first, notify the DPO to start the breach assessment (clock mechanics are a **VERIFY BEFORE LAUNCH** item in the privacy model), and revoke dependent tokens or sessions where relevant.

## Post-quantum migration plan (spec §T5, ASVS L3)

**Assumptions.** Symmetric primitives and hashes in this inventory (AES-256, SHA-256, HMAC-SHA-256) are not the main concern; the exposure is public-key cryptography (key exchange and signatures) based on RSA and elliptic curves, plus long-lived confidentiality of recorded traffic ("harvest now, decrypt later").

**Standards track.** NIST published ML-KEM (FIPS 203), ML-DSA (FIPS 204) and SLH-DSA (FIPS 205) in August 2024. Confirm current NIST and platform guidance at each yearly review rather than relying on this paragraph. **VERIFY BEFORE LAUNCH.**

| Area | Exposure | Plan | Trigger |
|---|---|---|---|
| TLS key exchange (CR-01, CR-02) | Recorded traffic decrypted later | Enable hybrid post-quantum key exchange at the edge when the chosen edge and mobile OS TLS stacks support it; no application change needed | Edge provider support; mobile OS support (**VERIFY**) |
| Signatures: JWT, checkpoints, OTA, release, cosign (CR-08, CR-15, CR-19, CR-21) | Forgery by a future quantum adversary; short-lived tokens are low risk, long-lived checkpoints and release signatures are higher | Algorithm agility via `kid` and a `alg` allow-list; keep signing behind the wrapper; for long-lived artifacts, plan dual signatures (classical plus post-quantum) once KMS and platform tooling support it | KMS and platform support for ML-DSA or SLH-DSA |
| Envelope encryption (CR-04) | AES-256 acceptable | No change; KEK wrapping may move to a post-quantum or hybrid KEM when KMS offers one | KMS support |
| Passkeys, App Attest, Play Integrity, Apple and Google JWKS | Controlled by third parties | Track provider roadmaps; Outlet NK cannot migrate these alone | Provider announcements |
| Data retained for years (P3 backups, audit log, ledger snapshots) | Longest confidentiality horizon | Prefer minimization and shorter retention; ensure backups are encrypted with CR-03 and CR-04 only (symmetric) | Retention review yearly |

**Concrete engineering steps, in order.**
1. Keep an up-to-date copy of this inventory and add a CI discovery scan that lists crypto imports and algorithm identifiers, failing on anything not in this table.
2. Route all signing and key agreement through one wrapper with algorithm identifiers in stored artifacts.
3. Require every new provider contract review to record its post-quantum roadmap.
4. Review the plan yearly with the key rotation review.

## Prohibited

MD5 and SHA-1 for security purposes, DES and 3DES, RC4, ECB mode, unauthenticated CBC, RSA below 2048 bits, HS256 with a key that is shared across services, JWT `none`, home-grown KDFs, fixed IVs or nonces, keys derived from user input, secrets in client bundles, and logging of keys, tokens or ciphertext keys.

## Decisions and open items

1. **Where access tokens are signed.** KMS signing adds a network hop per token; an in-process key from the secret manager is faster but weaker. Default proposal: KMS-held signing key, tokens issued only at login and refresh (low volume), verifiers cache the public key. Decide in the auth ADR.
2. **Key custody and break-glass** need an owner and a runbook (also an item in the admin threat model).
3. **KMS product and region** depend on ADR-0002 (residency); the `kms_arn` field name in the data model is provider specific and may change.
4. **Blind-index limits.** HMAC blind indexes allow equality lookup only and leak equality patterns; do not use them for low-entropy fields without rate limiting and key separation.
5. **Date of birth** is not stored today (only an 18+ attestation timestamp); a P3 column is added only when envelope encryption is accepted.
6. **Provider-specific algorithms** (PSP webhooks, ETA, courier) are placeholders until providers are chosen. **VERIFY BEFORE LAUNCH.**
