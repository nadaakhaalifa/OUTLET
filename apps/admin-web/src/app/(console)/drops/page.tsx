import { ErrorBlock, Flash, PageHeader, WritesDisabledNote } from "../../../components/ui";
import { ReasonDialog } from "../../../components/reason-dialog";
import { SwitchStrip } from "../../../components/switch-strip";
import { controlDropAction } from "../../../server/actions";
import { getConsole } from "../../../server/console";
import { ORDINARY_REASON_CODES } from "../../../view-models/common";

const KEYS = ["kill.drops", "kill.waiting_room", "kill.mystery_box", "kill.drop_type.public", "kill.drop_type.members_only", "kill.drop_type.flash_hour",
  "kill.drop_type.mystery_box", "kill.drop_type.price_ladder", "kill.drop_type.last_chance"] as const;

export default async function DropsPage({ searchParams }: { searchParams: Promise<{ r?: string }> }) {
  const c = await getConsole();
  const sp = await searchParams;
  const f = await c.api.flags("kill_switch");
  const writes = c.posture.sensitiveWritesEnabled;
  const reasons = ORDINARY_REASON_CODES.map((x) => ({ code: x.code, label: c.t(x.labelKey) }));
  const words = { pause: c.t("drops.pauseWords"), resume: c.t("drops.resumeWords"), end: c.t("drops.endWords") } as const;
  return (
    <>
      <PageHeader title={c.t("drops.title")} intro={c.t("drops.intro")} />
      <Flash code={sp.r} t={c.t} />
      <WritesDisabledNote c={c} />
      {!f.ok ? <ErrorBlock error={f.error} c={c} /> : <SwitchStrip items={f.value.data.items} keys={KEYS} c={c} />}
      <p><a href="/flags">{c.t("nav.flags")}</a></p>
      <h2>{c.t("drops.metrics")}</h2>
      <ul>
        <li>{c.t("drops.queueDepth")}: {c.t("common.notMeasured")}</li>
        <li>{c.t("drops.botBlock")}: {c.t("common.notMeasured")}</li>
        <li>{c.t("drops.admission")}: {c.t("common.notMeasured")}</li>
      </ul>
      <p className="muted">{c.t("common.noEndpoint")}</p>
      <section className="card">
        <h2>{c.t("drops.control")}</h2>
        <div className="row">
          {(["pause", "resume", "end"] as const).map((a) => (
            <ReasonDialog key={a} triggerLabel={c.t(`drops.${a}`)} title={c.t(`drops.${a}`)} description={`${words[a]} ${c.t("sw.auditNote")}`}
              reasonLabel={c.t("common.reason")} choosePlaceholder={c.t("common.choose")} submitLabel={c.t(`drops.${a}`)} cancelLabel={c.t("common.cancel")}
              reasons={reasons} action={controlDropAction} hidden={{ action: a }} danger={a !== "resume"} disabled={!writes}>
              <label htmlFor={`dr-id-${a}`}>{c.t("drops.id")}</label>
              <input id={`dr-id-${a}`} name="id" required dir="ltr" />
            </ReasonDialog>
          ))}
        </div>
      </section>
    </>
  );
}
