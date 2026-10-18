import { useCallback, useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { Illustration } from "../../art";
import { Banner, Button, Chip, EmptyState, ErrorState, Eyebrow, ProgressBar, Reveal, Screen, Skeleton, SwitchRow, Text, TextField } from "../../ui";
import { Section } from "../account-ui";
import { localizeDigits, type DisplayLocale } from "../money-display";
import { opt } from "../search/optional";
import {
  FIT_PREFERENCES, MEASUREMENT_KEYS, advance, back, collectMeasurements, currentKey, enterValue,
  formatTenths, initialWizard, isFinished, isMeasuredLater, measureLaterProfile, profilesFailureState, quickStart, validateLabel,
  type FitPreference, type NewProfile, type ProfileKind, type ProfilesScreenState, type SizeProfile, type SizeProfilePort, type WizardState,
} from "./model";
import { getFeaturePorts } from "../../state/ports";

const KINDS: readonly ProfileKind[] = ["me", "partner", "child"];

function Wizard(props: { label: string; kind: ProfileKind; locale: DisplayLocale; onDone: (p: NewProfile) => Promise<void>; onCancel: () => void }) {
  const { t } = useTranslation();
  const [w, setW] = useState<WizardState>(initialWizard());
  const [fit, setFit] = useState<FitPreference>("regular");
  const [modest, setModest] = useState(false);
  const [saving, setSaving] = useState(false);
  const key = currentKey(w);
  const num = (n: number) => localizeDigits(String(n), props.locale);

  if (isFinished(w)) {
    const { measurements, issues } = collectMeasurements(w);
    const save = async () => {
      setSaving(true);
      try {
        await props.onDone({ kind: props.kind, label: props.label.trim(), fitPreference: fit, modestFit: modest, measurements, usualSize: null });
      } finally {
        setSaving(false);
      }
    };
    return (
      <Section title={t("sizeProfile.reviewHeading")}>
        {MEASUREMENT_KEYS.map((k) => {
          const v = measurements[k];
          return v === undefined ? null : <Text key={k}>{t("sizeProfile.reviewRow", { name: t(`sizeProfile.key.${k}`), value: localizeDigits(formatTenths(v), props.locale), unit: t(k === "weight" ? "sizeProfile.unitKg" : "sizeProfile.unitCm") })}</Text>;
        })}
        {issues.map((i) => <Banner key={i} tone="warning" message={t(`sizeProfile.issue.${i}`)} />)}
        <Text variant="caption" secondary>{t("sizeProfile.fitHeading")}</Text>
        <View accessibilityRole="radiogroup" accessibilityLabel={t("sizeProfile.fitHeading")} style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {FIT_PREFERENCES.map((f) => <Chip key={f} label={t(`sizeProfile.fit.${f}`)} selected={f === fit} onPress={() => setFit(f)} />)}
        </View>
        <SwitchRow label={t("sizeProfile.modest")} value={modest} onValueChange={setModest} />
        <Button title={t("sizeProfile.save")} loading={saving} disabled={issues.length > 0} onPress={() => void save()} />
        <Button variant="secondary" title={t("sizeProfile.back")} onPress={() => setW(back(w))} />
      </Section>
    );
  }
  if (key === null) return null;
  const error = w.errors[key];
  const unit = t(key === "weight" ? "sizeProfile.unitKg" : "sizeProfile.unitCm");
  return (
    <Reveal index={0}><View style={{ gap: 14 }}>
      <View style={{ alignItems: "center" }}><Illustration name="measureTape" size={112} /></View>
      <ProgressBar current={w.index + 1} target={MEASUREMENT_KEYS.length} label={t("sizeProfile.stepOf", { current: num(w.index + 1), total: num(MEASUREMENT_KEYS.length) })} />
      <Text variant="caption" secondary>{t("sizeProfile.stepOf", { current: num(w.index + 1), total: num(MEASUREMENT_KEYS.length) })}</Text>
      <Text variant="display">{t(`sizeProfile.key.${key}`)}</Text>
      <Text variant="lede" secondary>{t(`sizeProfile.tip.${key}`)}</Text>
      <TextField
        label={t("sizeProfile.valueLabel", { name: t(`sizeProfile.key.${key}`), unit })}
        value={w.values[key] ?? ""}
        keyboardType="numeric"
        onChangeText={(v) => setW(enterValue(w, key, v))}
        {...opt("error", error !== undefined && error !== "empty" ? t(`sizeProfile.error.${error}`) : undefined)}
      />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Button title={(w.values[key] ?? "").trim().length === 0 ? t("sizeProfile.skip") : t("sizeProfile.next")} onPress={() => setW(advance(w))} />
        {w.index > 0 ? <Button variant="secondary" title={t("sizeProfile.back")} onPress={() => setW(back(w))} /> : null}
        <Button variant="secondary" title={t("common.cancel")} onPress={props.onCancel} />
      </View>
    </View></Reveal>
  );
}

function QuickStart(props: { label: string; kind: ProfileKind; onDone: (p: NewProfile) => Promise<void> }) {
  const { t } = useTranslation();
  const [h, setH] = useState("");
  const [wt, setWt] = useState("");
  const [size, setSize] = useState("");
  const [errs, setErrs] = useState<readonly string[]>([]);
  const go = async () => {
    const r = quickStart({ heightRaw: h, weightRaw: wt, usualSize: size });
    setErrs(r.errors);
    if (r.errors.length === 0) await props.onDone({ kind: props.kind, label: props.label.trim(), fitPreference: "regular", modestFit: false, measurements: r.measurements, usualSize: size.trim() });
  };
  const e = (k: string) => (errs.includes(k) ? t(`sizeProfile.quick.${k}`) : undefined);
  return (
    <Section title={t("sizeProfile.quickHeading")}>
      <TextField label={t("sizeProfile.quick.height")} value={h} onChangeText={setH} keyboardType="numeric" {...opt("error", e("heightInvalid"))} />
      <TextField label={t("sizeProfile.quick.weight")} value={wt} onChangeText={setWt} keyboardType="numeric" {...opt("error", e("weightInvalid"))} />
      <TextField label={t("sizeProfile.quick.size")} helper={t("sizeProfile.quick.sizeHelper")} value={size} onChangeText={setSize} {...opt("error", e("sizeRequired"))} />
      <Button title={t("sizeProfile.save")} onPress={() => void go()} />
    </Section>
  );
}

type Mode = "list" | "guided" | "quick";

/** `single`: the device-local guest profile: one profile named "Me", no kind picker, no second profile. */
export function SizeProfileScreen(props: { port?: SizeProfilePort; single?: boolean }) {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const locale: DisplayLocale = i18n.language === "en" ? "en" : "ar";
  const port = useMemo<SizeProfilePort>(() => props.port ?? getFeaturePorts().sizeProfile, [props.port]);
  const [state, setState] = useState<ProfilesScreenState>({ status: "loading" });
  const [mode, setMode] = useState<Mode>("list");
  const single = props.single === true;
  const [label, setLabel] = useState(single ? t("sizeProfile.kind.me") : "");
  const [kind, setKind] = useState<ProfileKind>("me");
  const [labelError, setLabelError] = useState<"required" | "tooLong" | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      setState({ status: "ready", profiles: await port.list() });
    } catch (e) {
      setState(profilesFailureState(e));
    }
  }, [port]);
  useEffect(() => { void load(); }, [load]);

  const persist = async (p: NewProfile) => {
    setFailed(false);
    try {
      await port.save(p);
      setMode("list");
      setLabel(single ? t("sizeProfile.kind.me") : "");
      await load();
    } catch {
      setFailed(true);
    }
  };
  const begin = (m: Mode) => {
    const err = validateLabel(label);
    setLabelError(err);
    if (err === null) setMode(m);
  };
  const remove = async (p: SizeProfile) => {
    setFailed(false);
    try {
      await port.remove(p.id);
      await load();
    } catch {
      setFailed(true);
    }
  };

  return (
    <Screen title={t("sizeProfile.title")} onBack={() => router.back()} backLabel={t("common.back")}>
      <Text variant="lede" secondary>{t("sizeProfile.privacy")}</Text>
      {single ? <Text variant="caption" secondary>{t("guestMe.sizeLocalNote")}</Text> : null}
      {state.status === "loading" ? (
        <View accessibilityRole="progressbar" accessibilityLabel={t("sizeProfile.loading")} style={{ gap: 14 }}>
          <Skeleton width="50%" height={28} />
          <Skeleton height={44} radius={14} />
          <Skeleton height={44} radius={14} />
        </View>
      ) : null}
      {state.status === "error" ? (
        <ErrorState
          offline={state.offline}
          title={t(state.offline ? "sizeProfile.offlineTitle" : "sizeProfile.errorTitle")}
          description={t(state.offline ? "sizeProfile.offlineBody" : "sizeProfile.errorBody")}
          retryTitle={t("common.retry")}
          onRetry={() => void load()}
        />
      ) : null}
      {failed ? <Banner tone="error" message={t("sizeProfile.actionFailed")} /> : null}
      {state.status === "ready" && mode === "list" ? (
        <>
          {state.profiles.length === 0 ? <EmptyState illustration={<Illustration name="measureTape" size={112} />} title={t("sizeProfile.emptyTitle")} description={t("sizeProfile.emptyBody")} /> : null}
          {state.profiles.map((p) => (
            <Section key={p.id}>
              <Text variant="title1">{p.label}</Text>
              <Eyebrow>{t(`sizeProfile.kind.${p.kind}`)}</Eyebrow>
              {isMeasuredLater(p) ? <Text secondary>{t("sizeProfile.measureLaterNote")}</Text> : null}
              {p.usualSize !== null ? <Text secondary>{t("sizeProfile.usualSize", { size: p.usualSize })}</Text> : null}
              <Button variant="secondary" title={t("sizeProfile.delete")} accessibilityLabel={t("sizeProfile.deleteName", { label: p.label })} onPress={() => void remove(p)} />
            </Section>
          ))}
          {single && state.profiles.length > 0 ? null : <Section title={t("sizeProfile.addHeading")}>
            <TextField
              label={t("sizeProfile.labelField")}
              helper={t("sizeProfile.labelHelper")}
              value={label}
              onChangeText={setLabel}
              {...opt("error", labelError === null ? undefined : t(`sizeProfile.labelError.${labelError}`))}
            />
            {single ? null : <View accessibilityRole="radiogroup" accessibilityLabel={t("sizeProfile.kindPicker")} style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {KINDS.map((k) => <Chip key={k} label={t(`sizeProfile.kind.${k}`)} selected={k === kind} onPress={() => setKind(k)} />)}
            </View>}
            {kind === "child" ? <Text variant="caption" secondary>{t("sizeProfile.childNote")}</Text> : null}
            <Button variant="brand" title={t("sizeProfile.startGuided")} onPress={() => begin("guided")} />
            <Button variant="secondary" title={t("sizeProfile.startQuick")} onPress={() => begin("quick")} />
            <Button
              variant="secondary"
              title={t("sizeProfile.measureLater")}
              onPress={() => {
                const err = validateLabel(label);
                setLabelError(err);
                if (err === null) void persist(measureLaterProfile(label, kind));
              }}
            />
          </Section>}
        </>
      ) : null}
      {state.status === "ready" && mode === "guided" ? <Wizard label={label} kind={kind} locale={locale} onDone={persist} onCancel={() => setMode("list")} /> : null}
      {state.status === "ready" && mode === "quick" ? (
        <>
          <QuickStart label={label} kind={kind} onDone={persist} />
          <Button variant="secondary" title={t("common.cancel")} onPress={() => setMode("list")} />
        </>
      ) : null}
    </Screen>
  );
}
