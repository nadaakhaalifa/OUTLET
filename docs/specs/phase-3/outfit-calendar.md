# Spec P3-02: Outfit calendar

Refs: §28 row 3, §11, §12, §8. Depends on: stylist (outfits, capsule), wishlists (occasions, dates), budget (`AffordabilityFilterPort`, opt-in), notifications (quiet hours, frequency caps), history/personalization, size profile. No legal gate of its own; calendar import is the only privacy-sensitive part (VR-P3-13 does not apply, but DPO review is required for calendar permissions, noted below).
Status: buildable now on synthetic data; entirely rules and existing stylist; LLM optional and off by default.

## Flow
Me or Stylist tab -> "My calendar" -> add an event (type: work, wedding guest, date, Eid, university, travel, custom; date and time; dress-code note; modesty and weather band) manually, or from wishlist occasions (birthday, Eid list dates), or (opt-in) from the device calendar via an on-device read that sends only title-free `{date, type}` choices the shopper confirms. Each event shows "Outfit status": none, planned, owned items only, needs purchases. Tap -> stylist generates 3 outfits for the event using owned (wardrobe, Phase 3) and purchasable items; "gap fill" lists only the missing slots with total cost and budget fit. Reminders 7 days (order lead time) and 1 day before.

## Rules
- Events belong to one user. Max 100 future events. Dates are stored as UTC instant plus Cairo-local date; display in the shopper's locale, Hijri optional.
- Gap fill uses the existing stylist pipeline with `slots_required`; budget filter only if `budget_insights` consent exists, never sending exact budget to any LLM (band only, ADR-0025).
- Delivery feasibility: items must arrive >= 2 days before the event using courier p80 ETA (§21); otherwise flag "may not arrive in time" and show the cutoff date. Never claim guaranteed delivery.
- Reminders obey quiet hours 23:00-09:00 Africa/Cairo, marketing consent for promotional phrasing, and frequency caps; a calendar reminder is a **service message** only when the shopper created the event and enabled reminders for it.
- Events from imported calendars store no titles, attendees or locations.
- Weather band is user-chosen or coarse (season), no location tracking required.

## Edge cases
Event in the past -> archived; two events same day; event date changed -> reminders re-planned, bag items kept; outfit item sold out -> swap suggestion; DST (Egypt observes DST in some years: store UTC, resolve via tz database, test across transitions); user clears history -> events kept unless "clear calendar" chosen; Ramadan/Eid dates are moon-dependent: shown as "expected", user editable; account deletion erases events; event privacy: never shared with sellers or ads.

## Data
`calendar_events(id, user_id P2, kind, starts_at, local_date, note P2-short, modesty, season_band, source manual|wishlist|device, reminders_enabled, status)` · `calendar_outfits(id, event_id, outfit_id, status planned|in_bag|purchased|worn, created_at)` · `calendar_reminders(id, event_id, due_at, sent_at)`.

## API
| Endpoint | Auth | Idem | Rate |
|---|---|---|---|
| `GET/POST /v1/me/calendar/events` | owner | POST yes | 60/min |
| `PATCH/DELETE /v1/me/calendar/events/{id}` | owner | no | 60/min |
| `POST /v1/me/calendar/events/{id}/outfits` | owner | no | 10/min (shares stylist quota) |
| `POST /v1/me/calendar/events/{id}/add-gap-to-bag` | owner | yes | 20/min |

## Events
Outbox `calendar.event_created`, `calendar.reminder_due`. Analytics: `calendar_event_created(kind, source)`, `calendar_outfit_planned`, `calendar_gap_added_to_bag`, `calendar_reminder_opened`.

## Failure handling
Stylist down -> rules fallback (source flagged); reminder job retries, de-duplicates on `(event_id, due_at)`; notification provider down -> in-app inbox only.

## Security and abuse
BOLA by owner id; DTO allow-lists; free-text note length cap and treated as untrusted if ever sent to LLM (default: never sent); device-calendar read is on-device and permission-prompted after a value screen; stylist quotas apply (LLM10 cost control).

## Metrics
Events per active user, plan-to-purchase rate, outfit add-to-bag from calendar, reminder open rate, unsubscribe rate (guardrail), late-delivery complaints (guardrail).

## Acceptance
```
Given an event in 3 days and a gap item with p80 ETA 4 days, then the UI shows "may not arrive in time" and no delivery promise.
Given quiet hours, then a due reminder is deferred to 09:00 Cairo.
Given a device-calendar import, then only date and type are sent to the server (contract test on the request body).
Given the shopper deletes the account, then all events and outfits links are erased.
```
