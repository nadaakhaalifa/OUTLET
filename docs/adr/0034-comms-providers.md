# ADR-0034: Communication providers (push, SMS and OTP, WhatsApp, email)

- Status: **Proposed** (owner picks vendors and signs contracts; code stays vendor pluggable)
- Date: 2026-10-11
- Deciders: CTO, Finance, Legal/DPO
- Spec refs: s1 (OTP, SMS pumping, failover SMS A, B, WhatsApp), s24, B1 (consent, residency), T5 (API6, API10), VR-COMMS-01..05

## Context
`UnconfiguredChannelProvider` and `UnconfiguredOtpSender` fail closed today. We need real adapters that can be selected by env once contracts exist, without hard-coding a vendor and without any live call before then.

## Options per channel
- **Push.** (1) Expo Push Service: no APNs/FCM credentials in our code, batching and receipts built in, one more hop and a third-party processor of device tokens. (2) Direct APNs and FCM: no middleman, but two protocols, key rotation and an Expo-token mismatch. Default: Expo, the app already uses Expo (ADR-0006).
- **SMS and OTP.** (1) Twilio-style REST (Messages, optional Verify): strong delivery tooling and status webhooks, Egyptian sender-id rules and price vary. (2) A regional aggregator (Vodafone, Etisalat, Infobip-class): cheaper local routes, API shapes differ. Default: a Twilio-compatible adapter used twice (A and B) so any compatible vendor fits, with an EG-only allow-list enforced before sending.
- **WhatsApp.** (1) Meta Cloud API direct: lowest cost, we run template approvals. (2) A BSP (Twilio, Infobip, 360dialog): managed onboarding and support, margin per message. Default: Cloud-API-shaped adapter, which most BSPs mirror.
- **Email.** (1) Postmark: transactional focus, simple templates and bounce webhooks, region is US/EU. (2) Amazon SES: cheapest, regional choice (eu-south-1, me-central-1), more setup. Default: Postmark-shaped adapter; SES follows through the same conformance suite.

## Decision (engineering default, reversible)
1. Adapters implement the notifications `ChannelProvider` port and the auth `OtpSender` port over an injected `fetch`. A channel gets a real adapter only when its whole env group is present; otherwise it stays Unconfigured and fails at call time with 503 `provider_not_configured`. A partial group is reported by name and stays Unconfigured.
2. Typed errors: ProviderNotConfigured 503, ProviderUnavailable 502 (timeout 10 s, network, 5xx, exhausted 429), RejectedByProvider (permanent), ProviderDrift (2xx body fails Zod). Drift is never retried because the message may have been sent.
3. Retries: only a 429 (not processed) or an idempotent call. No vendor idempotency guarantee is proven yet, so every send is a single attempt and the dispatcher retries with the per-message key.
4. OTP: destinations outside the allow-list (`SMS_ALLOWED_PREFIXES`, default `+20`) are refused before any request; a per-prefix budget hook can refuse more. Failover A then B then WhatsApp moves on after retryable or unconfigured outcomes and stops at a permanent refusal.
5. Webhooks verify HMAC or a shared secret in constant time over the raw body; unparsable bodies are drift. Hard bounces, complaints and unsubscribes become suppressions; `DeviceNotRegistered` deactivates the push token.
6. No P2 data in logs: recipient, token, body and credentials are never logged; log events carry vendor, operation, outcome, status and request id.
7. Every future adapter must pass `channelConformanceCases` (`apps/api/src/production/adapters/comms/conformance.ts`).

## Consequences
Owner must still choose vendors, sign contracts and settle residency for recipient data (ADR-0002, VR-COMMS rows). Fixtures are hand-authored and every endpoint or field is an assumption until sandbox traffic replaces them. Composition work remains: durable ticket store, token and suppression lookups, webhook controllers, receipt polling job (VR-COMMS-05).
