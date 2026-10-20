# AI features (wardrobe, stylist, seller copilot, forecasting, anomaly, reports) under PDPL and LLM safety

Labels: DOCUMENTED = web source (URL). REPO = path in /Users/nadakhalifa/OUTLET. INFERENCE = mine. About 14 tool calls used; web evidence is mostly secondary (search snippets, not full-page reads).

## Wardrobe digitisation and outfit-from-history stylist

### Takeaway
Industry peers digitise wardrobes from flat photos with auto background removal and tagging (often error-prone), and generate outfits mostly by rules/randomisation plus embeddings. Z-OUTLET already has the modules built behind fakes; the gating items are the vision vendor, image bucket and consent/residency decisions, not code.

### Cited Findings
- Zalando size advice: item-level size flags from brand measurements, returns history and fitting models; size-related returns down 10% vs items without advice — [Zalando](https://corporate.zalando.com/en/node/10416)
- Zalando photo-measurement (July 2023, DACH, women's tops/dresses): two photos, measurements predicted, photos deleted, none leaves the phone — [The Industry Fashion](https://www.theindustry.fashion/zalando-launches-size-advice-based-on-customers-own-body-measurements/); [Zalando](https://corporate.zalando.com/en/node/10477)
- Whering: photo import, auto background removal and category/colour tagging (reviewers say tagging often wrong; weak crop with no manual cleanup), "Dress Me" outfit generation described as randomised or quiz/weather-informed (sources disagree), cost-per-wear, calendar planning, some AI actions paid — [Stork profile](https://www.stork.ai/en/whering), [Indyx comparison](https://myindyx.com/versus/whering-vs-cladwell)
- Amazon Echo Look / Style Check was shut down 24 July 2020; Amazon said Style by Alexa moved into the Shopping app — [TechRadar](https://www.techradar.com/news/amazon-is-discontinuing-its-echo-look-fashion-advice-gadget). Search found nothing on its privacy handling.
- Stitch Fix latent style/size, Pinterest Complete the Look (CVPR 2019; KDD 2020 bootstrapping) are cited in the spec; I did NOT re-verify them this pass — spec lists [Pinterest CVPR](https://openaccess.thecvf.com/content_CVPR_2019/papers/Kang_Complete_the_Look_Scene_Based_Complementary_Product_Recommendation_CVPR_2019_paper.pdf), [Stitch Fix](https://multithreaded.stitchfix.com/blog/2018/06/28/latent-style/)
- REPO: modules exist in apps/api/src/modules: stylist (incl. chat, golden tests), wardrobe, outfit-calendar, visual-search, recommendations, ranking, sizing, llm-gateway, forecasting. docs/plan/status-2026-10.md: "Stylist chat, outfit calendar, wardrobe, demand forecasting, ranking v2" built, tested with fakes, composed; blocked by ADR-0025 / VR-P3-15 (chat), VR-P3-13 (wardrobe vision). Visual search is NOT composed (embedder, object store, classifier, index, consent port unbound).
- REPO: wardrobe/adapters/unconfigured.ts: image store and vision port fail closed (503), "no vision vendor is contracted (VR-P3-13)"; vision port carries `residency: "in_region"`. Kill switches present in code: kill.stylist_llm, kill.stylist_ml, kill.stylist_chat, kill.wardrobe, kill.wardrobe_vision, kill.ml_ranking, kill.llm_search_parse, kill.demand_forecasting.
- REPO: apps/ml-services contains only `bg-removal` (Dockerfile, models.lock.json, MODEL_LICENSES.md); no stylist/embedding service exists there.
- REPO: ADR-0023 (Proposed): pgvector HNSW on a dedicated read replica for 768-d SigLIP/CLIP embeddings, SQL-applied filters, DSAR deletion simple; revisit at p95 > 50 ms at 500k vectors.
- Spec §11/§28: personalisation via style vector outside the LLM; beam search width 50 with budget bound; price never LLM-generated; wardrobe digitisation Phase 3, photos treated as P2 and user-deletable.

### Inferences
- At small scale, co-purchase/collaborative signals are too sparse; compatibility from embeddings plus category/colour/formality rules (spec's choice) is the right cold-start, with explicit swap/like feedback updating a per-user vector. Evaluate offline with a hand-labelled Egyptian outfit set (spec-style golden sets), then online add-to-bag and swap rate; do not claim accuracy figures until measured.
- Purchase/browse history should feed only an in-house style vector; the LLM should see labels (occasion, size label, budget band), per ADR-0025.

### Gaps
- No verified technical documentation for Stylebook, Cladwell, Acloset, Google style products found. No benchmark numbers for CLIP/SigLIP on Arabic-market fashion.
- Whether the repo style vector actually consumes browse history, and its consent gating, not verified (did not read stylist domain code).

## Seller copilot

### Takeaway
Shopify and Amazon ship drafting plus analytics Q&A with human confirmation on actions; this is the pattern to copy. In the repo no seller-copilot module exists (only spec mention); the building blocks (llm-gateway, seller-analytics, price-integrity) do.

### Cited Findings
- Shopify Sidekick: drafts product descriptions in context, bulk collection edits with preview before applying, plain-language analytics via admin API calls; weak on predictive/cohort analysis; won't refund without confirmation (third-party blogs, not Shopify docs) — [Strix](https://www.strix.net/en/insights/blog/what-can-shopify-sidekick-actually-do), [Mesa](https://www.getmesa.com/blog/shopify-sidekick)
- Amazon Seller Assistant (agentic, Sept 2025): flags slow-moving stock, recommends markdown/remove, demand-pattern shipment suggestions; sellers choose recommend-only or act-with-approval; approval requirements and audit trails; built on Bedrock (Nova, Claude); 1.3M sellers used genAI listing tools generating ~70% of a listing — [Exchange4media](https://www.exchange4media.com/digital-news/amazon-unveils-ai-powered-seller-assistant-with-agentic-capabilities-147575.html), [PYMNTS](https://www.pymnts.com/amazon/2025/amazon-expands-seller-assistant-with-agentic-ai-to-become-always-on-partner/), primary: [aboutamazon](https://www.aboutamazon.com/md/news/innovation-at-amazon/seller-assistant-agentic-ai) (not fetched)
- REPO/spec: §19.1 markdown advice must state the new price will not show "% off" unless verified; §28 #15 copilot P2 (listing score, photo tips, Q&A drafts, seller sends); Arabic title/description mandatory, seller approves. Price-integrity (VRP) module exists (packages/domain/src/price-integrity), so a markdown tool can call it to preview the claim outcome.

### Inferences
- Copilot output types should be drafts/recommendations only; price change and message send require explicit seller action through existing authenticated endpoints (LLM06). Markdown tool: show elasticity-based suggestion plus "no % off will be displayed" computed from VRP, never from the model.

### Gaps
- Noon tools: nothing found. Shopify Magic and Amazon primary pages not read. No Egyptian-market seller-AI examples.

## Demand forecasting and anomaly detection at small scale

### Takeaway
The repo already implements a conservative design: ETS plus Croston-SBA, served only if beating a baseline, nominal 80% interval, insufficient-history refusals and k-anonymity. Anomaly detection has no dedicated module found.

### Cited Findings
- Croston-SBA smooths size and interval separately; original Croston biased upward, SBA applies (1 - alpha/2) correction; forecast flat over horizon; ADI/CV2 used to classify intermittency — [Nixtla statsforecast](https://nixtlaverse.nixtla.io/statsforecast/docs/models/crostonsba.html), [MetricGate](https://metricgate.com/calculator/syntetos-boylan-approximation) (vendor, weaker)
- REPO: packages/domain/src/forecasting: candidates `ets_seasonal` and `croston_sba` for intermittent series, "served only when it beats [the baseline]"; NOMINAL_COVERAGE 8000 bps; BACKTEST_MIN_TRAIN_DAYS 14; MIN_OBSERVED_DAYS, MIN_COMPARABLE_UNITS, FORECAST_K_MIN constants; reconcileTopDown for hierarchy; scopes sku/category/category_size/category_governorate; ingest schema strict (rejects user_id, measurements, budget); fraud-flagged orders must be excluded (apps/api/src/modules/forecasting/domain/ports.ts).
- REPO: no module named anomaly found; "anomal" matches only auto-buy, payments, money-wiring, production/bindings (not confirmed as detectors). Spec mentions anomaly alerts on KPIs (§23) and price-anomaly isolation forest (§9.4).

### Inferences
- With sparse SKU data, forecast at category/size level and shrink SKU to parent (the repo's top-down reconcile does this); report intervals as nominal, check empirical coverage in backtest. Prophet/LightGBM add little below hundreds of days of history; robust z-score/STL residual with weekly seasonality and a persistence rule (N consecutive breaches), per-metric cooldown and daily digest limit alert fatigue. Money anomalies (refund, payout, ledger drift) should be deterministic reconciliation rules, not ML.

### Gaps
- No source retrieved for minimum history, hierarchical shrinkage, Prophet, STL or isolation-forest guidance (search returned only Croston pages). Repo constant values (MIN_OBSERVED_DAYS etc.) not read.

## PDPL 151/2020 and Executive Regulations 816/2025

### Takeaway
Secondary sources confirm licensing and a cross-border approval track but say nothing found on profiling/automated decisions; the repo's P0-only external LLM default is the conservative reading. Arabic primary text still unread.

### Cited Findings
- Regulations issued Nov 2025 (Decree 816/2025); one-year compliance window; general licences for controllers/processors typically valid three years; cross-border transfers need separate approval with destination, purpose, data categories, safeguards; one firm reports ~90 working days review; adequacy-oriented approach, SCC/BCR mentioned subject to approval — [CMS](https://cms.law/en/are/legal-updates/egypt-s-pdpl-executive-regulations-issued-one-year-compliance-countdown-begins), [Al Tamimi](https://www.tamimi.com/news/from-policy-to-practice-egypt-issues-executive-regulations-of-the-personal-data-protection-law), [Legal500 on transfers](https://www.legal500.com/guides/?p=140776)
- Spec §B1: consent purposes include personalization, analytics, measurements, cross_border_ml; no P2/P3 to external LLM/ML without consent and licence; DPIA for stylist/fit/budget/fraud models (T6); minors: no accounts under 18; retention for measurements until deletion.
- REPO: ADR-0025 Proposed (blocked on VR-02): option 1 external API with no P2/P3 (allow-listed fields: product data, occasion, size label, budget band; never phone, DOB, address, measurements, exact budget, names); default off in prod until DPO sign-off. ADR-0002 residency Proposed.

### Inferences
- Wardrobe photos are personal data of the user (possibly incl. faces/home backgrounds): process on-device or in-region (the vision port is typed `in_region`), strip EXIF, delete on request and on account deletion, retention tied to account, purpose-limited to wardrobe, separate consent. Using purchase/browsing history for stylist is profiling: needs personalization consent, an off switch (spec §13), and a DPIA; budget data stays excluded from ads/promotions. Copilot and weekly reports use aggregates only; k >= 50 for demographic cuts.

### Gaps
- Profiling/automated-decision, DPIA, minors and retention provisions of the regulations: not found in any source; official Arabic text not read. Whether a transfer licence is needed for P0 product text to a foreign LLM: not determined; needs counsel (VR-02).

## LLM safeguards

### Takeaway
The gateway already implements most T12 controls; remaining work is evals, human-in-the-loop UI for copilot actions and wiring a real provider.

### Cited Findings
- OWASP LLM Top 10 2025: LLM01 Prompt Injection, 02 Sensitive Info Disclosure, 03 Supply Chain, 04 Data/Model Poisoning, 05 Improper Output Handling, 06 Excessive Agency, 07 System Prompt Leakage, 08 Vector/Embedding Weaknesses, 09 Misinformation, 10 Unbounded Consumption; indirect injection via external content; multimodal hidden instructions — [AppScan list](https://help.hcl-software.com/appscan/Enterprise/10.10.0/topics/r_owasp_top_10_for_llm.html), [Invicti](https://invicti.com/blog/web-security/owasp-top-10-risks-llm-security-2025) (secondary; official genai.owasp.org not fetched)
- REPO: apps/api/src/modules/llm-gateway/domain: injection.ts (heuristics, LLM01), scrub.ts (PII, over-redacts, LLM02), breaker.ts (CostBreaker, hourly micro-EGP cap, LLM10), render.ts (delimited data envelope), prompts.ts (versioned schemas, Zod), error codes injection/budget_exceeded/breaker_open; in-memory adapters; stylist/adapters/gateway-chat.ts and gateway-llm.ts; stylist/chat.golden.test.ts.

### Inferences
- Multimodal wardrobe/listing images are an injection vector (hidden text); treat vision output as untrusted suggestions, validate against attribute enums. Seller text (titles, Q&A) is untrusted: delimited, scrubbed of contact fields. Weekly VoC: aggregates computed in SQL first, LLM only narrates numbers passed in; verify numbers in output match inputs. Arabic and English golden sets per prompt change; Arabic injection phrasing and Franco-Arabic need own cases.

### Gaps
- No real provider contracted, so no measured Arabic quality or cost data. Whether golden sets exist in Arabic for all prompts not checked. A weekly-report/VoC generator module was not found in the repo (voc spec only in docs/haul-master-prompt-v3.md).
