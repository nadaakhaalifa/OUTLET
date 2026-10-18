# AWS adapters

Code: `apps/api/src/production/adapters/aws` (barrel `production/adapters-index.ts`). ADR-0032.

## Env variables (all optional; absent means Unconfigured)
| Variable | Meaning |
|---|---|
| AWS_REGION | Required with any of S3 (unless S3_ENDPOINT), KMS, Secrets. No default. |
| S3_BUCKET | Enables `object.store`. |
| S3_ENDPOINT, S3_FORCE_PATH_STYLE | Any S3-compatible endpoint (path style defaults on with an endpoint). |
| S3_KMS_KEY_ID | SSE-KMS key id/ARN/alias. Required with S3_BUCKET unless S3_ALLOW_SSE_S3=true. |
| KMS_KEY_ID, KMS_HMAC_KEY_ID, KMS_KEY_VERSION | Enables `kms.envelope` (both keys required; version default 1, bump on alias repoint). |
| SECRETS_TOKEN_KEYS_ID | Enables `secrets.manager`: JSON `{activeKid, keys[]}` for the auth TokenKeySource. |
| SECRETS_ADMISSION_KEYS_ID | Waiting-room signing set `{activeKid, keys:[{kid,key(base64)}]}`. |
| SECRETS_ANALYTICS_KEYS_ID | Optional (needs SECRETS_TOKEN_KEYS_ID). Analytics pseudonym keys `{current:{kid,shopperKey,termKey},previous?}`, base64, 32+ bytes each; read once at boot (PrimedShopperKeyer). Unset or unreadable = ingest 503. Never printed. |
| SECRETS_CACHE_TTL_SECONDS | Default 300. |
| AWS_PROBE_TIMEOUT_MS | Readiness probe timeout, default 2000. |
Credentials: default AWS provider chain only (IAM role/OIDC). No key variables.

## What is wired
- `object.store`: privacy exports + erasure (ObjectStorePort), retention BlobDeletePort, catalog CatalogObjectStore, returns EvidencePort, reviews PhotoUploadPort.
- `kms.envelope`: auth FieldCipher (KmsFieldCipher), sizing EnvelopeFieldCipher, privacy FieldDecryptPort.
- `secrets.manager`: auth TokenKeySource, waiting-room SecretPort.
- Not yet on a real adapter: gift-cards/budget/subscriptions/ads/crawler `kms.envelope` ports (different shapes), fulfillment/promotions/aramex secrets, admin PII, upload issuing endpoints (use `S3ObjectStore.presignUpload`).
- /v1/ready `providers.<name>` is `configured`, `unreachable` (probe: HeadBucket / DescribeKey / GetSecretValue) or `unconfigured`.
- Rotation: add the new signing key, move `activeKid`; Secrets Manager `AWSPREVIOUS` keeps verifying.
