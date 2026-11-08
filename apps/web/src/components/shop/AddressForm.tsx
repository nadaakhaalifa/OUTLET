"use client";
import { useEffect, useId, useState, type SyntheticEvent } from "react";
import { language, type Locale } from "@outlet/i18n";
import { Button, Field } from "@outlet/ui-web";
import type { ShopperApi } from "../../lib/client-api";
import { normalizeEgPhone } from "../../lib/phone";
import type { Address, GeoArea } from "../../lib/wire";
import { Alert, useShared } from "./shared";

interface SelectProps {
  readonly label: string;
  readonly placeholder: string;
  readonly value: string;
  readonly options: readonly GeoArea[];
  readonly locale: Locale;
  readonly disabled?: boolean;
  readonly onChange: (id: string) => void;
}
function GeoSelect({ label, placeholder, value, options, locale, disabled = false, onChange }: SelectProps) {
  const id = useId();
  const en = language(locale) === "en";
  return (
    <div className="shopField">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} disabled={disabled} required onChange={(e) => { onChange(e.target.value); }} className="shopSelect">
        <option value="">{placeholder}</option>
        {options.map((o) => <option key={o.id} value={o.id}>{en && o.name_en !== null ? o.name_en : o.name_ar}</option>)}
      </select>
    </div>
  );
}

export interface AddressFormProps {
  readonly locale: Locale;
  readonly api: ShopperApi;
  readonly onSaved: (address: Address) => void;
}

/** Governorate, then city, then street, building, floor, apartment and a landmark (the API requires one). The map pin is optional and not collected here. */
export function AddressForm({ locale, api, onSaved }: AddressFormProps) {
  const { t } = useShared(locale);
  const [govs, setGovs] = useState<readonly GeoArea[]>([]);
  const [cities, setCities] = useState<readonly GeoArea[]>([]);
  const [districts, setDistricts] = useState<readonly GeoArea[]>([]);
  const [gov, setGov] = useState("");
  const [city, setCity] = useState("");
  const [district, setDistrict] = useState("");
  const [f, setF] = useState({ recipient: "", phone: "", street: "", building: "", floor: "", apartment: "", landmark: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }): void => { setF((p) => ({ ...p, [k]: e.target.value })); };

  useEffect(() => { api.geoAreas("governorate").then(setGovs, () => { setError(t("error.generic")); }); }, [api, t]);
  useEffect(() => {
    setCities([]); setCity(""); setDistricts([]); setDistrict("");
    if (gov !== "") api.geoAreas("city", gov).then(setCities, () => { setError(t("error.generic")); });
  }, [api, gov, t]);
  useEffect(() => {
    setDistricts([]); setDistrict("");
    if (city !== "") api.geoAreas("district", city).then(setDistricts, () => { setDistricts([]); });
  }, [api, city]);

  async function submit(e: SyntheticEvent): Promise<void> {
    e.preventDefault();
    const phone = normalizeEgPhone(f.phone);
    const districtId = district !== "" ? district : districts.length === 0 ? city : "";
    if (phone === null) { setError(t("auth.phone.invalid")); return; }
    if (gov === "" || city === "" || districtId === "" || f.recipient.trim() === "" || f.street.trim() === "" || f.building.trim() === "" || f.landmark.trim() === "") { setError(t("checkout.address.invalid")); return; }
    setBusy(true); setError(null);
    try {
      onSaved(await api.createAddress({ recipientName: f.recipient.trim(), phoneE164: phone, governorateId: gov, districtId, street: f.street.trim(), building: f.building.trim(), floor: f.floor.trim(), apartment: f.apartment.trim(), landmark: f.landmark.trim() }));
    } catch { setError(t("checkout.address.invalid")); } finally { setBusy(false); }
  }

  return (
    <form noValidate className="shopForm" onSubmit={(e) => { void submit(e); }} aria-label={t("checkout.address.new")}>
      <Field label={t("checkout.address.recipient")} value={f.recipient} onChange={set("recipient")} autoComplete="name" required />
      <Field label={t("checkout.address.phone")} value={f.phone} onChange={set("phone")} type="tel" inputMode="tel" autoComplete="tel" required dir="ltr" />
      <GeoSelect label={t("checkout.address.governorate")} placeholder={t("checkout.address.choose")} value={gov} options={govs} locale={locale} onChange={setGov} />
      <GeoSelect label={t("checkout.address.city")} placeholder={t("checkout.address.choose")} value={city} options={cities} locale={locale} disabled={gov === ""} onChange={setCity} />
      {districts.length > 0 ? <GeoSelect label={t("checkout.address.district")} placeholder={t("checkout.address.choose")} value={district} options={districts} locale={locale} onChange={setDistrict} /> : null}
      <Field label={t("checkout.address.street")} value={f.street} onChange={set("street")} autoComplete="address-line1" required />
      <Field label={t("checkout.address.building")} value={f.building} onChange={set("building")} required />
      <Field label={t("checkout.address.floor")} value={f.floor} onChange={set("floor")} />
      <Field label={t("checkout.address.apartment")} value={f.apartment} onChange={set("apartment")} />
      <Field label={t("checkout.address.landmark")} hint={t("checkout.address.landmarkHint")} value={f.landmark} onChange={set("landmark")} required />
      {error === null ? null : <Alert>{error}</Alert>}
      <Button type="submit" loading={busy}>{t("checkout.address.save")}</Button>
    </form>
  );
}
