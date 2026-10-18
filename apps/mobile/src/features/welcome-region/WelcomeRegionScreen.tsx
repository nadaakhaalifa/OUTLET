import { useEffect, useMemo, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, View } from "react-native";
import { FlashList } from "@shopify/flash-list";
import { useLocalSearchParams, useRouter, type Href } from "expo-router";
import { getLocales } from "expo-localization";
import { StatusBar } from "expo-status-bar";
import { useTranslation } from "react-i18next";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { radius, spacing } from "@outlet/ui-tokens";
import { Banner, Button, Eyebrow, GlassSurface, Icon, IconButton, Reveal, Scrim, SearchField, Text, useTheme } from "../../ui";
import { HeroArt, Wordmark } from "../../art";
import { FabricBackdrop } from "../../components/FabricBackdrop";
import { useServices } from "../../state/services";
import { applyLanguage } from "../../i18n";
import { STORAGE_KEYS } from "../../platform/secure-storage";
import { defaultRegion, mayWriteRegion, readStorefront, suggestLanguage, unconfiguredStorefront } from "./default-region";
import {
  SHOP_FOR, countryName, flagFor, isServed, makePref, searchCountries, sortedCountries, type Country, type ShopFor,
} from "./model";

const SEARCH_DEBOUNCE_MS = 200;
const ROW_MIN = 56;
const TOTAL_STEPS = 2;

/** Flag is decoration only (hidden from VoiceOver, the label carries the name). Code badge where a flag cannot render. */
function Flag(props: { country: Country }) {
  const { colors } = useTheme();
  const f = flagFor(props.country);
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: 40, alignItems: "center" }}>
      {f.kind === "emoji" ? (
        <Text variant="title2" accessibilityRole="none" maxScale={1.2}>{f.glyph}</Text>
      ) : (
        <View style={{ minWidth: 34, paddingHorizontal: 4, height: 24, borderRadius: radius.xs, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, backgroundColor: colors.fill, alignItems: "center", justifyContent: "center" }}>
          <Text variant="caption" weight="600" accessibilityRole="none" maxScale={1.1}>{f.text}</Text>
        </View>
      )}
    </View>
  );
}

function CountryRow(props: { country: Country; locale: string; selected: boolean; onPress: (c: Country) => void }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const c = props.country;
  const name = countryName(c, props.locale);
  const served = isServed(c.code);
  return (
    <Pressable
      testID={`region-row-${c.code}`}
      accessibilityRole="button"
      accessibilityLabel={t(served ? "welcomeRegion.country.rowAvailable" : "welcomeRegion.country.rowNotAvailable", { name })}
      accessibilityState={{ selected: props.selected }}
      onPress={() => props.onPress(c)}
      style={{ minHeight: ROW_MIN, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.hairline }}
    >
      <Flag country={c} />
      <View style={{ flex: 1, paddingVertical: 8 }}>
        <Text variant="body" accessibilityRole="none" weight={served ? "600" : "400"}>{name}</Text>
        <Text variant="caption" secondary accessibilityRole="none">{t(served ? "welcomeRegion.country.available" : "welcomeRegion.country.notAvailable")}</Text>
      </View>
      {props.selected ? <Icon name="checkmark-circle" size={22} color="savings" /> : null}
    </Pressable>
  );
}

/**
 * First-run welcome: where are you shopping from, then an optional browsing preference.
 * Device-local only. Not registration, never gates browsing, sends nothing and records no analytics.
 * DEV ONLY preview: `?step=shop` opens step 2 directly (ignored in release builds).
 * Edit mode (`?mode=edit`, from Settings) returns to the previous screen and may suggest the region's language.
 * First launch only: once a region is saved this screen is never shown again except in edit mode. Choosing a country
 * that is not served opens a static "not available yet" view: no input, no analytics, no server call.
 */
