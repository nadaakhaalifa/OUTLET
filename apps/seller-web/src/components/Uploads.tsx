"use client";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import type { Out } from "../app/actions-onboarding";
import { createTranslator, type Locale, type MessageKey } from "../i18n";
import { putWithProgress, sha256Hex } from "../lib/upload";
import { FILE_PROBLEM_KEY, formatBytes, uploadPercent, validateFile } from "../view-models/application-form";

type Begin = (f: { name: string; type: string; size: number; sha256: string }) => Promise<Out<{ ref: string; uploadUrl: string; headers: Record<string, string> }>>;
type Finish = (ref: string) => Promise<Out<unknown>>;

type Phase = { kind: "idle" } | { kind: "hashing" } | { kind: "uploading"; pct: number } | { kind: "confirming" } | { kind: "done" } | { kind: "error"; key: MessageKey };

/** One file input with progress. The browser PUTs straight to storage; the API only signs and confirms. */
function UploadControl({
  label, hint, statusText, accept, accepts, maxBytes, begin, finish, locale, actionLabel,
}: {
  label: string; hint: string | null; statusText: string; accept: string; accepts: readonly string[]; maxBytes: number;
  begin: Begin; finish: Finish; locale: Locale; actionLabel: string;
}) {
  const t = createTranslator(locale);
  const router = useRouter();
  const id = useId();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const input = useRef<HTMLInputElement>(null);

  async function onPick(file: File | undefined): Promise<void> {
    if (file === undefined) return;
    const problem = validateFile(file, { accepts, maxBytes });
    if (problem !== null) {
      setPhase({ kind: "error", key: FILE_PROBLEM_KEY[problem] });
      return;
    }
    try {
      setPhase({ kind: "hashing" });
      const sha256 = await sha256Hex(file);
      const b = await begin({ name: file.name, type: file.type, size: file.size, sha256 });
      if (!b.ok) {
        if (b.unauthorized === true) window.location.assign("/login");
        setPhase({ kind: "error", key: b.messageKey });
        return;
      }
      setPhase({ kind: "uploading", pct: 0 });
      const put = await putWithProgress(b.data.uploadUrl, b.data.headers, file, (l, tot) => setPhase({ kind: "uploading", pct: uploadPercent(l, tot) }));
      if (put !== "ok") {
        setPhase({ kind: "error", key: put === "network" ? "state.offline" : "ob.doc.err.upload" });
        return;
      }
      setPhase({ kind: "confirming" });
      const f = await finish(b.data.ref);
      if (!f.ok) {
        setPhase({ kind: "error", key: f.messageKey });
        return;
      }
      setPhase({ kind: "done" });
      router.refresh();
    } catch {
      setPhase({ kind: "error", key: "state.error" });
    } finally {
      if (input.current !== null) input.current.value = "";
    }
  }

  const busy = phase.kind === "hashing" || phase.kind === "uploading" || phase.kind === "confirming";
  return (
    <div className="zm-upload">
      <div className="zm-upload-head">
        <label htmlFor={id}>{label}</label>
        <span className="zm-tag">{statusText}</span>
      </div>
      {hint === null ? null : <p className="zm-hint">{hint}</p>}
      <p className="zm-hint">{t("ob.doc.limits", { size: formatBytes(maxBytes) })}</p>
      <input ref={input} id={id} type="file" accept={accept} disabled={busy} onChange={(e) => void onPick(e.currentTarget.files?.[0])} className="zm-file" aria-label={`${actionLabel}: ${label}`} />
      {phase.kind === "uploading" ? (
        <div className="zm-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={phase.pct} aria-label={t("ob.doc.uploading")}>
          <progress max={100} value={phase.pct} />
          <span>{phase.pct}%</span>
        </div>
      ) : null}
      <p role="status" className="zm-hint">
        {phase.kind === "hashing" ? t("ob.doc.hashing") : phase.kind === "confirming" ? t("ob.doc.confirming") : phase.kind === "done" ? t("ob.doc.uploaded") : ""}
      </p>
      {phase.kind === "error" ? <p role="alert" className="zm-err">{t(phase.key)}</p> : null}
    </div>
  );
}

