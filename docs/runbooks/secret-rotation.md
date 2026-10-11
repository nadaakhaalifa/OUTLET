# Runbook: secret and key rotation

Owner: Security engineering. Roles: security lead, platform on-call, DBA, finance lead for PSP keys, DPO informed if personal data may be exposed. Severity: scheduled rotation is routine (no incident); suspected or confirmed leak is Sev1 and also opens breach.md.

## Trigger
- Scheduled: yearly key rotation for field-encryption KEKs (spec T5); periodic rotation for webhook secrets and API tokens (cadence VERIFY with owner; none is automated).
- Unscheduled: secret in a repo or log, CI compromise, departing admin, vendor breach notice, secret-scanning alert.

## Honest status (2026-10-11)
- Environments, KMS keys, secrets module and GitHub OIDC are defined as IaC layout in ADR-0016 (`infra/terraform/modules/{kms,secrets,github-oidc}`); VERIFY that they have been applied anywhere.
- Crypto inventory: `docs/security/crypto-inventory.md` lists keys and owners. Use it as the authoritative list; this runbook does not duplicate it.
- No PSP, courier, ETA, SMS or LLM vendor credential exists yet because none is contracted; rows below are templates.
- There is no automated rotation job and no rotation drill has been run.

## Steps: compromised secret (emergency)
1. Declare Sev1. Record: which secret, since when, where exposed.
2. Revoke at the source first (PSP dashboard, GitHub token page, cloud IAM). Do not wait for replacement.
3. Issue the new secret into the secrets manager; never into the repo, chat or CI variables by hand without OIDC policy review.
4. Deploy consumers (rolling). Support dual-valid window where the vendor allows: accept old and new webhook HMAC secret for at most the vendor's retry window, then drop old. VERIFY per provider.
5. Search logs and audit for use of the old secret after revocation time. Unexpected use means breach.md.
6. Rewrite git history is not enough: treat anything pushed as public.

## Steps: scheduled rotation
| Secret class | Procedure | Note |
|---|---|---|
| Webhook HMAC secrets (PSP, courier, ETA callbacks) | Create second secret at vendor, deploy dual-accept, flip, retire old | VERIFY dual-secret support per vendor |
| DB credentials | Rotate in secrets manager, rolling restart, PgBouncer reload | Staging cannot reach prod data (ADR-0016) |
| KMS KEK for P3 field encryption | Create new key version, re-wrap DEKs; data is not re-encrypted wholesale | Test the restore path with restore-drill.md |
| Session/JWT signing keys | Publish new key id, keep old verify-only until max token age (access 10 min, refresh 30 d per spec section 1) | Refresh rotation limits blast radius |
| HMAC key for gift-card code hashes | Rotation changes hashes: needs key versioning in the stored hash. Not implemented; do NOT rotate without a design | VERIFY |
| CI/OIDC | Trust subject per environment (ADR-0016); no long-lived cloud keys to rotate | |

## Verification
- Old secret rejected by the vendor/endpoint; new in use (synthetic transaction in staging, then prod canary).
- Webhook success rate unchanged; no growth of `webhook-dlq` (webhook-dlq-replay.md).
- Secret scanning clean; crypto inventory updated with date and key version.

## Rollback
Re-enable the previous version only if it was not compromised and the vendor still accepts it. For a compromised secret there is no rollback: fix forward.

## Escalation
Security lead -> head of engineering -> owner; DPO if personal data accessible; counsel for contractual notice to vendors.

## Post-mortem checklist
- Exposure window, access evidence, data possibly affected.
- How the secret escaped; add scanner or policy rule.
- Time to revoke and to restore service.
- Update crypto-inventory.md, asvs-5.0-matrix.md rows, and the verify register if a vendor term was learned.
