"use client";
import { useCallback, useEffect, useState } from "react";
import { LOCALES, localeSegment, type Locale } from "@outlet/i18n";
import { Button, LocaleSwitch } from "@outlet/ui-web";
import { browserApi, type ShopperApi } from "../../lib/client-api";
import type { ConsentState, PrivacyRequest, SessionFamily } from "../../lib/wire";
import { Alert, isProblem, Status, useShared } from "./shared";

export interface AccountPanelProps {
  readonly locale: Locale;
  readonly api?: ShopperApi;
  readonly navigate?: (href: string) => void;
}
type Load = "loading" | "out" | "error" | "ready";
const STATE_KEYS = ["RECEIVED", "VERIFIED", "BLOCKED", "COOLING", "IN_PROGRESS", "COMPLETED", "CANCELLED", "REJECTED"] as const;
type StateKey = (typeof STATE_KEYS)[number];
const asState = (s: string): StateKey | null => STATE_KEYS.find((k) => k === s) ?? null;

export function AccountPanel({ locale, api = browserApi(), navigate = (h) => { window.location.assign(h); } }: AccountPanelProps) {
  const { t, date, base } = useShared(locale);
  const [load, setLoad] = useState<Load>("loading");
  const [phone, setPhone] = useState("");
  const [sessions, setSessions] = useState<readonly SessionFamily[]>([]);
  const [consents, setConsents] = useState<readonly ConsentState[]>([]);
  const [requests, setRequests] = useState<readonly PrivacyRequest[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ackCredit, setAckCredit] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [me, s, c, r] = await Promise.all([api.me(), api.listSessions(), api.listConsents(), api.listPrivacyRequests()]);
      setPhone(me.phoneMasked); setSessions(s); setConsents(c); setRequests(r); setLoad("ready");
    } catch (e) { setLoad(isProblem(e, 401) ? "out" : "error"); }
  }, [api]);
  useEffect(() => { void refresh(); }, [refresh]);

  const act = async (fn: () => Promise<void>, ok?: string): Promise<void> => {
    setBusy(true); setError(null); setNote(null);
    try { await fn(); if (ok !== undefined) setNote(ok); } catch (e) { if (isProblem(e, 401)) setLoad("out"); else setError(t("account.error.action")); } finally { setBusy(false); }
  };

  if (load === "loading") return <p role="status">{t("state.loading")}</p>;
  if (load === "out") return (
    <div className="empty" role="status">
      <p>{t("account.signedOut")}</p>
      <a className="shopLink" href={`${base}/login?next=${encodeURIComponent(`${base}/account`)}`}>{t("auth.goLogin")}</a>
    </div>
  );
  if (load === "error") return <Alert>{t("account.error.load")}</Alert>;

  const deletion = requests.find((r) => r.kind === "delete" && (r.status === "COOLING" || r.status === "BLOCKED" || r.status === "VERIFIED" || r.status === "RECEIVED"));
  const exportReady = requests.find((r) => r.kind === "export" && r.export_url !== null);

  return (
    <div className="shopStack">
      <p dir="ltr" className="hint">{t("account.phone", { phone })}</p>
      <nav aria-label={t("account.links.title")} className="shopRow">
        <a className="shopLink" href={`${base}/orders`}>{t("account.links.orders")}</a>
        <a className="shopLink" href={`${base}/returns`}>{t("account.links.returns")}</a>
        <a className="shopLink" href={`${base}/account/addresses`}>{t("account.links.addresses")}</a>
      </nav>
      {error === null ? null : <Alert>{error}</Alert>}
      {note === null ? null : <Status>{note}</Status>}

      <section aria-labelledby="acc-language" className="shopCard">
        <h2 id="acc-language">{t("account.language.title")}</h2>
        <LocaleSwitch locale={locale} onChange={(next) => { if (LOCALES.includes(next)) navigate(`/${localeSegment("eg", next)}/account`); }} />
      </section>

      <section aria-labelledby="acc-sessions" className="shopCard">
        <h2 id="acc-sessions">{t("account.sessions.title")}</h2>
        <ul className="shopList">
          {sessions.map((s) => {
            const name = t("account.sessions.platform", { platform: s.platform, browser: s.ua_family ?? "none" });
            return (
              <li key={s.id} className="shopListRow">
                <span>
                  {name}
                  {s.current ? <strong className="shopBadge"> {t("account.sessions.current")}</strong> : null}
                  {s.last_seen_at === null ? null : <span className="hint"> {t("account.sessions.lastSeen", { date: date(s.last_seen_at) })}</span>}
                </span>
                {s.current ? null : (
                  <Button variant="secondary" disabled={busy} aria-label={t("account.sessions.revoke", { device: name })} onClick={() => { void act(async () => { await api.revokeSession(s.id); setSessions((prev) => prev.filter((x) => x.id !== s.id)); }); }}>
                    {t("account.sessions.revokeBtn")}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
        <Button variant="ghost" onClick={() => { void act(async () => { await api.logout(); navigate(`${base}/login`); }); }}>{t("auth.signOut")}</Button>
      </section>

      <section aria-labelledby="acc-consents" className="shopCard">
        <h2 id="acc-consents">{t("account.consents.title")}</h2>
        <p className="hint">{t("account.consents.hint")}</p>
        {consents.map((c) => (
          <label key={c.purpose_code} className="shopCheck">
            <input type="checkbox" checked={c.granted} disabled={busy} onChange={(e) => {
              const granted = e.target.checked;
              void act(async () => { const updated = await api.patchConsents([{ code: c.purpose_code, version: c.purpose_version, granted }]); setConsents((prev) => prev.map((p) => updated.find((u) => u.purpose_code === p.purpose_code) ?? p)); }, t("account.consents.saved"));
            }} />
            <span>{locale === "en-EG" && c.text_en !== null ? c.text_en : c.text_ar}</span>
          </label>
        ))}
      </section>

      <section aria-labelledby="acc-privacy" className="shopCard">
        <h2 id="acc-privacy">{t("account.privacy.title")}</h2>
        <Button variant="secondary" disabled={busy} onClick={() => { void act(async () => { const r = await api.requestExport(); setRequests((p) => [r, ...p]); }, t("account.privacy.exportRequested", { hours: 72 })); }}>{t("account.privacy.exportBtn")}</Button>
        {exportReady?.export_url ? <p><a className="shopLink" href={exportReady.export_url} rel="noopener noreferrer">{t("account.privacy.download")}</a></p> : null}

        <h3>{t("account.privacy.deleteTitle")}</h3>
        <p>{t("account.privacy.deleteExplain", { days: 14 })}</p>
        {deletion === undefined ? (
          <>
            <label className="shopCheck"><input type="checkbox" checked={ackCredit} onChange={(e) => { setAckCredit(e.target.checked); }} /><span>{t("account.privacy.credit")}</span></label>
            <label className="shopCheck"><input type="checkbox" checked={confirmDelete} onChange={(e) => { setConfirmDelete(e.target.checked); }} /><span>{t("account.privacy.confirm")}</span></label>
            <Button variant="secondary" disabled={busy || !ackCredit || !confirmDelete} onClick={() => { void act(async () => { const r = await api.requestDelete(ackCredit); setRequests((p) => [r, ...p]); }); }}>{t("account.privacy.deleteBtn")}</Button>
          </>
        ) : (
          <>
            {deletion.cooling_until === null ? null : <Status>{t("account.privacy.coolingUntil", { date: date(deletion.cooling_until) })}</Status>}
            {deletion.blocked_reason === null ? null : <Alert>{t("account.privacy.blocked", { reason: deletion.blocked_reason })}</Alert>}
            <Button variant="secondary" disabled={busy} onClick={() => { void act(async () => { await api.cancelDelete(); setRequests((p) => p.map((r) => (r.id === deletion.id ? { ...r, status: "CANCELLED" } : r))); }); }}>{t("account.privacy.cancelDelete")}</Button>
          </>
        )}

        {requests.length === 0 ? null : (
          <>
            <h3>{t("account.privacy.requests")}</h3>
            <ul className="shopList">
              {requests.map((r) => {
                const k = asState(r.status);
                return <li key={r.id}>{t(r.kind === "export" ? "account.privacy.kind.export" : "account.privacy.kind.delete")} · {t("account.privacy.status", { status: k === null ? r.status : t(`account.privacy.state.${k}`) })}</li>;
              })}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}
