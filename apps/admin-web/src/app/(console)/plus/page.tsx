import { Badge, Empty, ErrorBlock, Flash, PageHeader, WritesDisabledNote } from "../../../components/ui";
import { ReasonDialog } from "../../../components/reason-dialog";
import { SwitchStrip } from "../../../components/switch-strip";
import { formatDateTime, formatMoney } from "../../../lib/format";
import { publishPlusPlanAction, requestPlusApprovalAction, setPlusPlanActiveAction } from "../../../server/actions";
import { getConsole } from "../../../server/console";
import { ORDINARY_REASON_CODES } from "../../../view-models/common";
import { earliestEffectiveMs, planGroups, PLUS_METRICS_NOT_MEASURED } from "../../../view-models/plus";

const ID = "plus-form";
export default async function PlusPage({ searchParams }: { searchParams: Promise<{ r?: string }> }) {
  const c = await getConsole();
  const sp = await searchParams;
  const [r, f] = await Promise.all([c.api.plusPlans(), c.api.flags("kill_switch")]);
  const now = r.ok ? (r.value.serverNowMs ?? c.deviceNowMs) : c.deviceNowMs;
  const groups = r.ok ? planGroups(r.value.data.items, now) : [];
  const reasons = ORDINARY_REASON_CODES.map((x) => ({ code: x.code, label: c.t(x.labelKey) }));
  const writes = c.posture.sensitiveWritesEnabled;
  const min = new Date(earliestEffectiveMs(now)).toISOString().slice(0, 16);
  const fields = (
    <>
      <label htmlFor={`${ID}-code`}>{c.t("plus.code")}</label><input id={`${ID}-code`} name="code" required dir="ltr" pattern="plus_[a-z0-9_]{1,40}" />
      <label htmlFor={`${ID}-int`}>{c.t("plus.col.interval")}</label>
      <select id={`${ID}-int`} name="interval" defaultValue="month"><option value="month">{c.t("plus.interval.month")}</option><option value="year">{c.t("plus.interval.year")}</option></select>
      <label htmlFor={`${ID}-price`}>{c.t("plus.price")}</label><input id={`${ID}-price`} name="price_egp" required inputMode="decimal" dir="ltr" />
      <label htmlFor={`${ID}-trial`}>{c.t("plus.trial")}</label><input id={`${ID}-trial`} name="trial_days" inputMode="numeric" defaultValue="0" dir="ltr" />
      <label htmlFor={`${ID}-eff`}>{c.t("plus.effective")}</label><input id={`${ID}-eff`} name="effective_from" type="datetime-local" required min={min} />
    </>
  );
  return (
    <>
      <PageHeader title={c.t("plus.title")} intro={c.t("plus.intro")} />
      <Flash code={sp.r} t={c.t} />
      <WritesDisabledNote c={c} />
      <SwitchStrip items={f.ok ? f.value.data.items : null} keys={["kill.plus.sales", "kill.plus.recurring.card", "kill.plus.recurring.mobile_wallet", "kill.plus.recurring.apple_pay"]} c={c} />
      {!r.ok ? <ErrorBlock error={r.error} c={c} /> : groups.length === 0 ? <Empty t={c.t} /> : groups.map((g) => (
        <section key={g.code}>
          <h2>{c.t("plus.versions", { code: g.code })}</h2>
          <div className="table-wrap"><table>
            <thead><tr><th>{c.t("plus.col.version")}</th><th>{c.t("plus.col.interval")}</th><th>{c.t("plus.col.price")}</th><th>{c.t("plus.col.effective")}</th><th>{c.t("plus.col.notified")}</th><th>{c.t("col.status")}</th><th>{c.t("col.actions")}</th></tr></thead>
            <tbody>{g.versions.map((v) => (
              <tr key={v.id}>
                <td>{v.version}</td><td>{c.t(v.interval === "month" ? "plus.interval.month" : "plus.interval.year")}</td>
                <td>{formatMoney(v.priceMinor, c.locale)}</td>
                <td>{formatDateTime(new Date(v.effectiveFromMs).toISOString(), c.locale)}{v.scheduled ? <> <Badge tone="warn">{c.t("plus.scheduled")}</Badge></> : null}</td>
                <td>{v.membersNotifiedAtMs === null ? c.t("plus.notNotified") : formatDateTime(new Date(v.membersNotifiedAtMs).toISOString(), c.locale)}</td>
                <td><Badge tone={v.active ? "ok" : "neutral"}>{c.t(v.active ? "plus.active" : "plus.inactive")}</Badge></td>
                <td><ReasonDialog triggerLabel={c.t(v.active ? "plus.deactivate" : "plus.activate")} title={c.t(v.active ? "plus.deactivate" : "plus.activate")}
                  reasonLabel={c.t("common.reason")} choosePlaceholder={c.t("common.choose")} submitLabel={c.t(v.active ? "plus.deactivate" : "plus.activate")}
                  cancelLabel={c.t("common.cancel")} reasons={reasons} action={setPlusPlanActiveAction} hidden={{ id: v.id, active: String(!v.active) }} danger={v.active} disabled={!writes} /></td>
              </tr>
            ))}</tbody>
          </table></div>
        </section>
      ))}
      <section className="card">
        <h2>{c.t("plus.formTitle")}</h2>
        <p className="muted">{c.t("plus.earliest", { date: formatDateTime(new Date(earliestEffectiveMs(now)).toISOString(), c.locale) })}</p>
        <form action={publishPlusPlanAction}>
          {fields}
          <label htmlFor={`${ID}-ap`}>{c.t("common.approvalId")}</label><input id={`${ID}-ap`} name="approval_id" required dir="ltr" aria-describedby={`${ID}-aph`} />
          <p id={`${ID}-aph`} className="muted">{c.t("common.approvalHelp")}</p>
          <button type="submit" className="btn primary" disabled={!writes}>{c.t("act.publish")}</button>
        </form>
        <h3>{c.t("common.requestApproval")}</h3>
        <form action={requestPlusApprovalAction}>
          {fields}
          <label htmlFor={`${ID}-rs`}>{c.t("common.reason")}</label>
          <select id={`${ID}-rs`} name="reason_code" required defaultValue=""><option value="" disabled>{c.t("common.choose")}</option>
            {reasons.map((x) => <option key={x.code} value={x.code}>{x.label}</option>)}</select>
          <button type="submit" className="btn" disabled={!writes}>{c.t("common.requestApproval")}</button>
        </form>
      </section>
      <section>
        <h2>{c.t("plus.metrics")}</h2>
        <p className="muted">{c.t("plus.metricsNote")}</p>
        <ul>{PLUS_METRICS_NOT_MEASURED.map((m) => <li key={m} dir="ltr">{m}: {c.t("common.notMeasured")}</li>)}</ul>
      </section>
    </>
  );
}
