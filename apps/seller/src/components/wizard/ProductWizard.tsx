"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createTranslator, localeSegment, type Locale, type MessageKey } from "@outlet/i18n";
import { createSellerApi, type ApiFailure, type AttributeSetWire, type CategoryWire, type ProductWire, type SellerApi } from "../../client/seller-api";
import { DraftSaver } from "../../lib/draft-saver";
import {
  EMPTY_STATE,
  STEPS,
  reasonKey,
  stepProblems,
  validPhotoFile,
  type RequiredAttribute,
  type Slot,
  type StepId,
  type StepProblem,
  type WizardState,
} from "../../lib/wizard-model";
import { stateFromProduct } from "../../lib/product-state";
import { useSaveStatus } from "../SaveStatus";
import { ProblemBanner } from "../ProblemBanner";
import { BuyerPreview } from "./BuyerPreview";
import { DetailsStep } from "./DetailsStep";
import { PhotosStep } from "./PhotosStep";
import { PriceStep } from "./PriceStep";
import { ReadinessChecklist } from "./ReadinessChecklist";
import { ReviewStep } from "./ReviewStep";

const STEP_KEYS: Readonly<Record<StepId, MessageKey>> = { 1: "seller.step.photos", 2: "seller.step.details", 3: "seller.step.price", 4: "seller.step.review" };
const PROBLEM_KEYS: Readonly<Record<StepProblem, MessageKey>> = {
  category: "seller.reason.CATEGORY_REQUIRED",
  mainPhoto: "seller.reason.MAIN_PHOTO_REQUIRED",
  defectPhoto: "seller.reason.CONDITION_PHOTO_REQUIRED",
  defectType: "seller.problem.defectType",
  defectLocation: "seller.problem.defectLocation",
  notes: "seller.problem.notes",
  name: "seller.reason.TITLE_AR_REQUIRED",
  description: "seller.reason.DESCRIPTION_AR_REQUIRED",
  attributes: "seller.reason.ATTRIBUTES_INCOMPLETE",
  price: "seller.price.invalid",
};

const readAsDataUrl = (file: File): Promise<string | undefined> =>
  new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => { resolve(typeof r.result === "string" ? r.result : undefined); };
    r.onerror = () => { resolve(undefined); };
    r.readAsDataURL(file);
  });

export interface ProductWizardProps {
  readonly locale: Locale;
  readonly marketId: string;
  /** Present when editing an existing listing (loaded by the server page). */
  readonly product?: ProductWire;
  /** Test seam: defaults to the BFF client. */
  readonly api?: SellerApi;
  readonly debounceMs?: number;
}

