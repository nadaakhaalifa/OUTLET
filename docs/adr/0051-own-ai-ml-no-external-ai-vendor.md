# ADR-0051: Own AI and ML, no external hosted AI vendor

- Status: **Proposed** (records a stated owner preference; not Accepted until the owner confirms the scope questions below and Legal/DPO confirm the residency consequences)
- Date: 2026-10-16
- Deciders: Owner, CTO, ML lead, DPO, Legal
- Spec refs: §11 (stylist), §28 (features 3, 4, 15), §T3 (ML services), §T12 (LLM platform rules), §B1 (PDPL, residency), §4 (NL search), §9.2 (product matching), §20.5 to §20.8 (ranking, recommendations, fraud, forecasting)
- Related: ADR-0002 (residency, Proposed), ADR-0023 (pgvector, Proposed), ADR-0025 (LLM provider, Proposed; this ADR proposes an amendment), ADR-0029 (Unconfigured fails closed, Accepted), ADR-0039 (on-device photo measurement), ADR-0040 (GCC), ADR-0043 (wardrobe)
- VERIFY rows: VR-02, VR-P2-08, VR-P2-12, VR-P3-06, VR-P3-13, VR-P3-15, VR-P3-BG-01..06, new VR-AI-01..VR-AI-06

## Context and problem statement

**Current default (ADR-0025, Proposed).** Option 1: an external hosted LLM API that receives only P0/P1 fields (catalog text, labels, bands), no user identifiers, through `llm-gateway`. Anything needing P2/P3 is blocked until VR-02 is Verified and `cross_border_ml` consent exists. LLM features are off in production until DPO sign-off. A self-hosted open-weights model in the ADR-0002 region was listed as option 3 and kept possible by the provider abstraction.

**What the owner wants.** Paraphrased: "I don't need any AI ready-made, I want to build my own." Read as: Z-OUTLET runs its own models (self-hosted or trained in-house) and does not depend on an external hosted AI vendor.

**What the repository already does (read 2026-10-16).**

| Capability | Today | Depends on an LLM? |
|---|---|---|
| NL search parsing | Deterministic Arabic/English/Franco rule parser (`packages/domain/src/search/parser.ts`, `arabic.ts`, `lexicon.ts`); optional LLM refiner (`llm-gateway/adapters/search-refiner.ts`, prompt `search_parse`, kill switch `kill.llm_search_parse`) that the search module already treats as optional | Optional only |
| Stylist outfits | Rules outfits plus a budget-constrained optimizer over embeddings (`stylist/application/generate.ts`, `fallbackReason` `ml_off`/`ml_down`/`no_embeddings`); LLM prompts `stylist_intent` and `stylist_rerank` give a mild re-rank on validated ids | Optional only |
| Stylist chat | Spec ships a rules intent matcher (keywords and slot forms) as the fallback; LLM path off pending VR-P3-15 | Yes for free conversation |
| Demand forecasting | `seasonal_naive`, `ets_seasonal`, `croston_sba` with backtests and intervals (`packages/domain/src/forecasting/models.ts`) | No |
| Ranking | `LinearRanker` baseline plus a tree evaluator for a GBDT behind a port, shadow runs (`packages/domain/src/ranking/`) | No |
| Product matching (§9.2) | GTIN, seller SKU, perceptual hash, embedding similarity, calibration (`packages/domain/src/price-matching/`) | Embeddings only |
| Fit | Size charts, item flags, latent size parameters (`packages/domain/src/sizing/`) | No |
| Visual search | Module built, `ImageEmbedderPort` with `residency: "in_region" \| "external"`, face-region masking; not composed (embedder unbound) | Needs an image embedding model |
| Wardrobe photo attributes | `UnconfiguredVision` (503) in production; manual add works | Needs a vision model |
| Background removal | Self-hosted Python service `apps/ml-services/bg-removal` with an allow-list of open-weights models and `MODEL_LICENSES.md`; external APIs (remove.bg and similar) explicitly not the default | Pretrained open weights, self-hosted |
| COD and fraud risk (§20.7) | Rules in the spec and `dpia-fraud.md`; no trained risk model found in the repository | No |
| Seller copilot, VoC summaries, AI bilingual copy | Spec only | Yes for generated text |

