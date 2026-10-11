# Threat model 08: drops and waiting room

Status: Draft for review · Date: 2026-10-11 · Spec refs: §16, §20.2, API6, §T9 · ADR-0024 (waiting-room vendor, Proposed, blocked on VR-16) · Code: none for drops. Related existing code: `kill.drops` flag; `inventory` drop pool, Fawry non-drop pool rule (`modules/inventory`), Fawry refuses drop SKUs (`payments/test/application.test.ts`).

## What exists
Inventory has a separate drop pool and refuses drop SKUs for Fawry, tested in `inventory/test/application.test.ts` ("refuses a drop SKU for Fawry and serves it from the drop pool otherwise"). No drop state machine, per-user limits, admission token, queue, bot scoring or edge waiting room is implemented.

## Threats and required controls
| ID | STRIDE | Threat | Required control | Proving test (to be written) | Status |
|---|---|---|---|---|---|
| DRP-S1 | S | Bots/scalpers hold stock via many accounts | App Attest, per-user and per-device SKU limits, bot scoring | k6 drop test with bot profile | not implemented |
| DRP-T1 | T | Queue jump with forged admission token | Signed 15 min JWT bound to device and drop | token forgery negative test | not implemented |
| DRP-T2 | T | Oversell at 50k VUs on 500 units | Row-per-unit reserve (implemented and unit-tested), Redis only a sold-out pre-filter | k6 + `tooling/db/inventory-concurrency.sh` at scale | reserve path implemented; drop acceptance test not run |
| DRP-D1 | D | Redis down | Waiting room fails closed (drops paused), normal checkout continues; `kill.drops` | chaos test | not implemented |
| DRP-I1 | I | Early price/stock leak before SCHEDULED | State gate on PDP | state-machine test | not implemented |
| DRP-R1 | R | Seller edits price after SCHEDULED | Drop machine forbids it | transition table test | not implemented |

## Residual risk
Do not offer drops (leave `kill.drops` off) until vendor, region and per-user limits exist. The truthful-social-proof rule (no fake "viewing now") has no code or lint in this scope (VERIFY copy-lint in CI).
