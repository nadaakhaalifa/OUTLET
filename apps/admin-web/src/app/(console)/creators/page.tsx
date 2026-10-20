import { Badge, Empty, ErrorBlock, Flash, PageHeader, WritesDisabledNote } from "../../../components/ui";
import { SwitchStrip } from "../../../components/switch-strip";
import { CREATOR_STATUSES, type CreatorStatus } from "../../../api/phase3-schemas";
import { createCreatorPayoutAction, creatorPayoutStepAction, decideCreatorAction } from "../../../server/actions-phase3";
import { getConsole } from "../../../server/console";
import { formatDateTime, formatMoney } from "../../../lib/format";
import { actionAvailability, creatorRows, payoutGate, payoutRows, payoutTone, type PayoutAction } from "../../../view-models/creators";

const STEP_OF: Readonly<Record<PayoutAction, "approve" | "send" | "cancel" | "settled" | "rejected">> = {
  approve: "approve", send: "send", cancel: "cancel", outcome_settled: "settled", outcome_rejected: "rejected",
};

export default async function CreatorsPage({ searchParams }: { searchParams: Promise<{ r?: string; status?: string }> }) {
  const c = await getConsole();
  const sp = await searchParams;
  const status = CREATOR_STATUSES.find((s) => s === sp.status) as CreatorStatus | undefined;
  const [accounts, payouts, flags] = await Promise.all([c.api.creators(status), c.api.creatorPayouts(), c.api.flags("kill_switch")]);
  const items = flags.ok ? flags.value.data.items : null;
  const gate = payoutGate(items);
  const writes = c.posture.sensitiveWritesEnabled;
  const rows = accounts.ok ? creatorRows(accounts.value.data.items) : [];
  const pRows = payouts.ok ? payoutRows(payouts.value.data.items, c.selfId) : [];
  return (
    <>
      <PageHeader title={c.t("creators.title")} intro={c.t("creators.intro")} />
      <Flash code={sp.r} t={c.t} />
      <WritesDisabledNote c={c} />
      <SwitchStrip items={items} keys={["kill.creator_program", "kill.creator_payouts"]} c={c} />
      <p><a href="/flags">{c.t("nav.flags")}</a></p>

      <section aria-labelledby="cr-accounts">
        <h2 id="cr-accounts">{c.t("creators.accounts")}</h2>
        <form method="get" className="row">
          <label htmlFor="cr-status">{c.t("creators.filter")}</label>
          <select id="cr-status" name="status" defaultValue={status ?? ""}>
            <option value="">{c.t("creators.filterAll")}</option>
            {CREATOR_STATUSES.map((s) => <option key={s} value={s}>{c.t(`creators.status.${s}`)}</option>)}
          </select>
          <button type="submit" className="btn">{c.t("creators.filterApply")}</button>
        </form>
        {!accounts.ok ? <ErrorBlock error={accounts.error} c={c} /> : rows.length === 0 ? <Empty t={c.t} /> : (
          <div className="table-wrap"><table>
            <thead><tr><th>{c.t("creators.col.handle")}</th><th>{c.t("creators.col.name")}</th><th>{c.t("col.status")}</th><th>{c.t("creators.col.kyc")}</th><th>{c.t("creators.col.reason")}</th><th>{c.t("col.actions")}</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id}>
                <td dir="ltr">{r.handle}<div className="muted" dir="ltr">{r.id}</div></td>
                <td>{r.displayName}</td>
                <td><Badge tone={r.status === "ACTIVE" ? "ok" : r.status === "APPLIED" ? "warn" : r.status === "SUSPENDED" ? "bad" : "neutral"}>{c.t(`creators.status.${r.status}`)}</Badge></td>
                <td>{c.t(`creators.kyc.${r.kycState as "DRAFT"}`)}</td>
                <td>{r.reason ?? ""}</td>
                <td>{r.decisions.length === 0 ? <span className="muted">{c.t("creators.noDecisions")}</span> : (
                  <form action={decideCreatorAction}>
                    <input type="hidden" name="id" value={r.id} />
                    <label htmlFor={`cr-d-${r.id}`}>{c.t("creators.decision")}</label>
                    <select id={`cr-d-${r.id}`} name="action" defaultValue={r.decisions[0]}>
                      {r.decisions.map((d) => <option key={d} value={d}>{c.t(`creators.decision.${d}`)}</option>)}
                    </select>
                    <label htmlFor={`cr-r-${r.id}`}>{c.t("creators.reason")}</label>
                    <input id={`cr-r-${r.id}`} name="reason" maxLength={200} />
                    <button type="submit" className="btn" disabled={!writes}>{c.t("creators.apply")}</button>
                  </form>
                )}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>

      <section aria-labelledby="cr-commissions">
        <h2 id="cr-commissions">{c.t("creators.commissions")}</h2>
        <p className="muted">{c.t("creators.commissionsGap")}</p>
      </section>

      <section aria-labelledby="cr-payouts">
        <h2 id="cr-payouts">{c.t("creators.payouts")}</h2>
        <p role="status" className={gate.moneyActionsEnabled ? "notice ok" : "notice error"}>
          {gate.moneyActionsEnabled ? c.t("creators.payoutsAllowed") : c.t(gate.reported ? "creators.payoutsBlocked" : "creators.payoutsNotReported")}
        </p>
        {!payouts.ok ? <ErrorBlock error={payouts.error} c={c} /> : pRows.length === 0 ? <Empty t={c.t} /> : (
          <div className="table-wrap"><table>
            <thead><tr><th>{c.t("creators.col.creator")}</th><th>{c.t("creators.col.amount")}</th><th>{c.t("col.status")}</th><th>{c.t("creators.col.attempt")}</th><th>{c.t("creators.col.created")}</th><th>{c.t("col.actions")}</th></tr></thead>
            <tbody>{pRows.map((p) => (
              <tr key={p.id}>
                <td dir="ltr">{p.creatorId}</td>
                <td>{formatMoney(p.amountMinor, c.locale)}</td>
                <td><Badge tone={payoutTone(p.state)}>{c.t(`creators.payoutState.${p.state}`)}</Badge>
                  {p.holdReason === null ? null : <div className="muted">{c.t("creators.holdReason", { reason: p.holdReason })}</div>}
                  {p.failureReason === null ? null : <div className="muted">{c.t("creators.failureReason", { reason: p.failureReason })}</div>}</td>
                <td>{p.attempt}</td>
                <td>{p.createdAt === null ? "" : formatDateTime(p.createdAt, c.locale)}</td>
                <td>{p.actions.length === 0 ? null : p.actions.map((a) => {
                  const av = actionAvailability(p, a, gate, writes);
                  const key = a === "outcome_settled" ? "settled" : a === "outcome_rejected" ? "rejected" : a;
                  const hintId = `po-${p.id}-${a}-why`;
                  return (
                    <form key={a} action={creatorPayoutStepAction}>
                      <input type="hidden" name="id" value={p.id} />
                      <input type="hidden" name="step" value={STEP_OF[a]} />
                      {a === "outcome_settled" || a === "outcome_rejected" ? (
                        <>
                          <label htmlFor={`po-${p.id}-${a}-ref`}>{c.t("creators.providerRef")}</label>
                          <input id={`po-${p.id}-${a}-ref`} name="provider_ref" maxLength={128} dir="ltr" />
                        </>
                      ) : null}
                      <button type="submit" className="btn" disabled={!av.enabled} aria-describedby={av.enabled ? undefined : hintId}>{c.t(`creators.act.${key}`)}</button>
                      {av.enabled ? null : <p id={hintId} className="muted">{c.t(`creators.why.${av.why}`)}</p>}
                    </form>
                  );
                })}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
        <div className="card">
          <h3>{c.t("creators.createPayout")}</h3>
          <p className="muted">{c.t("creators.createPayoutHelp")}</p>
          <form action={createCreatorPayoutAction}>
            <label htmlFor="po-new">{c.t("creators.creatorId")}</label>
            <input id="po-new" name="creator_id" required dir="ltr" aria-describedby={gate.moneyActionsEnabled ? undefined : "po-new-why"} />
            <button type="submit" className="btn primary" disabled={!gate.moneyActionsEnabled || !writes}>{c.t("creators.createPayout")}</button>
            {gate.moneyActionsEnabled ? null : <p id="po-new-why" className="muted">{c.t("creators.why.kill_switch")}</p>}
          </form>
        </div>
      </section>
    </>
  );
}
