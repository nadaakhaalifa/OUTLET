import { DynamicForm } from "../../../components/DynamicForm";
import { ErrorNotice } from "../../../components/ErrorNotice";
import { canWriteSettings, settingsCtx } from "../../../page-settings";
import { GOVERNORATES } from "../../../view-models/store-settings";
import { saveShippingAction } from "../../actions-onboarding";

const PACKAGING = ["standard_box", "branded_box", "poly_mailer", "garment_bag", "eco_packaging"] as const;

export default async function ShippingPage() {
  const c = await settingsCtx();
  if (!c.ok) return c.node;
  const { api, scope, t, locale } = c;
  const r = await api.shipping(scope.storeId);
  if (!r.ok) return <ErrorNotice error={r.error} locale={locale} />;
  const s = r.value.data;
  const o = s.configured ? s.origin : null;
  const writable = canWriteSettings(scope.role);
  return (
    <section aria-labelledby="sh-h">
      <h1 id="sh-h">{t("ob.shipping.title")}</h1>
      <p className="zm-lead">{t("ob.shipping.lead")}</p>
      {writable ? null : <p role="status" className="zm-notice">{t("ob.set.readOnly")}</p>}
      <DynamicForm
        action={saveShippingAction} locale={locale} submitLabel={t("common.save")} nextPath="/settings/shipping" disabled={!writable}
        fields={[
          { name: "governorate", label: t("ob.shipping.governorate"), type: "select", required: true, value: o?.governorate_code ?? "", options: GOVERNORATES.map((g) => ({ value: g.code, label: locale === "ar" ? g.ar : g.en })), disabled: !writable },
          { name: "city", label: t("ob.shipping.city"), type: "text", dir: "ltr", required: true, value: o?.city_code ?? "", hint: t("ob.shipping.cityHint"), disabled: !writable },
          { name: "street", label: t("ob.shipping.street"), type: "text", required: true, value: o?.street ?? "", maxLength: 200, disabled: !writable },
          { name: "building", label: t("ob.shipping.building"), type: "text", value: o?.building ?? "", maxLength: 40, disabled: !writable },
          { name: "landmark", label: t("ob.shipping.landmark"), type: "text", required: true, value: o?.landmark ?? "", maxLength: 120, disabled: !writable },
          { name: "contactName", label: t("ob.shipping.contactName"), type: "text", required: true, value: o?.contact_name ?? "", maxLength: 80, autoComplete: "name", disabled: !writable },
          {
            name: "contactPhone", label: t("ob.shipping.contactPhone"), type: "tel", dir: "ltr", inputMode: "tel", autoComplete: "tel", required: o === null,
            hint: o === null ? t("ob.auth.phoneHint") : t("ob.shipping.phoneStored", { masked: o.contact_phone_masked }), disabled: !writable,
          },
          { name: "lat", label: t("ob.shipping.lat"), type: "text", dir: "ltr", inputMode: "decimal", value: o?.pin?.lat === undefined ? "" : String(o.pin.lat), disabled: !writable },
          { name: "lng", label: t("ob.shipping.lng"), type: "text", dir: "ltr", inputMode: "decimal", value: o?.pin?.lng === undefined ? "" : String(o.pin.lng), hint: t("ob.shipping.pinHint"), disabled: !writable },
          { name: "handlingHours", label: t("ob.shipping.handling"), type: "number", dir: "ltr", inputMode: "numeric", required: true, value: String(s.handling_time_hours), hint: t("ob.shipping.handlingHint"), disabled: !writable },
          {
            name: "packaging", label: t("ob.shipping.packaging"), type: "checks", disabled: !writable,
            values: s.configured ? s.packaging_options : ["standard_box"],
            options: PACKAGING.map((p) => ({ value: p, label: t(`ob.pack.${p}` as const) })),
          },
        ]}
      />
    </section>
  );
}
