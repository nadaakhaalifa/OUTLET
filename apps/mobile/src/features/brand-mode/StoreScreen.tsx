import { useEffect, useState } from "react";
import { Linking, View } from "react-native";
import { Image } from "expo-image";
import { useTranslation } from "react-i18next";
import { StoreAvatar, StoreCover } from "../../art";
import { Badge, Banner, BottomSheet, Button, Chip, ListRow, Screen, Skeleton, SwitchRow, Text, TextField, useToast } from "../../ui";
import { localizeDigits } from "../money-display";
import { FailureView, StaleBanner, useBrand, useLoad } from "./kit";
import { pickPhotos } from "./photos";
import { sellerCenterUrl } from "./state";
import {
  INVITE_ROLES, LOCKED_NOTIFICATIONS, NOTIFICATION_EVENTS, PAYOUT_HOLD_HOURS, STATUTORY_MIN_DEFECT_DAYS, STATUTORY_MIN_RETURN_DAYS,
  can, failureOf, maskIban, normalizeEgPhone, validateHandlingHours, validateIban, validateReturnPolicy, validateVacation,
  type BrandFailure, type InviteRole, type StoreSettings, type TeamMember,
} from "./model";

type SheetId = "profile" | "returns" | "shipping" | "vacation" | "payout" | "team" | "notifications" | null;