export function WelcomeRegionScreen() {
  const { t, i18n } = useTranslation();
  const { colors, isDark } = useTheme();
  const router = useRouter();
  const services = useServices();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ step?: string; mode?: string }>();
  const edit = params.mode === "edit";
  const locale = i18n.language;

  const [step, setStep] = useState<"country" | "shop">(__DEV__ && params.step === "shop" ? "shop" : "country");
  const [country, setCountry] = useState<string | null>(() => defaultRegion(null, getLocales()[0]?.regionCode).code);
  const touched = useRef(false);
  const [shopFor, setShopFor] = useState<ShopFor | null>(null);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [unavailable, setUnavailable] = useState<{ readonly name: string | null } | null>(null);
  const [suggestion, setSuggestion] = useState<"ar" | "en" | null>(null);

  // DEV preview only: the route is already mounted when the deep link changes the param.
  useEffect(() => { if (__DEV__ && params.step === "shop") setStep("shop"); }, [params.step]);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [query]);

  // Edit mode starts from what is saved on this device. First launch: a saved region means this screen never shows
  // again (stale link), and the default comes from the App Store storefront, then the locale region, then Egypt.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const saved = await services.region.load();
        if (!alive) return;
        if (edit) {
          if (saved !== null) { setCountry(saved.country); setShopFor(saved.shopFor); }
          return;
        }
        if (saved !== null) { router.replace("/(tabs)" as Href); return; }
      } catch { /* unreadable: treat as first launch */ }
      const sf = await readStorefront(unconfiguredStorefront);
      if (alive && !touched.current) setCountry(defaultRegion(sf, getLocales()[0]?.regionCode).code);
    })();
    return () => { alive = false; };
  }, [edit, services, router]);

  // Edit mode only: suggest the region's language if the shopper never chose one. Never switches by itself.
  useEffect(() => {
    if (!edit || country === null) return;
    let alive = true;
    services.storage.getString(STORAGE_KEYS.localePreference).then(
      (v) => { if (alive) setSuggestion(suggestLanguage({ edit, languageChosen: v !== null, region: country, current: locale })); },
      () => undefined,
    );
    return () => { alive = false; };
  }, [edit, country, locale, services]);

  const sorted = useMemo(() => sortedCountries(locale), [locale]);
  const rows = useMemo(() => searchCountries(sorted, debounced, locale), [sorted, debounced, locale]);

  const pick = (c: Country) => {
    touched.current = true;
    setCountry(c.code);
    if (!isServed(c.code)) setUnavailable({ name: countryName(c, locale) });
  };
  const next = () => {
    const c = sorted.find((x) => x.code === country);
    if (c !== undefined && !isServed(c.code)) setUnavailable({ name: countryName(c, locale) });
    else setStep("shop");
  };
  const finish = async (chosen: ShopFor | null) => {
    try {
      const existing = (await services.region.load()) !== null;
      if (mayWriteRegion({ edit, existing })) await services.region.save(makePref(country ?? "EG", chosen));
    } catch {
      // Not persisted: the welcome shows again next launch, which is safe.
    }
    if (edit) router.back();
    else router.replace("/role" as Href);
  };

  const showBack = step === "shop" || edit;
  const onBack = () => { if (step === "shop") setStep("country"); else router.back(); };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <StatusBar style={isDark ? "light" : "dark"} />
      {isDark ? (
        <View pointerEvents="none" style={StyleSheet.absoluteFill} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <HeroArt variant="tide" style={{ width: "100%", height: "100%", aspectRatio: undefined }} />
          <Scrim position="both" style={{ opacity: 0.8 }} />
        </View>
      ) : <FabricBackdrop />}
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={{ flex: 1, paddingTop: insets.top + 8, paddingHorizontal: 20, paddingBottom: Math.max(insets.bottom, 16), gap: 16 }}>
          <Reveal index={0}>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 44 }}>
              <View style={{ minWidth: 44 }}>{showBack ? <IconButton icon="arrow-back" directional label={t("common.back")} onPress={onBack} testID="region-back" /> : null}</View>
              <Wordmark size={16} tone={isDark ? "dark" : "light"} />
              <View style={{ minWidth: 44, alignItems: "flex-end" }}>
                <Eyebrow>{t("welcomeRegion.progress", { current: step === "country" ? 1 : 2, total: TOTAL_STEPS })}</Eyebrow>
              </View>
            </View>
          </Reveal>
          <Reveal index={1}>
            <View style={{ gap: 8 }}>
              <Text variant="display" accessibilityRole="header">{t(step === "country" ? "welcomeRegion.country.title" : "welcomeRegion.shop.title")}</Text>
              <Text variant="lede" secondary>{t(step === "country" ? "welcomeRegion.country.body" : "welcomeRegion.shop.body")}</Text>
            </View>
          </Reveal>

          {step === "country" ? (
            <>
              {/* One glass panel behind search and list: a blur per row would be too costly. */}
              <View style={{ flex: 1 }}>
                <GlassSurface radius={radius.xl} elevated style={{ flex: 1 }} innerStyle={{ flex: 1 }}>
                  <View style={{ padding: 12 }}>
                    <SearchField testID="region-search" value={query} onChangeText={setQuery} placeholder={t("welcomeRegion.country.searchPlaceholder")} label={t("welcomeRegion.country.searchLabel")} clearLabel={t("welcomeRegion.country.clear")} />
                  </View>
                  <View accessibilityLabel={t("welcomeRegion.country.listLabel")} style={{ flex: 1 }}>
                    <FlashList
                      data={rows}
                      extraData={country}
                      keyExtractor={(c) => c.code}
                      keyboardShouldPersistTaps="handled"
                      keyboardDismissMode="on-drag"
                      renderItem={({ item }) => <CountryRow country={item} locale={locale} selected={item.code === country} onPress={pick} />}
                      ListEmptyComponent={<View style={{ padding: 24 }}><Text variant="callout" secondary align="center">{t("welcomeRegion.country.empty")}</Text></View>}
                    />
                  </View>
                </GlassSurface>
              </View>
              <Button variant="brand" testID="region-continue" title={t("welcomeRegion.country.continue")} disabled={country === null} onPress={next} />
              <Button variant="ghost" testID="region-somewhere-else" title={t("entry.somewhereElse")} onPress={() => { touched.current = true; setUnavailable({ name: null }); }} />
            </>
          ) : (
            <>
              <GlassSurface radius={radius.xl} elevated innerStyle={{ paddingVertical: 4 }}>
                <View accessibilityRole="radiogroup">
                  {SHOP_FOR.map((id, i) => {
                    const on = shopFor === id;
                    return (
                      <Pressable
                        key={id}
                        testID={`shopfor-${id}`}
                        accessibilityRole="radio"
                        accessibilityLabel={t(`welcomeRegion.shop.${id}`)}
                        accessibilityState={{ checked: on }}
                        onPress={() => setShopFor(on ? null : id)}
                        style={{ minHeight: ROW_MIN, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, borderTopWidth: i === 0 ? 0 : StyleSheet.hairlineWidth, borderTopColor: colors.hairline }}
                      >
                        <Text variant="body" accessibilityRole="none" weight={on ? "600" : "400"} style={{ flex: 1 }}>{t(`welcomeRegion.shop.${id}`)}</Text>
                        <Icon name={on ? "radio-button-on" : "radio-button-off"} size={22} color={on ? "savings" : "textSecondary"} />
                      </Pressable>
                    );
                  })}
                </View>
              </GlassSurface>
              <Text variant="caption" secondary>{t("welcomeRegion.shop.localOnly")}</Text>
              {suggestion !== null ? (
                <View style={{ gap: spacing.sm }}>
                  <Banner tone="info" message={t("entry.languageSuggest")} />
                  <Button variant="secondary" testID="region-language-switch" title={t(suggestion === "ar" ? "entry.switchToArabic" : "entry.switchToEnglish")} onPress={() => void applyLanguage(suggestion, services.storage)} />
                </View>
              ) : null}
              <View style={{ flex: 1 }} />
              <Button variant="brand" testID="region-start" title={t("welcomeRegion.shop.start")} onPress={() => void finish(shopFor)} />
              <Button variant="ghost" testID="region-skip" title={t("welcomeRegion.shop.skip")} onPress={() => void finish(null)} />
            </>
          )}
        </View>
      </KeyboardAvoidingView>

      {unavailable !== null ? <NotAvailable name={unavailable.name} onBack={() => { setUnavailable(null); setCountry("EG"); }} /> : null}
    </View>
  );
}

/**
 * Static "not available yet" page for a country we do not serve, or "Somewhere else". Text and one way back only:
 * no input field, no analytics, no server call, nothing is stored (no waitlist).
 */
function NotAvailable(props: { name: string | null; onBack: () => void }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View testID="region-not-available" style={[StyleSheet.absoluteFill, { backgroundColor: colors.background, paddingTop: insets.top + spacing.lg, paddingHorizontal: spacing.lg, paddingBottom: Math.max(insets.bottom, spacing.md), gap: spacing.md }]}>
      <Wordmark size={16} />
      <Text variant="display" accessibilityRole="header">{t("entry.notAvailable.title")}</Text>
      <Text variant="lede" secondary>{props.name !== null ? t("entry.notAvailable.bodyNamed", { name: props.name }) : t("entry.notAvailable.body")}</Text>
      <View style={{ flex: 1 }} />
      <Button variant="brand" testID="region-not-available-back" title={t("entry.notAvailable.back")} onPress={props.onBack} />
    </View>
  );
}
