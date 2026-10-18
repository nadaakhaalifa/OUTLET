import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { Banner, BottomSheet, Button, Card, Eyebrow, ListRow, LoadingState, ProgressBar, Reveal, Text, useTheme } from "../../../ui";
import { ErrorNote, FlowScreen, StatusChip, slotIcon, useDigits } from "../components";
import { useAction, useBrandApply } from "../context";
import { useFlowNav } from "../nav";
import {
  buildChecklist, canDelete, canStartUpload, errorCodeOf, isEditable, isRetryable, pickBi, slotFromServer, slotReducer, stepProgress, validateFile, wireContentType,
  MAX_DOCUMENTS, type DocView, type FileError, type PickSource, type PickedFile, type ReqDoc, type SlotEvent, type SlotState,
} from "../model";

type Slots = Readonly<Record<string, SlotState>>;
type Action = { readonly code: string; readonly ev: SlotEvent } | { readonly reset: Slots };
function reducer(s: Slots, a: Action): Slots {
  if ("reset" in a) return a.reset;
  return { ...s, [a.code]: slotReducer(s[a.code] ?? { kind: "missing" }, a.ev) };
}
const fromDocs = (docs: readonly DocView[]): Slots => Object.fromEntries(docs.map((d) => [d.requirementCode, slotFromServer(d)]));