export interface DocSlotView {
  readonly code: string;
  readonly label: string;
  readonly help: string | null;
  readonly required: boolean;
  readonly group: string | null;
  readonly accepts: readonly string[];
  readonly acceptAttr: string;
  readonly maxBytes: number;
  readonly stateLabel: string;
  readonly needsUpload: boolean;
  readonly scanning: boolean;
  readonly filename: string | null;
}

export function DocumentSlots({
  applicationId, slots, locale, createDocument, confirmDocument,
}: {
  applicationId: string;
  slots: readonly DocSlotView[];
  locale: Locale;
  createDocument: (i: { id: string; requirementCode: string; contentType: string; size: number; sha256: string; filename: string }) => Promise<Out<{ documentId: string; uploadUrl: string; headers: Record<string, string> }>>;
  confirmDocument: (i: { id: string; documentId: string }) => Promise<Out>;
}) {
  const t = createTranslator(locale);
  const router = useRouter();
  const scanning = slots.some((s) => s.scanning);
  useEffect(() => {
    if (!scanning) return undefined;
    const h = window.setInterval(() => router.refresh(), 5000);
    return () => window.clearInterval(h);
  }, [scanning, router]);

  return (
    <ul className="zm-list">
      {slots.map((s) => (
        <li key={s.code}>
          <UploadControl
            label={`${s.label}${s.required ? "" : ` (${t("ob.doc.optional")})`}`}
            hint={s.help}
            statusText={s.group === null ? s.stateLabel : `${s.stateLabel} · ${t("ob.doc.oneOf")}`}
            accept={s.acceptAttr}
            accepts={s.accepts}
            maxBytes={s.maxBytes}
            locale={locale}
            actionLabel={s.needsUpload ? t("ob.doc.choose") : t("ob.doc.replace")}
            begin={async (f) => {
              const r = await createDocument({ id: applicationId, requirementCode: s.code, contentType: f.type, size: f.size, sha256: f.sha256, filename: f.name });
              return r.ok ? { ok: true, data: { ref: r.data.documentId, uploadUrl: r.data.uploadUrl, headers: r.data.headers } } : r;
            }}
            finish={(ref) => confirmDocument({ id: applicationId, documentId: ref })}
          />
          {s.filename === null ? null : <p className="zm-hint" dir="auto">{s.filename}</p>}
        </li>
      ))}
    </ul>
  );
}

export function MediaSlot({
  slot, label, hint, statusText, locale, createUpload, confirmUpload,
}: {
  slot: "logo" | "cover";
  label: string;
  hint: string;
  statusText: string;
  locale: Locale;
  createUpload: (i: { slot: "logo" | "cover"; contentType: string; size: number }) => Promise<Out<{ uploadId: string; uploadUrl: string; headers: Record<string, string> }>>;
  confirmUpload: (i: { uploadId: string }) => Promise<Out<unknown>>;
}) {
  const t = createTranslator(locale);
  const max = slot === "logo" ? 2 * 1024 * 1024 : 5 * 1024 * 1024;
  return (
    <UploadControl
      label={label} hint={hint} statusText={statusText} accept="image/jpeg,image/png,image/webp" accepts={["image/jpeg", "image/png", "image/webp"]}
      maxBytes={max} locale={locale} actionLabel={t("ob.doc.choose")}
      begin={async (f) => {
        const r = await createUpload({ slot, contentType: f.type, size: f.size });
        return r.ok ? { ok: true, data: { ref: r.data.uploadId, uploadUrl: r.data.uploadUrl, headers: r.data.headers } } : r;
      }}
      finish={(ref) => confirmUpload({ uploadId: ref })}
    />
  );
}