So most of the product already runs on rules and classical ML, and the only path in code that sends data to a third-party AI is the unbound `LlmProviderPort`. The precedent for the owner's direction already exists: background removal is self-hosted.

`docs/specs/algorithms/` exists but was empty when this ADR was written; this ADR does not depend on those drafts and should be cross-checked once they land.

## Decision drivers

1. **Residency and lawfulness (PDPL 151/2020, Decision 816/2025, full compliance by 1 Nov 2026).** No P2/P3 transfer without a licence and TIA. Note: self-hosting does not by itself mean "in Egypt". A model self-hosted in AWS `me-central-1` is in the same legal position as the primary database under ADR-0002 option B (needs the transfer licence). Self-hosting removes the extra vendor transfer, not the region question.
2. **Cost.** Per-call API fees versus fixed GPU/CPU capacity, MLOps staff time and evaluation labour.
3. **Control.** Model version pinning, no silent upstream changes, auditability of every model that touches a shopper.
4. **Latency.** Stylist p95 < 1.5 s, search p95 < 150 ms, visual search p95 < 1.2 s; in-region inference avoids a cross-region round trip.
5. **Quality at small data scale.** Launch has about 30 brands and no interaction history; models trained only on our own data will be weak at first. Classical methods with priors do better than deep models on little data.
6. **Team capacity.** The team size is open (open question 12). Every self-run model needs an owner for training, evaluation, serving, drift and incident response.
7. **Vendor lock-in.** Avoid dependence on one hosted provider's pricing, availability and data terms.
8. **Safety and OWASP LLM Top 10 2025.** Self-hosting moves LLM03 (supply chain), LLM04 (data and model poisoning) and LLM10 (unbounded consumption, now as our own capacity) onto us, while reducing LLM02 (sensitive information disclosure to a vendor).
9. **Licences.** "Open weights" is not one licence. Some carry use restrictions, attribution, user-count thresholds or non-commercial terms; training-data terms may also reach derived weights (already raised for background removal in VR-P3-BG-03).

## Considered options

### A. External hosted LLM and embedding APIs (current ADR-0025 option 1)
- Pros: best general language quality, especially open-ended Arabic chat; no GPU operations; pay per use, near-zero cost at low traffic; fastest to ship.
- Cons: contradicts the owner's stated preference; vendor DPA and transfer question for even P0 text (VR-P2-12) and user free text (VR-P3-15) and user photos (VR-P3-13); upstream model changes break golden sets; costs scale with traffic; lock-in.
- Cost honesty: low fixed cost, variable cost per token or image; vendor prices not verified here.

### B. Self-hosted open-weights models in the ADR-0002 region
- Pros: no third-party AI processor; version pinning; data stays in the approved region; enables chat, vision, visual search and copy generation.
- Cons: needs accelerator capacity in the chosen region. Whether an Egypt-hosted provider (ADR-0002 option A) offers GPUs with the needed reliability is **unverified** (new VR-AI-02). Serving, autoscaling, quantisation, patching and on-call become ours. Quality of open models in Egyptian Arabic and Franco-Arabic is unknown until we run our own golden sets. Licence review per model: **I could not verify the licence terms of any specific open-weights LLM or vision model in this session**; the only licences documented in the repository are the background-removal ones in `apps/ml-services/bg-removal/MODEL_LICENSES.md` (rembg code MIT, IS-Net weights licence unstated, BRIA RMBG non-commercial and excluded).
- Cost honesty: fixed cost for at least one always-on accelerator instance per serving environment for low-latency features, plus staging capacity for evaluation; the price in the chosen region must be quoted by the owner (not verified). Image embeddings for the catalog can run as CPU or batch jobs; conversational generation at interactive latency realistically needs a GPU (estimate, to be benchmarked).

