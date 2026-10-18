import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { useTranslation } from "react-i18next";
import { radius, spacing } from "@outlet/ui-tokens";
import {
  Banner, BottomSheet, Button, Chip, EmptyState, ErrorState, IconButton, ProgressBar, Screen, Skeleton, Text, TextField, useTheme, useToast, TabBarInsetContext,
} from "../../ui";
import { useContext } from "react";
import { Illustration } from "../../art";
import { parseBudgetEgp } from "../search/model";
import { opt } from "../search/optional";
import { pluralKey } from "../../i18n/plural";
import { useFormat } from "../home/parts";
import { FilterButton } from "../filters/FilterButton";
import { useOptionalServices } from "../../state/services";
import { getFeaturePorts } from "../../state/ports";
import { Flow } from "../purchase/motion";
import { SavedRow } from "./SavedRow";
import { SavedFilterSheet } from "./SavedFilterSheet";
import { ListSettingsSheet } from "./ListSettingsSheet";
import {
  EMPTY_SAVED_FILTER, PortError, UNDO_MS, UndoTracker, WISHLIST_INTENTS, buildList, canShare, filterItems, savedFilterCount, savedRow, sortItems, storeNamesOf,
  subtitleCounts, validateDraft, type NewWishlistDraft, type SavedFilter, type SavedSort, type Wishlist, type WishlistIntent, type WishlistItem, type WishlistsPort,
} from "./model";

type ScreenState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly offline: boolean }
  | { readonly status: "ready"; readonly lists: readonly Wishlist[] };

const isOffline = (e: unknown): boolean => e instanceof PortError && e.kind === "offline";

