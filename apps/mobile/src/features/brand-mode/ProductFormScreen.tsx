import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Pressable, ScrollView, View, useWindowDimensions, type LayoutChangeEvent } from "react-native";
import { Image } from "expo-image";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { radius } from "@outlet/ui-tokens";
import { Banner, BottomSheet, Button, Chip, ChipGroup, Divider, EmptyState, Icon, IconButton, NumberField, PressScale, Radio, Reveal, Screen, SegmentedChoice, SelectRow, Skeleton, StickyBar, Text, TextField, useToast, useTheme, type IconName } from "../../ui";
import { backAction, canContinue, canJumpToPage, LAST_PAGE, pageState, primaryAction, WIZARD_PAGES, wizardChecklist, type FieldAnchor } from "./formSteps";
import { FailureView, ProgressRule, useBrand } from "./kit";
import { freshLink, previewUri, syncJobLinks } from "./cutout-link";
import { pickPhotos } from "./photos";
import { ArchStudio } from "../background-removal/Backdrops";
import { CutoutPanel } from "../background-removal/CutoutPanel";
import { getCutoutPort } from "../background-removal/state";
import { useCutouts, type CutoutsApi } from "../background-removal/useCutouts";
import {
  CONDITIONS, DEPARTMENTS, EMPTY_DRAFT, MAX_PHOTOS, can, failureOf, movePhoto, parseEgp, publishGate, validateDraft, validateSizes,
  type BrandFailure, type Category, type PhotoItem, type ProductDraft, type SizeChartOption,
} from "./model";

/** Unsaved drafts survive leaving the screen (memory). The server draft (autosave) is the durable copy. */
const localDrafts = new Map<string, ProductDraft>();
let uid = 0;
const nextLocalId = (): string => `ph-${Date.now()}-${++uid}`;

