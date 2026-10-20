// DEV-ONLY gallery for the brand and placeholder imagery kit. Not part of the product.
import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { Redirect, useLocalSearchParams } from "expo-router";
import { colors } from "@outlet/ui-tokens";
import {
  CATEGORY_NAMES, CategoryIcon, HERO_VARIANTS, HeroArt, ILLUSTRATION_NAMES, Illustration, Monogram,
  PRODUCT_KINDS, ProductArt, StoreAvatar, StoreCover, Wordmark, type ArtTone,
} from "../art";

const SEEDS = ["alpha", "bravo", "charlie"] as const;
const STORES = ["Nile Atelier", "مصنع القاهرة", "Delta Denim"] as const;

function Section({ title, tone, children }: { title: string; tone: ArtTone; children: React.ReactNode }) {
  return (
    <View style={{ marginTop: 22 }}>
      <Text style={{ color: tone === "light" ? colors.dark.background : colors.light.background, fontSize: 15, fontWeight: "700", marginBottom: 8 }}>{title}</Text>
      {children}
    </View>
  );
}

function ArtGalleryDev() {
  const q = useLocalSearchParams<{ dark?: string; y?: string }>();
  const [tone, setTone] = useState<ArtTone>(q.dark === "1" ? "dark" : "light");
  const ref = useRef<ScrollView>(null);
  useEffect(() => {
    ref.current?.scrollTo({ y: Number(q.y ?? 0), animated: false });
    if (q.dark !== undefined) setTone(q.dark === "1" ? "dark" : "light");
  }, [q.y, q.dark]);
  const fg = tone === "light" ? colors.dark.background : colors.light.background;
  const bg = tone === "light" ? colors.light.background : colors.dark.background;
  const wrap = { flexDirection: "row", flexWrap: "wrap", gap: 8 } as const;
  return (
    <ScrollView ref={ref} onLayout={() => ref.current?.scrollTo({ y: Number(q.y ?? 0), animated: false })} style={{ flex: 1, backgroundColor: bg }} contentContainerStyle={{ padding: 16, paddingTop: 60, paddingBottom: 80 }}>
      <Pressable onPress={() => setTone(tone === "light" ? "dark" : "light")}>
        <Text style={{ color: fg, fontWeight: "700" }}>ART GALLERY (placeholder kit, dev only) - tap: {tone}</Text>
      </Pressable>
      <Section title="Brand" tone={tone}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 20 }}>
          <Monogram size={72} tone={tone} />
          <Monogram size={72} tone={tone === "light" ? "dark" : "light"} filled />
          <Wordmark size={22} tone={tone} />
        </View>
      </Section>
      <Section title="ProductArt 3:4 (placeholder)" tone={tone}>
        <View style={wrap}>
          {PRODUCT_KINDS.map((k, i) => (
            <View key={k} style={{ width: "31.5%" }}>
              <ProductArt kind={k} seed={SEEDS[i % 3] ?? "a"} tone={tone} />
              <Text style={{ color: fg, fontSize: 11 }}>{k}</Text>
            </View>
          ))}
        </View>
      </Section>
      <Section title="Seeds x ratios (tee, dress, sneaker)" tone={tone}>
        {(["tee", "dress", "sneaker"] as const).map((k) => (
          <View key={k} style={[wrap, { marginBottom: 8, alignItems: "flex-end" }]}>
            {SEEDS.map((s) => (
              <View key={s} style={{ width: "23%" }}><ProductArt kind={k} seed={s} tone={tone} /></View>
            ))}
            <View style={{ width: "23%" }}><ProductArt kind={k} seed="alpha" ratio="1:1" tone={tone} /></View>
          </View>
        ))}
        <ProductArt kind="bag" seed="charlie" ratio="16:9" tone={tone} />
      </Section>
      <Section title="StoreCover + StoreAvatar" tone={tone}>
        {SEEDS.concat("delta" as never).map((s) => (
          <StoreCover key={s} seed={s} tone={tone} style={{ marginBottom: 8, borderRadius: 12 }} />
        ))}
        <View style={{ flexDirection: "row", gap: 10 }}>
          {STORES.map((n) => <StoreAvatar key={n} name={n} tone={tone} size={52} />)}
        </View>
      </Section>
      <Section title="HeroArt" tone={tone}>
        {HERO_VARIANTS.map((v) => <HeroArt key={v} variant={v} style={{ marginBottom: 8, borderRadius: 14 }} />)}
      </Section>
      <Section title="Illustrations" tone={tone}>
        <View style={wrap}>
          {ILLUSTRATION_NAMES.map((n) => (
            <View key={n} style={{ alignItems: "center", width: "31%" }}>
              <Illustration name={n} size={92} tone={tone} label={n} />
              <Text style={{ color: fg, fontSize: 10 }}>{n}</Text>
            </View>
          ))}
        </View>
      </Section>
      <Section title="Category icons" tone={tone}>
        <View style={wrap}>
          {CATEGORY_NAMES.map((n) => (
            <View key={n} style={{ alignItems: "center", width: "22%" }}>
              <CategoryIcon name={n} size={34} tone={tone} label={n} />
              <Text style={{ color: fg, fontSize: 10 }}>{n}</Text>
            </View>
          ))}
        </View>
      </Section>
    </ScrollView>
  );
}

/** Dev-only route: in a production bundle nothing below the gate mounts (no effects run) and the user is sent home. */
export default function ArtGallery() {
  if (typeof __DEV__ !== "undefined" && !__DEV__) return <Redirect href="/" />;
  return <ArtGalleryDev />;
}
