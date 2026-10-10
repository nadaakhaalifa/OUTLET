# Threat model: notifications and CRM

Status: Draft for review · Date: 2026-10-10 · Method: STRIDE per element · Spec refs: §24, §B1, §1 (OTP), §T5 · Modules: `notifications`, templates, preferences, provider adapters (push, WhatsApp, SMS, email)

No code exists. Providers are not chosen.

## Scope and assets
Templates (AR/EN, versioned), recipient contact data (P2/P3), push tokens, consent state per channel, `notification_log`, provider credentials, deep links embedded in messages.

## Threats and controls
| ID | STRIDE | Threat | Control | Proving test | Status |
|---|---|---|---|---|---|
| NOTIF-S1 | S | Phishing that imitates Outlet NK messages, or a spoofed sender | Fixed sender IDs, message templates that never ask for OTP, payment or password, links only to verified domains, universal links only | NOTIF-T01 template lint rejects URLs outside the allow-list and shortened links | planned |
| NOTIF-T1 | T | Template or recipient list tampering by an insider to send scams | Templates versioned with admin dual approval for marketing and any template containing links; audit log; per-send recipient source recorded | NOTIF-T02 template publish without second approver fails | planned |
| NOTIF-T2 | T | Deep link parameters tamper with navigation or state | Parameters validated by Zod and never trusted for auth; a link opens a screen, authorization still enforced on the API | NOTIF-T03 forged deep link parameters cannot expose another user's order | planned |
| NOTIF-R1 | R | Dispute that a user consented to marketing or was notified | Consent record version checked at send time and stored on the log row; provider message ID stored | NOTIF-T04 marketing send without current channel consent is blocked and logged | planned |
| NOTIF-I1 | I | PII in push payloads visible on lock screen or in provider logs | Push payloads carry minimal text, order details fetched after unlock; no P3 in any provider payload | NOTIF-T05 payload schema allow-list rejects P3 fields | planned |
| NOTIF-I2 | I | Provider breach exposes contact data | Data processing agreements, minimal data shared, provider-specific tokens rotated, residency per ADR-0002. VERIFY BEFORE LAUNCH per provider | NOTIF-T06 processor register lists every provider with data categories | planned |
| NOTIF-D1 | D | Notification storms, loops or cost blowups; SMS or WhatsApp pumping | Frequency caps (marketing at most 1 push per day and 3 per week), quiet hours 23:00-09:00 Africa/Cairo with transactional exempt, per-channel cost budget and circuit breaker, bag reminder once | NOTIF-T07 property test: no user exceeds caps over a simulated week; NOTIF-T08 quiet-hours boundary tests | planned |
| NOTIF-D2 | D | Provider outage blocks OTP or order messages | Provider failover, WhatsApp template rejection falls back to SMS for transactional only | NOTIF-T09 fake-provider failure triggers failover without duplicate sends | planned |
| NOTIF-E1 | E | Marketing messages sent as transactional to bypass consent | Template class (transactional versus marketing) is fixed per template and enforced by the sender; transactional list is a reviewed allow-list | NOTIF-T10 marketing-class template cannot be sent through transactional path | planned |
| NOTIF-E2 | E | Unsubscribe or preference abuse by a third party | Preference changes need authenticated session or signed single-purpose link scoped to one channel | NOTIF-T11 unsubscribe link cannot change other settings | planned |

## Residual risk
SMS is not a secure channel; OTP and transactional content must assume interception and carry no sensitive details.
