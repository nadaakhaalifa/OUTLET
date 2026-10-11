# Screens, wave 5b: stylist, budget, rewards, drops

Specs: phase2/03, 04, 06, 07; master spec §11, §12, §15.5, §16. Every screen has loading, empty, error and offline states, AR/RTL strings, 44pt targets (shared Button), accessible names on every action, and no animation (Reduce Motion is satisfied by having none). No counters or timers are invented.

## Stylist (`/stylist`)
- Inputs: occasion, vibe, modest, optional budget (whole EGP). Fixed "AI suggestions" banner (LLM09).
- 3-5 outfit cards (hard cap 5), each: items with store and size, items total, per-store delivery (server fees, 0 = free), budget fit (spare / exact / over), partial outfit with the server shortfall ("add X for shoes").
- Like, dislike, swap per item. Swap replaces the outfit in place.
- Add whole outfit goes through `OutfitBagPort.addOutfit` with an idempotency key. The server re-validates stock and price; rejected items are listed by reason (sold out, paused, price changed) and are never silently dropped.
- `source: rules` shows the "AI unavailable, rule-based suggestions" banner. Errors use offline vs failed states.

## Budget (`/budget`)
- Gate: `budget_insights` consent. Nothing is requested before consent; withdrawal calls `setConsent(false)` (server deletes within 24h).
- Monthly amount, payday (31 clamps to the last day in shorter months), cap mode off/soft/hard.
- Remaining now (clamped, with explicit "over by"), after payday, spent, installments (labelled estimate, provider vs own entry), optional "count my bag", wishlist affordability (now / after payday / not yet).
- Soft cap: a real 10 second hold started by the shopper. Hard cap: unlock request, server-timed 24h delay; readiness is judged on server time.
- "Not financial advice" note always visible. Budget data is not imported by promotions, ads or ranking modules.

## Rewards (`/rewards`)
- Coin balance, conversion to store credit, coins expiring (real expiry dates only), tier and net-spend progress.
- Games render only when the server `games` switch is on AND a published odds table sums to 100%. The odds table and "free, no purchase, coins or vouchers only" note are shown above the Play button; there is no play affordance without them. Cooldown shows the server's next-play time or "not available".

## Drops (`/drops?id=`)
- Countdown comes from the server timestamp (offset captured at fetch), never the device clock. A zero countdown does not flip the phase; only a server state change does.
- Waiting room: position and ETA are shown only when the server returns them; otherwise a neutral "checking your place" line. Polling honours the server `pollAfterMs` and never goes below 1 s.
- Admission token: held in memory only (`admissionStore`), never in URLs or UI; judged on server time; expired means rejoin at the back.
- Rejections: per-user limit, members only, sold out, not live, paused, under 18. Real stock is shown only when 5 or fewer.
