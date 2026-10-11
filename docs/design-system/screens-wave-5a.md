# Screens, wave 5a: Plus, credit wallet, gift cards

Specs: `docs/specs/phase2/01-plus-subscriptions.md`, `02-gift-cards.md`, `docs/specs/store-credit.md`. ADR-0004 (Plan A), ADR-0021. Code: `apps/mobile/src/features/{plus,wallet,gift-cards}`, routes `/plus`, `/wallet`, `/gift-cards`. Pure model plus port with in-memory fake, same pattern as bag and checkout. All three screens run on dev fixtures until the API client lands.

## Plus (`/plus`)
- Paywall: plans, prices and trial length all come from the server `plans`. "Pay N, get M free" and the saving are computed from the two server prices and shown only when the yearly price is an exact whole number of monthly prices below twelve.
- Auto-renew disclosure (price, period, first charge date, reminder, cancel path) sits in the same card as the Join button.
- Age gate (server `minAge`, `ageEligible`) and kill switch `plus_sales` disable purchase with a plain message. No dark patterns: cancel is one tap on the first manage view (2 taps from Me), pause is offered next to it, copy is linted for confirm-shaming.
- Savings meter reads the server `plus_savings_ledger` totals; empty state says so honestly.
- Plan A: benefit list is commerce-only and states that the stylist stays free.
- States: loading, empty (no plans), error, offline, ready. Chips are 44pt, radio group roles, progress and amounts have accessible names.

## Wallet (`/wallet`)
- "{{product}} credit" with sub-balances (refund, gift card, coins, referral, goodwill), earliest expiry per sub-balance, server-selected "expiring soon", and a cursor-paged transaction list.
- Read only: the port has `load` and `transactions` and nothing else. No top-up, withdraw or transfer control exists. Copy never says cash or money (test).

## Gift cards (`/gift-cards`)
- Purchase: design, 100 to 10,000 EGP whole pounds, message, channel, optional Cairo-date schedule, expiry shown from the server term. Over 5,000 EGP needs a 21+ purchaser (also enforced by the server).
- Redeem: Crockford normalisation, local format check (malformed codes never use a server attempt), one "did not work" answer for wrong and unknown codes with the server remaining-attempts count, a locked state on 429 that disables the form.
- Group gift pots: create, progress, contribute (min 50 EGP). Voiding a card before delivery.
- Capabilities `gift_card_sales` and `gift_card_redemption`: each section hides on its own switch; when both are off the screen renders nothing (and shows no title while loading).

## Gaps for the integrator
- Me tab entries (Plus, Credit, Gift cards) and the checkout "Plus would save you X" nudge are not wired (Me and checkout belong to other owners). `giftVisibility` is exported for the Me row.
- PSP hosted payment step for subscribe and gift card purchase, App Attest header, API client adapters and the help link on the age gate are not built. Nothing was run on a simulator.
