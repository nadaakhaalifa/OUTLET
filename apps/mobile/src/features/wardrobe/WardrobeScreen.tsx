import { useCallback, useEffect, useMemo, useState } from "react";
import { View, useWindowDimensions } from "react-native";
import { Image } from "expo-image";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { radius, spacing } from "@outlet/ui-tokens";
import { Banner, Button, Chip, Divider, Eyebrow, PressScale, Reveal, Screen, Skeleton, SwitchRow, Text, useTheme } from "../../ui";
import { ProductArt, type ProductKind } from "../../art";
import { OfflineBanner, StateScreen } from "../../components/states";
import { getFeaturePorts } from "../../state/ports";
import { reasonOf, type AiFailureReason } from "../ai-failure";
import type { PhotoPickerPort } from "../returns/model";
import {
  CATEGORIES, COLOURS, EMPTY_ATTRIBUTES, FORMALITY, MATERIALS, PATTERNS, WARDROBE_CAP, WARDROBE_SEASONS, atCapacity, canSuggest, missingFields, reviewCount, sortItems, togglePalette, toggleSeason,
  type WardrobeAttributes, type WardrobeItem, type WardrobePort,
} from "./model";

const KIND: Readonly<Record<string, ProductKind>> = { top: "tee", bottom: "jeans", dress: "dress", shoes: "sneaker", bag: "bag", accessory: "scarf", outerwear: "jacket" };

function ErrorBanner(props: { reason: AiFailureReason; onPrivacy: () => void }) {
  const { t } = useTranslation();
  return (
    <View style={{ gap: spacing.sm }}>
      <Banner tone={props.reason === "consent" ? "info" : "error"} message={t(`aiFailure.${props.reason}`)} />
      {props.reason === "consent" ? <Button title={t("wardrobe.openPrivacy")} variant="secondary" fullWidth={false} onPress={props.onPrivacy} /> : null}
    </View>
  );
}

function Tile(props: { item: WardrobeItem; width: number; port: WardrobePort; onPress: () => void }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { item } = props;
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (item.photo !== "clean") {
      setUrl(null);
      return;
    }
    let alive = true;
    props.port.photoUrl(item.id).then((u) => { if (alive) setUrl(u); }, () => undefined);
    return () => { alive = false; };
  }, [item.id, item.photo, props.port]);
  const cat = item.attributes.category;
  const label = cat !== null ? t(`wardrobe.category.${cat}`) : t("wardrobe.uncategorised");
  return (
    <PressScale onPress={props.onPress} accessibilityRole="button" accessibilityLabel={item.needsReview ? t("wardrobe.tileReview", { name: label }) : label} style={{ width: props.width }}>
      <View style={{ width: props.width, gap: spacing.xs }}>
        <View style={{ width: props.width, height: Math.round(props.width * (4 / 3)), backgroundColor: colors.fill, overflow: "hidden", borderRadius: radius.lg }}>
          {url !== null ? (
            <Image source={{ uri: url }} style={{ width: "100%", height: "100%" }} contentFit="cover" accessibilityLabel={label} />
          ) : (
            <ProductArt kind={KIND[cat ?? "top"] ?? "tee"} seed={item.id} ratio="3:4" />
          )}
        </View>
        <Text variant="callout" numberOfLines={1}>{label}</Text>
        {item.needsReview ? <Eyebrow>{t("wardrobe.needsReview")}</Eyebrow> : item.photo === "pending_scan" ? <Text variant="caption" secondary>{t("wardrobe.scanning")}</Text> : null}
      </View>
    </PressScale>
  );
}

function Pick<T extends string>(props: { heading: string; all: readonly T[]; value: T | null; label: (v: T) => string; onChange: (v: T | null) => void }) {
  return (
    <View style={{ gap: spacing.sm }}>
      <Eyebrow>{props.heading}</Eyebrow>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
        {props.all.map((v) => <Chip key={v} label={props.label(v)} selected={props.value === v} onPress={() => props.onChange(props.value === v ? null : v)} />)}
      </View>
    </View>
  );
}

