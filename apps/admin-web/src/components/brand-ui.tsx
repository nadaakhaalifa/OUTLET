import Link from "next/link";
import type { BrandStatus } from "../api/brand-schemas";
import type { MessageKey, Translator } from "../i18n";
import type { RiskBand, SlaView, QueueRow, QueueFilters } from "../view-models/brand-review";
import { queueSearch } from "../view-models/brand-review";
import { BRAND_STATUSES } from "../api/brand-schemas";
import { Badge, clockText, Empty } from "./ui";

export const statusKey = (s: BrandStatus): MessageKey => `brand.status.${s}`;
const RISK_TONE: Record<RiskBand, "ok" | "warn" | "bad" | "neutral"> = { low: "ok", medium: "warn", high: "bad", unknown: "neutral" };

export function StatusBadge({ status, t }: { status: BrandStatus; t: Translator }) {
  const tone = status === "APPROVED" ? "ok" : status === "REJECTED" || status === "SUSPENDED" ? "bad" : status === "NEEDS_INFO" ? "warn" : "neutral";
  return <Badge tone={tone}>{t(statusKey(status))}</Badge>;
}

export function RiskChip({ band, score, t }: { band: RiskBand; score: number | null; t: Translator }) {
  return (
    <Badge tone={RISK_TONE[band]}>
      {t(`brand.risk.${band}`)}{score === null ? "" : ` ${score}`}
    </Badge>
  );
}

/** SLA cell from the SERVER clock: a countdown, a meter and a text label (never colour alone). */
export function SlaCell({ sla, t }: { sla: SlaView; t: Translator }) {
  if (sla.clock === null) return <span className="muted">—</span>;
  return (
    <div>
      <span className={sla.breached ? "sla late" : "sla"}>{clockText(sla.clock, t)}</span>
      {sla.breached ? <> <Badge tone="bad">{t("brand.sla.breached")}</Badge></> : null}
      <meter className="sla-meter" min={0} max={100} value={Math.round(sla.elapsed * 100)} aria-label={t("brand.sla.consumed", { pct: Math.round(sla.elapsed * 100) })} />
    </div>
  );
}

const ASSIGNEES = ["any", "me", "unassigned"] as const;

/** Server-rendered filter form (GET). No JS needed; every state of the queue is a shareable URL. */
export function QueueFilterForm({ f, t, lockAssignee }: { f: QueueFilters; t: Translator; lockAssignee: boolean }) {
  return (
    <form method="get" className="filters card" aria-label={t("brand.filters.title")}>
      <div className="filter">
        <label htmlFor="f-status">{t("col.status")}</label>
        <select id="f-status" name="status" defaultValue={f.status ?? ""}>
          <option value="">{t("brand.filters.any")}</option>
          {BRAND_STATUSES.filter((s) => s !== "DRAFT").map((s) => <option key={s} value={s}>{t(statusKey(s))}</option>)}
        </select>
      </div>
      <div className="filter">
        <label htmlFor="f-kind">{t("brand.filters.kind")}</label>
        <select id="f-kind" name="kind" defaultValue={f.kind ?? ""}>
          <option value="">{t("brand.filters.any")}</option>
          <option value="local">{t("brand.kind.local")}</option>
          <option value="global">{t("brand.kind.global")}</option>
        </select>
      </div>
      <div className="filter">
        <label htmlFor="f-country">{t("brand.filters.country")}</label>
        <input id="f-country" name="country" dir="ltr" maxLength={2} size={3} placeholder="EG" defaultValue={f.country ?? ""} pattern="[A-Za-z]{2}" />
      </div>
      {lockAssignee ? null : (
        <div className="filter">
          <label htmlFor="f-assignee">{t("brand.filters.assignee")}</label>
          <select id="f-assignee" name="assignee" defaultValue={f.assignee ?? "any"}>
            {ASSIGNEES.map((a) => <option key={a} value={a}>{t(`brand.assignee.${a}`)}</option>)}
          </select>
        </div>
      )}
      <label className="check"><input type="checkbox" name="sla_breached" value="true" defaultChecked={f.slaBreached === true} />{t("brand.filters.slaBreached")}</label>
      <div className="row">
        <button className="btn primary" type="submit">{t("brand.filters.apply")}</button>
        <Link className="btn ghost" href="?">{t("brand.filters.reset")}</Link>
      </div>
    </form>
  );
}

export function QueueTable({ rows, t, base }: { rows: readonly QueueRow[]; t: Translator; base: string }) {
  if (rows.length === 0) return <Empty t={t} messageKey="brand.queue.empty" />;
  return (
    <div className="table-wrap">
      <table className="dense">
        <caption className="sr-only">{t("brand.queue.caption")}</caption>
        <thead>
          <tr>
            <th scope="col">{t("brand.col.brand")}</th><th scope="col">{t("col.status")}</th><th scope="col">{t("brand.col.kindCountry")}</th>
            <th scope="col">{t("brand.col.sla")}</th><th scope="col">{t("brand.col.risk")}</th><th scope="col">{t("brand.col.assignee")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={r.sla.breached ? "late-row" : undefined}>
              <th scope="row">
                <Link data-row-link href={`${base}/${r.id}`}>{r.brandName}</Link>
                {r.appeal ? <> <Badge tone="warn">{t("brand.badge.appeal")}</Badge></> : null}
              </th>
              <td><StatusBadge status={r.status} t={t} /></td>
              <td><span dir="ltr">{t(`brand.kind.${r.kind}`)} · {r.country}</span>{r.highRiskCountry ? <> <Badge tone="warn">{t("brand.badge.highRiskCountry")}</Badge></> : null}</td>
              <td><SlaCell sla={r.sla} t={t} /></td>
              <td><RiskChip band={r.risk} score={r.riskScore} t={t} /></td>
              <td>{r.assignedToMe ? <Badge tone="ok">{t("brand.assignee.mineBadge")}</Badge> : r.unassigned ? <span className="muted">{t("brand.assignee.unassigned")}</span> : <Badge tone="neutral">{t("brand.assignee.other")}</Badge>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Pager({ f, nextCursor, t }: { f: QueueFilters; nextCursor: string | null; t: Translator }) {
  const { cursor: _drop, ...rest } = f;
  void _drop;
  return (
    <nav className="row" aria-label={t("brand.pager")}>
      {f.cursor === undefined ? null : <Link className="btn ghost" href={queueSearch(rest) === "" ? "?" : queueSearch(rest)}>{t("brand.pager.first")}</Link>}
      {nextCursor === null ? null : <Link className="btn" rel="next" href={queueSearch(rest, nextCursor)}>{t("brand.pager.next")}</Link>}
    </nav>
  );
}
