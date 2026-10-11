# Mobile close-out (navigation, testIDs, scheme)

Nothing here ran on a simulator or device. Evidence is unit tests, `tsc`, ESLint, copy-lint, i18n parity and YAML parsing of the Maestro flows.

## Done
- Tabs Home / Explore / Stylist / Bag / Me; Stylist moved into `(tabs)` (the root `/stylist` route was removed to avoid a duplicate path).
- Me menu with 11 rows, gift-cards row gated by `giftVisibility`; Help and Settings routes added (honest placeholders).
- Bag checkout CTA; checkout consumes the drop admission token; Plus nudge from `quote.plusSavings`.
- Single ports container (`state/ports.ts`); PDP and Stylist now write to the shared Bag and Wishlists ports.
- testIDs per `docs/engineering/e2e-maestro.md`; flows select by `id:` where one exists.
- Scheme `outletnk` renamed to `zoutlet` in `app.json`, fixtures, e2e doc, MASVS doc and mobile threat model.

## Gaps
- Never run on a simulator; Maestro selectors and `TestId` wrapper tap behaviour are unverified.
- `@outlet/ui-native` `TextField`/`Button`/`Checkbox` do not forward `testID` (owner: ui-native); wrappers are a stopgap.
- Bundle identifiers and slug still say `outletnk`/`outlet-nk` (pending open question 9, an identity decision). Other `outlet-nk` strings exist outside mobile (terraform tags, Grafana dashboards, CODEOWNERS, OpenAPI audiences) and were not touched.
- `InMemoryBagPort.addLine` prices from the client hint; the real API must price server-side. `CheckoutPort.place` gained an optional admission argument and `CheckoutQuote` a required `plusSavings` field, which the API contract (openapi) does not yet carry.
- Wishlist save creates one list per intent in the fake; real list selection is not designed.
- Tab icons are absent (no icon library chosen).
- Release builds still throw in `createApi` (no production adapter), so the app only runs as a development build.
