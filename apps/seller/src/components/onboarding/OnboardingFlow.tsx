"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createTranslator, type Locale, type MessageKey } from "@outlet/i18n";
import { createOnboardingApi, type OnboardingApi, type OnboardingWire } from "../../client/onboarding-api";
import type { ApiFailure } from "../../client/seller-api";
import {
  EMPTY_IDENTITY, SIGNATORY_MIN_AGE, editable, gapKey, docKey, governorateKey, ibanValid, identityProblems, normalizeIban, validDocumentFile,
  type DocType, type IdentityForm as Identity, type IdentityProblem,
} from "../../lib/onboarding-model";
import { ProblemBanner } from "../ProblemBanner";
import { BankForm } from "./BankForm";
import { DocumentsPanel } from "./DocumentsPanel";
import { IdentityForm } from "./IdentityForm";
import { KycStatus } from "./KycStatus";
import { LegalIdentityPreview } from "./LegalIdentityPreview";

type Load = { readonly kind: "loading" } | { readonly kind: "none" } | { readonly kind: "error"; readonly f: ApiFailure } | { readonly kind: "ready"; readonly data: OnboardingWire };

export interface OnboardingFlowProps {
  readonly locale: Locale;
  readonly marketId: string;
  readonly api?: OnboardingApi;
}

const DOC_ERRORS = (status: number): MessageKey => (status === 413 ? "seller.kyc.docs.err.size" : status === 415 ? "seller.kyc.docs.err.type" : status === 503 ? "seller.kyc.docs.err.unavailable" : status === 422 ? "seller.kyc.docs.err.rejected" : "seller.kyc.docs.err.generic");