export function StoreScreen() {
  const { t } = useTranslation();
  const toast = useToast();
  const { port, account, locale } = useBrand();
  const store = useLoad<StoreSettings>("store", () => port.store());
  const [sheet, setSheet] = useState<SheetId>(null);
  const [stepUp, setStepUp] = useState<null | (() => Promise<void>)>(null);
  const [failure, setFailure] = useState<BrandFailure | null>(null);
  const url = sellerCenterUrl();
  const canEdit = can(account.role, "settings_write");
  const s = store.state.status === "ready" ? store.state.data : null;
  const date = (ms: number) => new Intl.DateTimeFormat(locale === "ar" ? "ar-EG" : "en-GB", { timeZone: "Africa/Cairo", day: "numeric", month: "long" }).format(new Date(ms));
  const name = locale === "ar" ? account.name.ar : account.name.en;

  const save = async (next: StoreSettings) => {
    try {
      await port.saveStore(next);
      store.reload();
      toast.show(t("brandMode.store.saved"), "success");
      setSheet(null);
    } catch (e) {
      const f = failureOf(e);
      if (f === "conflict") store.reload();
      toast.show(t(f === "conflict" ? "brandMode.common.conflictBody" : f === "unsupported" ? "brandMode.common.unsupportedBody" : "brandMode.orders.actionFailed"), "error");
    }
  };
  const openSellerCenter = url === null ? undefined : () => { void Linking.openURL(url); };

  return (
    <Screen title={t("brandMode.store.title")} onRefresh={store.reload}>
      {store.state.status === "ready" ? <StaleBanner visible={store.state.stale} /> : null}
      {store.state.status === "loading" ? <View style={{ gap: 14 }}><Skeleton height={120} /><Skeleton height={56} /><Skeleton height={56} /></View> : null}
      {store.state.status === "error" ? <FailureView failure={store.state.failure} onRetry={store.reload} onOpenSellerCenter={openSellerCenter} /> : null}
      {failure === "unsupported" ? <Banner tone="warning" message={t("brandMode.common.unsupportedBody")} /> : null}
      {s !== null ? (
        <>
          <View style={{ gap: 12 }}>
            <View style={{ height: 120, borderRadius: 18, overflow: "hidden" }}>
              {s.coverUri !== null ? <Image source={{ uri: s.coverUri }} contentFit="cover" style={{ height: 120 }} /> : <StoreCover seed={account.storeId} aspect={3} />}
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
              {s.logoUri !== null ? <Image source={{ uri: s.logoUri }} style={{ width: 52, height: 52, borderRadius: 26 }} /> : <StoreAvatar name={name} seed={account.storeId} size={52} />}
              <View style={{ flex: 1, gap: 2 }}>
                <Text variant="title2">{name}</Text>
                <Badge label={t(`brandMode.store.roles.${account.role}`)} kind="neutral" />
              </View>
            </View>
          </View>
          {!canEdit ? <Text variant="caption" secondary>{t("brandMode.store.readOnly")}</Text> : null}
          <View>
            <ListRow title={t("brandMode.store.profile")} leadingIcon="storefront-outline" onPress={() => setSheet("profile")} divider />
            <ListRow title={t("brandMode.store.returnPolicy")} value={localizeDigits(`${s.returnDays.changeOfMind}/${s.returnDays.defect}`, locale)} leadingIcon="return-down-back-outline" onPress={() => setSheet("returns")} divider />
            <ListRow title={t("brandMode.store.shipping")} subtitle={[s.shipping.city, s.shipping.governorate].filter((x) => x !== "").join(", ")} leadingIcon="cube-outline" onPress={() => setSheet("shipping")} divider />
            <ListRow title={t("brandMode.store.vacation")} value={s.vacationEndMs === null ? t("brandMode.store.vacationOff") : t("brandMode.store.vacationOn", { date: date(s.vacationEndMs) })} leadingIcon="sunny-outline" onPress={() => setSheet("vacation")} divider />
            <ListRow title={t("brandMode.store.payout")} subtitle={s.payout.last4 === null ? t("brandMode.store.payoutNone") : maskIban(s.payout.last4)} leadingIcon="card-outline" onPress={() => setSheet("payout")} divider />
            <ListRow title={t("brandMode.store.team")} leadingIcon="people-outline" onPress={() => setSheet("team")} divider />
            <ListRow title={t("brandMode.store.notifications")} leadingIcon="notifications-outline" onPress={() => setSheet("notifications")} />
          </View>
          {url !== null ? <Button title={t("brandMode.store.sellerCenter")} variant="secondary" icon="open-outline" onPress={() => void Linking.openURL(url)} testID="brand-open-seller-center" /> : null}
        </>
      ) : null}

      {s !== null ? (
        <>
          <BottomSheet visible={sheet === "profile"} onClose={() => setSheet(null)} title={t("brandMode.store.profile")} closeLabel={t("brandMode.common.close")} maxHeightRatio={0.9}>
            <ProfileForm s={s} canEdit={canEdit} onSave={save} onMedia={async (slot) => {
              const r = await pickPhotos("library", 1);
              const uri = r.kind === "ok" ? r.uris[0] : undefined;
              if (uri === undefined) return;
              try { await port.uploadStoreMedia(slot, uri); store.reload(); } catch (e) { if (failureOf(e) === "unsupported") setFailure("unsupported"); setSheet(null); }
            }} />
          </BottomSheet>
          <BottomSheet visible={sheet === "returns"} onClose={() => setSheet(null)} title={t("brandMode.store.returnPolicy")} closeLabel={t("brandMode.common.close")}>
            <ReturnsForm s={s} canEdit={canEdit} onSave={save} />
          </BottomSheet>
          <BottomSheet visible={sheet === "shipping"} onClose={() => setSheet(null)} title={t("brandMode.store.shipping")} closeLabel={t("brandMode.common.close")} maxHeightRatio={0.9}>
            <ShippingForm s={s} canEdit={canEdit} onSave={save} />
          </BottomSheet>
          <BottomSheet visible={sheet === "vacation"} onClose={() => setSheet(null)} title={t("brandMode.store.vacation")} closeLabel={t("brandMode.common.close")}>
            <VacationForm s={s} canEdit={canEdit} onSave={save} />
          </BottomSheet>
          <BottomSheet visible={sheet === "payout"} onClose={() => setSheet(null)} title={t("brandMode.store.payout")} closeLabel={t("brandMode.common.close")} maxHeightRatio={0.9}>
            <PayoutForm s={s} canEdit={can(account.role, "payout_write")} onNeedStepUp={(retry) => { setStepUp(() => retry); }} onSaved={() => { store.reload(); }} />
          </BottomSheet>
          <BottomSheet visible={sheet === "team"} onClose={() => setSheet(null)} title={t("brandMode.store.team")} closeLabel={t("brandMode.common.close")} maxHeightRatio={0.9}>
            <TeamPanel canManage={can(account.role, "team_write")} />
          </BottomSheet>
          <BottomSheet visible={sheet === "notifications"} onClose={() => setSheet(null)} title={t("brandMode.store.notifications")} closeLabel={t("brandMode.common.close")}>
            <View>
              {NOTIFICATION_EVENTS.map((e) => {
                const locked = LOCKED_NOTIFICATIONS.includes(e);
                return (
                  <View key={e}>
                    <SwitchRow label={locked ? `${t(`brandMode.store.events.${e}`)} · ${t("brandMode.store.notificationsLocked")}` : t(`brandMode.store.events.${e}`)} value={locked ? true : s.notifications[e]} disabled={locked || !canEdit}
                      onValueChange={(v) => { void save({ ...s, notifications: { ...s.notifications, [e]: v } }); }} />
                  </View>
                );
              })}
            </View>
          </BottomSheet>
        </>
      ) : null}
      <StepUpSheet pending={stepUp} onClose={() => setStepUp(null)} />
    </Screen>
  );
}

