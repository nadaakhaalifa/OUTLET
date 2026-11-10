"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import type { z } from "zod";
import { createTranslator, type Locale, type MessageKey, type Translator } from "@outlet/i18n";
import { adminCall } from "../../client/admin-api";
import { fmtDateTime, fmtMoney, fmtNumber } from "../../lib/fmt";
import { label } from "../../lib/labels";
import {
  canHold, canRelease, DisputeList, FILTERS, HOLD_REASONS, PayoutList, RefundList, RELEASE_REASONS, ReturnList, shortId, toneOf,
  type HoldReason, type ListKind, type ReleaseReason,
} from "../../lib/lists";
import { problemKey } from "../../lib/problem";
import { uuidv7 } from "../../lib/uuid7";
import { EmptyState } from "../kit/EmptyState";
import { StatusChip } from "../kit/StatusChip";

type Row = Record<string, unknown> & { readonly id: string; readonly status: string };
interface Page { readonly items: readonly Row[]; readonly next_cursor?: string | null | undefined }

const SCHEMAS: Readonly<Record<ListKind, z.ZodType>> = { refunds: RefundList, payouts: PayoutList, returns: ReturnList, disputes: DisputeList };
const PAGE_SIZE = 20;

const str = (r: Row, k: string): string => (typeof r[k] === "string" ? r[k] : "");
const strOrNull = (r: Row, k: string): string | null => (typeof r[k] === "string" ? r[k] : null);
const flag = (r: Row, k: string): boolean => r[k] === true;
const moneyOf = (r: Row, k: string): { amount_minor: string; currency: string } | null => {
  const v = r[k];
  if (typeof v === "object" && v !== null && typeof (v as { amount_minor?: unknown }).amount_minor === "string" && typeof (v as { currency?: unknown }).currency === "string") return v as { amount_minor: string; currency: string };
  return null;
};

const Id = ({ id }: { id: string }) => <bdi dir="ltr" title={id}>{shortId(id)}</bdi>;
const chip = (t: Translator, kind: ListKind, status: string): ReactNode => <StatusChip tone={toneOf(status)}>{label(t, `admin.${kind}.status`, status)}</StatusChip>;
/** A staff hold reason is stored as `ops:<code>`; system reasons (iban_name_mismatch, rail_failed:...) are shown as the code. */
const holdLabel = (t: Translator, raw: string | null): string => (raw === null ? "" : label(t, "admin.payouts.holdCode", raw.startsWith("ops:") ? raw.slice(4) : raw));

interface Money { amount_minor: string; currency: string }
interface Col { readonly key: MessageKey; readonly cell: (r: Row) => ReactNode }

function columns(kind: ListKind, t: Translator, locale: Locale): readonly Col[] {
  const when = (v: string | null): ReactNode => (v === null ? "" : fmtDateTime(v, locale));
  switch (kind) {
    case "refunds":
      return [
        { key: "admin.refunds.colOrder", cell: (r) => <Id id={str(r, "order_group_id")} /> },
        { key: "admin.list.colStatus", cell: (r) => <>{chip(t, kind, r.status)}{flag(r, "overdue") ? <> <StatusChip tone="bad">{t("admin.refunds.overdue")}</StatusChip></> : null}</> },
        { key: "admin.refunds.colRoute", cell: (r) => label(t, "admin.refunds.route", str(r, "route")) },
        { key: "admin.refunds.colAmount", cell: (r) => fmtMoney(moneyOf(r, "amount"), locale) },
        { key: "admin.refunds.colDue", cell: (r) => when(strOrNull(r, "due_at")) },
        { key: "admin.list.colCreated", cell: (r) => when(str(r, "created_at")) },
      ];
    case "payouts":
      return [
        { key: "admin.payouts.colStore", cell: (r) => <Id id={str(r, "store_id")} /> },
        { key: "admin.list.colStatus", cell: (r) => chip(t, kind, r.status) },
        { key: "admin.payouts.colCycle", cell: (r) => `${str(r, "cycle_start")} / ${str(r, "cycle_end")}` },
        { key: "admin.payouts.colNet", cell: (r) => fmtMoney(moneyOf(r, "net"), locale) },
        { key: "admin.payouts.colHold", cell: (r) => holdLabel(t, strOrNull(r, "hold_reason")) },
      ];
    case "returns":
      return [
        { key: "admin.returns.colOrder", cell: (r) => <Id id={str(r, "order_group_id")} /> },
        { key: "admin.returns.colStage", cell: (r) => <StatusChip tone={toneOf(str(r, "stage"))}>{label(t, "admin.returns.stage", str(r, "stage"))}</StatusChip> },
        { key: "admin.returns.colReason", cell: (r) => label(t, "admin.returns.reason", str(r, "reason_code")) },
        { key: "admin.returns.colResolution", cell: (r) => label(t, "admin.returns.resolution", str(r, "resolution")) },
        { key: "admin.returns.colInspection", cell: (r) => when(strOrNull(r, "inspection_due_at")) },
        { key: "admin.list.colCreated", cell: (r) => when(str(r, "created_at")) },
      ];
    case "disputes":
      return [
        { key: "admin.disputes.colReturn", cell: (r) => <Id id={str(r, "return_request_id")} /> },
        { key: "admin.list.colStatus", cell: (r) => <>{chip(t, kind, r.status)}{flag(r, "past_sla") ? <> <StatusChip tone="bad">{t("admin.disputes.pastSla")}</StatusChip></> : null}</> },
        { key: "admin.disputes.colReason", cell: (r) => label(t, "admin.disputes.reason", str(r, "reason_code")) },
        { key: "admin.disputes.colAssigned", cell: (r) => t(flag(r, "assigned") ? "admin.list.yes" : "admin.list.no") },
        { key: "admin.disputes.colSla", cell: (r) => when(str(r, "sla_due_at")) },
        { key: "admin.list.colCreated", cell: (r) => when(str(r, "created_at")) },
      ];
  }
}