### C. Fully in-house trained small models plus classical ML and rules, no pretrained third-party weights
- Pros: literal reading of "build my own"; no licence or supply-chain exposure from third-party weights; cheap to serve (CPU); fully explainable; already mostly built (parser, optimizer, ETS/Croston, linear ranker, latent size, matching by GTIN/hash).
- Cons: no realistic path to open-ended conversational chat, garment vision, visual search or fluent seller copy: training such models from scratch needs data volumes and compute the company does not have. It would also remove the already-built self-hosted background removal (pretrained weights) and the embedding signal in product matching. Quality at launch depends on hand-written rules and priors.
- Cost honesty: lowest infrastructure cost; main cost is labelling (fit feedback, return reasons, 2,000 match pairs for VR-13) and rule maintenance.

### D. Hybrid, phased: rules and classical ML now, self-hosted open-weights later, external AI vendors never for personal data
- Phase now (launch): everything that ships uses rules, classical statistics and models trained in-house on our own data (option C scope).
- Phase later: features that genuinely need a pretrained model (chat, vision, visual search, copy) run on self-hosted open-weights models in the ADR-0002 region, each admitted only after licence clearance, an eval gate and a model card. Fine-tuning on our own labelled data is how "our own" grows over time.
- External hosted AI vendors: never for P2/P3 and never for user free text or user photos. Whether they may be used at all, even for P0 catalog text, is the owner's call (open question 1); the recommended default is no binding at all, which matches the owner's statement.
- Pros: ships without any AI vendor or GPU; matches the owner's direction; keeps the high-value features possible; each step is reversible.
- Cons: chat, wardrobe vision, visual search and seller copilot arrive later and depend on GPU capacity in the region; the team must build MLOps before Phase 3 vision features.

| Criterion | A external | B self-hosted OSS | C in-house only | D phased hybrid |
|---|---|---|---|---|
| Complexity | Low | High | Low to medium | Medium now, high later |
| Accuracy at launch | High (language) | Medium to high, unmeasured in Egyptian Arabic | Medium for structured tasks, none for chat/vision | Same as C at launch, B later |
| Cost | Variable, low fixed | High fixed (GPU, MLOps) | Lowest | Lowest now, step up when vision ships |
| Scalability | Vendor-bound | Our capacity planning | Good (CPU) | Good, then capacity-planned |
| Residency risk | Highest (vendor transfer) | Same as primary DB | Same as primary DB | Same as primary DB |
| Fits owner direction | No | Yes | Yes (strict) | Yes |

## Decision (proposed)

**Option D.** Rules and in-house classical ML cover every launch feature already, so the owner's "build our own" costs nothing at launch; self-hosted open-weights models are admitted one by one, in-region, when a feature needs them and passes the gates below; no external AI vendor is bound for personal data, and by default for anything.

Concretely:
1. `LlmProviderPort`, `ImageEmbedderPort`, `VisionAttributePort` and `BackgroundRemovalPort` implementations must be **self-hosted in the ADR-0002 region** (`residency: "in_region"`). No `residency: "external"` adapter is written or bound unless a later ADR, approved by the owner and DPO, allows it.
2. The gateway keeps its P2/P3 refusal, scrubber, injection heuristics, breaker, cache and budgets unchanged. Self-hosting does not relax data minimisation: P3 still never enters a prompt (sizes as labels, budgets as bands), because the model service, its logs and its caches are another place personal data could leak.
3. "In-house" includes fine-tuning pretrained open weights on our own data, provided the base licence permits it (VR-AI-01). If the owner instead means "no pretrained third-party weights at all" (strict option C), the features listed under "wait" below are dropped, not delayed, and background removal must be retired.

## Consequences