export function ProductFormScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const toast = useToast();
  const { port, account, locale } = useBrand();
  const params = useLocalSearchParams<{ id?: string; page?: string }>();
  const editId = typeof params.id === "string" ? params.id : null;
  const key = editId ?? "new";
  const [draft, setDraft] = useState<ProductDraft | null>(null);
  const [failure, setFailure] = useState<BrandFailure | null>(null);
  const [categories, setCategories] = useState<readonly Category[]>([]);
  const [charts, setCharts] = useState<readonly SizeChartOption[]>([]);
  const [save, setSave] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const [busy, setBusy] = useState(false);
  const dirty = useRef(false);
  const latest = useRef<ProductDraft | null>(null);
  const canWrite = can(account.role, "catalog_write");
  const cutouts = useCutouts(useMemo(() => getCutoutPort(account.storeId), [account.storeId]));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // `?page=1|2` opens a later page directly (dev preview and deep links from the checklist).
  const [page, setPage] = useState(() => { const n = Number.parseInt(params.page ?? "", 10); return Number.isFinite(n) ? Math.min(Math.max(n, 0), WIZARD_PAGES.length - 1) : 0; });
  useEffect(() => {
    const n = Number.parseInt(params.page ?? "", 10);
    if (Number.isFinite(n)) setPage(Math.min(Math.max(n, 0), WIZARD_PAGES.length - 1));
  }, [params.page]);
  const [published, setPublished] = useState(false);
  const [priceInfo, setPriceInfo] = useState(false);
  const [picker, setPicker] = useState<"category" | "sizeChart" | null>(null);
  const [catQuery, setCatQuery] = useState("");
  const [descOpen, setDescOpen] = useState(false);
  const [showMissing, setShowMissing] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const fieldTops = useRef<Partial<Record<FieldAnchor, number>>>({});
  const { colors } = useTheme();
  const { fontScale } = useWindowDimensions();

  const load = useCallback(() => {
    setFailure(null);
    const cached = localDrafts.get(key);
    const base = cached !== undefined ? Promise.resolve(cached) : editId === null ? Promise.resolve(EMPTY_DRAFT) : port.getProduct(editId);
    base.then((d) => { latest.current = d; setDraft(d); }, (e: unknown) => setFailure(failureOf(e)));
    port.categories().then(setCategories, () => undefined);
    port.sizeCharts().then(setCharts, () => undefined);
  }, [port, key, editId]);
  useEffect(load, [load]);

  const update = useCallback((patch: (d: ProductDraft) => ProductDraft) => {
    setDraft((d) => {
      if (d === null) return d;
      const n = patch(d);
      latest.current = n;
      localDrafts.set(key, n);
      dirty.current = true;
      return n;
    });
    setSave("idle");
  }, [key]);

  // Autosave: 1.5 s after the last edit, once there is an Arabic title worth saving.
  const persist = useCallback(async (publish: boolean): Promise<{ id: string } | null> => {
    const d = latest.current;
    if (d === null) return null;
    setSave("saving");
    try {
      const r = await port.saveProduct(d, publish);
      const withId = { ...d, id: r.id };
      latest.current = withId;
      setDraft((cur) => (cur === null ? cur : { ...cur, id: r.id }));
      dirty.current = false;
      setSave("saved");
      return { id: r.id };
    } catch (e) {
      setSave("failed");
      if (failureOf(e) === "unsupported") setFailure("unsupported");
      return null;
    }
  }, [port]);
  useEffect(() => {
    if (draft === null || !canWrite || !dirty.current || draft.titleAr.trim() === "") return;
    const id = setTimeout(() => { void persist(false); }, 1500);
    return () => clearTimeout(id);
  }, [draft, canWrite, persist]);

  const uploadInto = useCallback(async (uris: readonly string[], target: "photos" | "defectPhotos") => {
    const items: PhotoItem[] = uris.map((uri) => ({ localId: nextLocalId(), uri, uploadId: null, progress: 0, state: "uploading" }));
    update((d) => ({ ...d, [target]: [...d[target], ...items] }));
    // Background removal runs on its own track: it never blocks the form or the upload above.
    if (target === "photos") {
      items.forEach((it) => cutouts.start(it.localId, it.uri));
      if (items[0] !== undefined) setSelectedId(items[0].localId);
    }
    const setItem = (localId: string, p: Partial<PhotoItem>) => update((d) => ({ ...d, [target]: d[target].map((x) => (x.localId === localId ? { ...x, ...p } : x)) }));
    try {
      const res = await port.uploadPhotos(uris, (i, progress) => { const it = items[i]; if (it !== undefined) setItem(it.localId, { progress }); });
      items.forEach((it, i) => setItem(it.localId, { uploadId: res[i]?.uploadId ?? null, state: res[i] !== undefined ? "done" : "failed", progress: 1 }));
    } catch {
      items.forEach((it) => setItem(it.localId, { state: "failed" }));
    }
  }, [port, update, cutouts]);

  const add = async (source: "library" | "camera", target: "photos" | "defectPhotos") => {
    if (draft === null) return;
    const r = await pickPhotos(source, MAX_PHOTOS - draft[target].length);
    if (r.kind === "denied") toast.show(t("brandMode.form.permission"), "error");
    if (r.kind === "ok") void uploadInto(r.uris, target);
  };

  // A decided cutout becomes the product image: carry its job id on the photo (sent as images[].media_job_id).
  // Linked photos of an opened product have no entry yet: adopt their job so the preview links load and stay fresh.
  useEffect(() => {
    if (draft === null || !canWrite) return;
    draft.photos.forEach((p) => {
      const e = cutouts.entry(p.localId);
      if (p.mediaJobId !== undefined && p.mediaJobId !== null && e.job === null && !e.working && e.block === null) cutouts.adopt(p.localId, p.mediaJobId);
    });
    const synced = syncJobLinks(draft.photos, (id) => cutouts.entry(id).job);
    if (synced.changed) update((d) => ({ ...d, photos: syncJobLinks(d.photos, (id) => cutouts.entry(id).job).photos }));
  }, [draft, canWrite, cutouts, update]);

  const selectedPhoto = useMemo(() => draft?.photos.find((p) => p.localId === selectedId && p.uri !== "") ?? null, [draft?.photos, selectedId]);
  const category = useMemo(() => categories.find((c) => c.id === draft?.categoryId) ?? null, [categories, draft?.categoryId]);
  const gate = draft === null ? null : publishGate(draft, category);
  const errors = draft === null ? {} : validateDraft(draft);
  const sizeRows = draft === null ? null : validateSizes(draft.sizes);

  const publish = async () => {
    if (gate === null || !gate.canPublish) return;
    setBusy(true);
    const r = await persist(true);
    setBusy(false);
    if (r !== null) { localDrafts.delete(key); dirty.current = false; setPublished(true); }
    else toast.show(t("brandMode.orders.actionFailed"), "error");
  };
  const saveDraft = async (silent = false) => {
    if (latest.current === null) return;
    setBusy(true);
    const r = await persist(false);
    setBusy(false);
    if (r !== null && !silent) toast.show(t("brandMode.form.draftSaved"), "success");
    return r;
  };
  const leave = () => {
    if (!dirty.current) { router.back(); return; }
    Alert.alert(t("brandMode.form.discard"), undefined, [
      { text: t("brandMode.form.wizard.discardKeep"), style: "cancel" },
      { text: t("brandMode.form.wizard.discardLeave"), style: "destructive", onPress: () => { localDrafts.delete(key); router.back(); } },
      { text: t("brandMode.form.saveDraft"), onPress: () => { void persist(false).then(() => router.back()); } },
    ]);
  };
  const onBack = () => {
    const a = backAction(page, dirty.current);
    if (a === "previous") setPage((p) => Math.max(0, p - 1));
    else if (a === "confirm_leave") leave();
    else router.back();
  };

  const title = t(editId === null ? "brandMode.form.newTitle" : "brandMode.form.editTitle");
  if (failure !== null && failure !== "unsupported") return <Screen title={title} onBack={() => router.back()}><FailureView failure={failure} onRetry={load} /></Screen>;
  if (draft === null) return <Screen title={title} onBack={() => router.back()}><Skeleton height={200} /><Skeleton height={60} /><Skeleton height={60} /></Screen>;
  if (!canWrite) return <Screen title={title} onBack={() => router.back()}><EmptyState title={t("brandMode.common.forbiddenTitle")} description={t("brandMode.products.forbiddenAdd")} /></Screen>;

  if (published) {
    return (
      <Screen
        scroll={false}
        contentStyle={{ flex: 1, justifyContent: "center" }}
        footer={
          <StickyBar density="compact">
            <Button title={t("brandMode.form.wizard.addAnother")} onPress={() => { localDrafts.delete("new"); latest.current = null; setDraft(null); setPublished(false); setPage(0); setSelectedId(null); load(); if (editId !== null) router.replace("/brand-mode/product-edit"); }} testID="brand-add-another" />
            <Button title={t("brandMode.form.wizard.viewProducts")} variant="ghost" onPress={() => router.replace("/brand-mode/products")} testID="brand-view-products" />
          </StickyBar>
        }
      >
        <Reveal style={{ alignItems: "center", gap: 16 }}>
          <View style={{ width: 88, height: 88, borderRadius: radius.pill, backgroundColor: colors.savings, alignItems: "center", justifyContent: "center" }}>
            <Icon name="checkmark" size={44} color="onSavings" />
          </View>
          <Text variant="title1" align="center" testID="brand-live-title">{t("brandMode.form.wizard.liveTitle")}</Text>
          <Text variant="lede" secondary align="center">{t("brandMode.form.wizard.liveBody")}</Text>
        </Reveal>
      </Screen>
    );
  }

  const err = (code: string | undefined) => (code === undefined ? undefined : t(`brandMode.form.err.${code}`));
  const catLabel = (c: Category) => (locale === "ar" ? c.name.ar : c.name.en);
  const reqLabel = t("brandMode.form.required");
  const pageNames = [t("brandMode.form.wizard.pagePhotos"), t("brandMode.form.wizard.pageDetails"), t("brandMode.form.wizard.pagePrice")];
  const total = WIZARD_PAGES.length;
  const current = pageState(gate ?? { canPublish: false, missing: [] }, page);
  const action = primaryAction(gate ?? { canPublish: false, missing: [] }, page);
  const blocked = !canContinue(gate ?? { canPublish: false, missing: [] }, page);
  const checklist = wizardChecklist(gate ?? { canPublish: false, missing: [] });
  const reason = page < LAST_PAGE ? current.reason : null;
  const savedChip = save === "saved" || (save === "idle" && !dirty.current && draft.id !== null);

  const goPage = (n: number, anchor?: FieldAnchor) => {
    setPage(n);
    if (anchor === undefined) scrollRef.current?.scrollTo({ y: 0, animated: false });
    else setTimeout(() => {
      const y = fieldTops.current[anchor];
      if (y !== undefined) scrollRef.current?.scrollTo({ y: Math.max(0, y - 16), animated: true });
    }, 80);
  };
  const next = async () => {
    if (action === "continue") {
      if (blocked) return;
      if (draft.titleAr.trim() !== "" && dirty.current) void persist(false); // silent autosave, the Saved chip confirms
      goPage(page + 1);
      return;
    }
    if (action === "publish") { await publish(); return; }
    // Incomplete: keep it as a draft and show exactly what is missing.
    if (draft.titleAr.trim() !== "") await saveDraft(true);
    const first = checklist[0];
    toast.show(t("brandMode.form.wizard.savedDraftMissing", { count: checklist.length }), "info");
    if (first !== undefined && first.page !== page) goPage(first.page, first.anchor);
    setShowMissing(true);
  };
  const at = (a: FieldAnchor) => (e: LayoutChangeEvent) => { fieldTops.current[a] = e.nativeEvent.layout.y; };
  const sizeItems = draft.sizes.filter((r) => r.label.trim() !== "");
  const stockOf = (s: string): number => { const n = Number.parseInt(s, 10); return Number.isFinite(n) && n > 0 ? n : 0; };
  const cover = draft.photos[0];

  // One compact row (back, title, save draft) above a thin stage line + segments. At large text the title row scrolls with the form.
  const draftOff = busy || draft.titleAr.trim() === "";
  const titleRow = (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44 }}>
      <IconButton icon="arrow-back" directional size={22} label={t("common.back")} onPress={onBack} testID="brand-form-back" />
      <View style={{ flex: 1 }}>
        <Text variant="title1" numberOfLines={1} accessibilityRole="header" testID="brand-form-title">{title}</Text>
      </View>
      <Pressable
        onPress={() => void saveDraft()}
        disabled={draftOff}
        accessibilityRole="button"
        accessibilityLabel={t("brandMode.form.saveDraft")}
        accessibilityState={{ disabled: draftOff }}
        hitSlop={8}
        style={{ minHeight: 44, justifyContent: "center", opacity: draftOff ? 0.4 : 1 }}
        testID="brand-save-draft"
      >
        <Text variant="callout" weight="600" color="brand" accessibilityRole="none">{t("brandMode.form.saveDraft")}</Text>
      </Pressable>
    </View>
  );
  const stage = (
    <View style={{ gap: 4, paddingBottom: 12, flexShrink: 0 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text variant="caption" secondary testID="brand-form-stage">{page + 1}/{total} · {pageNames[page]}</Text>
        {savedChip ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }} testID="brand-autosave">
            <Icon name="checkmark" size={12} color="savings" />
            <Text variant="caption" weight="500" accessibilityRole="none">{t("brandMode.form.wizard.saved")}</Text>
          </View>
        ) : save === "failed" ? (
          <Text variant="caption" color="danger" testID="brand-autosave">{t("brandMode.form.autosaveFailed")}</Text>
        ) : null}
      </View>
      <View style={{ flexDirection: "row", gap: 6 }} testID="brand-form-steps" accessibilityRole="tablist">
        {WIZARD_PAGES.map((id, i) => {
          const reach = canJumpToPage(page, i);
          return (
            <Pressable
              key={id}
              disabled={!reach}
              accessibilityRole="tab"
              accessibilityState={{ selected: i === page, disabled: !reach }}
              accessibilityLabel={t("brandMode.form.wizard.stepName", { n: i + 1, name: pageNames[i] ?? "" })}
              onPress={() => goPage(i)}
              hitSlop={{ top: 12, bottom: 12 }}
              style={{ flex: 1, height: 3 }}
            >
              <View style={{ flex: 1, borderRadius: radius.pill, backgroundColor: i <= page ? colors.brand : colors.hairline }} />
            </Pressable>
          );
        })}
      </View>
    </View>
  );

  const primaryTitle = action === "continue" ? t("brandMode.form.wizard.continue") : t("brandMode.form.wizard.done");

  return (
    <Screen
      scroll={false}
      gutter={16}
      contentStyle={{ flex: 1, gap: 0 }}
      testID="brand-product-wizard"
      footer={
        <StickyBar>
          {reason !== null && blocked ? (
            <View accessibilityRole="alert" accessibilityLiveRegion="polite" style={{ flexDirection: "row", gap: 6, alignItems: "center" }} testID="brand-continue-reason">
              <Text variant="caption" secondary numberOfLines={1} style={{ flex: 1 }} accessibilityRole="none">{t(`brandMode.form.gate.${reason}`)}</Text>
            </View>
          ) : null}
          <Button density="compact" title={primaryTitle} onPress={() => void next()} disabled={busy || blocked} loading={busy} testID={action === "continue" ? "brand-continue" : "brand-publish"} />
        </StickyBar>
      }
    >
      {fontScale > 1.3 ? null : titleRow}
      {stage}
      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={{ gap: 16, paddingTop: 0, paddingBottom: 12 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        {fontScale > 1.3 ? titleRow : null}
        {failure === "unsupported" ? <Banner tone="warning" message={t("brandMode.common.unsupportedBody")} /> : null}

        {page === 0 ? (
          <>
            <View onLayout={at("photos")}>
              <Text variant="caption" secondary>{t("brandMode.form.photosHelp", { max: MAX_PHOTOS })}</Text>
            </View>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <AddTile icon="camera-outline" label={t("brandMode.form.addFromCamera")} onPress={() => void add("camera", "photos")} disabled={draft.photos.length >= MAX_PHOTOS} testID="brand-photo-camera" />
              <AddTile icon="images-outline" label={t("brandMode.form.addFromLibrary")} onPress={() => void add("library", "photos")} disabled={draft.photos.length >= MAX_PHOTOS} testID="brand-photo-library" />
            </View>
            {draft.photos.length > 0 ? (
              <View style={{ gap: 8 }}>
                <Text variant="callout" weight="500" secondary>{t("brandMode.form.wizard.photosCount", { count: draft.photos.length, max: MAX_PHOTOS })}</Text>
                <PhotoGrid
                  items={draft.photos}
                  cutouts={cutouts}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  onAdd={() => void add("library", "photos")}
                  onRemove={(id) => update((d) => ({ ...d, photos: d.photos.filter((p) => p.localId !== id) }))}
                  onCover={(i) => update((d) => ({ ...d, photos: movePhoto(d.photos, i, 0) }))}
                  onEarlier={(i) => update((d) => ({ ...d, photos: movePhoto(d.photos, i, i - 1) }))}
                  onRetry={(p) => { update((d) => ({ ...d, photos: d.photos.filter((x) => x.localId !== p.localId) })); void uploadInto([p.uri], "photos"); }}
                  max={MAX_PHOTOS}
                />
              </View>
            ) : null}
            {selectedPhoto !== null ? (
              <CutoutPanel
                originalUri={selectedPhoto.uri}
                job={cutouts.entry(selectedPhoto.localId).job}
                block={cutouts.entry(selectedPhoto.localId).block}
                view={cutouts.view(selectedPhoto.localId)}
                acting={cutouts.entry(selectedPhoto.localId).acting}
                onAccept={() => cutouts.accept(selectedPhoto.localId)}
                onUseOriginal={() => cutouts.useOriginal(selectedPhoto.localId)}
                onRerun={(m) => cutouts.rerun(selectedPhoto.localId, m)}
                onRetry={() => cutouts.start(selectedPhoto.localId, selectedPhoto.uri)}
              />
            ) : null}
          </>
        ) : null}

        {page === 1 ? (
          <>
            <View style={{ gap: 12 }}>
              <TextField density="compact" label={t("brandMode.form.titleAr")} required requiredLabel={reqLabel} value={draft.titleAr} onChangeText={(v) => update((d) => ({ ...d, titleAr: v }))} error={err(errors.titleAr)} maxLength={120} testID="brand-title-ar" onLayout={at("titleAr")} />
              <TextField density="compact" label={t("brandMode.form.titleEn")} value={draft.titleEn} onChangeText={(v) => update((d) => ({ ...d, titleEn: v }))} error={err(errors.titleEn)} maxLength={120} testID="brand-title-en" />
              {descOpen || draft.descAr !== "" || draft.descEn !== "" ? (
                <>
                  <TextField density="compact" label={t("brandMode.form.descAr")} multiline value={draft.descAr} onChangeText={(v) => update((d) => ({ ...d, descAr: v }))} testID="brand-desc-ar" />
                  <TextField density="compact" label={t("brandMode.form.descEn")} multiline value={draft.descEn} onChangeText={(v) => update((d) => ({ ...d, descEn: v }))} testID="brand-desc-en" />
                </>
              ) : (
                <PressScale onPress={() => setDescOpen(true)} accessibilityRole="button" accessibilityLabel={t("brandMode.form.wizard.addDescription")} testID="brand-desc-add" innerStyle={{ minHeight: 44, flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <Icon name="add" size={18} color="brand" />
                  <Text variant="callout" weight="500" color="brand" accessibilityRole="none">{t("brandMode.form.wizard.addDescription")}</Text>
                </PressScale>
              )}
            </View>
            <Divider />
            <View style={{ gap: 12 }}>
              <SegmentedChoice
                label={t("brandMode.form.department")}
                value={draft.department}
                onChange={(id) => update((d) => ({ ...d, department: id as typeof d.department }))}
                options={DEPARTMENTS.map((x) => ({ id: x, label: t(`brandMode.form.departments.${x}`), testID: `brand-department-${x}` }))}
              />
              <SelectRow
                label={t("brandMode.form.category")}
                required
                value={categories.find((c) => c.id === draft.categoryId) !== undefined ? catLabel(categories.find((c) => c.id === draft.categoryId) as Category) : undefined}
                placeholder={t("brandMode.form.wizard.choose")}
                onPress={() => { setCatQuery(""); setPicker("category"); }}
                testID="brand-category"
                onLayout={at("category")}
              />
              <ChipGroup density="compact" label={t("brandMode.form.condition")} required onLayout={at("condition")}>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, width: "100%" }}>
                  {CONDITIONS.map((c) => (
                    <View key={c} style={{ width: "48%", flexGrow: 1 }}>
                      <Chip density="compact" role="radio" label={t(`brandMode.form.conditions.${c}`)} selected={draft.condition === c} onPress={() => update((d) => ({ ...d, condition: c }))} />
                    </View>
                  ))}
                </View>
              </ChipGroup>
              {draft.condition === "minor_defect" ? (
                <View style={{ gap: 8 }} onLayout={at("defectPhotos")}>
                  <Text variant="callout" weight="500">{t("brandMode.form.defectPhotos")}</Text>
                  <Text variant="caption" secondary>{t("brandMode.form.defectHelp")}</Text>
                  <PhotoGrid items={draft.defectPhotos} max={MAX_PHOTOS} onAdd={() => void add("library", "defectPhotos")} onRemove={(id) => update((d) => ({ ...d, defectPhotos: d.defectPhotos.filter((p) => p.localId !== id) }))} onRetry={(p) => { update((d) => ({ ...d, defectPhotos: d.defectPhotos.filter((x) => x.localId !== p.localId) })); void uploadInto([p.uri], "defectPhotos"); }} />
                </View>
              ) : null}
              <SelectRow
                label={t("brandMode.form.sizeChart")}
                value={charts.find((c) => c.id === draft.sizeChartId)?.name}
                placeholder={t("brandMode.form.sizeChartNone")}
                helper={draft.sizeChartId === null ? undefined : t("brandMode.form.sizeChartHelp")}
                onPress={() => setPicker("sizeChart")}
                testID="brand-size-chart"
                onLayout={at("sizeChart")}
              />
            </View>
          </>
        ) : null}

        {page === 2 ? (
          <>
            <View style={{ gap: 4 }}>
              <NumberField density="compact" label={t("brandMode.form.price")} required requiredLabel={reqLabel} value={draft.priceInput} onChangeText={(v) => update((d) => ({ ...d, priceInput: v }))} error={err(errors.price)} helper={t("brandMode.form.priceHelp")} testID="brand-price" onLayout={at("price")} />
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: priceInfo }}
                accessibilityLabel={t("brandMode.form.priceExplainerTitle")}
                onPress={() => setPriceInfo((v) => !v)}
                style={{ minHeight: 44, flexDirection: "row", alignItems: "center", gap: 8 }}
                testID="brand-price-info"
              >
                <Icon name="shield-checkmark-outline" size={18} color="savings" />
                <Text variant="body" weight="500" style={{ flex: 1 }} accessibilityRole="none">{t("brandMode.form.priceExplainerTitle")}</Text>
                <Icon name={priceInfo ? "chevron-up" : "chevron-down"} size={18} color="textSecondary" />
              </Pressable>
              {priceInfo ? <Text variant="caption" secondary>{t("brandMode.form.priceExplainer", { product: "Z-OUTLET" })}</Text> : null}
            </View>
            <Divider />
            <View style={{ gap: 12 }} onLayout={at("sizes")}>
              <Text variant="headline" accessibilityRole="header">{t("brandMode.form.sizesTitle")}</Text>
              {draft.sizes.map((r, i) => (
                <View key={i} style={{ gap: 12 }}>
                  <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10 }}>
                    <View style={{ flex: 1, minWidth: 96 }}>
                      <TextField density="compact" label={t("brandMode.form.sizeLabel")} value={r.label} onChangeText={(v) => update((d) => ({ ...d, sizes: d.sizes.map((x, j) => (j === i ? { ...x, label: v } : x)) }))} error={i === 0 && draft.sizes.length === 1 ? undefined : err(sizeRows?.rowErrors[i] === "required" ? undefined : sizeRows?.rowErrors[i] ?? undefined)} maxLength={20} testID={`brand-size-${i}`} />
                    </View>
                    <View style={{ gap: 6 }}>
                      <Text variant="callout" weight="500" accessibilityRole="none">{t("brandMode.form.stock")}</Text>
                      <View style={{ flexDirection: "row", alignItems: "center", minHeight: 44, gap: 4 }}>
                        <Stepper
                          value={stockOf(r.stock)}
                          moreLabel={t("brandMode.form.wizard.stockMore", { size: r.label })}
                          lessLabel={t("brandMode.form.wizard.stockLess", { size: r.label })}
                          onChange={(n) => update((d) => ({ ...d, sizes: d.sizes.map((x, j) => (j === i ? { ...x, stock: String(n) } : x)) }))}
                          testID={`brand-stock-${i}`}
                        />
                        {draft.sizes.length > 1 ? <IconButton icon="close-outline" label={t("brandMode.form.removeSize")} onPress={() => update((d) => ({ ...d, sizes: d.sizes.filter((_x, j) => j !== i) }))} /> : null}
                      </View>
                    </View>
                  </View>
                </View>
              ))}
              {errors.sizes !== undefined ? <Text variant="callout" color="danger">{err(errors.sizes)}</Text> : null}
              <Button density="compact" title={t("brandMode.form.addSize")} icon="add" variant="secondary" fullWidth={false} onPress={() => update((d) => ({ ...d, sizes: [...d.sizes, { label: "", stock: "" }] }))} testID="brand-add-size" />
            </View>
            <Divider />
            <View style={{ gap: 12 }}>
              <Text variant="callout" weight="500" secondary>{t("brandMode.form.wizard.optional")}</Text>
              <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 12 }}>
                <View style={{ flex: 1 }}><TextField density="compact" label={t("brandMode.form.sku")} value={draft.sku} onChangeText={(v) => update((d) => ({ ...d, sku: v }))} testID="brand-sku" /></View>
                <View style={{ flex: 1 }}><TextField density="compact" label={t("brandMode.form.barcode")} value={draft.barcode} onChangeText={(v) => update((d) => ({ ...d, barcode: v }))} error={err(errors.barcode)} keyboardType="numeric" onLayout={at("barcode")} testID="brand-barcode" /></View>
              </View>
            </View>

            <View style={{ gap: 12 }} testID="brand-section-review">
              <View>
                <View style={{ minHeight: 40, justifyContent: "center" }}><Text variant="headline" accessibilityRole="header">{t("brandMode.form.wizard.review")}</Text></View>
                <Divider />
              </View>
              <View style={{ flexDirection: "row", gap: 12, alignItems: "center" }}>
                <View style={{ width: 56, height: 70, borderRadius: radius.lg, backgroundColor: colors.fill, overflow: "hidden", alignItems: "center", justifyContent: "center" }}>
                  {cover !== undefined && originalUri(cutouts, cover) !== null
                    ? <Image source={{ uri: originalUri(cutouts, cover) ?? "" }} contentFit="cover" style={{ width: "100%", height: "100%" }} accessible={false} />
                    : <Icon name="image-outline" size={20} color="textSecondary" />}
                </View>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text variant="headline" numberOfLines={2}>{draft.titleAr.trim() !== "" ? draft.titleAr : t("brandMode.form.wizard.untitled")}</Text>
                  <Text variant="body" numeric>{parseEgp(draft.priceInput).ok ? `${draft.priceInput.trim()} EGP` : t("brandMode.form.wizard.noPrice")}</Text>
                  <Text variant="callout" secondary>{t("brandMode.form.wizard.sizesCount", { count: sizeItems.length })}</Text>
                </View>
              </View>
              {checklist.length > 0 ? (
                <View accessibilityLiveRegion="polite" testID="brand-gate">
                  <Text variant="callout" weight="600" color={showMissing ? "danger" : "textPrimary"} accessibilityRole="header">{t("brandMode.form.wizard.checklistTitle")}</Text>
                  {checklist.map((c) => (
                    <PressScale key={c.item} testID={`brand-gate-${c.item}`} onPress={() => goPage(c.page, c.anchor)} accessibilityRole="button" accessibilityLabel={t(`brandMode.form.gate.${c.item}`)} innerStyle={{ minHeight: 44, flexDirection: "row", alignItems: "center", gap: 10 }}>
                      <Icon name="ellipse-outline" size={16} color={showMissing ? "danger" : "textSecondary"} />
                      <Text variant="body" style={{ flex: 1 }} accessibilityRole="none">{t(`brandMode.form.gate.${c.item}`)}</Text>
                      <Icon name="chevron-forward" directional size={18} color="textSecondary" />
                    </PressScale>
                  ))}
                </View>
              ) : (
                <Banner tone="success" message={t("brandMode.form.wizard.allSet")} />
              )}
            </View>
          </>
        ) : null}
      </ScrollView>
      <BottomSheet visible={picker !== null} onClose={() => setPicker(null)} title={picker === "category" ? t("brandMode.form.category") : t("brandMode.form.sizeChart")} closeLabel={t("brandMode.form.wizard.closeSheet")}>
        {picker === "category" && categories.length > 6 ? (
          <TextField density="compact" label={t("brandMode.form.wizard.searchList")} value={catQuery} onChangeText={setCatQuery} testID="brand-category-search" />
        ) : null}
        <ScrollView style={{ maxHeight: 360 }} keyboardShouldPersistTaps="handled">
          {picker === "category"
            ? categories.filter((c) => catLabel(c).toLowerCase().includes(catQuery.trim().toLowerCase())).map((c) => (
                <Radio key={c.id} label={catLabel(c)} selected={draft.categoryId === c.id} onPress={() => { update((d) => ({ ...d, categoryId: c.id })); setPicker(null); }} />
              ))
            : picker === "sizeChart"
              ? (
                <>
                  <Radio label={t("brandMode.form.sizeChartNone")} selected={draft.sizeChartId === null} onPress={() => { update((d) => ({ ...d, sizeChartId: null })); setPicker(null); }} />
                  {charts.map((c) => <Radio key={c.id} label={c.name} selected={draft.sizeChartId === c.id} onPress={() => { update((d) => ({ ...d, sizeChartId: c.id })); setPicker(null); }} />)}
                </>
              )
              : null}
        </ScrollView>
      </BottomSheet>
    </Screen>
  );
}

