import { useEffect, useState } from "react";
import { useContext } from "react";
import { Image, ScrollView, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { TestId } from "../../components/TestId";
import type { GiftCapabilities } from "../../features/gift-cards/model";
import { getBrandModePort, modeSwitcher, profileView, signOut as runSignOut, type BrandModeEntry } from "../../features/me/model";
import { devProfileFixture } from "../../features/me/dev-fixtures";
import { remoteRevoker } from "../../features/me/signout";
import { groupedMeRows, type MeRow, type MeRowId } from "../../features/navigation/model";
import { buildPlus } from "../../features/plus/model";
import type { Tier } from "../../features/rewards/model";
import { getFeaturePorts, getGuestStore } from "../../state/ports";
import { onSignedOut } from "../../features/guest";
import { guestMeRows } from "../../features/me/guest-rows";
import { SELL_ROUTE, SIGN_IN_ROUTE } from "../../features/me/routes";
import { useGuestGateMode } from "../../features/me/useGuest";
import { TextAction } from "../../features/purchase/TextAction";
import { useServices } from "../../state/services";
import { TabBarInsetContext, tabBarZoomExtra } from "@outlet/ui-native";
import { chevronName, Divider, Icon, IconButton, Eyebrow, ListRow, PressScale, Reveal, SegmentedControl, Text, useTheme } from "../../ui";
import { Monogram } from "../../art";
import { radius } from "@outlet/ui-tokens";
import type { IconName } from "../../ui";


const PRIMARY_IDS: readonly MeRowId[] = ["orders", "wishlists", "addresses", "settings", "help"];
/** Board titles for the first six rows (i18n me.board.*). */
const BOARD_TITLE: Partial<Record<MeRowId, "orders" | "wishlist" | "help">> = { orders: "orders", wishlists: "wishlist", help: "help" };
const BOARD_ICON: Partial<Record<MeRowId, IconName>> = { wishlists: "heart-outline", help: "help-circle-outline", settings: "settings-outline" };

export default function MeScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const services = useServices();
  const { spacing, colors, isRTL, setPreference, scheme, layout } = useTheme();
  const insets = useSafeAreaInsets();
  const tabInset = useContext(TabBarInsetContext);
  const q = useLocalSearchParams<{ theme?: string }>();
  // Dev-only capture aid: /me?theme=dark|light|system.
  useEffect(() => {
    if (__DEV__ && (q.theme === "light" || q.theme === "dark" || q.theme === "system")) setPreference(q.theme);
  }, [q.theme, setPreference]);
  const mode = useGuestGateMode();
  const guest = mode === "guest";
  const dev = devProfileFixture();
  // Unknown until loaded: the gift-cards row stays hidden while the kill-switch state is unknown.
  const [gift, setGift] = useState<GiftCapabilities | null>(null);
  const [tier, setTier] = useState<Tier | null>(null);
  // null = unknown: the banner stays hidden until membership is known.
  const [isMember, setIsMember] = useState<boolean | null>(null);
  const [brand, setBrand] = useState<BrandModeEntry | null>(null);

  useEffect(() => {
    // A guest holds no account data: nothing here is fetched until a session exists.
    if (mode !== "member") return undefined;
    let alive = true;
    const ports = getFeaturePorts();
    ports.giftCards.load().then((s) => { if (alive) setGift(s.capabilities); }, () => { if (alive) setGift(null); });
    ports.rewards.load().then((s) => { if (alive) setTier(s.tier.tier); }, () => undefined);
    ports.plus.load().then((p) => { if (alive) setIsMember(buildPlus(p).mode === "manage"); }, () => undefined);
    getBrandModePort().entry().then((b) => { if (alive) setBrand(b); }, () => { if (alive) setBrand(null); });
    return () => { alive = false; };
  }, [mode]);

  const profile = profileView({ displayName: dev?.displayName ?? null, phoneE164: services.session.phoneE164, tier, email: dev?.email ?? null });
  const modes = modeSwitcher(brand);
  const groups = guest ? groupedMeRows(gift).map((g) => guestMeRows(g)).filter((g) => g.length > 0) : groupedMeRows(gift);
  const signOut = async () => {
    await runSignOut({ revokeRemote: remoteRevoker(), clearLocal: () => services.tokens.clear() });
    onSignedOut(getGuestStore());
    services.session.phoneE164 = null;
    router.replace("/");
  };
  const rowsById = new Map(groups.flat().map((r) => [r.id, r] as const));
  const primaryRows = PRIMARY_IDS.flatMap((id) => { const r = rowsById.get(id); return r === undefined ? [] : [r]; });
  // Board order: orders, wishlist, addresses, payment methods, settings, help.
  const primary = [...primaryRows.slice(0, 3), ...primaryRows.slice(3).sort((a) => (a.id === "settings" ? -1 : 1))];
  const paymentRow: MeRow | null = dev?.paymentMethods === true ? { id: "wallet", titleKey: "me.rows.wallet", href: "/wallet", testID: "me-row-wallet", icon: "card-outline", group: 0 } : null;
  const other = groups.flat().filter((r) => !PRIMARY_IDS.includes(r.id));
  const boardRows: readonly (MeRow & { readonly pay?: true })[] = [
    ...primary.slice(0, 3),
    ...(paymentRow !== null ? [{ ...paymentRow, pay: true as const }] : []),
    ...primary.slice(3),
  ];
  const boardRow = (r: MeRow & { readonly pay?: true }, i: number) => {
    const bt = BOARD_TITLE[r.id];
    const title = r.pay === true ? t("me.board.paymentMethods") : bt !== undefined ? t(`me.board.${bt}`) : t(r.titleKey, { product: "Z-OUTLET" });
    return (
      <Reveal key={r.pay === true ? "pay" : r.id} index={1 + i}>
        <TestId id={r.testID}>
          <PressScale onPress={() => router.push(r.href)} accessibilityRole="button" accessibilityLabel={title} scale={0.995}>
            <View style={{ minHeight: 46, flexDirection: "row", alignItems: "center", gap: 22 }}>
              <Icon name={BOARD_ICON[r.id] ?? r.icon} size={22} />
              <Text variant="callout" style={{ flex: 1 }} accessibilityRole="none">{title}</Text>
              <Icon name={chevronName(isRTL)} size={16} />
            </View>
          </PressScale>
          <Divider />
        </TestId>
      </Reveal>
    );
  };
  const renderRows = (rows: readonly MeRow[], start: number) => rows.map((r, i) => (
    <Reveal key={r.id} index={start + i}>
      <TestId id={r.testID}>
        <ListRow
          title={guest && r.id === "privacy" ? t("guestMe.dataRow") : t(r.titleKey, { product: "Z-OUTLET" })}
          leadingIcon={r.icon}
          divider
          {...(r.id === "plus" ? { trailing: <Icon name="diamond" size={14} color="plus" /> } : {})}
          {...(r.hintKey !== undefined ? { accessibilityHint: t(r.hintKey) } : {})}
          onPress={() => router.push(r.href)}
        />
      </TestId>
    </Reveal>
  ));
  if (mode === "unknown") return <View style={{ flex: 1, backgroundColor: colors.ink }} />;
  const ink = colors.ink;
  const sand = /^#[0-9a-fA-F]{6}$/.test(colors.sand) ? colors.sand : null;
  const cardColors: readonly [string, string] = scheme === "dark" && sand !== null ? [`${sand}4D`, `${sand}1F`] : [colors.fill, colors.fill];
  const photo = profile.photoUrl !== null ? { uri: profile.photoUrl } : dev !== null ? dev.avatar : null;
  return (
    <View style={{ flex: 1, backgroundColor: ink }}>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top, paddingBottom: tabInset + tabBarZoomExtra(layout.z) + spacing.xl, paddingHorizontal: spacing.xl }}>
        <View style={{ height: 44, flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginHorizontal: -spacing.sm }}>
          {router.canGoBack() ? <IconButton icon="arrow-back" label={t("me.back")} onPress={() => router.back()} testID="me-back" /> : <View />}
          <IconButton icon="settings-outline" label={t("me.rows.settings")} onPress={() => router.push("/settings")} testID="me-gear" />
        </View>
        {guest ? (
          <Reveal index={0}><View style={{ paddingTop: spacing.sm, paddingBottom: spacing.lg }}><Text variant="title" accessibilityRole="header">{t("tabs.profile")}</Text></View></Reveal>
        ) : <Reveal index={0}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 19, paddingTop: spacing.sm, paddingBottom: 26 }} accessibilityRole="summary" accessibilityLabel={profile.title ?? t("me.guest")}>
            <View style={{ width: 108, height: 108, borderRadius: radius.pill, overflow: "hidden", backgroundColor: colors.fill, alignItems: "center", justifyContent: "center" }}>
              {photo !== null ? <Image source={photo} accessible={false} style={{ width: 108, height: 108 }} resizeMode="cover" /> : <Monogram size={56} tone="light" />}
            </View>
            <View style={{ flex: 1, gap: 6 }}>
              <Text variant="title" numberOfLines={1}>{profile.title ?? t("me.guest")}</Text>
              {profile.email !== null ? <Text variant="caption" secondary numberOfLines={1}>{profile.email}</Text> : null}
            </View>
          </View>
        </Reveal>}
        <View accessibilityRole="list" accessibilityLabel={t("me.menuLabel")}>
          <View style={{ borderTopWidth: 1, borderTopColor: colors.hairline }}>{boardRows.map(boardRow)}</View>
        </View>
        {!guest && isMember === false ? (
          <TestId id="me-member-banner">
            <View style={{ marginTop: spacing.lg }}>
              <PressScale onPress={() => router.push("/plus")} accessibilityRole="button" accessibilityLabel={`${t("me.memberTitle")}. ${t("me.board.memberBody")}`}>
                <LinearGradient colors={cardColors} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ flexDirection: "row", alignItems: "center", height: 86, borderRadius: radius.md, overflow: "hidden", borderWidth: 1, borderColor: colors.glassBorder }}>
                  {dev !== null ? <Image source={dev.memberPhoto} accessible={false} style={{ width: 92, height: 86 }} resizeMode="cover" /> : <View style={{ width: 92, height: 86, alignItems: "center", justifyContent: "center" }}><Icon name="diamond-outline" size={26} color="plus" /></View>}
                  <View style={{ flex: 1, gap: 4, paddingStart: spacing.md, paddingEnd: spacing.xs }}>
                    <Text variant="headline" accessibilityRole="none">{t("me.memberTitle")}</Text>
                    <Text variant="caption" secondary numberOfLines={1} accessibilityRole="none">{t("me.board.memberBody")}</Text>
                  </View>
                  <View style={{ paddingEnd: spacing.md, transform: [{ rotate: isRTL ? "-135deg" : "-45deg" }] }}><Icon name="arrow-forward" size={18} /></View>
                </LinearGradient>
              </PressScale>
            </View>
          </TestId>
        ) : null}
        {/* Below the fold on purpose: the first screen shows exactly the board's content. */}
        <View style={{ marginTop: 220, gap: spacing.md }}>
          {profile.tier !== null ? <Eyebrow>{t("me.tier", { tier: t(`rewards.tier.${profile.tier}`) })}</Eyebrow> : null}
          {modes !== null && brand !== null ? (
            <TestId id="me-mode-switcher">
              <SegmentedControl options={[t("me.mode.shopping"), t("me.mode.brand")]} index={0} onChange={(i) => { if (i === 1) getBrandModePort().enter(brand); }} />
            </TestId>
          ) : null}
          {other.length > 0 ? (
            <View>
              <Eyebrow>{t("me.board.more")}</Eyebrow>
              <View style={{ marginTop: spacing.sm, borderTopWidth: 1, borderTopColor: colors.hairline }}>{renderRows(other, 8)}</View>
            </View>
          ) : null}
          <TestId id="me-row-sell">
            <ListRow title={t("guestMe.sellRow")} leadingIcon="storefront-outline" divider onPress={() => router.push(SELL_ROUTE)} />
          </TestId>
          {guest ? (
            <TestId id="me-quiet-sign-in">
              <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs, flexWrap: "wrap" }}>
                <Text variant="caption" secondary>{t("guestMe.signInPrompt")}</Text>
                <TextAction testID="me-quiet-sign-in-link" label={t("guestMe.signIn")} onPress={() => router.push(SIGN_IN_ROUTE)} />
              </View>
            </TestId>
          ) : null}
          {guest ? null : <PressScale onPress={() => void signOut()} accessibilityRole="button" accessibilityLabel={t("me.signOut")} innerStyle={{ minHeight: 56, justifyContent: "center" }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
              <Icon name="log-out-outline" size={20} color="textSecondary" />
              <Text variant="callout" secondary accessibilityRole="none">{t("me.signOut")}</Text>
            </View>
          </PressScale>}
        </View>
      </ScrollView>
    </View>
  );
}
