import { createTranslator, type Locale } from "@outlet/i18n";
import { KYC_TRACK, STATE_KEYS, gapKey, docKey, type KycState } from "../../lib/onboarding-model";

export interface KycStatusProps {
  readonly locale: Locale;
  readonly state: KycState;
  readonly gaps: readonly string[];
  readonly reason: string | null;
}

/** The review track (DRAFT → SUBMITTED → AUTO_CHECKS → APPROVED) with the exits (NEEDS_INFO, REJECTED, SUSPENDED) as a labelled status. */
export function KycStatus({ locale, state, gaps, reason }: KycStatusProps) {
  const t = createTranslator(locale);
  const at = KYC_TRACK.indexOf(state as (typeof KYC_TRACK)[number]);
  const exit = at === -1;
  return (
    <section className="kycStatus" aria-labelledby="kyc-status-title" data-state={state}>
      <h2 id="kyc-status-title" className="panelTitle">
        {t("seller.kyc.status.title")}
      </h2>
      <ol className="steps" aria-label={t("seller.kyc.status.track")}>
        {KYC_TRACK.map((s, i) => (
          <li key={s} {...(s === state ? { "aria-current": "step" as const } : {})} data-done={!exit && i < at}>
            <span className="stepNum">{i + 1}</span> {t(STATE_KEYS[s].label)}
          </li>
        ))}
      </ol>
      <p className="resultNote" role="status" data-tone={exit ? "bad" : undefined}>
        {t(STATE_KEYS[state].label)}: {t(STATE_KEYS[state].desc)}
      </p>
      {state === "NEEDS_INFO" || state === "REJECTED" || state === "SUSPENDED" ? (
        <div className="blocked">
          {state === "NEEDS_INFO" ? <p>{t("seller.kyc.needsInfo.title")}</p> : null}
          {reason === null ? null : <p className="hint">{t("seller.kyc.reason", { reason })}</p>}
          {state === "NEEDS_INFO" && gaps.length > 0 ? (
            <ul>
              {gaps.map((g) => {
                const k = gapKey(g);
                return <li key={g}>{k.doc === undefined ? t(k.key) : t(k.key, { doc: t(docKey(k.doc)) })}</li>;
              })}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