/** Compact camera / library tile (72pt min height). */
function AddTile(props: { icon: IconName; label: string; onPress: () => void; disabled?: boolean; testID?: string }) {
  const { colors } = useTheme();
  return (
    <View style={{ flex: 1, opacity: props.disabled === true ? 0.4 : 1 }}>
      <PressScale onPress={props.onPress} disabled={props.disabled === true} accessibilityRole="button" accessibilityLabel={props.label} testID={props.testID}>
        <View style={{ minHeight: 72, borderRadius: radius.lg, borderWidth: 1.5, borderStyle: "dashed", borderColor: colors.fieldBorder, backgroundColor: colors.brandSoft, alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 10, paddingHorizontal: 8 }}>
          <Icon name={props.icon} size={24} color="brand" />
          <Text variant="body" weight="500" align="center" accessibilityRole="none">{props.label}</Text>
        </View>
      </PressScale>
    </View>
  );
}

/** Minus / value / plus: 40pt buttons, 44pt row (hit slop covers the rest). */
function Stepper(props: { value: number; onChange: (n: number) => void; moreLabel: string; lessLabel: string; testID?: string }) {
  const { colors } = useTheme();
  const btn = (icon: IconName, label: string, to: number, off: boolean) => (
    <PressScale onPress={() => props.onChange(to)} disabled={off} accessibilityRole="button" accessibilityLabel={label} hitSlop={2} innerStyle={{ width: 40, height: 40, borderRadius: radius.md, borderWidth: 1, borderColor: colors.fieldBorder, alignItems: "center", justifyContent: "center", opacity: off ? 0.4 : 1 }}>
      <Icon name={icon} size={20} color="textPrimary" />
    </PressScale>
  );
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }} testID={props.testID}>
      {btn("remove", props.lessLabel, Math.max(0, props.value - 1), props.value <= 0)}
      <Text variant="headline" numeric align="center" style={{ minWidth: 32 }}>{String(props.value)}</Text>
      {btn("add", props.moreLabel, Math.min(100000, props.value + 1), props.value >= 100000)}
    </View>
  );
}