/** Seller Center application: legal identity → documents → payout IBAN → submit, with the live KYC state. */
export function OnboardingFlow({ locale, marketId, api: apiProp }: OnboardingFlowProps) {
  const t = useMemo(() => createTranslator(locale), [locale]);
  const api = useMemo(() => apiProp ?? createOnboardingApi(marketId.toLowerCase()), [apiProp, marketId]);
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [online, setOnline] = useState(true);
  const [identity, setIdentity] = useState<Identity>(EMPTY_IDENTITY);
  const [sessionIdentity, setSessionIdentity] = useState<Identity | null>(null);
  const [idProblems, setIdProblems] = useState<IdentityProblem[]>([]);
  const [busy, setBusy] = useState<"create" | "bank" | "submit" | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [progress, setProgress] = useState<Partial<Record<DocType, number>>>({});
  const [docErrors, setDocErrors] = useState<Partial<Record<DocType, MessageKey>>>({});
  const [iban, setIban] = useState("");
  const [accountName, setAccountName] = useState("");
  const [bankProblem, setBankProblem] = useState<"iban" | "name" | null>(null);
  const [last4, setLast4] = useState<string | null>(null);
  const [submitGaps, setSubmitGaps] = useState<readonly string[]>([]);

  const refresh = useCallback(async () => {
    const r = await api.get();
    if (r.ok) setLoad({ kind: "ready", data: r.data });
    else if (r.status === 404) setLoad({ kind: "none" });
    else setLoad({ kind: "error", f: r });
  }, [api]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    setOnline(typeof navigator === "undefined" ? true : navigator.onLine);
    const on = (): void => { setOnline(true); };
    const off = (): void => { setOnline(false); };
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  const create = useCallback(async () => {
    const problems = identityProblems(identity);
    setIdProblems(problems);
    if (problems.length > 0 || identity.governorate === "") return;
    setBusy("create");
    setFailure(null);
    const r = await api.start({
      legal_type: identity.legalType,
      legal_name_ar: identity.nameAr.trim(),
      ...(identity.nameEn.trim() === "" ? {} : { legal_name_en: identity.nameEn.trim() }),
      commercial_register_no: identity.register.trim(),
      tax_card_no: identity.tax.trim(),
      governorate_code: identity.governorate,
      governorate_name_ar: createTranslator("ar-EG")(governorateKey(identity.governorate)),
    });
    setBusy(null);
    if (!r.ok) {
      setFailure(r);
      return;
    }
    setSessionIdentity(identity);
    await refresh();
  }, [api, identity, refresh]);

  const onFile = useCallback(
    (type: DocType, file: File) => {
      const bad = validDocumentFile(file);
      if (bad !== null) {
        setDocErrors((e) => ({ ...e, [type]: bad === "type" ? "seller.kyc.docs.err.type" : "seller.kyc.docs.err.size" }));
        return;
      }
      setDocErrors((e) => ({ ...e, [type]: undefined }));
      setProgress((p) => ({ ...p, [type]: 0 }));
      void (async () => {
        const r = await api.uploadDocument(type, file, (f) => { setProgress((p) => ({ ...p, [type]: f })); });
        setProgress((p) => ({ ...p, [type]: undefined }));
        if (!r.ok) {
          setDocErrors((e) => ({ ...e, [type]: r.status === 0 ? "seller.kyc.docs.err.network" : DOC_ERRORS(r.status) }));
          if (r.status === 401 || r.status === 403) setFailure(r);
          return;
        }
        await refresh();
      })();
    },
    [api, refresh],
  );

  const saveBank = useCallback(async () => {
    if (!ibanValid(iban)) {
      setBankProblem("iban");
      return;
    }
    if (accountName.trim() === "") {
      setBankProblem("name");
      return;
    }
    setBankProblem(null);
    setBusy("bank");
    setFailure(null);
    const r = await api.setBank(normalizeIban(iban), accountName.trim());
    setBusy(null);
    if (!r.ok) {
      setFailure(r);
      return;
    }
    setLast4(r.data.iban_last4);
    setIban("");
    await refresh();
  }, [accountName, api, iban, refresh]);

  const submit = useCallback(async () => {
    setBusy("submit");
    setFailure(null);
    setSubmitGaps([]);
    const r = await api.submit();
    setBusy(null);
    if (r.ok) {
      setLoad({ kind: "ready", data: r.data });
      return;
    }
    if (r.status === 422) setSubmitGaps(r.reasons);
    setFailure(r);
  }, [api]);

  const shown = load.kind === "ready" ? sessionIdentity : identity;
  const data = load.kind === "ready" ? load.data : null;
  const canEdit = data !== null && editable(data.status);
  const problemFor = failure === null ? null : failure.status === 422 && failure.code === "signatory-under-21" ? "under21" : failure.status === 409 ? "conflict" : failure.status === 422 ? "incomplete" : null;

  return (
    <div className="wizard onboarding">
      <header className="wizardHead">
        <h1 className="pageTitle">{t("seller.kyc.title")}</h1>
        <p className="lead">{t("seller.kyc.lead")}</p>
      </header>
      {online ? null : (
        <div className="banner" role="alert" data-code="offline">
          <p>{t("seller.kyc.offline")}</p>
        </div>
      )}
      {failure === null ? null : problemFor === null ? (
        failure.status === 0 ? (
          <div className="banner" role="alert" data-code="network">
            <p>{t("seller.kyc.error.network")}</p>
          </div>
        ) : (
          <ProblemBanner t={t} code={failure.code} status={failure.status} />
        )
      ) : (
        <div className="banner" role="alert" data-code={failure.code}>
          <p>{problemFor === "under21" ? t("seller.kyc.error.under21", { age: SIGNATORY_MIN_AGE }) : problemFor === "conflict" ? t("seller.kyc.error.conflict") : t("seller.kyc.error.incomplete")}</p>
          {submitGaps.length > 0 ? (
            <ul>
              {submitGaps.map((g) => {
                const k = gapKey(g);
                return <li key={g}>{k.doc === undefined ? t(k.key) : t(k.key, { doc: t(docKey(k.doc)) })}</li>;
              })}
            </ul>
          ) : null}
        </div>
      )}
      {load.kind === "loading" ? (
        <p role="status" aria-busy="true" className="empty">
          {t("seller.kyc.loading")}
        </p>
      ) : load.kind === "error" ? (
        <div className="empty">
          <ProblemBanner t={t} code={load.f.code} status={load.f.status} />
          <button type="button" className="btn btnSecondary" onClick={() => { setLoad({ kind: "loading" }); void refresh(); }}>
            {t("seller.kyc.retry")}
          </button>
        </div>
      ) : (
        <div className="wizardGrid">
          <div className="stepForm">
            {data === null ? (
              <>
                <div className="empty">
                  <h2 className="panelTitle">{t("seller.kyc.empty.title")}</h2>
                  <p>{t("seller.kyc.empty.body")}</p>
                </div>
                <IdentityForm
                  locale={locale}
                  value={identity}
                  problems={idProblems}
                  busy={busy === "create"}
                  onChange={(patch) => { setIdProblems([]); setIdentity((cur) => ({ ...cur, ...patch })); }}
                  onSubmit={() => void create()}
                />
              </>
            ) : (
              <>
                <KycStatus locale={locale} state={data.status} gaps={data.gaps} reason={data.decision_reason} />
                {canEdit ? null : <p className="hint">{t("seller.kyc.locked")}</p>}
                <DocumentsPanel locale={locale} gaps={data.gaps} required={data.required_documents} disabled={!canEdit} progress={progress} errors={docErrors} onFile={onFile} />
                <BankForm
                  locale={locale}
                  iban={iban}
                  name={accountName}
                  hasAccount={!data.gaps.includes("bank_account")}
                  last4={last4}
                  problem={bankProblem}
                  busy={busy === "bank"}
                  disabled={!canEdit}
                  onChange={(p) => { setBankProblem(null); if (p.iban !== undefined) setIban(p.iban); if (p.name !== undefined) setAccountName(p.name); }}
                  onSave={() => void saveBank()}
                />
                <section className="stepBody" aria-labelledby="review-title">
                  <h2 id="review-title" className="panelTitle">
                    {t("seller.kyc.review.title")}
                  </h2>
                  {data.gaps.length === 0 ? (
                    <p className="success">{t("seller.kyc.review.ready")}</p>
                  ) : (
                    <div className="blocked">
                      <p>{t("seller.kyc.review.gaps")}</p>
                      <ul>
                        {data.gaps.map((g) => {
                          const k = gapKey(g);
                          return <li key={g}>{k.doc === undefined ? t(k.key) : t(k.key, { doc: t(docKey(k.doc)) })}</li>;
                        })}
                      </ul>
                    </div>
                  )}
                  <div className="footer">
                    <button type="button" className="btn btnPrimary" disabled={!canEdit || busy === "submit" || data.gaps.length > 0} onClick={() => void submit()}>
                      {busy === "submit" ? t("seller.kyc.submitting") : t("seller.kyc.submit")}
                    </button>
                  </div>
                </section>
              </>
            )}
          </div>
          <div className="side">
            <LegalIdentityPreview locale={locale} identity={shown} />
          </div>
        </div>
      )}
    </div>
  );
}
