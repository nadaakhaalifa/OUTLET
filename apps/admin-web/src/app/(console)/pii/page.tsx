import { PiiViewer } from "../../../components/pii-viewer";
import { PageHeader } from "../../../components/ui";
import { getConsole } from "../../../server/console";
import { ORDINARY_REASON_CODES } from "../../../view-models/common";
import { PII_FIELDS, PII_FIELD_KEYS } from "../../../view-models/pii";

export default async function PiiPage() {
  const c = await getConsole();
  return (
    <>
      <PageHeader title={c.t("pii.title")} intro={c.t("pii.intro")} />
      <PiiViewer
        labels={{
          open: c.t("pii.open"), title: c.t("pii.dialogTitle"), subject: c.t("pii.subject"), fields: c.t("pii.fields"),
          reason: c.t("common.reason"), choose: c.t("common.choose"), submit: c.t("pii.submit"), cancel: c.t("common.cancel"),
          hideNow: c.t("pii.hideNow"), autoHides: c.t("pii.autoHides"), error: c.t("state.error"),
        }}
        fieldOptions={PII_FIELDS.map((f) => ({ value: f, label: c.t(PII_FIELD_KEYS[f]) }))}
        reasons={ORDINARY_REASON_CODES.map((x) => ({ code: x.code, label: c.t(x.labelKey) }))}
        errorMessages={{
          "state.forbidden": c.t("state.forbidden"), "state.notFound": c.t("state.notFound"), "state.unavailable": c.t("state.unavailable"),
          "state.notConfigured": c.t("state.notConfigured"), "pii.error.subject": c.t("pii.error.subject"),
          "pii.error.fields": c.t("pii.error.fields"), "pii.error.reason": c.t("pii.error.reason"),
        }}
      />
    </>
  );
}
