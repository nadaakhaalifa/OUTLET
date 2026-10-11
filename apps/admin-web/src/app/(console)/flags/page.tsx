import { Badge, Empty, ErrorBlock, Flash, PageHeader, WritesDisabledNote } from "../../../components/ui";
import { ReasonDialog } from "../../../components/reason-dialog";
import { setFlagAction } from "../../../server/actions";
import { getConsole } from "../../../server/console";
import { ORDINARY_REASON_CODES } from "../../../view-models/common";
import { changeSentence, killSwitchBoard, type SwitchGroup } from "../../../view-models/killswitch";

export default async function FlagsPage({ searchParams }: { searchParams: Promise<{ r?: string }> }) {
  const c = await getConsole();
  const sp = await searchParams;
  const r = await c.api.flags();
  const board = r.ok ? killSwitchBoard(r.value.data.items, c.locale) : null;
  const reasons = ORDINARY_REASON_CODES.map((x) => ({ code: x.code, label: c.t(x.labelKey) }));
  const writes = c.posture.sensitiveWritesEnabled;
  return (
    <>
      <PageHeader title={c.t("flags.title")} intro={c.t("flags.intro")} />
      <Flash code={sp.r} t={c.t} />
      <WritesDisabledNote c={c} />
      {!r.ok ? <ErrorBlock error={r.error} c={c} /> : null}
      {board === null ? null : (
        <>
          <p role="status">{c.t("sw.summary", { blocked: board.blockedCount, allowed: board.allowedCount })}</p>
          {board.notReported.length > 0 ? (
            <p role="alert" className="notice error">{c.t("sw.notReported")}: {board.notReported.map((n) => n.label).join(", ")}</p>
          ) : null}
          {board.groups.length === 0 ? <Empty t={c.t} /> : board.groups.map((g) => (
            <section key={g.group} aria-labelledby={`g-${g.group}`}>
              <h2 id={`g-${g.group}`}>{c.t(`sw.group.${g.group satisfies SwitchGroup}`)}</h2>
              <div className="table-wrap"><table>
                <thead><tr><th>{c.t("col.flag")}</th><th>{c.t("col.status")}</th><th>{c.t("col.actions")}</th></tr></thead>
                <tbody>{g.rows.map((s) => (
                  <tr key={s.key}>
                    <td>{s.label}<div className="muted" dir="ltr">{s.key}</div>
                      {s.blockedMeans === null ? null : <div className="muted">{c.t("sw.blockedMeans", { effect: s.blockedMeans })}</div>}</td>
                    <td><Badge tone={s.state === "allowed" ? "ok" : "bad"}>{c.t(s.state === "allowed" ? "sw.allowed" : "sw.blocked")}</Badge>
                      {s.isDefault ? <div className="muted">{c.t("sw.defaultNote")}</div> : null}</td>
                    <td><ReasonDialog triggerLabel={c.t(s.nextState === "allowed" ? "sw.setAllowed" : "sw.setBlocked")}
                      title={c.t("sw.changeTitle", { label: s.label })} description={`${changeSentence(s, c.locale)} ${c.t("sw.auditNote")}`}
                      reasonLabel={c.t("common.reason")} choosePlaceholder={c.t("common.choose")}
                      submitLabel={c.t(s.nextState === "allowed" ? "sw.setAllowed" : "sw.setBlocked")} cancelLabel={c.t("common.cancel")} reasons={reasons}
                      action={setFlagAction} hidden={{ key: s.key, enabled: String(s.nextEnabled) }} danger={s.nextState === "blocked"} disabled={!writes} /></td>
                  </tr>
                ))}</tbody>
              </table></div>
            </section>
          ))}
        </>
      )}
    </>
  );
}
