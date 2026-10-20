import { useEffect, useState } from "react";
import { View } from "react-native";
import { BottomSheet, Button, Chip, Text, TextField } from "../../ui";
import { useFormat } from "../home/parts";
import {
  BUDGET_PRESETS, NO_BUDGET, parseBudgetFields, piastresToField, sameBudget, stepBound, withMinMax, type Budget, type BudgetPreset,
} from "./model";
import { formatAmount } from "../money-display";

/** Draft state for the min/max fields. Reset from `budget` whenever `active` turns true. */
export function useBudgetDraft(budget: Budget, active: boolean) {
  const [minText, setMinText] = useState("");
  const [maxText, setMaxText] = useState("");
  useEffect(() => {
    if (!active) return;
    setMinText(budget.min === null ? "" : piastresToField(budget.min));
    setMaxText(budget.max === null ? "" : piastresToField(budget.max));
    // Reset the draft only when it becomes active.
  }, [active]);
  const parsed = parseBudgetFields(minText, maxText);
  const setDraft = (b: Budget): void => {
    setMinText(b.min === null ? "" : piastresToField(b.min));
    setMaxText(b.max === null ? "" : piastresToField(b.max));
  };
  return { minText, maxText, setMinText, setMaxText, parsed, setDraft };
}

/** Min/max EGP fields (Western or Eastern digits), presets and +/- steppers (no native slider module). */
export function BudgetFields(props: { draft: ReturnType<typeof useBudgetDraft> }) {
  const f = useFormat();
  const { minText, maxText, setMinText, setMaxText, parsed, setDraft } = props.draft;
  const step = (which: "min" | "max", dir: 1 | -1): void => {
    const base = parsed.ok ? parsed.budget : NO_BUDGET;
    const next = stepBound(which === "min" ? base.min : base.max, dir, 0n);
    setDraft(withMinMax(base, which, next));
  };
  const presetLabel = (p: BudgetPreset): string => {
    const { min, max } = p.budget;
    if (min !== null && max !== null) return f.t("shopFilter.presetBetween", { min: f.money(min), max: f.money(max) });
    if (max !== null) return f.t("shopFilter.presetUnder", { max: f.money(max) });
    return f.t("shopFilter.presetOver", { min: f.money(min ?? 0n) });
  };
  const errorFor = (which: "min" | "max"): string | undefined => {
    const e = parsed.errors[which];
    if (e !== undefined) return f.t("shopFilter.errorInvalid", { example1: formatAmount(50_000n, f.locale), example2: formatAmount(49_950n, f.locale) });
    if (which === "max" && parsed.errors.range !== undefined) return f.t("shopFilter.errorRange");
    return undefined;
  };
  const field = (which: "min" | "max") => {
    const label = f.t(which === "min" ? "shopFilter.budgetMin" : "shopFilter.budgetMax");
    return (
      <View style={{ gap: 8 }}>
        <TextField
          label={`${label} (${f.t("common.currency")})`}
          value={which === "min" ? minText : maxText}
          onChangeText={which === "min" ? setMinText : setMaxText}
          keyboardType="numeric"
          maxLength={12}
          error={errorFor(which)}
          testID={`shop-budget-${which}`}
        />
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Chip label="−" accessibilityLabel={f.t("shopFilter.stepDown", { field: label })} onPress={() => step(which, -1)} testID={`shop-budget-${which}-down`} />
          <Chip label="+" accessibilityLabel={f.t("shopFilter.stepUp", { field: label })} onPress={() => step(which, 1)} testID={`shop-budget-${which}-up`} />
        </View>
      </View>
    );
  };

  return (
    <View style={{ gap: 14 }}>
      <Text variant="caption" secondary>{f.t("shopFilter.budgetHint")}</Text>
      <View style={{ gap: 14 }}>{field("min")}{field("max")}</View>
      <Text variant="caption" secondary>{f.t("shopFilter.quickPicks")}</Text>
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
        {BUDGET_PRESETS.map((p) => (
          <Chip key={p.id} label={presetLabel(p)} selected={parsed.ok && sameBudget(parsed.budget, p.budget)} role="radio" onPress={() => setDraft(p.budget)} testID={`shop-budget-preset-${p.id}`} />
        ))}
      </View>
    </View>
  );
}

/** Budget sheet used by Home. */
export function BudgetSheet(props: { visible: boolean; onClose: () => void; budget: Budget; onApply: (b: Budget) => void }) {
  const f = useFormat();
  const draft = useBudgetDraft(props.budget, props.visible);
  const { parsed } = draft;
  return (
    <BottomSheet visible={props.visible} onClose={props.onClose} title={f.t("shopFilter.budgetSheetTitle")}>
      <BudgetFields draft={draft} />
      <Text variant="caption" secondary>{f.t("shopFilter.privacy")}</Text>
      <View style={{ gap: 8 }}>
        <Button title={f.t("shopFilter.apply")} disabled={!parsed.ok} onPress={() => { props.onApply(parsed.budget); props.onClose(); }} testID="shop-budget-apply" />
        <Button title={f.t("shopFilter.clearBudget")} variant="ghost" onPress={() => { props.onApply(NO_BUDGET); props.onClose(); }} testID="shop-budget-clear" />
      </View>
    </BottomSheet>
  );
}