function ProfileForm(props: { s: StoreSettings; canEdit: boolean; onSave: (s: StoreSettings) => Promise<void>; onMedia: (slot: "logo" | "cover") => Promise<void> }) {
  const { t } = useTranslation();
  const [v, setV] = useState(props.s);
  useEffect(() => setV(props.s), [props.s]);
  const arOk = v.name.ar.trim().length >= 2;
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: "row", gap: 12 }}>
        <View style={{ flex: 1 }}><Button title={`${t("brandMode.store.logo")}`} variant="secondary" icon="image-outline" disabled={!props.canEdit} onPress={() => void props.onMedia("logo")} /></View>
        <View style={{ flex: 1 }}><Button title={t("brandMode.store.cover")} variant="secondary" icon="image-outline" disabled={!props.canEdit} onPress={() => void props.onMedia("cover")} /></View>
      </View>
      <TextField label={t("brandMode.store.nameAr")} value={v.name.ar} disabled={!props.canEdit} onChangeText={(x) => setV({ ...v, name: { ...v.name, ar: x } })} error={arOk ? undefined : t("brandMode.form.err.required")} />
      <TextField label={t("brandMode.store.nameEn")} value={v.name.en} disabled={!props.canEdit} onChangeText={(x) => setV({ ...v, name: { ...v.name, en: x } })} />
      <TextField label={t("brandMode.store.descAr")} value={v.description.ar} disabled={!props.canEdit} onChangeText={(x) => setV({ ...v, description: { ...v.description, ar: x } })} />
      <TextField label={t("brandMode.store.descEn")} value={v.description.en} disabled={!props.canEdit} onChangeText={(x) => setV({ ...v, description: { ...v.description, en: x } })} />
      <TextField label={t("brandMode.store.instagram")} value={v.social.instagram} disabled={!props.canEdit} onChangeText={(x) => setV({ ...v, social: { ...v.social, instagram: x } })} />
      <TextField label={t("brandMode.store.website")} value={v.social.website} disabled={!props.canEdit} onChangeText={(x) => setV({ ...v, social: { ...v.social, website: x } })} />
      <Button title={t("brandMode.common.save")} disabled={!props.canEdit || !arOk} onPress={() => void props.onSave(v)} />
    </View>
  );
}

function ReturnsForm(props: { s: StoreSettings; canEdit: boolean; onSave: (s: StoreSettings) => Promise<void> }) {
  const { t } = useTranslation();
  const [a, setA] = useState(String(props.s.returnDays.changeOfMind));
  const [b, setB] = useState(String(props.s.returnDays.defect));
  const valid = validateReturnPolicy(Number(a), Number(b));
  return (
    <View style={{ gap: 12 }}>
      <Banner tone="info" message={t("brandMode.store.returnMin", { days: `${STATUTORY_MIN_RETURN_DAYS} / ${STATUTORY_MIN_DEFECT_DAYS}` })} />
      <TextField label={t("brandMode.store.returnChange")} value={a} keyboardType="numeric" disabled={!props.canEdit} onChangeText={setA} error={valid.changeOfMind ? undefined : t("brandMode.store.returnMin", { days: STATUTORY_MIN_RETURN_DAYS })} />
      <TextField label={t("brandMode.store.returnDefect")} value={b} keyboardType="numeric" disabled={!props.canEdit} onChangeText={setB} error={valid.defect ? undefined : t("brandMode.store.returnMin", { days: STATUTORY_MIN_DEFECT_DAYS })} />
      <Button title={t("brandMode.common.save")} disabled={!props.canEdit || !valid.changeOfMind || !valid.defect} onPress={() => void props.onSave({ ...props.s, returnDays: { changeOfMind: Number(a), defect: Number(b) } })} />
    </View>
  );
}

