# Proposed analytics events (guest browsing, G3)

For the analytics owner; not yet in `packages/analytics`. Guest events are sent only after the device `analytics` consent. No PII.

| Event | Payload | When |
|---|---|---|
| `quiet_sign_in_started` | none | Existing-account sign-in screen submits the age check and requests a code |
| `quiet_sign_in_succeeded` | `method: "phone_otp"` | Verified, account existed, session stored |
| `quiet_sign_in_not_found` | none | Verified number had no account; session discarded, nothing created |
| `analytics_banner_answered` | `choice: "allow" \| "not_now"` | Banner answered (emitted only when `allow`, since a decline starts no analytics) |