function ItemForm(props: {
  port: WardrobePort;
  photos: PhotoPickerPort;
  item: WardrobeItem | null;
  onBack: () => void;
  onSaved: (i: WardrobeItem) => void;
  onDeleted: (id: string) => void;
  onPrivacy: () => void;
}) {
  const { t } = useTranslation();
  const { item } = props;
  const [attrs, setAttrs] = useState<WardrobeAttributes>(item?.attributes ?? EMPTY_ATTRIBUTES);
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [current, setCurrent] = useState<WardrobeItem | null>(item);
  const [busy, setBusy] = useState<"save" | "suggest" | "delete" | null>(null);
  const [failure, setFailure] = useState<AiFailureReason | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [suggested, setSuggested] = useState(false);
  const set = (p: Partial<WardrobeAttributes>) => setAttrs((a) => ({ ...a, ...p }));
  const missing = missingFields(attrs);

  const pick = async () => {
    setFailure(null);
    try {
      const p = await props.photos.pick();
      if (p !== null) setPhotoUri(p.uri);
    } catch {
      setFailure("failed");
    }
  };
  const run = async (kind: "save" | "suggest" | "delete") => {
    setBusy(kind);
    setFailure(null);
    try {
      if (kind === "delete" && current !== null) {
        await props.port.remove(current.id);
        props.onDeleted(current.id);
        return;
      }
      if (kind === "suggest" && current !== null) {
        const s = await props.port.suggest(current.id);
        setCurrent(s);
        setAttrs(s.attributes);
        setSuggested(true);
        props.onSaved(s);
        return;
      }
      const saved = current === null ? await props.port.add({ photoUri, attributes: attrs }) : await props.port.update(current.id, attrs, current.version);
      setCurrent(saved);
      props.onSaved(saved);
      if (item === null) props.onBack();
    } catch (e) {
      setFailure(reasonOf(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Screen title={t(item === null ? "wardrobe.addTitle" : "wardrobe.editTitle")} onBack={props.onBack} backLabel={t("common.back")}>
      {current?.needsReview === true || suggested ? <Banner tone="info" message={t("wardrobe.reviewNote")} /> : null}
      {item === null ? (
        <View style={{ gap: spacing.sm }}>
          <Button title={t(photoUri === null ? "wardrobe.pickPhoto" : "wardrobe.changePhoto")} variant="secondary" icon="image-outline" onPress={() => void pick()} />
          <Text variant="caption" secondary>{t(photoUri === null ? "wardrobe.photoHelp" : "wardrobe.photoChosen")}</Text>
        </View>
      ) : null}
      <Pick heading={t("wardrobe.fields.category")} all={CATEGORIES} value={attrs.category} label={(v) => t(`wardrobe.category.${v}`)} onChange={(v) => set({ category: v })} />
      <View style={{ gap: spacing.sm }}>
        <Eyebrow>{t("wardrobe.fields.palette")}</Eyebrow>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
          {COLOURS.map((c) => <Chip key={c} label={t(`wardrobe.colour.${c}`)} selected={attrs.palette.includes(c)} onPress={() => set({ palette: togglePalette(attrs.palette, c) })} />)}
        </View>
      </View>
      <Pick heading={t("wardrobe.fields.pattern")} all={PATTERNS} value={attrs.pattern} label={(v) => t(`wardrobe.pattern.${v}`)} onChange={(v) => set({ pattern: v })} />
      <Pick<`${(typeof FORMALITY)[number]}`>
        heading={t("wardrobe.fields.formality")}
        all={FORMALITY.map((f) => `${f}` as const)}
        value={attrs.formality === null ? null : (`${attrs.formality}` as const)}
        label={(v) => t(`wardrobe.formality.${v}`)}
        onChange={(v) => set({ formality: v === null ? null : (Number(v) as WardrobeAttributes["formality"]) })}
      />
      <View style={{ gap: spacing.sm }}>
        <Eyebrow>{t("wardrobe.fields.seasons")}</Eyebrow>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
          {WARDROBE_SEASONS.map((s) => <Chip key={s} label={t(`outfitCalendar.season.${s}`)} selected={attrs.seasons.includes(s)} onPress={() => set({ seasons: toggleSeason(attrs.seasons, s) })} />)}
        </View>
      </View>
      <Pick heading={t("wardrobe.fields.material")} all={MATERIALS} value={attrs.material} label={(v) => t(`wardrobe.material.${v}`)} onChange={(v) => set({ material: v })} />
      <SwitchRow label={t("stylist.modest")} value={attrs.modest === true} onValueChange={(v) => set({ modest: v })} />
      {missing.length > 0 ? <Text variant="caption" secondary>{t("wardrobe.missing", { fields: missing.map((m) => t(`wardrobe.fields.${m}`)).join(", ") })}</Text> : null}
      {failure !== null ? <ErrorBanner reason={failure} onPrivacy={props.onPrivacy} /> : null}
      <Button
        variant="brand"
        title={t(current?.needsReview === true ? "wardrobe.confirm" : "wardrobe.save")}
        loading={busy === "save"}
        disabled={busy !== null}
        onPress={() => void run("save")}
      />
      {current !== null && canSuggest(current) ? (
        <Button title={t("wardrobe.suggest")} variant="secondary" loading={busy === "suggest"} disabled={busy !== null} onPress={() => void run("suggest")} />
      ) : null}
      {current !== null ? (
        confirmDelete ? (
          <View style={{ gap: spacing.sm }}>
            <Text>{t("wardrobe.deleteConfirm")}</Text>
            <Button title={t("wardrobe.deleteYes")} variant="secondary" disabled={busy !== null} onPress={() => void run("delete")} />
            <Button title={t("common.cancel")} variant="ghost" onPress={() => setConfirmDelete(false)} />
          </View>
        ) : (
          <Button title={t("wardrobe.delete")} variant="secondary" disabled={busy !== null} onPress={() => setConfirmDelete(true)} />
        )
      ) : null}
    </Screen>
  );
}

type Load = { status: "loading" } | { status: "error"; reason: AiFailureReason } | { status: "ready"; items: readonly WardrobeItem[] };
type Mode = { kind: "grid" } | { kind: "form"; id: string | null };

/** Me > Wardrobe. */
export function WardrobeScreen(props: { port?: WardrobePort; photos?: PhotoPickerPort }) {
  const { t } = useTranslation();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const { gutter } = useTheme();
  const port = useMemo<WardrobePort>(() => props.port ?? getFeaturePorts().wardrobe, [props.port]);
  const photos = props.photos ?? getFeaturePorts().photos;
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [mode, setMode] = useState<Mode>({ kind: "grid" });
  const [confirmClear, setConfirmClear] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<AiFailureReason | "cleared" | null>(null);

  const reload = useCallback(async () => {
    setLoad({ status: "loading" });
    try {
      setLoad({ status: "ready", items: sortItems(await port.list()) });
    } catch (e) {
      setLoad({ status: "error", reason: reasonOf(e) });
    }
  }, [port]);
  useEffect(() => {
    void reload();
  }, [reload]);

  const items = load.status === "ready" ? load.items : [];
  const toPrivacy = () => router.push("/privacy-center");
  const upsert = (i: WardrobeItem) => setLoad({ status: "ready", items: sortItems(items.some((x) => x.id === i.id) ? items.map((x) => (x.id === i.id ? i : x)) : [...items, i]) });

  if (mode.kind === "form") {
    const editing = mode.id === null ? null : (items.find((i) => i.id === mode.id) ?? null);
    return (
      <ItemForm
        key={mode.id ?? "new"}
        port={port}
        photos={photos}
        item={editing}
        onBack={() => setMode({ kind: "grid" })}
        onSaved={upsert}
        onDeleted={(id) => {
          setLoad({ status: "ready", items: items.filter((i) => i.id !== id) });
          setMode({ kind: "grid" });
        }}
        onPrivacy={toPrivacy}
      />
    );
  }

  const clear = async () => {
    setBusy(true);
    setConfirmClear(false);
    try {
      await port.clear();
      setLoad({ status: "ready", items: [] });
      setNotice("cleared");
    } catch (e) {
      setNotice(reasonOf(e));
    } finally {
      setBusy(false);
    }
  };

  const tileW = Math.floor((width - gutter * 2 - spacing.md) / 2);
  const review = reviewCount(items);
  return (
    <Screen title={t("wardrobe.title")} onBack={() => router.back()} backLabel={t("common.back")}>
      <Text variant="lede" secondary>{t("wardrobe.intro")}</Text>
      <View style={{ gap: spacing.xs }}>
        <Eyebrow>{t("wardrobe.privacyHeading")}</Eyebrow>
        <Text variant="callout">{t("wardrobe.privacyBody")}</Text>
        <PressScale onPress={toPrivacy} accessibilityRole="link" accessibilityLabel={t("wardrobe.openPrivacy")} innerStyle={{ minHeight: 44, justifyContent: "center" }}>
          <Text variant="callout" accessibilityRole="none" style={{ textDecorationLine: "underline" }}>{t("wardrobe.openPrivacy")}</Text>
        </PressScale>
      </View>
      <Divider />
      <OfflineBanner visible={load.status === "error" && load.reason === "offline"} message={t("common.offlineBanner")} />
      {load.status === "loading" ? (
        <View accessibilityRole="progressbar" accessibilityLabel={t("wardrobe.loading")} style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.md }}>
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} width={tileW} height={Math.round(tileW * (4 / 3))} radius={18} />)}
        </View>
      ) : null}
      {load.status === "error" ? (
        <StateScreen
          illustration={load.reason === "offline" ? "offline" : "error"}
          title={t(load.reason === "disabled" ? "wardrobe.pausedTitle" : load.reason === "offline" ? "stylist.offlineTitle" : "wardrobe.errorTitle")}
          description={t(`aiFailure.${load.reason}`)}
          actionTitle={t("common.retry")}
          onAction={() => void reload()}
        />
      ) : null}
      {load.status === "ready" ? (
        <>
          {notice === "cleared" ? <Banner tone="success" message={t("wardrobe.cleared")} /> : null}
          {notice !== null && notice !== "cleared" ? <ErrorBanner reason={notice} onPrivacy={toPrivacy} /> : null}
          {items.length === 0 ? (
            <StateScreen illustration="emptyBag" title={t("wardrobe.emptyTitle")} description={t("wardrobe.emptyBody")} actionTitle={t("wardrobe.add")} onAction={() => setMode({ kind: "form", id: null })} />
          ) : (
            <>
              {atCapacity(items.length) ? <Banner tone="info" message={t("wardrobe.full", { cap: WARDROBE_CAP })} /> : <Button variant="brand" title={t("wardrobe.add")} onPress={() => setMode({ kind: "form", id: null })} />}
              <Text variant="caption" secondary numeric>{t("wardrobe.count", { count: items.length, cap: WARDROBE_CAP })}</Text>
              {review > 0 ? <Banner tone="info" message={t("wardrobe.reviewCount", { count: review })} /> : null}
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.md }}>
                {items.map((i, n) => (
                  <Reveal key={i.id} index={n}>
                    <Tile item={i} width={tileW} port={port} onPress={() => setMode({ kind: "form", id: i.id })} />
                  </Reveal>
                ))}
              </View>
              <Divider />
              {confirmClear ? (
                <View style={{ gap: spacing.sm }}>
                  <Text>{t("wardrobe.clearConfirm", { count: items.length })}</Text>
                  <Button title={t("wardrobe.clearYes")} variant="secondary" disabled={busy} onPress={() => void clear()} />
                  <Button title={t("common.cancel")} variant="ghost" onPress={() => setConfirmClear(false)} />
                </View>
              ) : (
                <Button title={t("wardrobe.clear")} variant="secondary" disabled={busy} onPress={() => setConfirmClear(true)} />
              )}
            </>
          )}
        </>
      ) : null}
    </Screen>
  );
}