export function ProductWizard({ locale, marketId, product, api: apiProp, debounceMs }: ProductWizardProps) {
  const t = useMemo(() => createTranslator(locale), [locale]);
  const api = useMemo(() => apiProp ?? createSellerApi(marketId.toLowerCase()), [apiProp, marketId]);
  const save = useSaveStatus();
  const initialState = useMemo(() => (product === undefined ? EMPTY_STATE : stateFromProduct(product)), [product]);
  const [state, setState] = useState<WizardState>(initialState);
  const [step, setStep] = useState<StepId>(1);
  const [productId, setProductId] = useState<string | undefined>(product?.id);
  const [reasons, setReasons] = useState<string[] | null>(null);
  const [failure, setFailure] = useState<{ code: string; status: number } | null>(null);
  const [categories, setCategories] = useState<CategoryWire[]>([]);
  const [attributeSet, setAttributeSet] = useState<AttributeSetWire | null>(null);
  const [problems, setProblems] = useState<StepProblem[]>([]);
  const [progress, setProgress] = useState<Partial<Record<Slot, number>>>({});
  const [photoError, setPhotoError] = useState<Partial<Record<Slot, MessageKey>>>({});
  const [published, setPublished] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [conflict, setConflict] = useState(false);

  const defs: readonly RequiredAttribute[] = useMemo(() => (attributeSet?.attributes ?? []).map((a) => ({ code: a.code, dataType: a.data_type, required: a.required })), [attributeSet]);
  const defsRef = useRef(defs);
  defsRef.current = defs;
  const stateRef = useRef(state);
  stateRef.current = state;
  const touched = useRef(false);

  const [saver] = useState(
    () =>
      new DraftSaver(
      api,
      {
        status: (s) => {
          save.set(s);
        },
        reasons: setReasons,
        failure: (f: ApiFailure) => { setFailure({ code: f.code, status: f.status }); },
        conflict: (p) => {
          setConflict(true);
          setState((cur) => ({ ...stateFromProduct(p), photos: cur.photos }));
        },
        draftCreated: setProductId,
      },
        { ...(debounceMs === undefined ? {} : { debounceMs }), ...(product === undefined ? {} : { initial: { product, state: initialState, defs: [] } }) },
      ),
  );
  useEffect(() => () => { saver.dispose(); }, [saver]);

  // reference data
  useEffect(() => {
    let live = true;
    void api.categories().then((r) => {
      if (live && r.ok) setCategories(r.data);
    });
    return () => {
      live = false;
    };
  }, [api]);
  useEffect(() => {
    if (state.categoryId === "") {
      setAttributeSet(null);
      return;
    }
    let live = true;
    void api.attributeSet(state.categoryId).then((r) => {
      if (live && r.ok) setAttributeSet(r.data);
    });
    return () => {
      live = false;
    };
  }, [api, state.categoryId]);
  // readiness for an existing listing on first render
  useEffect(() => {
    if (product === undefined) return;
    void api.readiness(product.id).then((r) => {
      if (r.ok) setReasons(r.data.blocked_reasons);
    });
  }, [api, product]);

  const change = useCallback(
    (patch: Partial<WizardState>) => {
      setProblems([]);
      touched.current = true;
      const next = { ...stateRef.current, ...patch };
      stateRef.current = next;
      setState(next);
      saver.update(next, defsRef.current);
    },
    [saver],
  );
  // re-evaluate the debounced save when the attribute set arrives (details may become complete)
  useEffect(() => {
    if (attributeSet !== null && touched.current) saver.update(stateRef.current, defs);
  }, [attributeSet, defs, saver]);

  const onFile = useCallback(
    (slot: Slot, file: File) => {
      const bad = validPhotoFile(file);
      if (bad !== null) {
        setPhotoError((e) => ({ ...e, [slot]: bad === "type" ? "seller.photos.err.type" : "seller.photos.err.size" }));
        return;
      }
      setPhotoError((e) => ({ ...e, [slot]: undefined }));
      void (async () => {
        const id = await saver.ensureDraft(stateRef.current);
        if (id === null) {
          setPhotoError((e) => ({ ...e, [slot]: "seller.photos.needDraft" }));
          return;
        }
        setProgress((p) => ({ ...p, [slot]: 0 }));
        const [preview, up] = await Promise.all([readAsDataUrl(file), api.upload(id, slot === "defect" ? "defect" : "product", file, (f) => { setProgress((p) => ({ ...p, [slot]: f })); })]);
        setProgress((p) => ({ ...p, [slot]: undefined }));
        if (!up.ok) {
          const key: MessageKey = up.status === 413 ? "seller.photos.err.size" : up.status === 503 ? "seller.photos.err.unavailable" : up.status === 422 ? "seller.photos.err.rejected" : "seller.photos.err.generic";
          setPhotoError((e) => ({ ...e, [slot]: key }));
          if (up.status !== 413 && up.status !== 422 && up.status !== 503) setFailure({ code: up.code, status: up.status });
          return;
        }
        change({ photos: { ...stateRef.current.photos, [slot]: { mediaId: up.data.media_id, name: file.name, ...(preview === undefined ? {} : { previewUrl: preview }) } } });
      })();
    },
    [api, change, saver],
  );
  const onRemove = useCallback(
    (slot: Slot) => {
      change({ photos: Object.fromEntries(Object.entries(stateRef.current.photos).filter(([k]) => k !== slot)) });
    },
    [change],
  );

  const goto = useCallback(
    async (to: StepId) => {
      await saver.flush();
      setStep(to);
    },
    [saver],
  );
  const next = useCallback(() => {
    const found = stepProblems(step, state, defs);
    setProblems(found);
    if (found.length > 0) return;
    void goto(Math.min(4, step + 1) as StepId);
  }, [defs, goto, state, step]);

  const publish = useCallback(async () => {
    await saver.flush();
    const id = saver.productId;
    if (id === undefined) return;
    setPublishing(true);
    setFailure(null);
    const r = await api.publish(id, saver.version);
    setPublishing(false);
    if (r.ok) {
      setPublished(true);
      setReasons([]);
      return;
    }
    if (r.code === "activation-blocked") setReasons([...r.reasons]);
    else setFailure({ code: r.code, status: r.status });
  }, [api, saver]);

  const base = `/${localeSegment(marketId, locale)}`;
  const grade = state.condition;
  return (
    <div className="wizard" data-grade={grade}>
      <header className="wizardHead">
        <h1 className="pageTitle">{product === undefined ? t("seller.wizard.title") : t("seller.wizard.edit")}</h1>
        <p className="lead">{t("seller.wizard.subtitle")}</p>
        <nav aria-label={t("seller.wizard.steps")}>
          <ol className="steps">
            {STEPS.map((s) => (
              <li key={s} {...(s === step ? { "aria-current": "step" as const } : {})} data-done={s < step}>
                <span className="stepNum">{s}</span> {t(STEP_KEYS[s])}
              </li>
            ))}
          </ol>
        </nav>
        <p className="hint">{t("seller.step.progress", { current: step, total: STEPS.length })}</p>
      </header>
      {failure === null ? null : <ProblemBanner t={t} code={failure.code} status={failure.status} />}
      {conflict ? (
        <div className="banner" role="alert">
          <p>{t("seller.error.conflict")}</p>
          <button type="button" className="btn btnGhost" onClick={() => { setConflict(false); }}>
            {t("seller.error.dismiss")}
          </button>
        </div>
      ) : null}
      <div className="wizardGrid">
        <form
          className="stepForm"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (step < 4) next();
            else void publish();
          }}
        >
          {step === 1 ? <PhotosStep locale={locale} state={state} categories={categories} attributeSet={attributeSet} progress={progress} photoError={photoError} onChange={change} onFile={onFile} onRemove={onRemove} /> : null}
          {step === 2 ? <DetailsStep locale={locale} state={state} attributeSet={attributeSet} onChange={change} /> : null}
          {step === 3 ? <PriceStep locale={locale} state={state} onChange={change} /> : null}
          {step === 4 ? <ReviewStep locale={locale} hasDraft={productId !== undefined} reasons={reasons} published={published} listHref={`${base}/products`} onFix={(s) => void goto(s)} /> : null}
          {problems.length === 0 ? null : (
            <div role="alert" className="problems">
              <p>{t("seller.problem.title")}</p>
              <ul>
                {problems.map((p) => (
                  <li key={p}>{t(PROBLEM_KEYS[p])}</li>
                ))}
              </ul>
            </div>
          )}
          <p className="hint autosaveNote">{t("seller.autosave.note")}</p>
          <div className="footer">
            {step > 1 ? (
              <button type="button" className="btn btnGhost" onClick={() => void goto(Math.max(1, step - 1) as StepId)}>
                {t("seller.actions.back")}
              </button>
            ) : (
              <Link className="btn btnGhost" href={`${base}/products`}>
                {t("seller.review.viewList")}
              </Link>
            )}
            <button type="button" className="btn btnSecondary" onClick={() => void saver.flush()}>
              {t("seller.actions.saveDraft")}
            </button>
            {step < 4 ? (
              <button type="submit" className="btn btnPrimary">
                {step === 3 ? t("seller.actions.continueReview") : t("seller.actions.continue")}
              </button>
            ) : (
              <button type="submit" className="btn btnPrimary" disabled={publishing || productId === undefined || published}>
                {publishing ? t("seller.actions.publishing") : t("seller.actions.publish")}
              </button>
            )}
          </div>
        </form>
        <div className="side">
          <BuyerPreview locale={locale} state={state} />
          <ReadinessChecklist locale={locale} reasons={reasons} />
          {reasons !== null && reasons.length > 0 && step < 4 ? <p className="hint">{t(reasonKey(reasons[0] ?? ""))}</p> : null}
        </div>
      </div>
    </div>
  );
}
