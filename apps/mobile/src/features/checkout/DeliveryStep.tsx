import { useEffect, useState } from "react";
import { View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { spacing } from "@outlet/ui-tokens";
import { BottomSheet, Button, Eyebrow, StoreName, Text, TextField, useTheme } from "../../ui";
import { ItemArt } from "../purchase/ItemArt";
import { Section } from "../purchase/Section";
import { TextAction } from "../purchase/TextAction";
import { Flow } from "../purchase/motion";
import { Choice } from "./Choice";
import { useCheckoutSession } from "./CheckoutSession";
import { StepFrame, stepHref } from "./StepFrame";
import {
  addressSummary, citiesFor, pickText, setGovernorate, stepBlockers, validateAddress, visiblePaymentMethods,
  type AddressDraft, type AddressField,
} from "./model";

/** Step 1: address and one delivery option per store shipment. */
export function DeliveryStep() {
  const { t } = useTranslation();
  const router = useRouter();
  const s = useCheckoutSession();
  const { highlight } = useLocalSearchParams<{ highlight?: string }>();
  const [showErrors, setShowErrors] = useState(false);
  const [editing, setEditing] = useState(false);
  const [sheet, setSheet] = useState<"governorate" | "city" | null>(null);
  const { quote, sel, lang } = s;

  // Restored session: open on the step the shopper left (pushed once so back still returns to Delivery).
  useEffect(() => {
    if (s.restoredStep !== null && s.restoredStep !== "delivery") router.push(stepHref(s.restoredStep));
  }, [s.restoredStep]);
  // COD needs a pin and landmark: Payment sends the shopper here with the fields highlighted.
  useEffect(() => { if (highlight === "1") { setShowErrors(true); setEditing(true); } }, [highlight]);

  const method = quote !== null && sel !== null ? visiblePaymentMethods(quote).find((m) => m.id === sel.paymentMethodId) : undefined;
  const codSelected = method?.kind === "cod";
  const addrErrors = quote !== null && sel !== null ? validateAddress(sel.address, quote.coverage, codSelected) : [];
  const blockers = quote !== null && sel !== null ? stepBlockers("delivery", quote, sel, s.reconfirmed) : [];
  const showForm = sel !== null && (s.savedId === null || editing);
  const errFor = (field: AddressField, key: string): { error?: string } => (showErrors && addrErrors.includes(field) ? { error: t(key) } : {});
  const setAddr = (patch: Partial<AddressDraft>): void => { if (sel !== null) s.update({ address: { ...sel.address, ...patch } }); };

  return (
    <StepFrame step="delivery" blockers={blockers} showErrors={showErrors} ctaLabel={t("checkoutSteps.continue")}
      onContinue={() => router.push(stepHref("payment"))}
      onBlocked={() => { setShowErrors(true); if (addrErrors.length > 0) setEditing(true); }}>
      {quote !== null && sel !== null ? (
        <>
          <Flow index={0}><Section title={t("checkout.addressHeading")}>
            {s.saved.length > 0 ? (
              <View accessibilityRole="radiogroup" accessibilityLabel={t("checkout.savedAddresses")}>
                {s.saved.map((a) => (
                  <Choice key={a.id} selected={s.savedId === a.id} label={a.label ?? a.recipientName}
                    detail={<Text variant="caption" secondary>{`${a.recipientName}  ·  ${addressSummary(a.draft, quote.coverage, lang)}`}</Text>}
                    onPress={() => { setEditing(false); s.selectSaved(a); }} />
                ))}
                <Choice selected={s.savedId === null} label={t("checkout.newAddress")} onPress={() => s.selectSaved(null)} />
              </View>
            ) : null}
            {s.savedId !== null && !editing ? (
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: spacing.md }}>
                <Text variant="caption" secondary style={{ flex: 1 }}>
                  {addrErrors.length > 0 && showErrors ? t("checkout.blockers.address") : addressSummary(sel.address, quote.coverage, lang)}
                </Text>
                <TextAction label={t("checkout.editDetails")} onPress={() => setEditing(true)} />
              </View>
            ) : null}
            {showForm ? (
              <View style={{ gap: spacing.md }}>
                <PickerField label={t("checkout.governorate")}
                  value={sel.address.governorateId !== null ? pickText(quote.coverage.find((g) => g.id === sel.address.governorateId)?.name ?? { ar: "", en: "" }, lang) : ""}
                  placeholder={t("checkout.pickGovernorate")} onPress={() => setSheet("governorate")}
                  error={showErrors && addrErrors.includes("governorate") ? t("checkout.addressErrors.governorate") : undefined} />
                <PickerField label={t("checkout.city")} disabled={sel.address.governorateId === null}
                  value={pickText(citiesFor(quote.coverage, sel.address.governorateId).find((c) => c.id === sel.address.cityId)?.name ?? { ar: "", en: "" }, lang)}
                  placeholder={t("checkout.pickCity")} onPress={() => setSheet("city")}
                  error={showErrors && addrErrors.includes("city") ? t("checkout.addressErrors.city") : undefined} />
                <TextField label={t("checkout.street")} value={sel.address.street} onChangeText={(v) => setAddr({ street: v })} {...errFor("street", "checkout.addressErrors.street")} />
                <TextField label={t("checkout.building")} value={sel.address.building} onChangeText={(v) => setAddr({ building: v })} {...errFor("building", "checkout.addressErrors.building")} />
                <View style={{ flexDirection: "row", gap: spacing.md }}>
                  <View style={{ flex: 1 }}><TextField label={t("checkout.floor")} value={sel.address.floor} onChangeText={(v) => setAddr({ floor: v })} /></View>
                  <View style={{ flex: 1 }}><TextField label={t("checkout.apartment")} value={sel.address.apartment} onChangeText={(v) => setAddr({ apartment: v })} /></View>
                </View>
                <TextField label={t("checkout.landmark")} value={sel.address.landmark} onChangeText={(v) => setAddr({ landmark: v })} {...errFor("landmark", "checkout.addressErrors.landmark")} />
              </View>
            ) : null}
            {showForm || sel.address.pin !== null ? (
              <View style={{ gap: spacing.xs }}>
                <Button variant="secondary" icon="location-outline" title={t(sel.address.pin === null ? "checkout.pickOnMap" : "checkout.pinChange")}
                  onPress={() => void s.mapPin.pick(sel.address.pin).then((p) => { if (p !== null) setAddr({ pin: p }); })} />
                {sel.address.pin !== null ? <Text variant="caption" color="savings">{t("checkout.pinSet")}</Text> : null}
                {showErrors && addrErrors.includes("pin") ? <Text variant="caption" color="danger">{t("checkout.addressErrors.pin")}</Text> : null}
              </View>
            ) : null}
          </Section></Flow>

          <Flow index={1}><Section title={t("checkout.deliveryHeading")}>
            {quote.shipments.filter((sh) => sh.lines.length > 0).map((sh) => (
              <View key={sh.id} style={{ gap: spacing.md }}>
                <StoreName name={sh.storeName} layout="row" />
                {sh.lines.map((l) => (
                  <View key={l.lineId} style={{ flexDirection: "row", gap: spacing.md, alignItems: "center" }}>
                    <ItemArt title={l.title} seed={l.lineId} width={44} />
                    <Text variant="caption" secondary style={{ flex: 1 }}>
                      {t("checkout.lineSummary", { title: l.title, qty: s.num(l.qty), amount: s.money(l.unitPrice * BigInt(l.qty)) })}
                    </Text>
                  </View>
                ))}
                <View accessibilityRole="radiogroup">
                  {sh.deliveryOptions.map((o) => (
                    <Choice key={o.id} selected={sel.delivery[sh.id] === o.id} label={pickText(o.name, lang)}
                      detail={<Text variant="caption" secondary>{t("checkout.etaDays", { days: s.num(o.etaDays) })}</Text>}
                      trailing={<Text variant="callout" numeric color={o.fee === 0n ? "savings" : "textPrimary"}>{o.fee === 0n ? t("checkout.free") : s.money(o.fee)}</Text>}
                      accessibilityLabel={t("checkout.deliveryOption", { name: pickText(o.name, lang), days: s.num(o.etaDays), fee: o.fee === 0n ? t("checkout.free") : s.money(o.fee) })}
                      onPress={() => s.update({ delivery: { ...sel.delivery, [sh.id]: o.id } })} />
                  ))}
                </View>
              </View>
            ))}
            {showErrors && blockers.includes("delivery") ? <Text variant="caption" color="danger">{t("checkout.blockers.delivery")}</Text> : null}
          </Section></Flow>

          <BottomSheet visible={sheet !== null} onClose={() => setSheet(null)}
            title={sheet === "governorate" ? t("checkout.pickGovernorate") : t("checkout.pickCity")} closeLabel={t("common.close")}>
            <View accessibilityRole="radiogroup">
              {sheet === "governorate" ? quote.coverage.map((g) => (
                <Choice key={g.id} label={pickText(g.name, lang)} selected={sel.address.governorateId === g.id}
                  accessibilityLabel={t("checkout.choose", { name: pickText(g.name, lang) })}
                  onPress={() => { s.update({ address: setGovernorate(sel.address, quote.coverage, g.id) }); setSheet(null); }} />
              )) : null}
              {sheet === "city" ? citiesFor(quote.coverage, sel.address.governorateId).map((c) => (
                <Choice key={c.id} label={pickText(c.name, lang)} selected={sel.address.cityId === c.id}
                  accessibilityLabel={t("checkout.choose", { name: pickText(c.name, lang) })}
                  onPress={() => { setAddr({ cityId: c.id }); setSheet(null); }} />
              )) : null}
            </View>
          </BottomSheet>
        </>
      ) : null}
    </StepFrame>
  );
}

/** Read-only field that opens a picker sheet. */
function PickerField(props: { label: string; value: string; placeholder: string; onPress: () => void; error: string | undefined; disabled?: boolean }) {
  const { colors } = useTheme();
  return (
    <View style={{ gap: 4, opacity: props.disabled === true ? 0.5 : 1 }}>
      <Eyebrow>{props.label}</Eyebrow>
      <TextAction label={props.value.length > 0 ? props.value : props.placeholder}
        accessibilityLabel={`${props.label}: ${props.value.length > 0 ? props.value : props.placeholder}`}
        color={props.value.length > 0 ? "textPrimary" : "textSecondary"} disabled={props.disabled === true} onPress={props.onPress} />
      <View style={{ height: 1, backgroundColor: props.error !== undefined ? colors.danger : colors.hairline }} />
      {props.error !== undefined ? <Text variant="caption" color="danger">{props.error}</Text> : null}
    </View>
  );
}
