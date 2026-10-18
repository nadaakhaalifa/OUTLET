// DEV-ONLY design-system gallery. Not linked from the app; reachable at /__styleguide. Release builds render nothing.
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Redirect, useLocalSearchParams } from "expo-router";
import { View } from "react-native";
import {
  Avatar, Badge, Banner, BottomSheet, Button, Checkbox, Chip, Divider, EmptyState, Eyebrow, FullBleedHero, GlassSurface, IconButton, ListRow,
  PriceBlock, ProductCard, ProgressBar, QuantityStepper, Radio, Rating, Screen, SectionHeader, SegmentedControl, Skeleton, SizeSelector, StoreCard,
  SearchField, SwitchRow, TabBar, Card, Text, TextField, ThemeProvider, useTheme, useToast, type ThemePreference,
} from "@outlet/ui-native";
import { ProductArt, HeroArt, StoreCover, StoreAvatar, Monogram, Wordmark } from "../art";
import { colors as tokenColors, brand } from "@outlet/ui-tokens";
import { Reveal } from "@outlet/ui-native";

const COPY = {
  en: { title: "Style guide", sub: "Ivory paper. Deep teal ink. Honest prices.", theme: ["System", "Light", "Dark"], lang: ["EN", "AR"], name: "Linen shirt dress", seller: "Mantle Atelier", launch: "Launch price", save: "Save", more: "See all", info: "Free delivery on this order.", warn: "Low stock notice (server-derived).", err: "Enter a valid mobile number.", ok: "Price verified.", label: "Mobile number", helper: "We will send a code.", open: "Open sheet", toast: "Show toast", empty: "Your cart is empty", emptyBody: "Add something you love.", shop: "Shop now", add: "Add to cart", verified: "Verified discount", lowest: "Lowest in 30 days", sponsored: "Sponsored", live: "Live drop", plus: "Plus", deliveryLeft: "Add 120 EGP for free delivery", price: "EGP 1,250", ref: "EGP 1,667", pct: "-25%", newTitle: "The Eid edit", newSub: "Considered pieces, honest prices.", discover: "Discover", check: "Remember me", sw: "Notifications", r1: "Standard", r2: "Express" },
  ar: { title: "دليل التصميم", sub: "فخامة هادئة. زجاج. أسعار صادقة.", theme: ["النظام", "فاتح", "داكن"], lang: ["EN", "AR"], name: "فستان قميص كتان", seller: "مانتل أتيليه", launch: "سعر الإطلاق", save: "حفظ", more: "عرض الكل", info: "توصيل مجاني على هذا الطلب.", warn: "متبقي قطعتان فقط بمقاس M.", err: "أدخل رقم موبايل صحيح.", ok: "تم التحقق من السعر.", label: "رقم الموبايل", helper: "سنرسل لك رمزاً.", open: "افتح القائمة", toast: "أظهر إشعاراً", empty: "سلتك فارغة", emptyBody: "أضف شيئاً يعجبك.", shop: "تسوق الآن", add: "أضف إلى السلة", verified: "خصم موثّق", lowest: "الأقل خلال ٣٠ يوماً", sponsored: "إعلان", live: "إطلاق مباشر", plus: "بلس", deliveryLeft: "أضف ١٢٠ ج.م للتوصيل المجاني", price: "١٬٢٥٠ ج.م", ref: "١٬٦٦٧ ج.م", pct: "-٢٥٪", newTitle: "مختارات العيد", newSub: "قطع منتقاة بأسعار صادقة.", discover: "اكتشف", check: "تذكرني", sw: "الإشعارات", r1: "عادي", r2: "سريع" },
} as const;

/** `?g=0..9 (&bar=0 hides the controls)` shows one group of sections (for screenshots); omitted shows all. */
const GroupContext = createContext<number | null>(null);
function Section(props: { title: string; group: number; children: ReactNode }) {
  const g = useContext(GroupContext);
  if (g !== null && g !== props.group) return null;
  return (
    <View style={{ gap: 14 }}>
      <Divider />
      <Eyebrow>{props.title}</Eyebrow>
      {props.children}
    </View>
  );
}

