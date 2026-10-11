# Screens wave 3: Worlds and Bag

Scope: spec section 3 (Choose your world) and section 6 (Bag). Built against ports with in-memory
fakes. No live API; nothing has been run on a simulator or device.

## Worlds (Explore tab, `features/worlds`)
- Segmented control (radio group): Local, Global, Shop Everything, My Stores. Choice and sort persist per
  device in SecureStorage key `worlds.selection` (`world|sort`); unreadable values fall back to defaults.
- Sort chips: trending, biggest verified discount, new drops, fastest delivery, A to Z. Unknown values
  sort last; ties break by name then id.
- Discount text appears only when a verified value exists. No fake counters.
- Suspended stores are never listed. Suspended favourites are explained in My Stores with a banner.
- My Stores empty (no favourites, or all hidden): one tap "Shop Everything" widens the scope.
- States: loading, offline, error (retry), empty, ready.

## Bag (Bag tab, `features/bag`)
- Lines grouped by store; subtotal counts only available, non-saved lines of active stores.
- Free delivery bar: threshold from store config (default 2,000 EGP), integer floor percent, "add X to
  unlock", tooltip text states it counts before vouchers and credit. Plus shows free with no minimum.
- In-size suggestions come from `BagPort.inSizeSuggestions`; ranked cheapest gap-closing first, max 3.
- Price dropped and rose since added both shown with the exact delta.
- Sold out and paused lines flagged and excluded; suspended store locked with its lines excluded.
- Save for later and move back to bag. States: loading, offline, error, empty, ready.

## Quality rules
- Money: integer piastres (bigint), `features/money-display.ts` (Eastern digits and Arabic separators in
  Arabic, currency label from `common.currency`).
- Targets: chips, buttons and rows use ui-native components or `minTouchTarget` (44pt).
- Accessible names on chips (radio with selected state), progress bar (value text), save buttons (item name).
- Reduce Motion: no animations are used; the progress bar is static.
- RTL: only start/end-agnostic layout (flex row, flexWrap), text alignment auto.
- Copy parity AR/EN enforced by `pnpm i18n-check`.

## Known gaps
- Not run on a simulator; layout and RTL mirroring unverified visually.
- Store row press is a no-op until the store page exists; favourite toggling not built (My Stores
  membership comes from the port).
- No quantity edit or remove in the bag; checkout CTA not included.
- Worlds copy "." separators in subtitles are plain text, not localized punctuation.
- No existing numeral helper existed in i18n; `money-display.ts` is new and local to mobile.
