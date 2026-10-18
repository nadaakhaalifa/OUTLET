# ADR-0032: AWS-compatible adapters (S3, KMS, Secrets Manager) and region neutrality

Status: Proposed (region remains an owner decision under ADR-0002)

## Context
Production composition (ADR-0029) bound every external provider to a fail-closed Unconfigured adapter. Object storage, envelope encryption and secrets are needed before any real data (PDPL, ADR-0002).

## Decision
- Real adapters live in `apps/api/src/production/adapters/aws`. Each is selected only when its env config is present; otherwise the provider stays Unconfigured (503).
- Code is region-agnostic: `AWS_REGION` and `S3_ENDPOINT` come from env. Candidates remain me-central-1 (UAE), eu-south-1, or an Egypt-hosted S3-compatible provider (needs only S3_ENDPOINT; KMS and Secrets Manager would then need an equivalent). No default region exists. Choosing one is an owner/legal decision (VR rows 1-2); nothing here pre-empts it.
- KMS: data keys are generated in-process and wrapped with KMS Encrypt (encryption context = field AAD). The wrapped key stores the resolved key ARN plus `KMS_KEY_VERSION`, so alias repoints and rotation keep old data readable. Blind indexes use a separate HMAC_256 KMS key (GenerateMac). Alternative considered: GenerateDataKey per field. Rejected because the existing `KmsPort` takes a caller-made DEK and this avoids a KMS call on every encrypt-side key draw.
- Objects: private bucket, SSE-KMS, key scheme `{purpose}/{yyyy}/{mm}/{uuid}` (no PII), scan state as an object tag, never served unless `clean`. An upload id IS the object key; owner is object metadata. Presigned PUT signs content-type, exact content-length (<= 10 MB), SSE and tagging headers (a PUT URL cannot express a length range; POST policy would, and needs `@aws-sdk/s3-presigned-post`).
- Retries: only throttling, only idempotent operations, 3 attempts with jittered backoff. Client SDK retries are disabled so there is one policy.

## Consequences
- Existing `LocalKeyFieldCipher` ciphertexts are not readable by `KmsFieldCipher`; synthetic data is re-created, real data starts on KMS.
- Virus scanner and EXIF stripper are ports with no implementation yet: uploads stay `pending_scan` and unserved until one is configured.