function Gallery(props: { lang: "en" | "ar" }) {
  const c = COPY[props.lang];
  const theme = useTheme();
  const toast = useToast();
  const [sheet, setSheet] = useState(false);
  const [seg, setSeg] = useState(0);
  const [chk, setChk] = useState(true);
  const [sw, setSw] = useState(true);
  const [radio, setRadio] = useState(0);
  const [qty, setQty] = useState(2);
  const [size, setSize] = useState<string | null>("m");
  const [text, setText] = useState("");
  const [saved, setSaved] = useState(false);
  const claim = { referenceMinor: 166700n, percent: 25, verified: true, referenceText: c.ref, percentText: c.pct };
  return (
    <Screen title={c.title}>
      <Text variant="callout" secondary>{c.sub}</Text>

      <Section title="Identity" group={8}>
        <View style={{ alignItems: "center", gap: 20, paddingVertical: 24 }}>
          <Monogram size={96} />
          <Wordmark size={30} />
          <Text variant="lede" secondary align="center">{props.lang === "ar" ? "الأناقة بأسعار صادقة" : "Considered pieces. Honest prices."}</Text>
        </View>
        <View style={{ flexDirection: "row", gap: 0 }}>
          {([["ink", brand.ink], ["teal", brand.teal], ["forest", brand.forest], ["sage", brand.sage], ["sand", brand.sand], ["ivory", brand.ivory]] as const).map(([n, hex]) => (
            <View key={n} style={{ flex: 1, height: 72, backgroundColor: hex, justifyContent: "flex-end", padding: 6, borderWidth: 1, borderColor: theme.colors.hairline }}>
              <Text variant="caption" style={{ color: n === "ivory" || n === "sand" || n === "sage" ? brand.ink : brand.ivory, fontSize: 10 }}>{n}</Text>
            </View>
          ))}
        </View>
        <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap" }}>
          <Button title={c.add} onPress={() => undefined} fullWidth={false} />
          <Button title={c.discover} variant="brand" onPress={() => undefined} fullWidth={false} />
          <Button title={c.discover} variant="secondary" onPress={() => undefined} fullWidth={false} />
        </View>
        <Text variant="caption" secondary>{`brand=${theme.colors.brand} · bg=${theme.colors.background} · dark bg=${tokenColors.dark.background}`}</Text>
      </Section>

      <Section title="Motion, depth & art" group={9}>
        <Text variant="callout" secondary>{props.lang === "ar" ? "ظهور متتابع، ضغط بنبض خفيف، لمعان هيكلي." : "Staggered reveal, spring press, skeleton shimmer."}</Text>
        {[0, 1, 2].map((i) => (
          <Reveal key={`${props.lang}-${theme.scheme}-${i}`} index={i}>
            <ListRow leadingIcon="sparkles-outline" title={`${c.plus} ${i + 1}`} subtitle={c.helper} onPress={() => undefined} divider />
          </Reveal>
        ))}
        <View style={{ gap: 8 }}><Skeleton height={14} width="60%" /><Skeleton height={14} /><Skeleton height={120} /></View>
        <View style={{ flexDirection: "row", gap: 8 }}>
          {(["dress", "sneaker", "bag"] as const).map((k, i) => <View key={k} style={{ flex: 1 }}><ProductArt kind={k} seed={`g${i}`} ratio="3:4" /></View>)}
        </View>
        <StoreCover seed="atelier" aspect={2.2} />
        <HeroArt variant="sale" aspect={2} />
        <HeroArt variant="drop" aspect={2} />
      </Section>

      <Section title="Typography" group={0}>
        <Text variant="hero">More than just clothes.</Text>
        <Text variant="hero" style={{ fontStyle: "italic" }}>Hero italic 48/54</Text>
        <Text variant="display">Display 38/46</Text>
        <Text variant="title1">Title 1 28/34</Text>
        <Text variant="quote">Quote 22/30</Text>
        <Text variant="lede" secondary>Lede 17/26 Inter</Text>
        <Text variant="title2">Title 2 20/26</Text>
        <Text variant="headline">Headline 17/24</Text>
        <Text variant="body">Body 16/24: Soft linen, cut long.</Text>
        <Text variant="callout">Callout 15/22</Text>
        <Text variant="caption" secondary>Caption 13/18</Text>
        <Eyebrow>Eyebrow 11/14</Eyebrow>
        <Text variant="body">{props.lang === "ar" ? "الخط العربي: IBM Plex Sans Arabic وAmiri، ١٢٣٤٥" : "Inter tabular 1,234.50 / 0,000.00"}</Text>
      </Section>

      <Section title="Imagery & hero" group={1}>
        <FullBleedHero imageNode={<HeroArt variant="eid" aspect={4 / 5} />} eyebrow={c.plus} title={c.newTitle} subtitle={c.newSub} aspectRatio={4 / 5} action={<Button title={c.discover} onPress={() => undefined} onImage fullWidth={false} />} />
        <GlassSurface radius={24} elevated innerStyle={{ padding: 16, gap: 6 }}>
          <Eyebrow>Glass</Eyebrow>
          <Text variant="callout">{c.info}</Text>
        </GlassSurface>
      </Section>

      <Section title="Buttons" group={2}>
        <Button title={c.add} onPress={() => toast.show(c.ok, "success")} />
        <Button title={c.add} variant="secondary" onPress={() => undefined} />
        <Button title={c.add} variant="ghost" onPress={() => undefined} />
        <Button title={c.add} variant="destructive" onPress={() => undefined} />
        <Button title={c.add} onPress={() => undefined} loading />
        <Button title={c.add} onPress={() => undefined} disabled />
        <View style={{ flexDirection: "row" }}>
          <IconButton icon="heart-outline" label={c.save} onPress={() => undefined} />
          <IconButton icon="share-outline" label="Share" onPress={() => undefined} />
          <IconButton icon="close" label="Close" onPress={() => undefined} variant="glass" />
        </View>
        <View style={{ flexDirection: "row", gap: 18 }}>
          <IconButton variant="sand" icon="shirt-outline" label="Women" caption="Women" onPress={() => undefined} />
          <IconButton variant="sand" icon="bag-handle-outline" label="Bags" caption="Bags" onPress={() => undefined} />
          <IconButton variant="sand" icon="glasses-outline" label="Accessories" caption="Accessories" onPress={() => undefined} />
          <IconButton variant="sand" icon="pricetag-outline" label="Sale" caption="Sale" onPress={() => undefined} />
        </View>
      </Section>

      <Section title="Fields & selection" group={3}>
        <SearchField value={text} onChangeText={setText} placeholder={c.label} />
        <TextField label={c.label} value={text} onChangeText={setText} helper={c.helper} keyboardType="phone-pad" />
        <TextField label={c.label} value="1012" onChangeText={() => undefined} error={c.err} />
        <Checkbox label={c.check} value={chk} onValueChange={setChk} />
        <SwitchRow label={c.sw} value={sw} onValueChange={setSw} />
        <Radio label={c.r1} selected={radio === 0} onPress={() => setRadio(0)} />
        <Radio label={c.r2} selected={radio === 1} onPress={() => setRadio(1)} />
        <SegmentedControl options={[c.r1, c.r2, c.plus]} index={seg} onChange={setSeg} />
        <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
          <Chip label={c.r1} selected /><Chip label={c.r2} onPress={() => undefined} /><Chip label={c.lowest} icon="trending-down" onPress={() => undefined} />
        </View>
        <SizeSelector options={[{ id: "xs", label: "XS", available: false }, { id: "s", label: "S", available: true }, { id: "m", label: "M", available: true, yours: true }, { id: "l", label: "L", available: true }]} selectedId={size} onSelect={setSize} />
        <QuantityStepper value={qty} onChange={setQty} decrementLabel="-" incrementLabel="+" />
        <ProgressBar current={1880} target={2000} label={c.deliveryLeft} />
        <Text variant="caption" secondary>{c.deliveryLeft}</Text>
      </Section>

      <Section title="Badges & prices" group={4}>
        <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
          <Badge kind="verified" label={c.verified} /><Badge kind="lowest30" label={c.lowest} /><Badge kind="launch" label={c.launch} />
          <Badge kind="sponsored" label={c.sponsored} /><Badge kind="live" label={c.live} /><Badge kind="plus" label={c.plus} />
        </View>
        <PriceBlock size="lg" priceText={c.price} priceMinor={125000n} claim={claim} verifiedLabel={c.verified} />
        <PriceBlock priceText={c.price} priceMinor={125000n} launch launchLabel={c.launch} />
        <PriceBlock priceText={c.price} priceMinor={125000n} claim={{ ...claim, verified: false }} />
        <Rating value={4.5} count={210} countText="(210)" />
      </Section>

      <Section title="Cards" group={5}>
        <View style={{ flexDirection: "row", gap: 12 }}>
          <View style={{ flex: 1 }}><ProductCard imageNode={<ProductArt kind="dress" seed="a" ratio="3:4" />} title={c.name} sellerName={c.seller} priceText={c.price} priceMinor={125000n} claim={claim} saved={saved} onToggleSave={() => setSaved(!saved)} saveLabel={c.save} onPress={() => undefined} /></View>
          <View style={{ flex: 1 }}><ProductCard imageNode={<ProductArt kind="sneaker" seed="b" ratio="3:4" />} title={c.name} sellerName={c.seller} priceText={c.price} priceMinor={125000n} launch launchLabel={c.launch} badge={<Badge kind="sponsored" label={c.sponsored} />} onToggleSave={() => undefined} saveLabel={c.save} onPress={() => undefined} /></View>
        </View>
        <StoreCard name={c.seller} meta="Cairo · 4.8" coverNode={<StoreCover seed="s" aspect={1.6} />} avatarNode={<StoreAvatar seed="s" name={c.seller} size={40} />} onPress={() => undefined} badge={<Badge kind="live" label={c.live} />} />
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}><Avatar name={c.seller} /><Skeleton width={120} height={14} /></View>
      </Section>

      <Section title="Lists & notices" group={6}>
        <SectionHeader title={c.title} actionLabel={c.more} onAction={() => undefined} />
        <View>
          <ListRow leadingIcon="receipt-outline" title={c.r1} subtitle={c.helper} onPress={() => undefined} divider />
          <ListRow leadingIcon="wallet-outline" title={c.r2} value={c.price} onPress={() => undefined} divider />
          <ListRow leadingIcon="sparkles-outline" title={c.plus} onPress={() => undefined} />
        </View>
        <Card variant="elevated"><Text variant="headline" weight="600">{c.title}</Text><Text variant="callout" secondary>{c.info}</Text></Card>
        <View style={{ height: 92, overflow: "hidden", borderRadius: 18, borderWidth: 1, borderColor: theme.colors.hairline }}>
          <TabBar items={[
            { key: "h", label: "Home", icon: "home-outline", selected: true, onPress: () => undefined },
            { key: "s", label: "Shop", icon: "bag-handle-outline", selected: false, onPress: () => undefined },
            { key: "w", label: "Wishlist", icon: "heart-outline", selected: false, onPress: () => undefined },
            { key: "p", label: "Profile", icon: "person-outline", selected: false, onPress: () => undefined },
          ]} />
        </View>
        <Banner tone="info" message={c.info} />
        <Banner tone="warning" message={c.warn} />
        <Banner tone="error" message={c.err} />
        <Banner tone="success" message={c.ok} />
        <EmptyState title={c.empty} description={c.emptyBody} actionTitle={c.shop} onAction={() => undefined} />
      </Section>

      <Section title="Overlays" group={7}>
        <Button title={c.open} variant="secondary" onPress={() => setSheet(true)} />
        <Button title={c.toast} variant="secondary" onPress={() => toast.show(c.ok, "success")} />
        <Text variant="caption" secondary>{`isRTL=${String(theme.isRTL)} · ${theme.scheme} · fonts=${String(theme.fontsLoaded)} · reduceTransparency=${String(theme.reduceTransparency)}`}</Text>
      </Section>
      <BottomSheet visible={sheet} onClose={() => setSheet(false)} title={c.title}>
        <Text variant="body" secondary>{c.info}</Text>
        <Button title={c.add} onPress={() => setSheet(false)} />
      </BottomSheet>
      <View style={{ height: 120 }} />
    </Screen>
  );
}