**Rule-based or classical first (launch and Phase 2; mostly already built):**
- Search parsing: the deterministic AR/EN/Franco grammar and lexicon is the primary path; the LLM refiner stays unbound. Grammar gaps are found from `search_no_result` logs and fixed in the lexicon.
- Stylist: category templates, colour, formality, season and modesty rules, beam search with the knapsack budget bound; "compatibility" from in-house signals (curated outfits, co-purchase where it exists) and, once the catalog embedder is self-hosted, embeddings. The `stylist_intent` and `stylist_rerank` prompts stay unbound; intent comes from structured form fields.
- Stylist chat: the rules intent matcher and slot forms are the product, labelled honestly; no free conversation.
- Forecasting: seasonal naive, ETS seasonal, Croston SBA with backtests (as built).
- Ranking: linear baseline, then an in-house GBDT trained on our own events (the tree evaluator exists), with shadow runs.
- Fraud and COD risk: rules per §20.7 now, an in-house GBDT when there is enough labelled refusal and chargeback data (the DPIA in `docs/privacy/dpia-fraud.md` applies).
- Fit: size charts, Beta-Binomial item flags, latent size (as built).
- Product matching: GTIN, SKU, perceptual hash first; embeddings once self-hosted.
- VoC: topic counts, keyword and taxonomy tagging, sentiment from a small in-house classifier; no generated summary.
- Seller copy: structured templates and Arabic field validation; sellers write their own text.

**Waits for self-hosted open-weights models (Phase 3, each behind its existing kill switch, default blocked):**
- Conversational stylist chat (`stylist_chat`, `kill.stylist_llm`).
- Wardrobe photo-to-attribute vision (`wardrobe`, ADR-0043).
- Visual search image embedder (`visual_search`, ADR-0023).
- Catalog image and text embeddings for complete-the-look and similar items (CPU batch is likely enough; benchmark first).
- Seller copilot text, AI bilingual titles and descriptions, support reply suggestions, VoC summaries.

**Cost and staffing:** no GPU spend until the first "wait" feature is approved; then at least one accelerator per serving environment, an MLOps owner, an evaluation owner, and labelling budget. Unknown until the owner sets a GPU budget (open question 3).

**Bad:** the shopper experience at launch has no free-text chat and no photo features; Arabic language quality of self-hosted models is unproven; the team carries model operations that a vendor would otherwise carry.

## Proposed amendment to ADR-0025 (not applied)

ADR-0025 is left untouched: the ADR convention in `docs/adr/README.md` has no supersede or amend marker, and adding one to a Proposed record that another owner decision depends on should be the owner's call. If ADR-0051 is accepted, replace ADR-0025's "Decision (proposed default)" with:

> **Decision (amended by ADR-0051).** Option 3. The only permitted `LlmProviderPort` implementation is a self-hosted open-weights model served in the ADR-0002 region, admitted per model after licence clearance (VR-AI-01), an eval gate on the AR/EN golden sets, and a model card. Options 1 and 2 (external hosted APIs) are rejected; no external adapter is written or bound. The gateway's field allow-list, P2/P3 refusal, scrubber, injection heuristics, breaker, cache and per-user budgets remain mandatory for the self-hosted provider. Until a model is admitted, every LLM-backed feature runs its rule-based fallback, and LLM flags stay blocked in production until DPO sign-off.

and add to its header: `Amended by ADR-0051 (option 3 only; no external provider)`. VR-P2-12 and the external-vendor halves of VR-P3-13 and VR-P3-15 would then become moot rather than resolved; their rows should say so when the owner accepts, not before.

## What stays unchanged