function ShippingForm(props: { s: StoreSettings; canEdit: boolean; onSave: (s: StoreSettings) => Promise<void> }) {
  const { t } = useTranslation();
  const [v, setV] = useState(props.s.shipping);
  const [h, setH] = useState(String(props.s.shipping.handlingHours));
  const hOk = validateHandlingHours(Number(h));
  const req = (x: string) => (x.trim() === "" ? t("brandMode.form.err.required") : undefined);
  return (
    <View style={{ gap: 12 }}>
      <TextField label={t("brandMode.store.governorate")} value={v.governorate} disabled={!props.canEdit} onChangeText={(x) => setV({ ...v, governorate: x })} error={req(v.governorate)} />
      <TextField label={t("brandMode.store.city")} value={v.city} disabled={!props.canEdit} onChangeText={(x) => setV({ ...v, city: x })} error={req(v.city)} />
      <TextField label={t("brandMode.store.street")} value={v.street} disabled={!props.canEdit} onChangeText={(x) => setV({ ...v, street: x })} error={req(v.street)} />
      <TextField label={t("brandMode.store.handling")} value={h} keyboardType="numeric" disabled={!props.canEdit} onChangeText={setH} helper={t("brandMode.store.handlingHelp")} error={hOk ? undefined : t("brandMode.store.handlingHelp")} />
      <Button title={t("brandMode.common.save")} disabled={!props.canEdit || !hOk || v.governorate.trim() === "" || v.city.trim() === "" || v.street.trim() === ""} onPress={() => void props.onSave({ ...props.s, shipping: { ...v, handlingHours: Number(h) } })} />
    </View>
  );
}

const DAY = 86_400_000;
function VacationForm(props: { s: StoreSettings; canEdit: boolean; onSave: (s: StoreSettings) => Promise<void> }) {
  const { t, i18n } = useTranslation();
  const on = props.s.vacationEndMs !== null;
  const [days, setDays] = useState<number | null>(null);
  const [now] = useState(Date.now());
  const end = days === null ? null : now + days * DAY;
  const check = validateVacation(end, now);
  const f = new Intl.DateTimeFormat(i18n.language === "en" ? "en-GB" : "ar-EG", { timeZone: "Africa/Cairo", day: "numeric", month: "long" });
  return (
    <View style={{ gap: 14 }}>
      <Text variant="callout" secondary>{t("brandMode.store.vacationHelp")}</Text>
      {on ? (
        <Button title={t("brandMode.store.vacationOff")} variant="secondary" disabled={!props.canEdit} onPress={() => void props.onSave({ ...props.s, vacationEndMs: null })} />
      ) : (
        <>
          <Text variant="caption" secondary>{t("brandMode.store.vacationDays")}</Text>
          <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
            {[3, 7, 14, 30, 90].map((d) => <Chip key={d} label={localizeDigits(String(d), i18n.language === "en" ? "en" : "ar")} selected={days === d} onPress={() => setDays(d)} />)}
          </View>
          {end !== null ? <Text variant="caption" secondary>{t("brandMode.store.vacationEnd", { date: f.format(new Date(end)) })}</Text> : null}
          <Button title={t("brandMode.store.vacation")} disabled={!props.canEdit || check !== "ok"} onPress={() => { if (end !== null) void props.onSave({ ...props.s, vacationEndMs: end }); }} />
        </>
      )}
    </View>
  );
}

