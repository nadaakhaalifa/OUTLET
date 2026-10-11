# Z-OUTLET design system (@outlet/ui-native)

Core React Native components built on `@outlet/ui-tokens`. Arabic-first, RTL-safe, light and dark from tokens.

## Verification status (read first)

There is **no React Native renderer in this repo**. Component files (`src/components/basic.tsx`, `src/theme.tsx`) are **typechecked but NOT render-tested**. What is unit-tested (vitest, `src/logic/ui.test.ts`) is every decision that can be computed: button state to style, field state to view, screen status table, touch-target and font-scale maths, WCAG contrast of token pairs, RTL direction helpers, accessible-name validation. Visual and screen-reader behaviour must be checked on a device or simulator before release.

## Components

Text, Button (primary, secondary, destructive, loading, disabled), TextField (error, helper), Screen, Card, Badge, Banner (info, warning, error), EmptyState, ErrorState (also used for offline via `offline`), LoadingState, Skeleton, ListRow, SwitchRow, Checkbox, Divider.

```tsx
import { ThemeProvider, Screen, Text, TextField, Button, Banner } from "@outlet/ui-native";

<ThemeProvider>
  <Screen>
    <Text variant="title">{t("checkout.title")}</Text>
    <Banner tone="warning" message={t("checkout.codFee")} />
    <TextField label={t("address.line1")} value={v} onChangeText={setV} error={err} />
    <Button title={t("common.continue")} onPress={next} loading={busy} />
  </Screen>
</ThemeProvider>
```

Choosing a state screen: `resolveScreenStatus({ isLoading, isOnline, hasError, itemCount, hasCachedData })` returns `loading | offline | error | empty | ready`; cached data stays visible rather than being blanked by offline or error.

## Rules

- All user-facing copy is passed in by the caller from `@outlet/i18n`. Components hold no hard-coded copy except the English fallback banner prefixes (Info, Warning, Error); pass `prefix` to localise.
- Layout uses start/end (`borderStartWidth`, `textAlign: "auto"`, row direction follows I18nManager). Never left/right.
- Colours come from tokens only. Info and warning tones are not yet in `@outlet/ui-tokens`; the warning palette is local to `logic/palette.ts` and should move to tokens (decision for the tokens owner).
- Skeleton is a static block; there is no shimmer and nothing that imitates real data.

## Accessibility checklist

- [ ] Every interactive element has a role and a non-empty accessible name (`accessibleName`).
- [ ] Touch target at least 44pt (`minTouchTarget`); small visuals use `hitSlopFor`.
- [ ] Text uses `allowFontScaling` and a max multiplier (`MAX_FONT_SCALE` = 2); no fixed-height containers around text.
- [ ] Contrast at least 4.5:1 for text, 3:1 for UI borders (tested for tokens and tones in both schemes).
- [ ] State is never colour-only: errors and banners carry a text prefix and an alert role.
- [ ] Loading sets `busy` and blocks double submission.
- [ ] Directional icons flip in RTL (`iconScaleX`); non-directional ones do not.
- [ ] Decorative elements (Skeleton, Divider) are hidden from screen readers.
- [ ] Checked manually with VoiceOver and TalkBack, largest font size, and Arabic RTL. (NOT done: no device run yet.)