- Kill switches and their blocked-by-default polarity (A2.12, ADR-0028): `kill.stylist_llm`, `kill.llm_search_parse`, `stylist_chat`, `visual_search`, `wardrobe`, `kill.background_removal`.
- ADR-0029: unbound ports stay `Unconfigured` and fail closed (503 `provider_not_configured`); a self-hosted model service that is not deployed is Unconfigured, not faked.
- No P2/P3 to any third party, ever, without consent and a licence; with this ADR, no third-party AI processor at all.
- Consent purposes are unchanged. `personalization`, `measurements`, `budget_insights` still gate what features may use. `cross_border_ml` stays in the vocabulary (ADR-0018) because it still matters if the ADR-0002 region is outside Egypt; it is never a licence to use an external vendor.
- Measurements and budgets never reach any model as raw values in prompts; on-device processing for body photos (ADR-0039).
- `llm-gateway` audit stores hashes and counters only; no raw P2 text.
- Rule-based fallbacks remain mandatory for every model-backed feature.

## Verification and rollout

Every model (in-house or open-weights) goes through the same ladder:
1. **Admission:** licence file archived and reviewed (VR-AI-01), training-data terms noted (VR-AI-04), weights pinned by SHA-256 like `models.lock.json`, SBOM entry, container signed (ADR-0015).
2. **Model card** in `docs/ml/model-cards/<model>.md` (directory to be created by the builder): purpose, base weights and licence, training data and its lawful basis, evaluation sets, metrics, known failure modes in Arabic and RTL, fairness slices (governorate, modest wear, size range), owner.
3. **Offline eval gate:** golden sets AR/EN/Franco per feature; the model must beat the rules fallback on the feature's primary metric (for example search filter exact-match, outfit validity 100% on budget and size constraints, visual search recall@K) with no regression on safety cases (injection, PII echo). Thresholds set in the feature spec, not here.
4. **Shadow mode:** run alongside rules on live traffic (ranking already has `ranking_shadow_runs`); compare, never serve.
5. **Canary** behind the feature flag (1% then 10% then 50% then 100%), guardrails: latency SLO, return rate, complaint rate, cost per call.
6. **Drift monitoring:** input distribution and output metrics per `model_version`; scheduled re-evaluation on the golden set; automatic fallback to rules when the breaker trips or drift crosses the threshold.
7. **DPIA update** for stylist, fit, fraud and budget (`docs/privacy/dpia-*.md`) whenever training starts using personal data.

## Open questions for the owner and counsel

1. **Scope of "ready-made".** Does the owner accept pretrained open-weights models that we run and fine-tune ourselves (option D, and the existing background-removal service), or only models trained from scratch (strict option C, which drops chat, vision, visual search and copilot text, and retires background removal)?
2. **External vendors for P0 catalog text.** Never (recommended default, matches the owner's statement), or allowed for non-personal catalog work only?
3. **GPU budget** per month and per environment, and whether a GPU exists at all in the chosen ADR-0002 region (VR-AI-02).
4. **Hosting region** (ADR-0002): self-hosting in a non-Egyptian region still needs the transfer licence for any personal data the model sees.
5. **Who trains, labels and owns models:** ML lead, labelling budget (fit feedback, 2,000 match pairs for VR-13, outfit validity, Arabic golden sets), on-call for model services.
6. **Training on personal data:** lawful basis and consent mapping for training on purchases, returns, fit feedback and chat (where saved); DPIA updates (VR-AI-03).
7. **Licences:** per-model licence and acceptable-use review by counsel before any weights are admitted (VR-AI-01, VR-AI-04).

## New VERIFY rows

Appended to `docs/compliance/verify-register.md` as series VR-AI (6 rows). Not duplicated: VR-02 (residency), VR-P2-08 (image matching IP), VR-P2-12 (external LLM DPA), VR-P3-06 (on-device pose model), VR-P3-13 (vision vendor), VR-P3-15 (chat to external LLM), VR-P3-BG-01..06 (background removal).

## Safe default if no answer

Option D's launch scope: rules and in-house classical ML only; every LLM and vision port Unconfigured in production; no external adapter written. This is what the code already does, so nothing changes until the owner answers.