/** One line per summary entry, e.g. "Failed: 3 (EGP 1,200.00)"; counts the API computed for the whole market, never from the rows on screen. */
export function summaryLines(kind: ListKind, t: Translator, locale: Locale, summary: unknown): readonly string[] {
  if (Array.isArray(summary)) {
    return (summary as readonly { status: string; count: number; amount?: Money; net?: Money }[]).map((x) =>
      t("admin.list.summaryItem", { label: label(t, `admin.${kind}.status`, x.status), n: fmtNumber(x.count, locale), amount: fmtMoney(x.amount ?? x.net, locale) }));
  }
  if (typeof summary !== "object" || summary === null) return [];
  const s = summary as Readonly<Record<string, number | undefined>>;
  if (kind === "returns") return FILTERS.returns.values.map((k) => t("admin.list.summaryCount", { label: label(t, "admin.returns.stage", k), n: fmtNumber(s[k] ?? 0, locale) }));
  if (kind === "disputes") return [t("admin.list.summaryCount", { label: t("admin.disputes.status.OPEN"), n: fmtNumber(s.open ?? 0, locale) }), t("admin.list.summaryCount", { label: t("admin.disputes.pastSla"), n: fmtNumber(s.past_sla ?? 0, locale) })];
  return [];
}

/**
 * A keyset list: the first page comes from the server render, "Load more" asks the same-origin BFF for the next one (cursor from the API, never an offset) and appends it.
 * Payout rows offer Hold (single key) and Request release (always filed for a second approver by the server: the page says so, it never claims the payout was released).
 */