export function DocumentsScreen() {
  const { t } = useTranslation();
  const { spacing } = useTheme();
  const digits = useDigits();
  const s = useBrandApply();
  const nav = useFlowNav();
  const load = useAction();
  const fixMode = s.app?.status === "NEEDS_INFO";
  const draftId = s.draft.draftId;
  const [slots, dispatch] = useReducer(reducer, s.app?.documents ?? [], (d: readonly DocView[]) => fromDocs(d));
  const [docIds, setDocIds] = useState<Readonly<Record<string, string>>>(() => Object.fromEntries((s.app?.documents ?? []).map((d) => [d.requirementCode, d.id])));
  const [sheetFor, setSheetFor] = useState<ReqDoc | null>(null);
  const [permissionNote, setPermissionNote] = useState(false);
  const picked = useRef<Record<string, PickedFile>>({});
  const reasons = useRef<Record<string, FileError | undefined>>({});
  const editable = s.app === null ? true : isEditable(s.app);
  const docs = s.requirements?.documents ?? [];
  const count = Object.values(slots).filter((x) => x.kind !== "missing").length;

  useEffect(() => { if (!fixMode) s.rememberStep("documents"); }, [s.rememberStep, fixMode]);

  const refresh = useCallback(async () => {
    if (draftId === null) return;
    const a = await s.kit.port.getApplication(draftId);
    s.setApp(a);
    setDocIds(Object.fromEntries(a.documents.map((d) => [d.requirementCode, d.id])));
    for (const d of a.documents) dispatch({ code: d.requirementCode, ev: { t: "server", doc: d } });
  }, [draftId, s]);

  useEffect(() => {
    if (s.requirements !== null || s.draft.kind === null || s.draft.country === null) return;
    const { kind, country } = s.draft;
    void load.run(async () => { s.setRequirements(await s.kit.port.getRequirements(kind, country)); await refresh(); });
  }, []);
  useEffect(() => { if (s.requirements !== null && s.app === null) void load.run(refresh); }, [s.requirements]);

  // Poll while the security scan runs.
  const scanning = Object.values(slots).some((x) => x.kind === "scanning" || x.kind === "uploaded") && Object.values(slots).some((x) => x.kind === "scanning");
  useEffect(() => {
    if (!scanning) return;
    const id = setInterval(() => void refresh().catch(() => undefined), 2500);
    return () => clearInterval(id);
  }, [scanning, refresh]);

  const upload = useCallback(async (doc: ReqDoc, file: PickedFile) => {
    if (draftId === null) return;
    const bad = validateFile(file, doc.accepts, doc.maxBytes);
    if (bad !== null) { reasons.current[doc.code] = bad; dispatch({ code: doc.code, ev: { t: "start" } }); dispatch({ code: doc.code, ev: { t: "fail", reason: bad } }); return; }
    picked.current[doc.code] = file;
    reasons.current[doc.code] = undefined;
    dispatch({ code: doc.code, ev: { t: "start" } });
    try {
      const d = await s.kit.port.uploadDocument(draftId, { requirementCode: doc.code, contentType: wireContentType(file.mimeType), sizeBytes: file.sizeBytes, uri: file.uri, filename: file.name },
        (ratio) => dispatch({ code: doc.code, ev: { t: "progress", ratio } }));
      dispatch({ code: doc.code, ev: { t: "done" } });
      setDocIds((x) => ({ ...x, [doc.code]: d.id }));
      dispatch({ code: doc.code, ev: { t: "server", doc: d } });
    } catch (e) {
      dispatch({ code: doc.code, ev: { t: "fail", reason: errorCodeOf(e) === "offline" ? "network" : "server" } });
    }
  }, [draftId, s.kit.port]);

  const choose = async (doc: ReqDoc, source: PickSource) => {
    setSheetFor(null);
    setPermissionNote(false);
    try {
      const f = await s.kit.picker.pick(source);
      if (f !== null) await upload(doc, f);
    } catch { setPermissionNote(true); }
  };
  const remove = (doc: ReqDoc) => {
    const id = docIds[doc.code];
    if (id === undefined || draftId === null) { dispatch({ code: doc.code, ev: { t: "remove" } }); return; }
    void load.run(async () => { await s.kit.port.deleteDocument(draftId, id); dispatch({ code: doc.code, ev: { t: "remove" } }); delete picked.current[doc.code]; await refresh().catch(() => undefined); });
  };

  const checklist = useMemo(() => buildChecklist(docs, slots), [docs, slots]);
  const requiredCount = new Set(docs.filter((d) => d.required).map((d) => d.group ?? d.code)).size;
  const doneCount = requiredCount - checklist.missing.length;

  const stateLabel = (st: SlotState): string => {
    switch (st.kind) {
      case "uploading": return t("brandApply.documents.state.uploading", { percent: digits(`${Math.round(st.progress * 100)}%`) });
      case "failed": return t("brandApply.documents.state.failed");
      default: return t(`brandApply.documents.state.${st.kind}`);
    }
  };
  const note = (code: string, st: SlotState): string | null => {
    if (st.kind === "failed") return t(`brandApply.documents.reason.${st.reason}`);
    if (st.kind === "rejected") return st.note ?? t(`brandApply.documents.reason.${st.reason}`);
    if (st.kind === "needs_replacement") return t("brandApply.documents.reason.unreadable");
    void code; return null;
  };

  const renderDoc = (doc: ReqDoc) => {
    const st = slots[doc.code] ?? { kind: "missing" as const };
    const n = note(doc.code, st);
    const bad = st.kind === "failed" || st.kind === "rejected" || st.kind === "needs_replacement";
    const tone = bad ? "bad" : st.kind === "accepted" ? "good" : "neutral";
    return (
      <View key={doc.code} testID={`brand-doc-${doc.code}`}><Card variant="elevated" style={{ gap: spacing.sm, paddingVertical: spacing.lg }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
          <View style={{ flex: 1 }}>
            <Text variant="headline">{pickBi(doc.label, s.lang)}</Text>
          </View>
          <StatusChip label={stateLabel(st)} icon={slotIcon(st)} tone={tone} />
        </View>
        {doc.help !== undefined ? <Text variant="caption" secondary>{pickBi(doc.help, s.lang)}</Text> : null}
        {st.kind === "uploading" ? <ProgressBar current={Math.round(st.progress * 100)} target={100} label={stateLabel(st)} /> : null}
        {n !== null ? <Text variant="caption" color="danger">{n}</Text> : null}
        {editable ? (
          <View style={{ flexDirection: "row", gap: spacing.sm, flexWrap: "wrap" }}>
            {isRetryable(st) && picked.current[doc.code] !== undefined ? (
              <Button variant="secondary" fullWidth={false} title={t("brandApply.documents.retry")} onPress={() => { const f = picked.current[doc.code]; if (f !== undefined) void upload(doc, f); }} />
            ) : null}
            {canStartUpload(st) && st.kind !== "uploading" ? (
              <Button variant={st.kind === "missing" ? "primary" : "secondary"} fullWidth={false} icon={st.kind === "missing" ? "add" : "swap-horizontal-outline"} disabled={count >= MAX_DOCUMENTS && st.kind === "missing"}
                title={st.kind === "missing" ? t("brandApply.documents.add") : t("brandApply.documents.replace")} onPress={() => setSheetFor(doc)} testID={`brand-doc-add-${doc.code}`} />
            ) : null}
            {canDelete(st, editable) ? <Button variant="ghost" fullWidth={false} title={t("brandApply.documents.remove")} onPress={() => remove(doc)} /> : null}
          </View>
        ) : null}
      </Card></View>
    );
  };

  // Alternatives (same group) are shown together under one "provide one of" heading.
  const rendered: React.ReactNode[] = [];
  const seen = new Set<string>();
  for (const d of docs) {
    if (d.group === undefined) { rendered.push(renderDoc(d)); continue; }
    if (seen.has(d.group)) continue;
    seen.add(d.group);
    const members = docs.filter((x) => x.group === d.group);
    rendered.push(
      <View key={`g-${d.group}`} style={{ gap: spacing.md, paddingTop: spacing.sm }}>
        <Eyebrow secondary>{t("brandApply.documents.oneOf")}</Eyebrow>
        {members.map(renderDoc)}
      </View>,
    );
  }

  return (
    <FlowScreen
      eyebrow={t("brandApply.documents.eyebrow")} title={t("brandApply.documents.title")} body={t("brandApply.documents.body")}
      progress={fixMode ? undefined : stepProgress("documents", nav.steps)} onBack={nav.back}
      footer={<>
        <Text variant="caption" secondary align="center" accessibilityRole="text">{digits(t("brandApply.documents.progress", { done: Math.max(0, doneCount), total: requiredCount }))}</Text>
        <Button title={fixMode ? t("brandApply.common.done") : t("brandApply.common.continue")} disabled={!checklist.complete} onPress={() => { if (fixMode) nav.back(); else { s.patchDraft({ step: "website" }); nav.next("documents"); } }} testID="brand-docs-continue" />
      </>}
    >
      {s.requirements === null && load.error === null ? <LoadingState label={t("brandApply.common.loading")} /> : null}
      <ErrorNote code={load.error} />
      {permissionNote ? <Banner tone="warning" message={t("brandApply.documents.permission")} /> : null}
      <Reveal><View style={{ gap: spacing.md }}>{rendered}</View></Reveal>
      <BottomSheet visible={sheetFor !== null} onClose={() => setSheetFor(null)} title={sheetFor !== null ? pickBi(sheetFor.label, s.lang) : t("brandApply.documents.chooseSource")} closeLabel={t("brandApply.common.cancel")}>
        {sheetFor !== null ? (
          <View>
            <ListRow title={t("brandApply.documents.camera")} leadingIcon="camera-outline" chevron onPress={() => void choose(sheetFor, "camera")} testID="brand-source-camera" />
            <ListRow title={t("brandApply.documents.library")} leadingIcon="images-outline" chevron onPress={() => void choose(sheetFor, "library")} testID="brand-source-library" />
            <ListRow title={t("brandApply.documents.files")} leadingIcon="document-outline" chevron onPress={() => void choose(sheetFor, "files")} testID="brand-source-files" />
          </View>
        ) : null}
      </BottomSheet>
    </FlowScreen>
  );
}