/** Fade colour for the picker's trailing edge: the background at zero alpha, so the gradient never greys. */
const transparent = (hex: string): string => (/^#[0-9a-fA-F]{6}$/.test(hex) ? `${hex}00` : "transparent");

function NewListForm(props: { onCreate: (d: NewWishlistDraft) => Promise<void> }) {
  const { t } = useTranslation();
  const [intent, setIntent] = useState<WishlistIntent>("need");
  const [title, setTitle] = useState("");
  const [nickname, setNickname] = useState("");
  const [occasion, setOccasion] = useState("");
  const [budgetText, setBudgetText] = useState("");
  const [date, setDate] = useState("");
  const [errors, setErrors] = useState<readonly string[]>([]);
  const submit = async () => {
    const budget = budgetText.trim().length === 0 ? null : parseBudgetEgp(budgetText);
    const draft: NewWishlistDraft = {
      intent, title, targetDate: date.trim().length === 0 ? null : date.trim(),
      budget: budgetText.trim().length > 0 && budget === null ? 0n : budget,
      recipientNickname: intent === "gift" ? nickname : null, occasion: intent === "gift" ? occasion : null,
    };
    const e = validateDraft(draft);
    setErrors(e);
    if (e.length === 0) {
      await props.onCreate(draft);
      setTitle(""); setNickname(""); setOccasion(""); setBudgetText(""); setDate("");
    }
  };
  const err = (k: string) => (errors.includes(k) ? t(`wishlists.error.${k}`) : undefined);
  return (
    <View style={{ gap: spacing.md }}>
      <View accessibilityRole="radiogroup" accessibilityLabel={t("wishlists.intentPicker")} style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
        {WISHLIST_INTENTS.map((i) => <Chip key={i} label={t(`wishlists.intent.${i}`)} selected={i === intent} onPress={() => setIntent(i)} />)}
      </View>
      <TextField label={t("wishlists.titleLabel")} value={title} onChangeText={setTitle} {...opt("error", err("titleRequired") ?? err("titleTooLong"))} />
      {intent === "gift" ? (
        <>
          <TextField label={t("wishlists.nicknameLabel")} value={nickname} onChangeText={setNickname} {...opt("error", err("nicknameRequired"))} />
          <TextField label={t("wishlists.occasionLabel")} value={occasion} onChangeText={setOccasion} {...opt("error", err("occasionRequired"))} />
        </>
      ) : null}
      <TextField label={t("wishlists.budgetLabel")} value={budgetText} onChangeText={setBudgetText} keyboardType="numeric" {...opt("error", err("budgetInvalid"))} />
      <TextField label={t("wishlists.dateLabel")} helper={t("wishlists.dateHelper")} value={date} onChangeText={setDate} {...opt("error", err("dateInvalid"))} />
      <Button title={t("wishlists.create")} fullWidth onPress={() => void submit()} />
    </View>
  );
}

function SavedSkeleton() {
  return (
    <View accessibilityLabel="loading" style={{ gap: spacing.lg }} testID="saved-skeleton">
      {[0, 1, 2, 3].map((i) => (
        <View key={i} style={{ flexDirection: "row", gap: spacing.md }}>
          <Skeleton width={72} height={96} radius={12} />
          <View style={{ flex: 1, gap: spacing.sm }}><Skeleton width="40%" height={12} /><Skeleton width="85%" height={16} /><Skeleton width="30%" height={14} /></View>
        </View>
      ))}
    </View>
  );
}

export function WishlistsScreen(props: {
  port?: WishlistsPort; now?: () => number; undoMs?: number;
  onBuy?: (productId: string) => void; onFindSimilar?: (title: string) => void; onDiscover?: () => void; onBack?: () => void; onViewBag?: () => void;
}) {
  const { t } = useTranslation();
  const f = useFormat();
  const { colors } = useTheme();
  const toast = useToast();
  const tabInset = useContext(TabBarInsetContext);
  const analytics = useOptionalServices()?.analytics ?? null;
  const port = useMemo<WishlistsPort>(() => props.port ?? getFeaturePorts().wishlists, [props.port]);
  const [state, setState] = useState<ScreenState>({ status: "loading" });
  const [offline, setOffline] = useState(false);
  // Signed out: the port serves this phone's lists. No new lists and no sharing, and a plain note instead (never a sign-up prompt).
  const [guest, setGuest] = useState(false);
  const [bagIds, setBagIds] = useState<readonly string[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sort, setSort] = useState<SavedSort>("newest");
  const [filter, setFilter] = useState<SavedFilter>(EMPTY_SAVED_FILTER);
  const [filterOpen, setFilterOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [snack, setSnack] = useState<{ itemId: string; title: string } | null>(null);
  const [actionFailed, setActionFailed] = useState<string | null>(null);
  const tracker = useRef(new UndoTracker(props.undoMs ?? UNDO_MS));
  const alive = useRef(true);
  const track = useCallback((name: "wishlist_item_removed" | "wishlist_add_to_bag" | "wishlist_shared", payload: Record<string, unknown>) => {
    void (analytics as { track: (n: string, p: Record<string, unknown>) => Promise<boolean> } | null)?.track(name, payload).catch(() => false);
  }, [analytics]);

  const load = useCallback(async (silent = false) => {
    if (!silent) setState({ status: "loading" });
    try {
      const [lists, bag, isGuest] = await Promise.all([port.list(), port.bagProductIds().catch(() => [] as readonly string[]), port.isGuest?.().catch(() => false) ?? false]);
      if (!alive.current) return;
      setGuest(isGuest);
      setBagIds(bag);
      setOffline(false);
      setState({ status: "ready", lists });
    } catch (e) {
      if (!alive.current) return;
      const off = isOffline(e);
      // Cached lists stay readable (read-only) when only the refresh failed because the device is offline.
      setState((prev) => (prev.status === "ready" && off ? prev : { status: "error", offline: off }));
      if (off) setOffline(true);
    }
  }, [port]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    alive.current = true;
    const tr = tracker.current;
    return () => { tr.flush(); alive.current = false; };
  }, []);

  const lists = state.status === "ready" ? state.lists : [];
  const selected = lists.find((l) => l.id === selectedId) ?? lists[0] ?? null;
  const nowMs = (props.now ?? Date.now)();
  const counts = subtitleCounts(lists);
  const view = selected !== null ? buildList(selected, nowMs) : null;
  const visibleItems = useMemo(() => {
    if (selected === null) return [] as readonly WishlistItem[];
    const base = selected.items.filter((i) => !hidden.has(i.id));
    return sortItems(filterItems(base, filter, selected.budget), sort);
  }, [selected, hidden, filter, sort]);

  const fail = (): void => { setActionFailed(t("wishlists.actionFailed")); };
  const run = async (fn: () => Promise<void>): Promise<void> => {
    try { await fn(); setActionFailed(null); await load(true); } catch { fail(); }
  };

  const remove = (list: Wishlist, item: WishlistItem): void => {
    if (offline) return;
    setHidden((h) => new Set(h).add(item.id));
    setSnack({ itemId: item.id, title: item.title });
    tracker.current.schedule(item.id, () => {
      setSnack((s) => (s?.itemId === item.id ? null : s));
      port.removeItem(list.id, item.id).then(
        () => { track("wishlist_item_removed", { intent: list.intent }); if (alive.current) void load(true); },
        () => {
          if (!alive.current) return;
          setHidden((h) => { const n = new Set(h); n.delete(item.id); return n; });
          setActionFailed(t("savedTab.removeFailed"));
        },
      );
    });
  };
  const undo = (): void => {
    if (snack === null) return;
    if (tracker.current.undo(snack.itemId)) {
      const id = snack.itemId;
      setHidden((h) => { const n = new Set(h); n.delete(id); return n; });
    }
    setSnack(null);
  };
  const addToBag = (list: Wishlist, item: WishlistItem): void => {
    if (item.skuPref === null) { props.onBuy?.(item.productId); return; }
    const sku = item.skuPref;
    track("wishlist_add_to_bag", { intent: list.intent, cool_off: list.intent === "want" && list.coolOffEnabled });
    port.addToBag(sku).then(
      () => { toast.show(t("savedTab.addedToBag"), "success"); setBagIds((b) => (b.includes(item.productId) ? b : [...b, item.productId])); },
      () => fail(),
    );
  };
  const create = async (d: NewWishlistDraft): Promise<void> => {
    try { await port.create(d); setNewOpen(false); setActionFailed(null); await load(true); } catch { fail(); }
  };

  const shareable = selected !== null && canShare(selected);
  const settingsAvailable = selected !== null && (selected.intent === "want" || shareable);
  const total = view?.total ?? 0n;
  return (
    <View style={{ flex: 1 }}>
      <Screen {...(props.onBack !== undefined ? { onBack: props.onBack } : {})}>
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: spacing.sm }}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text variant="display" accessibilityRole="header">{t("savedTab.title")}</Text>
            {state.status === "ready" ? (
              <Text variant="caption" secondary testID="saved-subtitle">
                {t("savedTab.subtitle", { items: t(pluralKey("savedTab.itemsCount", counts.items), { n: f.num(counts.items) }), lists: t(pluralKey("savedTab.listsCount", counts.lists), { n: f.num(counts.lists) }) })}
              </Text>
            ) : null}
          </View>
          {state.status === "ready" && selected !== null ? (
            <View style={{ flexDirection: "row", gap: spacing.xs }}>
              <FilterButton count={savedFilterCount(filter) + (sort !== "newest" ? 1 : 0)} onPress={() => setFilterOpen(true)} testID="saved-filter-button" />
              {shareable ? <IconButton icon="share-outline" label={t("savedTab.share")} onPress={() => setSettingsOpen(true)} testID="saved-share-button" /> : null}
            </View>
          ) : null}
        </View>

        {offline ? <Banner tone="warning" message={t("savedTab.offlineReadOnly")} /> : null}
        {guest && state.status === "ready" ? <Text variant="caption" secondary testID="saved-local-note">{t("guestSurfaces.savedLocalNote")}</Text> : null}
        {actionFailed !== null ? <Banner tone="error" message={actionFailed} /> : null}
        {state.status === "loading" ? <SavedSkeleton /> : null}
        {state.status === "error" ? (
          <ErrorState offline={state.offline} title={t(state.offline ? "wishlists.offlineTitle" : "wishlists.errorTitle")}
            description={t(state.offline ? "wishlists.offlineBody" : "wishlists.errorBody")} retryTitle={t("common.retry")} onRetry={() => void load()} />
        ) : null}

        {state.status === "ready" ? (
          <>
            <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
              <View style={{ flex: 1 }}>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} accessibilityRole="radiogroup" contentContainerStyle={{ gap: spacing.sm, paddingEnd: spacing.xl }}>
                  {lists.map((l) => (
                    <Chip key={l.id} label={l.title} selected={l.id === selected?.id} onPress={() => { setSelectedId(l.id); setFilter(EMPTY_SAVED_FILTER); }} testID={`saved-list-${l.id}`} />
                  ))}
                </ScrollView>
                <LinearGradient pointerEvents="none" colors={[transparent(colors.background), colors.background]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                  style={{ position: "absolute", top: 0, bottom: 0, end: 0, width: 24 }} />
              </View>
              {guest ? null : <IconButton icon="add" label={t("savedTab.addList")} onPress={() => setNewOpen(true)} disabled={offline} testID="saved-add-list" />}
            </View>

            {lists.length === 0 ? (
              <EmptyState illustration={<Illustration name="emptyWishlist" size={120} />} title={t("savedTab.emptyNoListsTitle")} description={t("savedTab.emptyNoListsBody")}
                actionTitle={t("savedTab.discover")} onAction={() => props.onDiscover?.()} />
            ) : null}

            {selected !== null && selected.recipientNickname !== null ? (
              <Text variant="caption" secondary>{t("wishlists.recipient", { name: selected.recipientNickname, occasion: selected.occasion ?? "" })}</Text>
            ) : null}

            {selected !== null && selected.budget !== null && view !== null && view.budgetLeft !== null ? (
              <View style={{ gap: spacing.sm }} testID="saved-budget">
                <ProgressBar current={Number(total < 0n ? 0n : total)} target={Number(selected.budget)} label={t("wishlists.budgetName", { title: selected.title })} />
                <Text variant="caption" color={view.budgetLeft >= 0n ? "textSecondary" : "danger"}>
                  {view.budgetLeft >= 0n
                    ? t("savedTab.budgetLine", { budget: f.money(selected.budget), total: f.money(total), left: f.money(view.budgetLeft) })
                    : t("savedTab.budgetOverLine", { budget: f.money(selected.budget), total: f.money(total), over: f.money(-view.budgetLeft) })}
                </Text>
                <Text variant="caption" secondary>{t("savedTab.budgetCaption")}</Text>
              </View>
            ) : null}

            {settingsAvailable ? (
              <Button variant="secondary" density="compact" icon="settings-outline" title={t("savedTab.listSettings")} onPress={() => setSettingsOpen(true)} testID="saved-list-settings" />
            ) : null}

            {selected !== null && selected.items.length === 0 ? (
              <EmptyState illustration={<Illustration name="emptyWishlist" size={96} />} title={t("savedTab.emptyListTitle")} actionTitle={t("savedTab.discover")} onAction={() => props.onDiscover?.()} />
            ) : null}

            {selected !== null && selected.items.length > 0 && visibleItems.length === 0 ? (
              <Text variant="callout" secondary>{t("savedTab.emptyListTitle")}</Text>
            ) : null}

            {selected !== null ? (
              <View style={{ gap: spacing.xl }}>
                {visibleItems.map((item, i) => (
                  <Flow key={item.id} index={i}>
                    <SavedRow
                      view={savedRow(selected, item, nowMs, bagIds.includes(item.productId))}
                      listTitle={selected.title}
                      offline={offline}
                      onRemove={() => remove(selected, item)}
                      onAddToBag={() => addToBag(selected, item)}
                      onRemind={() => void run(() => port.startCoolOff(selected.id, item.id, nowMs))}
                      onFindSimilar={() => props.onFindSimilar?.(item.title)}
                      onViewBag={() => props.onViewBag?.()}
                      onOpen={() => props.onBuy?.(item.productId)}
                    />
                  </Flow>
                ))}
              </View>
            ) : null}
          </>
        ) : null}
      </Screen>

      {snack !== null ? (
        <View accessibilityLiveRegion="polite" style={{ position: "absolute", start: spacing.lg, end: spacing.lg, bottom: tabInset + spacing.md }} testID="saved-undo">
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md, paddingStart: spacing.lg, paddingEnd: spacing.sm, paddingVertical: spacing.xs, borderRadius: radius.lg, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.hairline }}>
            <Text variant="callout" style={{ flex: 1 }} numberOfLines={2}>{t("savedTab.removed", { title: snack.title })}</Text>
            <Button density="compact" variant="ghost" title={t("savedTab.undo")} onPress={undo} testID="saved-undo-button" />
          </View>
        </View>
      ) : null}

      <SavedFilterSheet visible={filterOpen} onClose={() => setFilterOpen(false)} sort={sort} filter={filter} stores={selected !== null ? storeNamesOf(selected.items) : []}
        hasBudget={selected !== null && selected.budget !== null} onApply={(s, fl) => { setSort(s); setFilter(fl); }} />
      {selected !== null ? (
        <ListSettingsSheet visible={settingsOpen} onClose={() => setSettingsOpen(false)} list={selected} shareActive={view?.shareActive ?? false} offline={offline} bottomInset={tabInset}
          onCoolOff={(on) => void run(() => port.setCoolOff(selected.id, on))}
          onCreateShare={(hide) => void run(async () => { await port.createShare(selected.id, null, hide); track("wishlist_shared", { intent: selected.intent }); })}
          onRevokeShare={() => void run(() => port.revokeShare(selected.id))} />
      ) : null}
      <BottomSheet visible={newOpen} onClose={() => setNewOpen(false)} title={t("wishlists.newHeading")} closeLabel={t("common.close")} maxHeightRatio={0.9}>
        <NewListForm onCreate={create} />
      </BottomSheet>
    </View>
  );
}
