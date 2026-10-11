# Threat model 06: notifications, referrals, rewards, wishlists

Status: Draft for review · Date: 2026-10-11 · Spec refs: §8, §15.4, §15.5, §24, API6 · Code: `apps/api/src/modules/{notifications,referrals,wishlists}`. There is no rewards/coins/games module in the repository: rewards rows are not implemented. Older detail: `notifications.md`.

## Trust boundaries
App to preference and device-token APIs; API to push/WhatsApp/SMS providers (fakes); referral code holders (untrusted) to attribution; anonymous holder of a wishlist share token.

## Threats
| ID | STRIDE | Threat | Existing control | Proving test | Status |
|---|---|---|---|---|---|
| NOT-I1 | I | Marketing sent without consent / in quiet hours / over cap | Consent, quiet hours 23:00-09:00 Cairo, frequency caps; transactional exempt | `notifications/send-notification.test.ts`: "never sends marketing push without consent; the inbox still gets it", "is exempt from quiet hours, consent and caps"; `domain.test.ts` | implemented+tested |
| NOT-T1 | T | Duplicate sends from retries | Request idempotency, concurrent collapse | send-notification.test.ts: "returns the earlier request and sends once", "collapses concurrent identical requests" | implemented+tested |
| NOT-T2 | T | Unsafe link or template injection | Template and payload validation, link allow-list | send-notification.test.ts: "rejects unknown templates, bad payloads, bad refs, unsafe links and unknown recipients" | implemented+tested |
| NOT-I2 | I | Security messages (OTP) stored in inbox | Single channel, never inbox | "sends security messages to one channel, never to the inbox" | implemented+tested |
| NOT-E1 | E | Reads or edits another user's inbox/preferences/device token | Caller scoping | `notifications.http.test.ts` (VERIFY titles) | implemented, partly verified |
| NOT-D1 | D | Provider down | Fallback channels | "falls back to the phone channels when the user has no push token" | partial: no real provider adapters or WhatsApp template flow |
| REF-S1 | S | Self-referral / same device farm | Silent rejection, logged, never rewarded | `referrals/test/referrals.test.ts`: "self referral is accepted silently, recorded as rejected, never rewarded, and logged", "same device is silent and rejected"; `adversarial.wave3-referrals.test.ts` | implemented+tested. Payment-fingerprint and graph cluster detection not implemented |
| REF-T1 | T | Reward paid before return window / twice | Reward intent only after close, once | referrals.test.ts: "rewards the referrer with an intent only after close, once (idempotent)" | implemented+tested. Payout of the intent is gated by `kill.referral_payouts`; ledger posting of reward not verified |
| REF-D1 | D | Code enumeration | Attribution requires attestation when configured; unknown code is uniform 404-class | referrals.test.ts: "requires attestation when configured", "unknown code is a 404-class result" | implemented+tested; per-IP rate limit proof not found (VERIFY) |
| WL-I1 | I | Share-token enumeration / PII in shared list | 128-bit hashed token, revocable, nickname only | `wishlists` tests (VERIFY titles); `GET /shared/wishlists/:token` | implemented, partly verified |
| RWD-T1 | T | Coins/games abuse | Not built | none | not implemented (Phase 2) |

## Residual risk
Rate limits are in a guard (`platform/rate-limit.guard.ts`); whether production limits are backed by Redis (not just per-process) is unverified. Referral reward fraud graph absent; first-order COD referral timing relies on return-window close event.
