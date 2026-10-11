import { useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { spacing } from "@outlet/ui-tokens";
import { Badge, Banner, Button, Card, Checkbox, EmptyState, ErrorState, ListRow, LoadingState, Screen, Text, TextField } from "../../ui";
import { formatMoney, localizeDigits, type DisplayLocale } from "../money-display";
import { opt } from "./optional";
import { Chip } from "./Chip";
import {
  CONDITIONS, EMPTY_FILTER, activeFilterCount, displayDiscountPct, normalizeQuery, parseBudgetEgp,
  runSearch, searchFailure, toggleCondition, type SearchFilter, type SearchOutcome, type SearchPort,
} from "./model";
import { getFeaturePorts } from "../../state/ports";

type View_ = { readonly kind: "idle" } | { readonly kind: "loading" } | { readonly kind: "error"; readonly offline: boolean } | SearchOutcome;

export function SearchScreen(props: { port?: SearchPort; onOpenProduct?: (id: string) => void }) {
  const { t, i18n } = useTranslation();
  const locale: DisplayLocale = i18n.language === "en" ? "en" : "ar";
  const port = useMemo<SearchPort>(() => props.port ?? getFeaturePorts().search, [props.port]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SearchFilter>(EMPTY_FILTER);
  const [budgetText, setBudgetText] = useState("");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<readonly string[]>([]);
  const [liveCount, setLiveCount] = useState<number | null>(null);
  const [view, setView] = useState<View_>({ kind: "idle" });
  const seq = useRef(0);
  const currency = t("common.currency");
  const num = (n: number) => localizeDigits(String(n), locale);

  useEffect(() => {
    let alive = true;
    port.suggest(query).then((s) => { if (alive) setSuggestions(s); }, () => { if (alive) setSuggestions([]); });
    return () => { alive = false; };
  }, [port, query]);

  useEffect(() => {
    if (!sheetOpen) return;
    let alive = true;
    setLiveCount(null);
    port.count(normalizeQuery(query), filter).then((c) => { if (alive) setLiveCount(c); }, () => { if (alive) setLiveCount(null); });
    return () => { alive = false; };
  }, [port, sheetOpen, query, filter]);

  const submit = async (q: string, f: SearchFilter) => {
    const id = ++seq.current;
    setView({ kind: "loading" });
    setSuggestions([]);
    try {
      const out = await runSearch(port, q, f);
      if (id === seq.current) setView(out);
    } catch (e) {
      if (id === seq.current) setView({ kind: "error", ...searchFailure(e) });
    }
  };

  const setBudget = (text: string) => {
    setBudgetText(text);
    setFilter((f) => ({ ...f, budgetMax: parseBudgetEgp(text) }));
  };
  const budgetInvalid = budgetText.trim().length > 0 && parseBudgetEgp(budgetText) === null;
  const count = activeFilterCount(filter);

  return (
    <Screen>
      <Text variant="title">{t("search.title")}</Text>
      <TextField label={t("search.queryLabel")} placeholder={t("search.queryPlaceholder")} value={query} onChangeText={setQuery} />
      {suggestions.length > 0 ? (
        <View accessibilityLabel={t("search.suggestionsName")}>
          {suggestions.map((s) => (
            <ListRow key={s} title={s} onPress={() => { setQuery(s); void submit(s, filter); }} />
          ))}
        </View>
      ) : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
        <Button title={t("search.submit")} onPress={() => void submit(query, filter)} />
        <Button
          variant="secondary"
          title={count > 0 ? t("search.filtersWithCount", { count: num(count) }) : t("search.filters")}
          accessibilityLabel={count > 0 ? t("search.filtersWithCount", { count: num(count) }) : t("search.filters")}
          onPress={() => setSheetOpen((o) => !o)}
        />
      </View>

      {sheetOpen ? (
        <Card>
          <Text variant="heading">{t("search.filters")}</Text>
          <TextField
            label={t("search.budgetLabel", { currency })}
            helper={t("search.budgetHelper")}
            {...opt("error", budgetInvalid ? t("search.budgetInvalid") : undefined)}
            value={budgetText}
            keyboardType="numeric"
            onChangeText={setBudget}
          />
          <Checkbox label={t("search.mySize")} value={filter.mySizeOnly} onValueChange={(v) => setFilter((f) => ({ ...f, mySizeOnly: v }))} />
          <Checkbox label={t("search.verifiedOnly")} value={filter.verifiedDiscountOnly} onValueChange={(v) => setFilter((f) => ({ ...f, verifiedDiscountOnly: v }))} />
          <Text variant="caption" secondary>{t("search.conditionHeading")}</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
            {CONDITIONS.map((c) => (
              <Chip key={c} role="checkbox" label={t(`search.condition.${c}`)} selected={filter.conditions.includes(c)} onPress={() => setFilter((f) => toggleCondition(f, c))} />
            ))}
          </View>
          <Text variant="caption" secondary>{t("search.paymentHeading")}</Text>
          <Checkbox label={t("search.installments")} value={filter.installmentsAvailable} onValueChange={(v) => setFilter((f) => ({ ...f, installmentsAvailable: v }))} />
          <Checkbox label={t("search.payableWithCredit")} value={filter.payableWithCredit} onValueChange={(v) => setFilter((f) => ({ ...f, payableWithCredit: v }))} />
          <Text variant="caption" secondary>{t("search.installmentsNote")}</Text>
          <View accessibilityLiveRegion="polite">
            <Text>{liveCount === null ? t("search.countLoading") : t("search.liveCount", { count: num(liveCount) })}</Text>
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
            <Button
              title={liveCount === null ? t("search.apply") : t("search.showResults", { count: num(liveCount) })}
              disabled={budgetInvalid}
              onPress={() => { setSheetOpen(false); void submit(query, filter); }}
            />
            <Button variant="secondary" title={t("search.clear")} onPress={() => { setFilter(EMPTY_FILTER); setBudgetText(""); }} />
          </View>
        </Card>
      ) : null}

      {view.kind === "loading" ? <LoadingState label={t("search.loading")} /> : null}
      {view.kind === "error" ? (
        <ErrorState
          offline={view.offline}
          title={t(view.offline ? "search.offlineTitle" : "search.errorTitle")}
          description={t(view.offline ? "search.offlineBody" : "search.errorBody")}
          retryTitle={t("common.retry")}
          onRetry={() => void submit(query, filter)}
        />
      ) : null}
      {view.kind === "idle" ? <Text secondary>{t("search.idle")}</Text> : null}
      {view.kind === "empty" ? <EmptyState title={t("search.emptyTitle")} description={t("search.emptyBody")} actionTitle={t("search.clear")} onAction={() => { setFilter(EMPTY_FILTER); setBudgetText(""); }} /> : null}
      {view.kind === "relaxed" ? (
        <Banner tone="info" message={t("search.relaxed", { filters: view.dropped.map((d) => t(`search.filterName.${d}`)).join(t("search.listSeparator")) })} />
      ) : null}
      {view.kind === "results" || view.kind === "relaxed" ? (
        <>
          <Text secondary>{t("search.resultCount", { count: num(view.total) })}</Text>
          {view.items.map((it) => {
            const pct = displayDiscountPct(it);
            return (
              <Card key={it.id}>
                {it.sponsored ? <Badge tone="info" label={t("search.sponsored")} /> : null}
                <Text variant="heading">{it.title}</Text>
                <Text variant="caption" secondary>{it.storeName}</Text>
                <Text>{formatMoney(it.price, locale, currency)}</Text>
                {pct !== null ? <Badge tone="info" label={t("pdp.verifiedDiscount", { pct: num(pct) })} /> : null}
                {props.onOpenProduct !== undefined ? <Button variant="secondary" title={t("search.open")} accessibilityLabel={t("search.openName", { title: it.title })} onPress={() => props.onOpenProduct?.(it.id)} /> : null}
              </Card>
            );
          })}
        </>
      ) : null}
      {typeof __DEV__ !== "undefined" && __DEV__ ? <Banner tone="info" message={t("common.devFixtureBackend")} /> : null}
    </Screen>
  );
}
