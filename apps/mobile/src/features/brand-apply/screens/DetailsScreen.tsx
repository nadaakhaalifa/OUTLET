import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { Banner, Button, Eyebrow, LoadingState, Radio, Text, TextField, useTheme } from "../../../ui";
import { ErrorNote, FlowScreen } from "../components";
import { useAction, useBrandApply } from "../context";
import { useFlowNav } from "../nav";
import {
  dirtyValues, normalizeFieldValue, pickBi, stepProgress, validateDetails, validateField, isEditable,
  type ErrorCode, type FieldFormat, type ReqField,
} from "../model";

const KEYBOARD: Partial<Record<FieldFormat, "numeric" | "phone-pad" | "email-address">> = {
  national_id: "numeric", tax_card_no: "numeric", phone: "phone-pad", email: "email-address", date: "numeric",
};
const OWNERSHIP = ["brand_owner", "authorized_distributor", "third_party_reseller"] as const;
type Saving = "idle" | "saving" | "saved" | "failed";

export function DetailsScreen() {
  const { t } = useTranslation();
  const { spacing } = useTheme();
  const s = useBrandApply();
  const nav = useFlowNav();
  const load = useAction();
  const fixMode = s.app?.status === "NEEDS_INFO";
  const [values, setValues] = useState<Record<string, string>>(() => ({ ...(s.app?.values ?? {}) }));
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const [saving, setSaving] = useState<Saving>("idle");
  const [basis, setBasis] = useState<string>(s.app?.ownershipBasis ?? "brand_owner");
  const savedRef = useRef<Record<string, string>>({ ...(s.app?.values ?? {}) });
  const basisSaved = useRef<string>(s.app?.ownershipBasis ?? "");
  const versionRef = useRef<string | null>(s.app?.version ?? null);
  const draftId = s.draft.draftId;
  const { requirements } = s;
  const kind = s.draft.kind;
  const country = s.draft.country;
  const fields = useMemo(() => requirements?.fields ?? [], [requirements]);
  const editable = s.app === null ? true : isEditable(s.app);

  useEffect(() => { if (!fixMode) s.rememberStep("details"); }, [s.rememberStep, fixMode]);

  const fetchReq = useCallback(() => {
    if (kind === null || country === null) return;
    void load.run(async () => {
      const r = await s.kit.port.getRequirements(kind, country);
      s.setRequirements(r);
      if (draftId !== null && s.app === null) {
        const a = await s.kit.port.getApplication(draftId);
        s.setApp(a);
        setValues((v) => ({ ...a.values, ...v }));
        savedRef.current = { ...a.values };
        versionRef.current = a.version;
      }
    });
  }, [kind, country, draftId, s, load]);
  useEffect(() => { if (requirements === null) fetchReq(); }, []);

  // Only values that pass validation are sent: a half-typed number never produces a 422 while the user is still typing.
  const pending = useMemo(() => {
    const out: Record<string, string> = {};
    for (const f of fields) {
      const raw = values[f.code] ?? "";
      if (raw === "" || validateField(f, raw) === null) out[f.code] = raw === "" ? "" : normalizeFieldValue(f, raw);
    }
    return dirtyValues(savedRef.current, out);
  }, [values, fields]);

  const flush = useCallback(async (): Promise<boolean> => {
    if (draftId === null || !editable) return true;
    const dirtyBasis = basis !== basisSaved.current;
    const sendable = Object.fromEntries(Object.entries(pending).filter(([, v]) => v !== ""));
    if (Object.keys(sendable).length === 0 && !dirtyBasis) return true;
    setSaving("saving");
    try {
      const app = await s.kit.port.updateApplication(draftId, { values: sendable, ...(dirtyBasis ? { ownershipBasis: basis } : {}) }, versionRef.current);
      savedRef.current = { ...savedRef.current, ...pending };
      basisSaved.current = basis;
      versionRef.current = app.version;
      s.setApp(app);
      setSaving("saved");
      return true;
    } catch (e) {
      setSaving("failed");
      void e;
      return false;
    }
  }, [draftId, editable, pending, basis, s]);

  // Autosave as DRAFT, debounced.
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => {
    if (Object.keys(pending).length === 0 && basis === basisSaved.current) return;
    const id = setTimeout(() => void flushRef.current(), 900);
    return () => clearTimeout(id);
  }, [pending, basis]);

  const errors = validateDetails(fields, values);
  const fieldError = (f: ReqField): string | undefined => {
    const e = errors[f.code];
    return e !== undefined && (showAll || touched.has(f.code)) ? t(`brandApply.errors.${e}`) : undefined;
  };
  const set = (f: ReqField, v: string) => {
    setValues((x) => ({ ...x, [f.code]: v }));
    setTouched((x) => new Set(x).add(f.code));
  };

  const cont = () => {
    setShowAll(true);
    if (Object.keys(errors).length > 0) return;
    void (async () => {
      const ok = await flush();
      if (!ok) return;
      if (fixMode) nav.back();
      else { s.patchDraft({ step: "documents" }); nav.next("details"); }
    })();
  };

  const status = saving === "saving" ? t("brandApply.details.draftSaving") : saving === "saved" ? t("brandApply.details.draftSaved") : saving === "failed" ? t("brandApply.details.draftFailed") : "";
  const err: ErrorCode | null = load.error;

  return (
    <FlowScreen
      eyebrow={t("brandApply.details.eyebrow")} title={t("brandApply.details.title")} body={t("brandApply.details.body")}
      progress={fixMode ? undefined : stepProgress("details", nav.steps)} onBack={nav.back}
      footer={<>
        {status !== "" ? <Text variant="caption" secondary align="center" accessibilityRole="text">{status}</Text> : null}
        <Button title={fixMode ? t("brandApply.common.done") : t("brandApply.common.continue")} disabled={requirements === null} onPress={cont} testID="brand-details-continue" />
      </>}
    >
      {requirements === null && err === null ? <LoadingState label={t("brandApply.common.loading")} /> : null}
      {requirements === null && err !== null ? (
        <View style={{ gap: spacing.md }}><ErrorNote code={err} /><Button variant="secondary" title={t("brandApply.common.retry")} onPress={fetchReq} /></View>
      ) : null}
      {fields.map((f) => (
        <TextField
          key={f.code} testID={`brand-field-${f.code}`}
          label={`${pickBi(f.label, s.lang)}${f.required ? "" : ` (${t("brandApply.common.optional")})`}`}
          value={values[f.code] ?? ""} onChangeText={(v) => set(f, v)}
          keyboardType={KEYBOARD[f.format] ?? "default"} error={fieldError(f)} disabled={!editable}
        />
      ))}
      {requirements !== null ? (
        <View style={{ gap: spacing.xs, paddingTop: spacing.md }}>
          <Eyebrow secondary>{t("brandApply.details.ownershipTitle")}</Eyebrow>
          {OWNERSHIP.map((o) => <Radio key={o} label={t(`brandApply.details.${o}`)} selected={basis === o} onPress={() => setBasis(o)} disabled={!editable} />)}
        </View>
      ) : null}
      {saving === "failed" ? <Banner tone="warning" message={t("brandApply.details.draftFailed")} /> : null}
    </FlowScreen>
  );
}