function PayoutForm(props: { s: StoreSettings; canEdit: boolean; onNeedStepUp: (retry: () => Promise<void>) => void; onSaved: () => void }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const { port } = useBrand();
  const [iban, setIban] = useState("");
  const [holder, setHolder] = useState("");
  const [busy, setBusy] = useState(false);
  const check = iban.trim() === "" ? null : validateIban(iban);
  const p = props.s.payout;
  const f = new Intl.DateTimeFormat(i18n.language === "en" ? "en-GB" : "ar-EG", { timeZone: "Africa/Cairo", day: "numeric", month: "long", hour: "numeric", minute: "2-digit" });
  const attempt = async (): Promise<void> => {
    setBusy(true);
    try {
      const r = await port.savePayoutAccount(iban, holder);
      toast.show(t(`brandMode.store.nameMatch.${r.nameMatch}`), r.nameMatch === "match" ? "success" : "error");
      setIban(""); setHolder("");
      props.onSaved();
    } catch (e) {
      const k = failureOf(e);
      if (k === "session_expired") props.onNeedStepUp(attempt);
      else toast.show(t(k === "unsupported" ? "brandMode.common.unsupportedBody" : "brandMode.orders.actionFailed"), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={{ gap: 12 }}>
      {p.last4 !== null ? (
        <View style={{ gap: 6 }}>
          <Text variant="headline" numeric>{maskIban(p.last4)}</Text>
          {p.holder !== null ? <Text variant="callout" secondary>{p.holder}</Text> : null}
          {p.nameMatch !== null ? <Badge label={t(`brandMode.store.nameMatch.${p.nameMatch}`)} kind={p.nameMatch === "match" ? "verified" : "neutral"} /> : null}
          {p.activatesAtMs !== null && p.activatesAtMs > Date.now() ? <Banner tone="warning" message={t("brandMode.store.holdActive", { date: f.format(new Date(p.activatesAtMs)) })} /> : null}
        </View>
      ) : null}
      <Banner tone="info" message={t("brandMode.store.holdNotice", { hours: localizeDigits(String(PAYOUT_HOLD_HOURS), i18n.language === "en" ? "en" : "ar") })} />
      <TextField label={t("brandMode.store.iban")} value={iban} onChangeText={setIban} disabled={!props.canEdit} helper={t("brandMode.store.ibanHelp")} error={check !== null && !check.ok ? t(`brandMode.store.ibanErr.${check.code}`) : undefined} testID="brand-iban" />
      <TextField label={t("brandMode.store.holder")} value={holder} onChangeText={setHolder} disabled={!props.canEdit} helper={t("brandMode.store.holderHelp")} />
      <Button title={t("brandMode.store.savePayout")} loading={busy} disabled={!props.canEdit || check === null || !check.ok || holder.trim().length < 3} onPress={() => void attempt()} testID="brand-save-payout" />
    </View>
  );
}

function StepUpSheet(props: { pending: (() => Promise<void>) | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { port } = useBrand();
  const [code, setCode] = useState("");
  const [bad, setBad] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (props.pending !== null) { setCode(""); setBad(false); } }, [props.pending]);
  const go = async () => {
    setBusy(true);
    try {
      await port.verifyStrongFactor(code);
      const retry = props.pending;
      props.onClose();
      if (retry !== null) await retry();
    } catch {
      setBad(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <BottomSheet visible={props.pending !== null} onClose={props.onClose} title={t("brandMode.store.stepUpTitle")} closeLabel={t("brandMode.common.close")}>
      <View style={{ gap: 14 }}>
        <Text variant="callout" secondary>{t("brandMode.store.stepUpBody")}</Text>
        <TextField label={t("brandMode.store.stepUpCode")} value={code} onChangeText={(v) => { setCode(v.replace(/\D/g, "").slice(0, 6)); setBad(false); }} keyboardType="numeric" maxLength={6} error={bad ? t("brandMode.store.stepUpBad") : undefined} autoFocus testID="brand-stepup-code" />
        <Button title={t("brandMode.store.stepUpConfirm")} loading={busy} disabled={code.length !== 6} onPress={() => void go()} />
      </View>
    </BottomSheet>
  );
}

function TeamPanel(props: { canManage: boolean }) {
  const { t } = useTranslation();
  const toast = useToast();
  const { port } = useBrand();
  const team = useLoad<readonly TeamMember[]>("team", () => port.team());
  const [phone, setPhone] = useState("");
  const [role, setRole] = useState<InviteRole>("catalog");
  const e164 = normalizeEgPhone(phone);
  const invite = async () => {
    if (e164 === null) return;
    try { await port.invite(e164, role); setPhone(""); team.reload(); } catch (e) { toast.show(t(failureOf(e) === "unsupported" ? "brandMode.common.unsupportedBody" : "brandMode.orders.actionFailed"), "error"); }
  };
  return (
    <View style={{ gap: 14 }}>
      {team.state.status === "loading" ? <Skeleton height={56} /> : null}
      {team.state.status === "error" ? <FailureView failure={team.state.failure} onRetry={team.reload} /> : null}
      {team.state.status === "ready" ? team.state.data.map((m) => (
        <ListRow key={m.id} title={m.name} subtitle={`${t(`brandMode.store.roles.${m.role}`)}${m.status === "invited" ? ` · ${t("brandMode.store.teamInvited")}` : ""}`} chevron={false}
          trailing={props.canManage && m.role !== "owner" ? <Button title={t("brandMode.store.teamRevoke")} variant="ghost" fullWidth={false} onPress={() => { void port.revoke(m.id).then(team.reload, () => toast.show(t("brandMode.orders.actionFailed"), "error")); }} /> : undefined} />
      )) : null}
      {props.canManage ? (
        <View style={{ gap: 12 }}>
          <Text variant="headline">{t("brandMode.store.teamInvite")}</Text>
          <TextField label={t("brandMode.store.teamPhone")} value={phone} onChangeText={setPhone} keyboardType="phone-pad" error={phone.length > 5 && e164 === null ? t("brandMode.store.teamPhoneErr") : undefined} />
          <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
            {INVITE_ROLES.map((r) => <Chip key={r} label={t(`brandMode.store.roles.${r}`)} selected={role === r} onPress={() => setRole(r)} />)}
          </View>
          <Button title={t("brandMode.store.teamSend")} disabled={e164 === null} onPress={() => void invite()} />
        </View>
      ) : <Text variant="caption" secondary>{t("brandMode.store.teamOwnerOnly")}</Text>}
    </View>
  );
}
