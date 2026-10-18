import { useCallback, useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { Illustration } from "../../art";
import { randomUrlSafeId } from "../../platform/random";
import { getFeaturePorts } from "../../state/ports";
import { Flow } from "../purchase/motion";
import { Banner, Button, Card, Divider, EmptyState, ErrorState, Eyebrow, Icon, ListRow, LoadingState, Screen, Text, TextField } from "../../ui";
import {
  PortError, addressSummary, citiesFor, pickText,
  type AddressDraft, type AddressesPort, type City, type Governorate, type Lang, type SavedAddress,
} from "../checkout/model";
import {
  EMPTY_FORM, canSetDefault, formFromSaved, orderAddresses, toAddressForm, validateAddressBookForm,
  type AddressBookField, type AddressFormState,
} from "./model";

type Load = { status: "loading" } | { status: "error"; offline: boolean } | { status: "ready"; items: readonly SavedAddress[] };
type Mode = { kind: "list" } | { kind: "form"; id: string | null };

const key = () => randomUrlSafeId(24);

export function AddressesScreen(props: { port?: AddressesPort }) {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const lang: Lang = i18n.language === "en" ? "en" : "ar";
  const port = useMemo<AddressesPort>(() => props.port ?? getFeaturePorts().addresses, [props.port]);
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const [govs, setGovs] = useState<readonly Governorate[]>([]);
  const [cities, setCities] = useState<Readonly<Record<string, readonly City[]>>>({});
  const [form, setForm] = useState<AddressFormState>(EMPTY_FORM);
  const [showErrors, setShowErrors] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<"save" | "action" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const reload = useCallback(async () => {
    setLoad({ status: "loading" });
    try {
      const [items, g] = await Promise.all([port.list(), port.governorates()]);
      setGovs(g);
      setLoad({ status: "ready", items: orderAddresses(items) });
    } catch (e) {
      setLoad({ status: "error", offline: e instanceof PortError && e.kind === "offline" });
    }
  }, [port]);
  useEffect(() => { void reload(); }, [reload]);

  // Cities load lazily per governorate and are merged into the coverage used for validation.
  const coverage = useMemo<readonly Governorate[]>(() => govs.map((g) => ({ ...g, cities: cities[g.id] ?? g.cities })), [govs, cities]);
  const govId = form.draft.governorateId;
  useEffect(() => {
    if (govId === null || cities[govId] !== undefined) return;
    let alive = true;
    port.cities(govId).then((c) => { if (alive) setCities((m) => ({ ...m, [govId]: c })); }, () => undefined);
    return () => { alive = false; };
  }, [govId, cities, port]);

  const setDraft = (d: Partial<AddressDraft>) => setForm((f) => ({ ...f, draft: { ...f.draft, ...d } }));
  const open = (a: SavedAddress | null) => {
    setForm(a === null ? EMPTY_FORM : formFromSaved(a));
    setShowErrors(false);
    setFailed(null);
    setConfirmDelete(false);
    setMode({ kind: "form", id: a?.id ?? null });
  };
  const back = () => {
    if (mode.kind === "form") setMode({ kind: "list" });
    else router.back();
  };

  const errors: readonly AddressBookField[] = validateAddressBookForm(form, coverage);
  const err = (f: AddressBookField, k: string): { error?: string } => (showErrors && errors.includes(f) ? { error: t(k) } : {});

  const run = async (kind: "save" | "action", f: () => Promise<void>) => {
    setBusy(true);
    setFailed(null);
    try {
      await f();
      setMode({ kind: "list" });
      await reload();
    } catch {
      setFailed(kind);
    } finally {
      setBusy(false);
    }
  };
  const save = () => {
    const payload = toAddressForm(form, coverage);
    if (payload === null) { setShowErrors(true); return; }
    const id = mode.kind === "form" ? mode.id : null;
    void run("save", async () => { if (id === null) await port.create(payload, key()); else await port.update(id, payload, key()); });
  };

  const editing = mode.kind === "form" && load.status === "ready" ? load.items.find((a) => a.id === mode.id) ?? null : null;

  if (mode.kind === "form") {
    return (
      <Screen title={t(mode.id === null ? "addresses.add" : "addresses.edit")} onBack={back} backLabel={t("common.back")}>
        <TextField label={t("addresses.label")} value={form.label} onChangeText={(v) => setForm((f) => ({ ...f, label: v }))} />
        <TextField label={t("addresses.recipient")} value={form.recipientName} onChangeText={(v) => setForm((f) => ({ ...f, recipientName: v }))} {...err("recipient", "addresses.errors.recipient")} />
        <TextField label={t("addresses.phone")} value={form.phoneInput} keyboardType="phone-pad" onChangeText={(v) => setForm((f) => ({ ...f, phoneInput: v }))} {...err("phone", "addresses.errors.phone")} />
        <View accessibilityRole="radiogroup" accessibilityLabel={t("checkout.governorate")}>
          <Eyebrow>{t("checkout.governorate")}</Eyebrow>
          <Divider />
          {govs.map((g) => (
            <ListRow key={g.id} title={pickText(g.name, lang)} divider trailing={g.id === govId ? <Icon name="checkmark" /> : undefined}
              onPress={() => setDraft({ governorateId: g.id, cityId: citiesFor(coverage, g.id).some((c) => c.id === form.draft.cityId) ? form.draft.cityId : null })} />
          ))}
          {showErrors && errors.includes("governorate") ? <Text variant="caption" color="danger">{t("checkout.addressErrors.governorate")}</Text> : null}
        </View>
        {govId !== null ? (
          <View accessibilityRole="radiogroup" accessibilityLabel={t("checkout.city")}>
            <Eyebrow>{t("checkout.city")}</Eyebrow>
            <Divider />
            {citiesFor(coverage, govId).map((c) => (
              <ListRow key={c.id} title={pickText(c.name, lang)} divider trailing={c.id === form.draft.cityId ? <Icon name="checkmark" /> : undefined}
                onPress={() => setDraft({ cityId: c.id })} />
            ))}
            {showErrors && errors.includes("city") ? <Text variant="caption" color="danger">{t("checkout.addressErrors.city")}</Text> : null}
          </View>
        ) : null}
        <TextField label={t("checkout.street")} value={form.draft.street} onChangeText={(v) => setDraft({ street: v })} {...err("street", "checkout.addressErrors.street")} />
        <TextField label={t("checkout.building")} value={form.draft.building} onChangeText={(v) => setDraft({ building: v })} {...err("building", "checkout.addressErrors.building")} />
        <TextField label={t("checkout.floor")} value={form.draft.floor} onChangeText={(v) => setDraft({ floor: v })} />
        <TextField label={t("checkout.apartment")} value={form.draft.apartment} onChangeText={(v) => setDraft({ apartment: v })} />
        <TextField label={t("checkout.landmark")} value={form.draft.landmark} onChangeText={(v) => setDraft({ landmark: v })} />
        {failed !== null ? <Banner tone="error" message={t(failed === "save" ? "addresses.saveFailed" : "addresses.actionFailed")} /> : null}
        <Button title={t("addresses.save")} onPress={save} loading={busy} />
        {editing !== null && canSetDefault(editing) ? (
          <Button title={t("addresses.setDefault")} variant="secondary" disabled={busy} onPress={() => void run("action", () => port.setDefault(editing.id, key()))} />
        ) : null}
        {editing !== null ? (
          confirmDelete ? (
            <View style={{ gap: 8 }}>
              <Text variant="caption" secondary>{t("addresses.deleteConfirm")}</Text>
              <Button title={t("addresses.deleteYes")} variant="secondary" disabled={busy} onPress={() => void run("action", () => port.remove(editing.id, key()))} />
              <Button title={t("common.cancel")} variant="secondary" disabled={busy} onPress={() => setConfirmDelete(false)} />
            </View>
          ) : (
            <Button title={t("addresses.delete")} variant="secondary" disabled={busy} onPress={() => setConfirmDelete(true)} />
          )
        ) : null}
      </Screen>
    );
  }

  return (
    <Screen title={t("addresses.title")} onBack={back} backLabel={t("common.back")}>
      {load.status === "loading" ? <LoadingState label={t("addresses.loading")} /> : null}
      {load.status === "error" ? (
        <ErrorState offline={load.offline} title={t(load.offline ? "addresses.offlineTitle" : "addresses.errorTitle")}
          description={t(load.offline ? "addresses.offlineBody" : "addresses.errorBody")} retryTitle={t("common.retry")} onRetry={() => void reload()} />
      ) : null}
      {load.status === "ready" && load.items.length === 0 ? (
        <EmptyState illustration={<Illustration name="deliveryTruck" size={120} />} title={t("addresses.emptyTitle")} description={t("addresses.emptyBody")} />
      ) : null}
      {load.status === "ready" && load.items.length > 0 ? (
        <Card variant="elevated" style={{ gap: 0 }}>
          {load.items.map((a, i) => (
            <Flow key={a.id} index={i}>
              <ListRow title={a.label ?? a.recipientName} divider
                subtitle={`${a.isDefault ? `${t("addresses.defaultTag")}  ·  ` : ""}${addressSummary(a.draft, coverage, lang)}`}
                onPress={() => open(a)} />
            </Flow>
          ))}
        </Card>
      ) : null}
      {load.status === "ready" ? <Button title={t("addresses.add")} onPress={() => open(null)} /> : null}
    </Screen>
  );
}
