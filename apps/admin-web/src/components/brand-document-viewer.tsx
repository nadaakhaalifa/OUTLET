"use client";
import { useEffect, useId, useRef, useState } from "react";
import { readBrandDocumentAction } from "../server/brand-actions";
import { mmss, urlLooksValid, urlRemainingMs, viewerKind, watermarkText } from "../view-models/brand-review";
import type { BrandLabels } from "../view-models/brand-labels";

export interface ViewerDoc {
  readonly id: string;
  readonly code: string;
  readonly filename: string | null;
  readonly contentType: "application/pdf" | "image/jpeg" | "image/png";
  readonly viewable: boolean;
  readonly stateLabel: string;
}

interface Live {
  readonly docId: string;
  readonly url: string;
  readonly expiresAtMs: number;
  readonly serverNowAtReceiptMs: number;
  readonly receivedAtPerf: number;
}

const REASONS = ["kyc_review", "appeal_review", "fraud_investigation", "legal_request"] as const;

/**
 * Document viewer. The signed URL is requested per view through a server action that audits the mandatory reason
 * code first; it lives only in React state (never in a URL, storage, cache or log), is rendered in a sandboxed
 * frame or an <img> with no referrer, carries a reviewer watermark, and is dropped the moment it expires.
 */
export function BrandDocumentViewer({ applicationId, docs, reviewerId, labels, allowed, gateReason, originConfigured }: {
  readonly applicationId: string;
  readonly docs: readonly ViewerDoc[];
  readonly reviewerId: string;
  readonly labels: BrandLabels;
  readonly allowed: boolean;
  readonly gateReason: string | null;
  readonly originConfigured: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const reasonId = useId();
  const [pick, setPick] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<Live | null>(null);
  const [expired, setExpired] = useState(false);
  const [left, setLeft] = useState(0);
  const [stamp, setStamp] = useState("");

  useEffect(() => {
    if (live === null) return;
    const tick = (): void => {
      const rem = urlRemainingMs({ expiresAtMs: live.expiresAtMs, serverNowAtReceiptMs: live.serverNowAtReceiptMs, elapsedSinceReceiptMs: performance.now() - live.receivedAtPerf });
      setLeft(rem);
      if (rem <= 0) { setLive(null); setExpired(true); }
    };
    tick();
    const h = window.setInterval(tick, 1000);
    return () => window.clearInterval(h);
  }, [live]);

  // Drop the credential when the tab is torn down or hidden for good.
  useEffect(() => () => setLive(null), []);

  const open = (id: string): void => {
    setPick(id); setReason(""); setError(null); setExpired(false);
    dialog.current?.showModal();
  };
  const submit = async (): Promise<void> => {
    if (pick === null || reason === "") return;
    setBusy(true); setError(null);
    const r = await readBrandDocumentAction({ applicationId, documentId: pick, reason, key: crypto.randomUUID() });
    setBusy(false);
    if (!r.ok) {
      const map: Readonly<Record<string, keyof BrandLabels>> = {
        forbidden: "state.forbidden", not_found: "state.notFound", conflict: "state.conflict", rate_limited: "state.rateLimited",
        offline: "state.offline", unavailable: "state.unavailable", unauthorized: "state.sessionExpired", not_configured: "state.notConfigured",
        validation: "flash.validation", "conflict.already_claimed": "brand.flash.alreadyClaimed",
      };
      setError(labels[map[r.kind] ?? "state.error"]);
      return;
    }
    const expiresAtMs = Date.parse(r.expiresAt);
    if (!urlLooksValid({ expiresAtMs, serverNowMs: r.serverNowMs })) { setError(labels["brand.doc.badUrl"]); return; }
    setStamp(watermarkText(reviewerId, applicationId, new Date(r.serverNowMs).toISOString()));
    setLive({ docId: pick, url: r.url, expiresAtMs, serverNowAtReceiptMs: r.serverNowMs, receivedAtPerf: performance.now() });
    dialog.current?.close();
  };

  const current = live === null ? null : docs.find((d) => d.id === live.docId) ?? null;
  return (
    <section aria-labelledby={`${reasonId}-h`}>
      <h3 id={`${reasonId}-h`}>{labels["brand.doc.viewTitle"]}</h3>
      {!originConfigured ? <p role="note" className="notice">{labels["brand.doc.noOrigin"]}</p> : null}
      {!allowed && gateReason !== null ? <p className="muted">{gateReason}</p> : null}
      {docs.length === 0 ? <p className="muted">{labels["brand.doc.none"]}</p> : (
        <ul className="doclist">
          {docs.map((d) => (
            <li key={d.id}>
              <span dir="ltr">{d.code}</span>
              {d.filename === null ? null : <span className="muted" dir="ltr"> · {d.filename}</span>}
              <span className="badge"> {d.stateLabel}</span>
              <button type="button" className="btn" disabled={!allowed || !d.viewable || !originConfigured} title={d.viewable ? undefined : labels["brand.doc.notViewable"]} onClick={() => open(d.id)}>
                {labels["brand.doc.view"]}
              </button>
            </li>
          ))}
        </ul>
      )}
      {expired ? <p role="status" className="notice">{labels["brand.doc.expired"]}</p> : null}
      {live !== null && current !== null ? (
        <div className="viewer" aria-live="off">
          <div className="row">
            <strong dir="ltr">{current.code}</strong>
            <span role="timer" aria-live="polite">{labels["brand.doc.expiresIn"].replace("{{t}}", mmss(left))}</span>
            <button type="button" className="btn ghost" onClick={() => setLive(null)}>{labels["brand.doc.close"]}</button>
          </div>
          <div className="viewer-stage" onContextMenu={(e) => e.preventDefault()}>
            {viewerKind(current.contentType) === "pdf" ? (
              <iframe title={current.code} src={live.url} sandbox="" referrerPolicy="no-referrer" className="viewer-frame" />
            ) : (
              <img alt={current.code} src={live.url} referrerPolicy="no-referrer" draggable={false} className="viewer-img" />
            )}
            <div className="watermark" aria-hidden="true">
              {Array.from({ length: 24 }, (_, i) => <span key={i} dir="ltr">{stamp}</span>)}
            </div>
          </div>
          <p className="muted">{labels["brand.doc.watermark"]}{viewerKind(current.contentType) === "pdf" ? ` ${labels["brand.doc.pdfNote"]}` : ""}</p>
        </div>
      ) : null}

      <dialog ref={dialog} className="dialog" aria-labelledby={`${reasonId}-t`}>
        <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <h2 id={`${reasonId}-t`}>{labels["brand.doc.viewTitle"]}</h2>
          <p className="muted">{labels["brand.doc.viewBody"]}</p>
          <label htmlFor={reasonId}>{labels["brand.doc.reasonLabel"]}</label>
          <select id={reasonId} required value={reason} onChange={(e) => setReason(e.target.value)}>
            <option value="" disabled>{labels["common.choose"]}</option>
            {REASONS.map((r) => <option key={r} value={r}>{labels[`brand.doc.reason.${r}`]}</option>)}
          </select>
          {error === null ? null : <p role="alert" className="notice error">{error}</p>}
          <div className="row end">
            <button type="button" className="btn ghost" onClick={() => dialog.current?.close()}>{labels["common.cancel"]}</button>
            <button type="submit" className="btn primary" disabled={busy || reason === ""}>{busy ? labels["brand.doc.loading"] : labels["brand.doc.request"]}</button>
          </div>
        </form>
      </dialog>
    </section>
  );
}