export function OpsList({ kind, locale, market, base, initial, summary, filter, canWrite, mayRelease }: {
  kind: ListKind; locale: Locale; market: string; base: string; initial: Page; summary: unknown; filter: string | undefined; /** payout.hold */ canWrite: boolean; /** payout.release; defaults to canWrite */ mayRelease?: boolean;
}) {
  const t = createTranslator(locale);
  const router = useRouter();
  const [rows, setRows] = useState<readonly Row[]>(initial.items);
  const [cursor, setCursor] = useState<string | null>(initial.next_cursor ?? null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ readonly ok: boolean; readonly text: string } | null>(null);
  const [holdReason, setHoldReason] = useState<HoldReason>(HOLD_REASONS[0]);
  const [releaseReason, setReleaseReason] = useState<ReleaseReason>(RELEASE_REASONS[0]);
  useEffect(() => { setRows(initial.items); setCursor(initial.next_cursor ?? null); }, [initial]);

  const cols = columns(kind, t, locale);
  const f = FILTERS[kind];
  const path = `/${kind}`;
  const lines = summaryLines(kind, t, locale, summary);
  const releasable = mayRelease ?? canWrite;
  const writable = kind === "payouts" && (canWrite || releasable);

  const more = async () => {
    if (cursor === null) return;
    setBusy(true);
    setMsg(null);
    const q = new URLSearchParams({ limit: String(PAGE_SIZE), cursor });
    if (filter !== undefined) q.set(f.param, filter);
    const r = await adminCall(market, `${kind}?${q.toString()}`);
    setBusy(false);
    const parsed = r.ok ? (SCHEMAS[kind].safeParse(r.data)) : null;
    if (parsed?.success === true) {
      const page = parsed.data as Page;
      setRows((cur) => [...cur, ...page.items]);
      setCursor(page.next_cursor ?? null);
    } else setMsg({ ok: false, text: t(r.ok ? "admin.error.generic" : problemKey(r.code, r.status)) });
  };

  const act = async (row: Row, action: "hold" | "release") => {
    setBusy(true);
    setMsg(null);
    const r = await adminCall(market, `payouts/${row.id}/${action}`, { method: "POST", idempotencyKey: uuidv7(), body: { reason_code: action === "hold" ? holdReason : releaseReason } });
    setBusy(false);
    if (r.ok) {
      const d = r.data as { status?: unknown; hold_reason?: unknown } | null;
      if (d !== null && typeof d.status === "string") setRows((cur) => cur.map((x) => (x.id === row.id ? { ...x, status: d.status as string, hold_reason: typeof d.hold_reason === "string" ? d.hold_reason : null } : x)));
      setMsg({ ok: true, text: t(action === "hold" ? "admin.payouts.held" : "admin.payouts.releaseFiled") });
      router.refresh();
    } else if (r.status === 409 && r.code === "dual-approval-required") setMsg({ ok: true, text: t("admin.payouts.releaseFiled") });
    else if (r.status === 409 && r.code === "stale-approval") setMsg({ ok: false, text: t("admin.payouts.stale") });
    else if (r.status === 409) setMsg({ ok: false, text: t("admin.payouts.invalid") });
    else setMsg({ ok: false, text: t(problemKey(r.code, r.status)) });
  };

  return (
    <div className="stack">
      {lines.length > 0 ? <ul className="listSummary" data-testid="list-summary">{lines.map((l, i) => <li key={i} className="tag"><bdi>{l}</bdi></li>)}</ul> : null}
      <nav className="listFilters" aria-label={t("admin.list.filter")}>
        <Link href={`${base}${path}`} className="rangePill" {...(filter === undefined ? { "aria-current": "true" as const } : {})} data-filter="all">{t("admin.list.all")}</Link>
        {f.values.map((v) => (
          <Link key={v} href={`${base}${path}?${f.param}=${v}`} className="rangePill" {...(filter === v ? { "aria-current": "true" as const } : {})} data-filter={v}>
            {label(t, kind === "returns" ? "admin.returns.stage" : `admin.${kind}.status`, v)}
          </Link>
        ))}
      </nav>
      {writable ? (
        <div className="rowActions" data-testid="payout-reasons">
          <label className="field">
            <span>{t("admin.payouts.holdReasonLabel")}</span>
            <select value={holdReason} onChange={(e) => { const v = HOLD_REASONS.find((c) => c === e.target.value); if (v) setHoldReason(v); }}>
              {HOLD_REASONS.map((c) => <option key={c} value={c}>{t(`admin.payouts.reason.${c}` as MessageKey)}</option>)}
            </select>
          </label>
          <label className="field">
            <span>{t("admin.payouts.releaseReasonLabel")}</span>
            <select value={releaseReason} onChange={(e) => { const v = RELEASE_REASONS.find((c) => c === e.target.value); if (v) setReleaseReason(v); }}>
              {RELEASE_REASONS.map((c) => <option key={c} value={c}>{t(`admin.payouts.releaseReason.${c}` as MessageKey)}</option>)}
            </select>
          </label>
        </div>
      ) : null}
      {msg ? <p className="hint" role={msg.ok ? "status" : "alert"} data-testid="list-msg">{msg.text}</p> : null}
      {rows.length === 0 ? <EmptyState title={t("admin.list.empty")} /> : (
        <div className="tableWrap card">
          <table className="table" data-testid="ops-list" data-kind={kind}>
            <caption className="srOnly">{t(`admin.${kind}.title` as MessageKey)}</caption>
            <thead><tr>
              {cols.map((c) => <th key={c.key} scope="col">{t(c.key)}</th>)}
              {writable ? <th scope="col"><span className="srOnly">{t("admin.payouts.colActions")}</span></th> : null}
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} data-row-id={r.id}>
                  {cols.map((c) => <td key={c.key}><bdi>{c.cell(r)}</bdi></td>)}
                  {writable ? (
                    <td>
                      {canWrite && canHold(r.status) ? <button type="button" className="btn btnSecondary" disabled={busy} onClick={() => { void act(r, "hold"); }}>{t("admin.payouts.hold")}</button> : null}
                      {releasable && canRelease(r.status) ? <button type="button" className="btn btnSecondary" disabled={busy} onClick={() => { void act(r, "release"); }}>{t("admin.payouts.release")}</button> : null}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="listMore">
        {cursor !== null
          ? <button type="button" className="btn btnSecondary" disabled={busy} aria-busy={busy} onClick={() => { void more(); }} data-testid="load-more">{t(busy ? "admin.list.loading" : "admin.list.more")}</button>
          : rows.length > 0 ? <p className="hint" data-testid="list-end">{t("admin.list.end")}</p> : null}
      </div>
    </div>
  );
}
