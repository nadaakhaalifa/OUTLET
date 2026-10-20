import { useState } from "react";
import { Image, ScrollView, View, type ImageSourcePropType } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { brand, radius } from "@outlet/ui-tokens";
import { FabricBackdrop } from "../../components/FabricBackdrop";
import { Icon, IconButton, PressScale, Text, useTheme } from "../../ui";
import { devChooserPhotos } from "./dev-fixtures";
import { nextRoute, SHOP_SCOPES, type ShopScope } from "./model";

/** Editorial shell: back control, then a left-aligned serif title under a hairline. Flat sections only. */
function Shell(props: { title: string; onBack: () => void; testID: string; children: React.ReactNode }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  return (
    <View style={{ flex: 1, backgroundColor: colors.background }} testID={props.testID}>
      <FabricBackdrop />
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 4, paddingBottom: insets.bottom + 32, paddingHorizontal: 24 }} showsVerticalScrollIndicator={false}>
        <View style={{ marginStart: -12 }}>
          <IconButton variant="plain" icon="chevron-back" directional label={t("storesDir.back")} onPress={props.onBack} testID={`${props.testID}-back`} />
        </View>
        <Text variant="title1" weight="600" accessibilityRole="header" style={{ paddingTop: 4, paddingBottom: 16 }}>{props.title}</Text>
        <View style={{ height: 1, backgroundColor: colors.accent, opacity: 0.25 }} />
        {props.children}
      </ScrollView>
    </View>
  );
}

const SCOPE_LABEL: Record<ShopScope, "storesDir.scopeLocal" | "storesDir.scopeGlobal" | "storesDir.scopeBoth"> = {
  local: "storesDir.scopeLocal", global: "storesDir.scopeGlobal", both: "storesDir.scopeBoth",
};

/** One directory entry: a framed photograph, the serif name and a quiet line, then its actions. A hairline closes it. */
function Entry(props: { photo: ImageSourcePropType | null; title: string; sub: string; testID: string; last?: boolean; children: React.ReactNode }) {
  const { colors } = useTheme();
  return (
    <View style={{ paddingVertical: 20, gap: 14, borderBottomWidth: props.last === true ? 0 : 1, borderBottomColor: colors.accent + "40" }} testID={props.testID}>
      <View style={{ borderRadius: radius.lg, overflow: "hidden", aspectRatio: 21 / 9, backgroundColor: brand.ink }}>
        {props.photo !== null ? (
          <Image source={props.photo} resizeMode="cover" style={{ width: "100%", height: "100%" }} accessibilityElementsHidden importantForAccessibility="no" accessibilityIgnoresInvertColors />
        ) : (
          <LinearGradient pointerEvents="none" start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} colors={[brand.teal, brand.forest]} style={{ flex: 1 }} />
        )}
      </View>
      <View style={{ gap: 4 }}>
        <Text variant="display" weight="600" accessibilityRole="header">{props.title}</Text>
        <Text variant="headline" weight="600" accessibilityRole="none">{props.sub}</Text>
      </View>
      {props.children}
    </View>
  );
}

/** Outlined segment that fills with ink while pressed. */
function Segment(props: { label: string; a11y: string; onPress: () => void; testID: string; icon?: boolean; divider?: boolean }) {
  const { colors } = useTheme();
  const [pressed, setPressed] = useState(false);
  const fg = pressed ? colors.onAccent : colors.accent;
  return (
    <PressScale
      onPress={props.onPress}
      onPressedChange={setPressed}
      scale={0.99}
      accessibilityRole="button"
      accessibilityLabel={props.a11y}
      testID={props.testID}
      style={{ flex: 1 }}
      innerStyle={{ minHeight: 48, backgroundColor: pressed ? colors.accent : "transparent", borderStartWidth: props.divider === true ? 1 : 0, borderStartColor: colors.accent + "59", flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingHorizontal: 12 }}
    >
      <Text variant="headline" weight="600" style={{ color: fg }} accessibilityRole="none">{props.label}</Text>
      {props.icon === true ? <Icon name="arrow-forward" size={18} color={pressed ? "onAccent" : "accent"} directional /> : null}
    </PressScale>
  );
}

function SegmentGroup(props: { children: React.ReactNode }) {
  const { colors } = useTheme();
  return <View style={{ flexDirection: "row", borderWidth: 1, borderColor: colors.accent, borderRadius: radius.pill, overflow: "hidden" }}>{props.children}</View>;
}

function useBack() {
  const router = useRouter();
  return () => (router.canGoBack() ? router.back() : router.replace("/"));
}

function go(router: ReturnType<typeof useRouter>, r: ReturnType<typeof nextRoute>) {
  router.push(r.params === undefined ? { pathname: r.pathname } : { pathname: r.pathname, params: r.params });
}

export function ModeStep() {
  const { t } = useTranslation();
  const router = useRouter();
  const back = useBack();
  const photos = devChooserPhotos();
  const online = t("storesDir.modeOnline");
  const scopes: readonly ShopScope[] = SHOP_SCOPES;
  return (
    <Shell title={t("storesDir.stepModeTitle")} onBack={back} testID="stores-step-mode">
      <Entry photo={photos?.online ?? null} title={online} sub={t("storesDir.modeOnlineSub")} testID="stores-mode-online">
        <SegmentGroup>
          {scopes.map((sc, i) => {
            const label = t(SCOPE_LABEL[sc]);
            return <Segment key={sc} divider={i > 0} label={label} a11y={t("storesDir.modeScopeLabel", { mode: online, scope: label })} onPress={() => go(router, nextRoute("online", sc))} testID={`stores-scope-${sc}`} />;
          })}
        </SegmentGroup>
      </Entry>
      <Entry last photo={photos?.inStore ?? null} title={t("storesDir.modeInStore")} sub={t("storesDir.modeInStoreSub")} testID="stores-mode-instore">
        <SegmentGroup>
          <Segment icon label={t("storesDir.findOutlets")} a11y={`${t("storesDir.modeInStore")}, ${t("storesDir.findOutlets")}`} onPress={() => go(router, nextRoute("inStore"))} testID="stores-mode-instore-go" />
        </SegmentGroup>
      </Entry>
    </Shell>
  );
}