/** Wrapper with theme + language controls pinned above the gallery. */
function StyleGuideDev() {
  const parent = useTheme();
  const q = useLocalSearchParams<{ g?: string; lang?: string; theme?: string; bar?: string }>();
  const [lang, setLang] = useState<"en" | "ar">(q.lang === "ar" ? "ar" : parent.isRTL ? "ar" : "en");
  useEffect(() => {
    if (q.lang === "ar" || q.lang === "en") setLang(q.lang);
    if (q.theme === "light" || q.theme === "dark" || q.theme === "system") parent.setPreference(q.theme);
  }, [q.lang, q.theme]);
  const group = q.g !== undefined && /^[0-9]$/.test(q.g) ? Number(q.g) : null;
  const c = COPY[lang];
  const prefs: ThemePreference[] = ["system", "light", "dark"];
  return (
    <ThemeProvider preference={parent.preference} onPreferenceChange={parent.setPreference} isRTL={lang === "ar"} fontsLoaded={parent.fontsLoaded}>
      <View style={{ flex: 1 }}>
        <GroupContext.Provider value={group}><Gallery lang={lang} /></GroupContext.Provider>
        {q.bar === "0" ? null : <View style={{ position: "absolute", start: 0, end: 0, bottom: 0 }}>
          <GlassSurface edges="top" innerStyle={{ paddingHorizontal: 20, paddingTop: 10, paddingBottom: 28, gap: 6 }}>
            <SegmentedControl options={[...c.theme]} index={prefs.indexOf(parent.preference)} onChange={(i) => parent.setPreference(prefs[i] ?? "system")} testID="sg-theme" />
            <SegmentedControl options={[...c.lang]} index={lang === "en" ? 0 : 1} onChange={(i) => setLang(i === 0 ? "en" : "ar")} testID="sg-lang" />
          </GlassSurface>
        </View>}
      </View>
    </ThemeProvider>
  );
}

/** Dev-only route: in a production bundle nothing below the gate mounts (no effects run) and the user is sent home. */
export default function StyleGuide() {
  if (typeof __DEV__ !== "undefined" && !__DEV__) return <Redirect href="/" />;
  return <StyleGuideDev />;
}