/** The accepted cutout's fresh signed link, or null (the original is shown). */
function cutoutUri(c: CutoutsApi | undefined, p: PhotoItem): string | null {
  if (c === undefined) return null;
  const v = c.view(p.localId);
  const job = c.entry(p.localId).job;
  if (v.display !== "cutout" || job === null) return null;
  return freshLink(job.cutoutUrl, job, Date.now());
}

/** Local file, fresh signed original, or null (a placeholder; never a broken image when links have expired). */
function originalUri(c: CutoutsApi | undefined, p: PhotoItem): string | null {
  if (p.uri !== "") return p.uri;
  const job = c?.entry(p.localId).job ?? null;
  return job === null ? null : previewUri(p, job, { phase: "original", display: "original", canToggle: false }, Date.now());
}

/** Rounded 3-column photo grid. Tapping a tile selects it; its actions appear as wrapping chips under the grid. The last cell adds photos. */
function PhotoGrid(props: {
  items: readonly PhotoItem[];
  max: number;
  onAdd: () => void;
  onRemove: (localId: string) => void;
  onCover?: (index: number) => void;
  onEarlier?: (index: number) => void;
  onRetry: (p: PhotoItem) => void;
  cutouts?: CutoutsApi;
  selectedId?: string | null;
  onSelect?: (localId: string) => void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const [w, setW] = useState(0);
  const [local, setLocal] = useState<string | null>(null);
  const GAP = 8;
  const cell = w > 0 ? Math.min(96, Math.floor((w - GAP * 2) / 3)) : 0;
  const sel = props.onSelect !== undefined ? props.selectedId ?? null : local;
  const pick = (id: string) => { if (props.onSelect !== undefined) props.onSelect(id); else setLocal(id); };
  const index = props.items.findIndex((p) => p.localId === sel);
  const current = index >= 0 ? props.items[index] : undefined;
  const canAdd = props.items.length < props.max;
  return (
    <View style={{ gap: 8 }}>
      <View onLayout={(e) => setW(e.nativeEvent.layout.width)} style={{ flexDirection: "row", flexWrap: "wrap", gap: GAP }}>
        {cell === 0 ? null : props.items.map((p, i) => {
          const cut = cutoutUri(props.cutouts, p);
          const orig = originalUri(props.cutouts, p);
          const on = sel === p.localId;
          return (
            <PressScale key={p.localId} onPress={() => pick(p.localId)} accessibilityRole="button" accessibilityLabel={t("brandMode.cutout.select")} accessibilityState={{ selected: on }}>
              <View style={{ width: cell, height: Math.round(cell * 1.15), borderRadius: radius.lg, backgroundColor: colors.fill, overflow: "hidden", borderWidth: on ? 2 : 1, borderColor: on ? colors.brand : colors.border }}>
                {cut !== null
                  ? <ArchStudio uri={cut} width={cell} height={Math.round(cell * 1.15)} />
                  : orig !== null ? <Image source={{ uri: orig }} contentFit="cover" style={{ width: "100%", height: "100%" }} accessible={false} /> : null}
                {i === 0 && props.onCover !== undefined ? (
                  <View style={{ position: "absolute", top: 6, start: 6, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, backgroundColor: colors.accent }}>
                    <Text variant="caption" weight="600" color="onAccent" accessibilityRole="none">{t("brandMode.form.cover")}</Text>
                  </View>
                ) : null}
                {p.state === "uploading" ? (
                  <>
                    <View style={{ position: "absolute", top: 0, start: 0, end: 0, bottom: 0, backgroundColor: colors.scrim, opacity: 0.35 }} />
                    <View style={{ position: "absolute", start: 0, end: 0, bottom: 0 }}><ProgressRule ratio={p.progress} height={3} tone="onImage" /></View>
                  </>
                ) : null}
                {p.state === "failed" ? (
                  <View style={{ position: "absolute", top: 0, start: 0, end: 0, bottom: 0, backgroundColor: colors.overlay, alignItems: "center", justifyContent: "center", padding: 6 }}>
                    <Icon name="alert-circle-outline" size={20} color="onImage" />
                    <Text variant="caption" color="onImage" align="center" accessibilityRole="none">{t("brandMode.form.failedUpload")}</Text>
                  </View>
                ) : null}
              </View>
            </PressScale>
          );
        })}
        {cell > 0 && canAdd ? (
          <PressScale onPress={props.onAdd} accessibilityRole="button" accessibilityLabel={t("brandMode.form.addFromLibrary")}>
            <View style={{ width: cell, height: Math.round(cell * 1.15), borderRadius: radius.lg, borderWidth: 1.5, borderStyle: "dashed", borderColor: colors.fieldBorder, alignItems: "center", justifyContent: "center" }}>
              <Icon name="add" size={26} color="textSecondary" />
            </View>
          </PressScale>
        ) : null}
      </View>
      {current !== undefined ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {current.state === "failed" ? <Chip icon="refresh-outline" label={t("brandMode.form.retryUpload")} onPress={() => props.onRetry(current)} /> : null}
          {props.onCover !== undefined && index > 0 ? <Chip icon="star-outline" label={t("brandMode.form.makeCover")} onPress={() => props.onCover?.(index)} /> : null}
          {props.onEarlier !== undefined && index > 0 ? <Chip icon="arrow-back-outline" label={t("brandMode.form.moveEarlier")} onPress={() => props.onEarlier?.(index)} /> : null}
          <Chip icon="trash-outline" label={t("brandMode.form.removePhoto")} onPress={() => { props.onRemove(current.localId); setLocal(null); }} />
        </View>
      ) : null}
    </View>
  );
}
