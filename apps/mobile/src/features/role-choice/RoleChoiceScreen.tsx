import { useCallback, useState } from "react";
import { ScrollView, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { useFocusEffect, useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { radius } from "@outlet/ui-tokens";
import { Button, Eyebrow, Reveal, GlassSurface, Screen, Text, lightImpact, useLayout, useTheme } from "../../ui";
import { HeroArt, Monogram, Wordmark } from "../../art";
import { FabricBackdrop } from "../../components/FabricBackdrop";
import { LuxuryTexture } from "../../components/LuxuryTexture";
import { LanguageThemeToggle } from "../chrome/LanguageThemeToggle";
import { useServices } from "../../state/services";
import { BRAND_ROUTE, type Role } from "./model";
import { cardsSideBySide, entranceMode, panelShare } from "./layout-mode";

const MAX_WIDTH = 560;

/** Z-OUTLET must never break at the hyphen. */
const joinName = (s: string): string => s.replace(/Z-OUTLET/g, "Z\u2060-\u2060OUTLET");

/** The very first screen after the splash: shopper (primary path) or brand (secondary, dignified). */
export function RoleChoiceScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const services = useServices();
  const insets = useSafeAreaInsets();
  const layout = useLayout();
  const mode = entranceMode(layout.sizeClass, layout.effectiveWidth);
  const [busy, setBusy] = useState(false);
  const [, setFocused] = useState(true);
  useFocusEffect(useCallback(() => { setFocused(true); return () => setFocused(false); }, []));

  const pick = async (role: Role) => {
    lightImpact();
    setBusy(true);
    try {
      await services.role.choose(role);
      router.replace(role === "brand" ? BRAND_ROUTE : "/(tabs)");
    } finally {
      setBusy(false);
    }
  };
  const signIn = () => { router.push("/sign-in"); };

  if (mode !== "phone") return mode === "split" ? <RoleChoiceSplit busy={busy} onShop={() => void pick("shopper")} onBrand={() => void pick("brand")} onSignIn={signIn} /> : <RoleChoiceBand busy={busy} onShop={() => void pick("shopper")} onBrand={() => void pick("brand")} onSignIn={signIn} />;

  return (
    <View style={{ flex: 1 }}>
      <EntranceBackdrop />
      <Screen padded={false} testID="role-screen" contentStyle={{ paddingBottom: insets.bottom + 32 }}>
        <View style={{ width: "100%", maxWidth: MAX_WIDTH, alignSelf: "center", paddingHorizontal: 20, gap: 28 }}>
          
          <Toggle />
          <Reveal index={0}><EntranceHeader size={30} /></Reveal>
          <Reveal index={2}>
            <GlassSurface elevated radius={radius.lg} innerStyle={{ gap: 0 }}>
              <HeroArt variant="atelier" style={{ width: "100%", aspectRatio: 16 / 9 }} />
              <View style={{ padding: 20, gap: 10 }}>
                <Text variant="display">{t("roleChooser.shopTitle")}</Text>
                <Text variant="body">{t("roleChooser.shopBody")}</Text>
                <View style={{ marginTop: 6 }}>
                  <Button title={t("roleChooser.shopCta")} icon="arrow-forward" fullWidth disabled={busy} onPress={() => void pick("shopper")} testID="role-shopper" accessibilityLabel={`${t("roleChooser.shopTitle")}. ${t("roleChooser.shopBody")}`} />
                </View>
              </View>
            </GlassSurface>
          </Reveal>
          <Reveal index={3}>
            <GlassSurface elevated radius={radius.lg} innerStyle={{ padding: 20, gap: 10 }}>
              <Eyebrow>{t("roleChooser.sellEyebrow")}</Eyebrow>
              <Text variant="title1">{joinName(t("roleChooser.sellTitle"))}</Text>
              <Text variant="body">{t("roleChooser.sellBody")}</Text>
              <View style={{ marginTop: 6 }}>
                <Button title={t("roleChooser.sellCta")} variant="secondary" fullWidth disabled={busy} onPress={() => void pick("brand")} testID="role-brand" accessibilityLabel={`${joinName(t("roleChooser.sellTitle"))}. ${t("roleChooser.sellBody")}`} />
              </View>
            </GlassSurface>
          </Reveal>
          <Reveal index={4} style={{ alignItems: "center", gap: 2 }}>
            <Text variant="callout" secondary>{t("roleChooser.signInPrompt")}</Text>
            <SignInLink onPress={signIn} />
            <AdultsNote />
          </Reveal>
        </View>
      </Screen>
    </View>
  );
}

interface Handlers { readonly busy: boolean; readonly onShop: () => void; readonly onBrand: () => void; readonly onSignIn: () => void }

/** Brand art with the wordmark and promise over a scrim (iPad only). */
function BrandArt(props: { readonly wordmark: number; readonly rounded?: number }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { s } = useLayout();
  return (
    <View style={[{ flex: 1 }, { overflow: "hidden", borderRadius: props.rounded ?? 0, backgroundColor: colors.forest }]}>
      <HeroArt variant="atelier" style={{ position: "absolute", top: 0, start: 0, width: "100%", height: "100%" }} />
      <LinearGradient pointerEvents="none" colors={["transparent", colors.scrim]} style={{ position: "absolute", start: 0, end: 0, bottom: 0, top: "30%" }} />
      <View style={{ flex: 1, justifyContent: "flex-end", padding: s(24), gap: s(10) }}>
        <View accessibilityRole="header"><Wordmark size={s(props.wordmark)} tone="dark" /></View>
        <Text variant="callout" color="onImage">{t("roleChooser.promise")}</Text>
      </View>
    </View>
  );
}

/** The two choice cards and the sign-in link. The shop card drops its hero art here: the brand art is already on screen. */
function Choices(props: Handlers & { readonly sideBySide: boolean }) {
  const { t } = useTranslation();
  const { s } = useLayout();
  const { busy, onShop, onBrand } = props;
  const shop = (
    <GlassSurface elevated radius={s(radius.lg)} style={{ flex: props.sideBySide ? 1 : undefined }} innerStyle={{ flex: 1, padding: s(20), gap: s(10) }}>
      <Text variant="display">{t("roleChooser.shopTitle")}</Text>
      <Text variant="body">{t("roleChooser.shopBody")}</Text>
      <View style={{ marginTop: s(6) }}>
        <Button title={t("roleChooser.shopCta")} icon="arrow-forward" fullWidth disabled={busy} onPress={onShop} testID="role-shopper" accessibilityLabel={`${t("roleChooser.shopTitle")}. ${t("roleChooser.shopBody")}`} />
      </View>
    </GlassSurface>
  );
  const sell = (
    <GlassSurface elevated radius={s(radius.lg)} style={{ flex: props.sideBySide ? 1 : undefined }} innerStyle={{ flex: 1, padding: s(20), gap: s(10) }}>
      <Eyebrow>{t("roleChooser.sellEyebrow")}</Eyebrow>
      <Text variant="title1">{joinName(t("roleChooser.sellTitle"))}</Text>
      <Text variant="body">{t("roleChooser.sellBody")}</Text>
      <View style={{ marginTop: s(6) }}>
        <Button title={t("roleChooser.sellCta")} variant="secondary" fullWidth disabled={busy} onPress={onBrand} testID="role-brand" accessibilityLabel={`${joinName(t("roleChooser.sellTitle"))}. ${t("roleChooser.sellBody")}`} />
      </View>
    </GlassSurface>
  );
  return (
    <View style={{ gap: s(20) }}>
      {props.sideBySide ? <View style={{ flexDirection: "row", gap: s(16), alignItems: "stretch" }}>{shop}{sell}</View> : <View style={{ gap: s(16) }}>{shop}{sell}</View>}
      <View style={{ alignItems: "center", gap: 2 }}>
        <Text variant="callout" secondary>{t("roleChooser.signInPrompt")}</Text>
        <SignInLink onPress={props.onSignIn} />
        <AdultsNote />
      </View>
    </View>
  );
}

function Toggle() {
  const { s } = useLayout();
  return <View style={{ flexDirection: "row", justifyContent: "flex-end", marginBottom: s(16) }}><GlassSurface radius={999} innerStyle={{ paddingHorizontal: s(4) }}><LanguageThemeToggle testIDPrefix="role" /></GlassSurface></View>;
}

/** iPad, effective width 640 and up: brand panel at the start, choices scroll in the end pane. */
function RoleChoiceSplit(props: Handlers) {
  const { colors } = useTheme();
  const layout = useLayout();
  const { s } = layout;
  const insets = useSafeAreaInsets();
  const share = panelShare(layout.effectiveWidth);
  const [box, setBox] = useState({ h: 0, c: 0, y: 0 });
  return (
    <View style={{ flex: 1, flexDirection: "row", backgroundColor: colors.background }} testID="role-screen">
      <EntranceBackdrop />
      <View style={{ width: `${share * 100}%` }} testID="role-brand-panel"><BrandArt wordmark={38} /></View>
      <View style={{ flex: 1 }}>
        <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator scrollEventThrottle={32}
          onLayout={(e) => setBox((b) => ({ ...b, h: e.nativeEvent.layout.height }))}
          onContentSizeChange={(_w, h) => setBox((b) => ({ ...b, c: h }))}
          onScroll={(e) => { const y = e.nativeEvent.contentOffset.y; setBox((b) => (Math.abs(b.y - y) < 4 ? b : { ...b, y })); }}
          contentContainerStyle={{ flexGrow: 1, justifyContent: "center", paddingTop: insets.top + s(16), paddingBottom: insets.bottom + s(24), paddingHorizontal: s(24) }}>
          <View style={{ width: "100%", maxWidth: s(400), alignSelf: "center" }}>
            <Toggle />
            <Choices {...props} sideBySide={false} />
          </View>
        </ScrollView>
        {box.c - box.h - box.y > 4 ? <LinearGradient pointerEvents="none" colors={["transparent", colors.background]} style={{ position: "absolute", start: 0, end: 0, bottom: 0, height: s(24) }} /> : null}
      </View>
    </View>
  );
}

/** iPad, effective width 600 to 640: whole page scrolls, brand art as an inset top band. */
function RoleChoiceBand(props: Handlers) {
  const { colors } = useTheme();
  const layout = useLayout();
  const { s } = layout;
  const insets = useSafeAreaInsets();
  const bandHeight = Math.min(Math.round(layout.windowHeight * 0.28), s(260));
  const side = cardsSideBySide(layout.contentWidth);
  return (
    <View style={{ flex: 1, backgroundColor: colors.background }} testID="role-screen">
      <EntranceBackdrop />
      <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator contentContainerStyle={{ flexGrow: 1, justifyContent: "center", paddingTop: insets.top + s(16), paddingBottom: insets.bottom + s(24), paddingHorizontal: layout.gutter }}>
        <View style={{ width: "100%", maxWidth: s(576), alignSelf: "center" }}>
          <Toggle />
          <View style={{ height: Math.max(bandHeight, s(160)), marginBottom: s(24), flexDirection: "row" }}><BrandArt wordmark={30} rounded={s(radius.xl)} /></View>
          <Choices {...props} sideBySide={side} />
        </View>
      </ScrollView>
    </View>
  );
}

/** Static layered backdrop: fabric weave (light), paper grain, then a soft teal vignette. No animation, no blur. */
function EntranceBackdrop() {
  const { colors } = useTheme();
  return (
    <View pointerEvents="none" style={{ position: "absolute", top: 0, bottom: 0, start: 0, end: 0 }}>
      <FabricBackdrop soft />
      <LuxuryTexture />
      <LinearGradient colors={[colors.brandSoft, "transparent", colors.brandSoft]} locations={[0, 0.5, 1]} style={{ position: "absolute", top: 0, bottom: 0, start: 0, end: 0 }} />
    </View>
  );
}

/** Premium header: monogram, sand hairline ornament, display wordmark, then the promise as a tracked small-caps line. */
function EntranceHeader(props: { readonly size: number }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { s } = useLayout();
  return (
    <View style={{ alignItems: "center", gap: s(14), paddingTop: s(8) }}>
      <Monogram size={s(28)} />
      <View style={{ flexDirection: "row", alignItems: "center", gap: s(10) }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <View style={{ width: s(36), height: 1, backgroundColor: colors.sand }} />
        <View style={{ width: s(5), height: s(5), transform: [{ rotate: "45deg" }], backgroundColor: colors.sand }} />
        <View style={{ width: s(36), height: 1, backgroundColor: colors.sand }} />
      </View>
      <View accessibilityRole="header"><Wordmark size={s(props.size)} /></View>
      <Eyebrow style={{ textAlign: "center", paddingHorizontal: s(12) }}>{t("roleChooser.promise")}</Eyebrow>
    </View>
  );
}

/** Quiet text link for existing accounts (44 pt+ target from the kit's ghost button). */
function SignInLink(props: { readonly onPress: () => void }) {
  const { t } = useTranslation();
  return <Button title={t("roleChooser.signIn")} variant="ghost" onPress={props.onPress} testID="role-signin" />;
}

/** One honest 18+ line; the age is confirmed before the first order, not here. */
function AdultsNote() {
  const { t } = useTranslation();
  const { s } = useLayout();
  return <Text variant="caption" secondary style={{ textAlign: "center", marginTop: s(8) }}>{joinName(t("roleChooser.adultsNote"))}</Text>;
}
