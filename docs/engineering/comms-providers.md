# Communication providers (engineering guide)

Code: `apps/api/src/production/adapters/comms/`. Decision record: ADR-0034 (Proposed). All endpoints and fields are assumptions from public docs (VERIFY BEFORE LAUNCH, VR-COMMS-01..05). No live calls are made by tests.

## Selection
`parseCommsConfig(process.env)` then `buildCommsWiring(config, deps)` returns a `ProviderRegistry` for `NOTIFICATION_PROVIDERS`, an `OtpSender` for the auth module, and the list of configured channels. A channel with an incomplete env group stays Unconfigured (503 at call time). It is not yet called from `production/compose.ts` (VR-COMMS-05).

## Env variables (all optional)
- Push: `EXPO_PUSH_ENABLED`, `EXPO_PUSH_ACCESS_TOKEN`.
- SMS provider A and B (Twilio-style; B is the failover): `SMS_{A|B}_ACCOUNT_SID`, `_AUTH_TOKEN`, exactly one of `_FROM` or `_MESSAGING_SERVICE_SID`, optional `_VERIFY_SERVICE_SID`, `_BASE_URL`, `_VERIFY_BASE_URL`. Shared: `SMS_STATUS_CALLBACK_URL`, `SMS_ALLOWED_PREFIXES` (default `+20`).
- WhatsApp: `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_APP_SECRET`, optional `WHATSAPP_OTP_TEMPLATE` (adds WhatsApp as the last OTP fallback).
- Email: `EMAIL_POSTMARK_SERVER_TOKEN`, `EMAIL_FROM`, `EMAIL_MESSAGE_STREAM` (default `outbound`), `EMAIL_WEBHOOK_SECRET`.

## Error mapping
2xx with a body that fails Zod: drift (`failed`/`provider_drift`, not retried). 4xx: permanent (`invalid_recipient`, `template_rejected` or `failed`). 5xx, timeout (10 s), network: `unavailable`. 429: retried with Retry-After (max 3 attempts).

## Adding a vendor
Implement `ChannelProvider` (and `OtpSender` for SMS/WhatsApp) using `call()` and `parseOrDrift()` from `core.ts`, then register tests with `channelConformanceCases(harness)` in your test file. Never log recipients, tokens or bodies.
