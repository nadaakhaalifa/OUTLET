# Algorithm specification: recommendations, AI stylist and wardrobe engine (in-house, in-region)

- Status: **Proposed** (architect draft, 2026-10-16). Documents only; no code was changed.
- Owner direction this spec implements: **built in-house. No external AI vendor (no hosted LLM, no embedding or vision API). No personal data leaves Egypt.** Only self-hosted open-weights models or models we train ourselves, running in the ADR-0002 region.
- Spec refs: master prompt §10, §11, §12, §13, §20.5, §20.6, §28 (rows 3, 4), §T6, §T12, §B1; Phase 2 specs 04 and 05; Phase 3 specs `stylist-chat.md`, `wardrobe.md`, `outfit-calendar.md`, `visual-search.md`, `ranking-v2.md`; ADR-0023, ADR-0025, ADR-0028, ADR-0029, ADR-0043; VR-02, VR-P3-13, VR-P3-15, VR-P3-BG-*.
- Code read for this spec: `packages/domain/src/stylist/*` (optimizer, compat, score, style-vector, capsule, validate), `packages/domain/src/recommendations/*`, `packages/domain/src/ranking/*`, `packages/domain/src/sizing/fit.ts`, `apps/api/src/modules/{stylist,wardrobe,outfit-calendar,recommendations,visual-search,llm-gateway}`, `apps/ml-services/bg-removal`.

**Conventions used throughout.**
- Every numeric parameter written as `p = value` is an **untuned inference** unless it is quoted from the master prompt (marked "spec"). Each one must be set from the offline evaluation in section 6 before launch and recorded in the model card.
- Money is integer piastres (`bigint` in TS, `BIGINT` in Postgres). Scores that order user-visible lists are integers (permille) as in the existing domain; floats are allowed only inside model inference and similarity, never for money.
- "Verified" literature citations give title, authors, venue and year. They are cited **from memory and were not re-fetched in this pass**, except the model licence facts in section 1.2, which were checked on the model cards on 2026-10-16. Section 9 lists what is unverified.

---

## 0. Summary of decisions

| Area | Chosen algorithm | Why (2-3 lines) |
|---|---|---|
| Image embedding | Self-hosted **SigLIP-family ViT-B/16** encoder (start with `google/siglip2-base-patch16-224`, Apache-2.0; challenger `Marqo/marqo-fashionSigLIP`, Apache-2.0), ONNX Runtime, int8 on CPU, stored as `halfvec` | Permissive weights, multilingual text tower (SigLIP 2), image and text in one space so text-to-image search and zero-shot labelling come free. CPU-servable at our catalogue size, so no GPU is needed for Phase A. |
| Text embedding | `intfloat/multilingual-e5-base` (MIT, 768-d, Arabic in its 100 languages) behind the existing Arabic normaliser and Franco transliteration | Small (XLM-R base), MIT, documented Arabic retrieval. BGE-M3 (MIT, 1024-d) is the challenger if Egyptian-dialect recall is weak. |
| Attributes | Calibrated **linear or small MLP heads on frozen embeddings**, trained on seller labels plus weak labels (Arabic/English title rules and zero-shot SigLIP prompts), with abstention | Cheap to train and serve, retrainable weekly, and it fails closed: "unknown" never counts as modest or harmonious. |
| Colour | Garment mask (existing bg-removal) -> **k-means++ in OKLab** -> canonical colour ids plus OKLCh hue-template harmony | Perceptually uniform space, deterministic with a fixed seed, and it explains itself ("beige is neutral"). |
| ANN | pgvector **HNSW** on the read replica, with **partial indexes per slot** and `iterative_scan` | Better recall/latency than IVFFlat without training, handles incremental inserts, and stays consistent with ADR-0023. |
| Recommenders | Staged: **content + popularity + cluster-level co-occurrence with shrinkage** at launch -> **EASE / iALS** -> **two-tower** -> **SASRec**, each promoted only by a data-volume gate plus an offline win plus an A/B | A new off-price marketplace is sparse and SKUs churn weekly. Content and cluster-level signals work from day one; heavier models only win once the data exists. |
| Outfit compatibility | Now: **rules + type-aware embedding similarity** (an upgrade of the current `pairCompat`). Later: a **learned pairwise model** (logistic/GBDT over pair features) trained on curated outfits, bootstrapped without user labels | It needs no labels today and becomes learned once about 2,000 in-house curated outfits exist. Explainable at the feature level. |
| Outfit search | **Beam search (width 50, spec) with a multiple-choice-knapsack LP bound** and a node-expansion budget. ILP is the offline oracle | Predictable latency and explainability. The MCKP bound is a real knapsack bound (the current bound ignores budget). Counting nodes instead of milliseconds makes results deterministic. |
| Outfit-set diversity | **MMR** with the hard ">= 2 slots differ" rule (spec) | We only pick 3-5 outfits from at most a few hundred, so a DPP adds cost without adding value. |
| Online style learning | **Bayesian linear preference model in a 32-d PCA style space** (Gaussian posterior), with Thompson-style exploration capped by the 5% exploration budget | Gives principled uncertainty, a cold-start prior from onboarding vibes, and bounded per-user state of 32 + 528 floats. It replaces the unweighted additive vector update. |
| Capsule | **Bundle-greedy plus 1-swap local search** online. **ILP (HiGHS)** offline as oracle and optional exact solver for small pools | The outfit-count objective is *not* submodular (a top is worth nothing without a bottom), so the current single-item greedy has no guarantee and stalls at zero gain. |
| Wardrobe | On-device crop -> in-region bg-removal -> garment-only stored image -> embed and attribute suggestion (user confirms) -> dedupe -> gap analysis by marginal-outfit gain | Personal photos are P2. Storing only the masked garment and keeping embeddings in a per-user table (not the shared index) minimises risk. |
| Chat | **Cascade: rules parser (exists) -> in-house intent/slot classifier on e5 embeddings -> optional self-hosted small open-weights LLM used only as a schema-constrained classifier**. Replies are always templates | It meets the owner's no-vendor rule. The model can only choose enums, so injection harm is bounded to misclassification. The LLM stage is optional and gated on an in-region GPU. |

---

## 1. Item representation (no external API)

### 1.1 Pipeline per product image version
```
seller image -> upload pipeline (type sniff, AV, EXIF strip; exists)
            -> bg-removal sidecar (u2netp default; exists, apps/ml-services/bg-removal)
            -> alpha mask M, garment bbox, crop with 4% margin
            -> (a) vision embedding  e_img  (section 1.2)
            -> (b) colour palette   P      (section 1.4)
            -> (c) attribute heads   A      (section 1.3) on e_img and e_txt
title_ar, title_en, description, seller attributes
            -> normalise (alef/ya/ta-marbuta folding, diacritics, Eastern digits; reuse chat normalizeText / search normaliser)
            -> text embedding e_txt (section 1.5)
write product_embeddings / product_attributes with model_version; outbox event embedding.updated
```
Computed once per `(product_id, image_version, model_version)`. Idempotent on that key. Re-embedding for a new model version is a backfill into a parallel column or index with dual reads until cutover (as `visual-search.md` already requires).

### 1.2 Vision-language embedding models (open weights, self-hosted)

| Candidate | Licence (checked on the model card, 2026-10-16) | Notes | Status |
|---|---|---|---|
| `google/siglip2-base-patch16-224` | Apache-2.0 | SigLIP 2, multilingual text tower (Gemma tokenizer, vocab 256,000 per config). Base ViT hidden size 768 per the Transformers default for the base config (confirm from the full config before indexing). | **Default candidate** |
| `Marqo/marqo-fashionSigLIP` | Apache-2.0 | Fine-tuned from ViT-B-16-SigLIP (WebLI) on fashion text fields. The card names **no training dataset** (only benchmark datasets). English-centric text tower. | **Challenger** (image-image similarity). Training-data terms: VERIFY |
| `facebook/dinov2-base` | Apache-2.0 | Self-supervised, image only (86.6M params). Strong for near-duplicate and visual similarity, no text tower. | Use for **dedupe/near-duplicate** and as a visual-similarity challenger |
| `laion/CLIP-ViT-B-32-laion2B-s34B-b79K` (OpenCLIP) | MIT tag, **but the card says "any deployed use case … is currently out of scope"** and does not recommend LAION-5B for industrial products | **Excluded** from production |
| `patrickjohncyh/fashion-clip` (FashionCLIP 2.0) | MIT tag. Version 2.0 is built on the LAION checkpoint above. Training set (Farfetch) "awaiting official release" | **Excluded** (inherits the LAION deployment caveat) |

Rules:
- Weights are pinned in a `models.lock.json` with `sha256` and both the code and weights licence, using the bg-removal pattern (`apps/ml-services/bg-removal/models.lock.json`, `MODEL_LICENSES.md`). The build fails on a null hash.
- **Training-data terms are open for every candidate.** SigLIP was trained on WebLI, which is not public; Marqo states no dataset. A permissive weights licence does not settle dataset terms (the same point as VR-P3-BG-03). New verify row VR-ML-01 (section 8).
- Model choice is made by the section 6 benchmark on a labelled Egyptian catalogue set, never from this table.

**Embedding definition.** For a product with images `x_1..x_m` (primary first; use at most 4):
```
v_k   = f_img(crop(x_k)) / ||f_img(crop(x_k))||_2
w_1   = 0.5, w_k = 0.5/(m-1) for k >= 2  (w_1 = 1 when m = 1)          [untuned]
e_img = normalise( sum_k w_k v_k )
```

**Fused retrieval vector** (similar items, candidate generation). The image and text spaces differ, so they are concatenated rather than averaged:
```
z = [ sqrt(omega) * e_img ; sqrt(1 - omega) * e_txt ]        ||z|| = 1
z_i . z_j = omega * cos(e_img_i, e_img_j) + (1 - omega) * cos(e_txt_i, e_txt_j)
omega = 0.7                                                     [untuned]
```
The dimension is 768 + 768 = 1536, which is at most 2,000, so it is indexable as `vector` or `halfvec` (pgvector limits, see 1.7). Option: index `e_img` alone (768) for visual search and `z` for "similar". Decide by benchmark; the default is both indexes, because visual search must match query photos that have no text.

**In-house fine-tuning (Phase B, optional).** Once at least 50,000 (image, Arabic or English title) catalogue pairs exist (untuned), fine-tune the image tower on our catalogue only (P0 data, never user photos) with the SigLIP sigmoid loss:
```
L = -(1/|B|) * sum_{i in B} sum_{j in B} log sigma( z_ij * ( t * x_i . y_j + b ) ),   z_ij = +1 if i = j else -1
```
t and b are learnt temperature and bias (Zhai et al., ICCV 2023). The gate for keeping a fine-tune is: recall@10 on the Egyptian labelled set improves by at least 2 points and zero-shot attribute macro-F1 does not drop by more than 1 point (untuned).

### 1.3 Attribute extraction by supervised classifiers

Targets are the closed vocabularies already in code (`wardrobe/domain/attributes.ts`, `stylist/types.ts`):

| Attribute | Type | Head |
|---|---|---|
| category / slot (top, bottom, dress, shoes, bag, accessory, outerwear) | single-label | softmax |
| colours (20 canonical ids) | multi-label | primarily from section 1.4; a sigmoid head is the fallback when no mask exists |
| pattern (solid, striped, floral, checked, printed, other) | single-label | softmax |
| formality 0..4 | ordinal | CORAL cumulative-logit head (Cao, Mirjalili, Raschka, "Rank consistent ordinal regression for neural networks…", Pattern Recognition Letters 2020) |
| seasons | multi-label | sigmoid |
| silhouette (fitted, straight, a-line, oversized, wide-leg, n/a) | single-label | softmax (new vocabulary; add to the Zod enums first) |
| coverage: sleeve, neckline, length | 3 single-label heads | softmax |
| material (cotton, linen, …) | single-label | softmax on `e_txt` + `e_img` (text dominates) |

**Model.** Input `h = [e_img ; e_txt]` (frozen). Each head is multinomial logistic regression or one hidden layer (256 units, untuned) with dropout. Linear probes are tried first; an MLP is used only if it beats the linear probe on macro-F1 by at least 2 points (untuned).

**Labels (no user data).**
1. Seller-entered attributes (noisy, but plentiful). The seller is untrusted, so these are treated as one labelling source, not ground truth.
2. Weak labelling functions (Ratner et al., "Snorkel: Rapid Training Data Creation with Weak Supervision", VLDB 2017):
   - Arabic/English/Franco keyword rules on normalised titles, e.g. `فستان|fostan|dress -> dress`, `مشجر|floral -> floral`, `كتان|linen -> linen`, `كم طويل|long sleeve -> sleeve=long`, `سواريه|soiree -> formality>=3`.
   - Zero-shot SigLIP: `argmax_c cos(e_img, T("a photo of a {c}"))` with bilingual prompt sets, accepted only when the margin between first and second is at least 0.05 (untuned).
   - Store-level priors (a lingerie store never emits "outerwear").
3. **Gold set.** 3,000 items labelled by in-house staff with double annotation and Cohen's kappa reported per attribute (untuned size). It is used only for evaluation and calibration, never for training.

Label aggregation: a weighted majority vote, with each source's weight learnt as `log(acc/(1-acc))` on the gold set (a Snorkel-style label model is the upgrade if the sources disagree in correlated ways).

**Calibration and abstention.** Temperature scaling per head (Guo et al., "On Calibration of Modern Neural Networks", ICML 2017), fitted on the gold set's calibration half:
```
p_c = softmax(logits / T)_c
emit c* = argmax p_c only if p_{c*} >= tau_attr(attribute)       tau_attr = 0.7  [untuned]
otherwise attribute = unknown
```
**Modest coverage is fail-closed.** An item is `modest_compliant` only if `P(sleeve >= elbow) >= 0.9`, `P(neckline != low) >= 0.9` and `P(length >= midi or n/a) >= 0.9` (untuned), **and** no seller field contradicts it. Otherwise it is excluded from modest mode. This matches `isModestCompliant` but adds a probability floor. A modest-mode false positive is a trust incident, so its precision target is at least 0.98 on the gold set (untuned) and recall is secondary.

**Seller loop.** Predicted attributes are shown in Seller Center as suggestions; the seller confirms or edits. Confirmed values override predictions for display. A disagreement between seller and model where the model probability is at least 0.95 goes into the catalogue-quality score, never into an automatic penalty.

### 1.4 Colour palette extraction and harmony

**Extraction** (deterministic, given a seed):
1. Pixels with alpha `M >= 0.5` from the bg-removal mask. Uniform subsample of at most 4,096 pixels with a seeded PRNG (seed = hash(product_id, image_version)).
2. Convert sRGB to linear: `c_lin = c/12.92` if `c <= 0.04045`, else `((c+0.055)/1.055)^2.4`.
3. Linear RGB to OKLab (Ottosson, "A perceptual color space for image processing", 2020, blog, not peer reviewed):
```
l = 0.4122214708 r + 0.5363325363 g + 0.0514459929 b
m = 0.2119034982 r + 0.6806995451 g + 0.1073969566 b
s = 0.0883024619 r + 0.2817188376 g + 0.6299787005 b
l', m', s' = cbrt(l), cbrt(m), cbrt(s)
L = 0.2104542553 l' + 0.7936177850 m' - 0.0040720468 s'
a = 1.9779984951 l' - 2.4285922050 m' + 0.4505937099 s'
b = 0.0259040371 l' + 0.7827717662 m' - 0.8086757660 s'
```
   The builder must copy the constants from the primary source and unit-test against its reference values. The constants above are from memory.
4. k-means++ (Arthur and Vassilvitskii, "k-means++: The Advantages of Careful Seeding", SODA 2007) with `k = 5`, at most 50 iterations, a fixed seed, on (L, a, b).
5. Drop clusters with mass below 5%. Merge centroids with `||Delta Lab|| < 0.04`. Keep the top 3 by mass (matches `palette.max(3)`).
6. Map each centroid to the nearest **canonical colour prototype** (the 20 ids in `COLOURS`) by Euclidean OKLab distance. Prototypes are means of gold-set swatches, re-fitted when the gold set grows. If the distance to the nearest prototype is above 0.12 (untuned), emit the nearest anyway but flag `colour_low_confidence`.
7. **On-model photos.** Skin and hair must not become "beige" or "brown". Do **not** use a skin-colour classifier, which is a fairness risk across skin tones. Use a garment-parsing segmentation mask where available. Where it is not, take the palette from the primary flat-lay or ghost image, and fall back to the seller colour field if every image is on-model. The fairness test set covers dark and light skin tones (as in visual-search.md).

**Harmony** (replaces the hand-written pair table, keeping it as a regression oracle). In OKLCh: `C = sqrt(a^2 + b^2)`, `h = atan2(b, a)` in degrees.
- A colour is **neutral** if `C < C_n` (C_n = 0.04, untuned), or if it is one of the canonical neutrals (black, white, grey, beige, navy, denim, cream, brown). Navy and denim are neutral by fashion convention, not by chroma.
- For two non-neutral colours with hue difference `d = min(|h1-h2|, 360-|h1-h2|)`:
```
H(d) = max_t  w_t * exp( -(d - mu_t)^2 / (2 sigma_t^2) )
templates t:  monochrome  mu=0,   sigma=12, w=0.85    (requires |L1-L2| >= 0.12, else w=0.6)
              analogous   mu=30,  sigma=12, w=0.80
              triadic     mu=120, sigma=15, w=0.70
              complementary mu=180, sigma=20, w=0.75
              (all untuned; template idea from Cohen-Or et al., "Color Harmonization", SIGGRAPH 2006, after Matsuda's hue templates)
harmony(c1, c2) = 1.0 if either neutral else H(d)
pair colour score (0..1000) = round(1000 * max_{x in P_a, y in P_b} mass_x * mass_y-weighted harmony)
```
- **Outfit-level palette rule.** At most 2 non-neutral hue families per outfit unless every pair scores at least 0.6, and at most one patterned item (non-solid) unless the two patterns are the same family (untuned). These are hard rules in modest and formal (formality >= 3) contexts, and soft penalties of -150 per violation (untuned) otherwise.
- **Regression gate.** The new `harmony` must agree with the current `HARMONY` table on at least 90% of its listed pairs (untuned), and every disagreement must be listed and approved by a stylist. This stops a silent behaviour change.

### 1.5 Text embeddings (Arabic and English)

| Candidate | Licence (checked) | Dim | Notes |
|---|---|---|---|
| `intfloat/multilingual-e5-base` | MIT | 768 | 100 languages from XLM-R, Arabic in Mr. TyDi (MRR@10 72.3 per card), 512-token limit, `query:`/`passage:` prefixes (Wang et al., "Multilingual E5 Text Embeddings: A Technical Report", arXiv 2024) |
| `BAAI/bge-m3` | MIT | 1024 | Larger, 100+ languages (Arabic not named on the card), dense+sparse+multi-vector (Chen et al., "BGE M3-Embedding…", arXiv 2024) |
| SigLIP 2 text tower | Apache-2.0 | 768 | Same space as the images; short captions only (64 tokens in SigLIP configs, VERIFY) |

**Default: multilingual-e5-base** for titles and descriptions, with the input built as
`"passage: " + normalise(title_ar) + " | " + normalise(title_en) + " | " + attribute words in AR and EN`. Franco-Arabic queries go through the existing transliteration before embedding. **Unverified:** Egyptian dialect and Franco quality of both models. The gate is recall@10 on 500 Egyptian query-product pairs (section 6) before production.

### 1.6 Quantisation and serving cost (estimates; measure before sizing)

| Item | Estimate (untuned, from architecture size, not measured) |
|---|---|
| ViT-B/16 at 224 px | about 17-18 GFLOPs per image (standard ViT-B/16 figure) |
| CPU throughput, ONNX Runtime int8 dynamic quantisation, 8 vCPU | about 15-40 images/s (estimate). Measure with `tooling/` bench |
| Backfill, 200k SKUs x 4 images = 800k images | 800,000 / 20 per s = 40,000 s, about 11 h on one 8-vCPU node; parallelise across 4 nodes for about 3 h |
| Steady state | new and changed images only; at 5,000 per day that is about 4 minutes of compute per day |
| e5-base text | about 278M params; short titles at about 100+ per s on CPU (estimate) |
| Storage per product | `halfvec(1536)` = 3 KB, `halfvec(768)` = 1.5 KB; 200k products is about 0.9 GB with both, before HNSW overhead |
| HNSW memory | roughly vector bytes + `m * 2 * 8` bytes per node at layer 0; at m = 16 that is about 256 B per node (estimate) |

**Quantisation acceptance gate:** int8 vs fp32 mean cosine at least 0.99 on 5,000 eval images, and recall@10 drop at most 1 point (untuned). Otherwise serve fp16 on CPU (slower) or keep fp32. **No GPU is required for item representation in Phase A.**

### 1.7 pgvector ANN indexing (ADR-0023 refinement)

Facts checked on the pgvector README (2026-10-16): HNSW `m` default 16, `ef_construction` default 64, `hnsw.ef_search` default 40. IVFFlat `lists` is about rows/1000 up to 1M rows and about sqrt(rows) above that, with `probes` starting at sqrt(lists), and the index must be built after the data exists. Indexable dimension limits are 2,000 for `vector` and 4,000 for `halfvec`. Binary quantisation is supported via `binary_quantize` plus re-rank. **Iterative index scans (`hnsw.iterative_scan = strict_order | relaxed_order`, bounded by `hnsw.max_scan_tuples` default 20,000) exist from version 0.8.0.**

| | HNSW | IVFFlat |
|---|---|---|
| Recall/latency | better at equal latency (Malkov and Yashunin, "Efficient and robust approximate nearest neighbor search using Hierarchical Navigable Small World graphs", IEEE TPAMI 2020) | lower; depends on probes |
| Build | slower, more memory | fast, but needs data first and degrades as the distribution drifts (weekly off-price churn) |
| Inserts | incremental | centroids go stale and need periodic rebuilds |
| **Decision** | **HNSW** | rejected for the online path; acceptable for offline batch jobs |

Parameters (untuned): `m = 16`, `ef_construction = 128`, `hnsw.ef_search = 100`, `hnsw.iterative_scan = relaxed_order`, `max_scan_tuples = 20000`, `halfvec` storage, cosine ops (`halfvec_cosine_ops`).

**Filtered ANN.** Outfit candidate generation is per slot. Create **partial HNSW indexes per slot** (`WHERE slot = 'shoes' AND sellable`), so the filter is in the index rather than applied after it. Other filters (store scope, world, size in stock, modest) are applied in SQL with 4x oversampling (untuned): `LIMIT 4*K`, then filter, then take the top K. Stock and price are re-read from the primary at render and add-to-bag, as today.

**VERIFY:** the managed Postgres offering in the ADR-0002 region ships pgvector at least 0.8.0. If not, oversample 8x and accept lower filtered recall.

---

## 2. Recommenders

### 2.1 Surfaces
`Similar` (visual + attribute), `Similar for less` (similar AND cheaper AND `claim_allowed`; exists), `Goes with your purchase` (compatibility, section 3), `Because you bought`, `Similar to what you viewed`, home feed candidates (retrieval for the existing `ranking` module), restock reminders (exists), and wardrobe gap fills (section 4).

### 2.2 Options compared

| Option | Data needed | Cold start (items) | Off-price churn | Cost | Explainable | Notes |
|---|---|---|---|---|---|---|
| Item-item co-occurrence (cosine/Jaccard/PMI with shrinkage) (Sarwar et al., "Item-based collaborative filtering recommendation algorithms", WWW 2001; Linden, Smith, York, "Amazon.com recommendations: item-to-item collaborative filtering", IEEE Internet Computing 2003) | low-medium | none (new item has no co-counts) | poor at SKU level, good at cluster level | trivial SQL batch | yes ("people also viewed") | needs k-anonymity floor |
| EASE (Steck, "Embarrassingly Shallow Autoencoders for Sparse Data", WWW 2019) | medium | none | as above | one `n x n` inverse; fine up to about 50k columns | weights inspectable | strong baseline in Dacrema, Cremonesi, Jannach, "Are we really making much progress?", RecSys 2019 |
| Implicit ALS (Hu, Koren, Volinsky, "Collaborative Filtering for Implicit Feedback Datasets", ICDM 2008) | medium | none | poor at SKU level | CPU, minutes | weak | user factors are personal data (P2) |
| BPR-MF (Rendle et al., "BPR: Bayesian Personalized Ranking from Implicit Feedback", UAI 2009) | medium | none | poor | CPU | weak | similar role to iALS |
| Two-tower retrieval (Covington, Adams, Sargin, "Deep Neural Networks for YouTube Recommendations", RecSys 2016; Yi et al., "Sampling-Bias-Corrected Neural Modeling for Large Corpus Item Recommendations", RecSys 2019) | high | **good** (item tower uses content embedding) | good | GPU training preferred | weak | needs logQ correction |
| Session models: GRU4Rec (Hidasi et al., "Session-based Recommendations with Recurrent Neural Networks", ICLR 2016), SASRec (Kang and McAuley, "Self-Attentive Sequential Recommendation", ICDM 2018) | high, long sessions | poor unless content-fed | medium | GPU training | weak | uses session only, can be consent-light |
| Content-based (embedding kNN, attributes) | none | **good** | **good** | already computed | yes | no collaborative signal |
| Hybrid content+CF (Kula, "Metadata Embeddings for User and Item Cold-start Recommendations", CBRecSys workshop 2015, LightFM) | low-medium | good | good | CPU | medium | a bridge between content and two-tower |

### 2.3 Decision rule by data volume (untuned thresholds)
Let `I90` = deduplicated user-item interactions (view >= 3 s, save, bag, buy) in the last 90 days from **personalization-consenting** users. Let `U5` = such users with at least 5 interactions. Let `S3` = sessions with at least 3 item events.

| Stage | Gate | Retrieval sources |
|---|---|---|
| A (launch) | always | content kNN (`z`), popularity per world (Bayesian-smoothed, 2.6), **cluster-level co-occurrence** (2.4), rules |
| B | `I90 >= 100,000` and `U5 >= 5,000` | + EASE on style clusters (or iALS if the cluster count exceeds 50k) |
| C | `I90 >= 5,000,000` | + two-tower (item tower = MLP over `z` + attributes + price band; user tower = MLP over recent item embeddings + category/store affinity) |
| D | `S3 >= 1,000,000` per 90 days and stage C live | + SASRec for "next in session" |

**Promotion rule.** A stage goes live only if (1) the gate is met, (2) offline NDCG@10 on the temporal split (section 6) beats the incumbent by at least 3% relative, with the 95% bootstrap CI excluding 0, and (3) a 2-week A/B (at least one full payday cycle) shows no guardrail breach. Demotion is automatic if drift alarms fire (section 6.6).

### 2.4 Co-occurrence at cluster level (the off-price adaptation)
Off-price SKUs sell out in days, so SKU-level co-counts never mature. Co-occurrence is therefore computed between **style clusters**, then projected onto live items.
- **Clusters.** `k(i)` = assignment of `z_i` to `K_c` k-means centroids within each slot (K_c = n_items_slot / 25, untuned), re-fitted weekly. Assignments are kept stable across refits by Hungarian matching of new to old centroids.
- **Counts.** Over a window `W = 90 days` with exponential decay `w(t) = 0.5^(age/14d)` (matches `HALF_LIFE_MS`):
```
n_a      = sum over distinct users u of max decay weight of any event of u on any item in cluster a
c_ab     = sum over distinct users u of decay weight, counted when u touched both a and b within the same 7-day window
           (co-view, co-save, co-bag, co-buy kept as separate matrices with weights 1, 2, 3, 5; untuned)
```
- **Similarities** (computed for all pairs with `c_ab >= k_min` distinct users, `k_min = 5`; k-anonymity floor, untuned):
```
cosine     s_ab = c_ab / sqrt(n_a * n_b)
jaccard    s_ab = c_ab / (n_a + n_b - c_ab)
asym. cos  s_ab = c_ab / (n_a^alpha * n_b^(1-alpha)),  alpha = 0.5..0.9  (damps popular b; Aiolli, "Efficient top-n recommendation for very large scale binary rated datasets", RecSys 2013)
PPMI       s_ab = max(0, log( c_ab * N / (n_a * n_b) ))   (Church and Hanks, "Word association norms, mutual information, and lexicography", Computational Linguistics 1990)
shrinkage  s'_ab = ( c_ab / (c_ab + lambda) ) * s_ab,  lambda = 20   (Koren, "Factorization meets the neighborhood", KDD 2008)
```
  The default is shrunk asymmetric cosine with alpha = 0.7 (untuned); the others are evaluated offline. PPMI is unstable at low counts, so it is used only with shrinkage.
- **Projection to items.** `score(i -> j) = s'_{k(i),k(j)} * cos(z_i, z_j)^gamma` for live items j in cluster `k(j)`, with gamma = 1 (untuned). This favours the most similar live item inside a co-occurring cluster.
- **Cross-slot co-buy** (for example, top bought with bottom) feeds the **learned compatibility** labels in section 3.2 as weak positives, never directly into outfits.

### 2.5 Collaborative models (stages B-D), exact objectives
- **EASE:** `X` is a binary user x cluster matrix. `P = (X^T X + lambda I)^{-1}`, `B_ij = -P_ij / P_jj` for i != j, `B_ii = 0`. The score is `x_u B`. lambda = 500 (untuned; grid search on the validation split).
- **iALS:** minimise `sum_{u,i} c_ui (p_ui - x_u^T y_i)^2 + lambda (sum ||x_u||^2 + sum ||y_i||^2)` with `p_ui = 1[r_ui > 0]` and `c_ui = 1 + alpha r_ui`. Closed form: `x_u = (Y^T Y + Y^T (C^u - I) Y + lambda I)^{-1} Y^T C^u p(u)`. Factors d = 64, alpha = 10, lambda = 0.1 (untuned). The Python library `implicit` (MIT licence from memory, VERIFY) is acceptable.
- **Two-tower:** `s(u,i) = <g(u), h(i)> / tau`. Training uses in-batch sampled softmax with **logQ correction** `s_c(u,i) = s(u,i) - log Q(i)`, where `Q(i)` is the item's sampling probability estimated by streaming frequency (Yi et al. 2019). Loss: `-log( exp(s_c(u,i+)) / sum_j exp(s_c(u,j)) )`, tau = 0.05 (untuned). Serving: item vectors go into a pgvector HNSW index like section 1.7; the user vector is computed at request time from features and **never persisted** beyond the feature-store TTL (24 h, `FEATURE_MAX_AGE_MS`).
- **SASRec:** the last n = 50 events (`MAX_SESSION_EVENTS`), item inputs = projected `z`, 2 blocks, 1 head, d = 64, binary cross-entropy with one sampled negative per position (untuned).

### 2.6 Blending, cold start, popularity debiasing
- **Union and fusion.** Each source returns the top 200 (untuned), merged by Reciprocal Rank Fusion: `RRF(i) = sum_s w_s / (60 + rank_s(i))` (Cormack, Clarke, Büttcher, "Reciprocal rank fusion outperforms Condorcet and individual rank learning methods", SIGIR 2009). The fused top 500 go to the existing `ranking` module (`LinearRanker` / `TreeEnsembleRanker`, LambdaMART per Burges, "From RankNet to LambdaRank to LambdaMART: An Overview", MSR-TR-2010-82). Diversity (`diversify`, at most 2 consecutive per store) and exploration (`pickExploration`, cap 5%) stay as built.
- **New item cold start.** Content kNN from the first upload. The item inherits its cluster's co-occurrence via `k(i)`. It is eligible for the 5% Thompson exploration slot when the seller is new (exists).
- **New user cold start.** The onboarding vibes and favourite brands give a prior style vector (section 3.6). Before any interaction: popularity per world plus the user's chosen vibes. **Governorate is not used** for ranking (it is address-derived P2 and outside the personalization purpose).
- **Popularity debiasing.**
  1. Smoothed popularity: `pop_i = (clicks_i + a) / (impressions_i + a + b)` with prior `a/(a+b)` = category mean CTR and `a + b = 50` (untuned).
  2. Position-bias-corrected training labels with clipped IPS `w = min(M, 1/p(pos))`, M = 10 (exists: `ipsWeight`). Joachims, Swaminathan, Schnabel, "Unbiased Learning-to-Rank with Biased Feedback", WSDM 2017.
  3. logQ correction in the two-tower model (above).
  4. A re-rank penalty `s' = s - beta * log(1 + n_i)`, beta = 0.05 (untuned), used only if catalogue coverage falls below its target (Abdollahpouri, Burke, Mobasher, "Controlling Popularity Bias in Learning-to-Rank Recommendation", RecSys 2017).
  5. Sold-out and suspended items are filtered **before** popularity is computed, so popularity never snowballs onto unavailable stock.

### 2.7 Privacy rules for recommenders (binding)
- `personalizationDecision` (exists) remains the single gate. When it returns false, the request uses `baselineScore` only (popularity + freshness) and **no user feature, style vector or user embedding is read** (spec §13 acceptance; there is an integration test today).
- **Training data:** only events of users with `personalization` consent and history not paused (`recordDecision`). Events are pseudonymised (rotating analytics ID, §T6) in the warehouse.
- **Aggregates:** co-occurrence pairs below `k_min = 5` distinct users are dropped, so "also viewed" cannot reveal one person's behaviour.
- **History clear (24 h, spec):** the user's events are deleted, the per-user feature row and style vector are deleted, and the **nightly** rebuild of co-occurrence, EASE and two-tower item factors excludes them, which satisfies "derived features within 24 h". User factors (iALS `x_u`) are never stored; they are recomputed at request time from retained events or not at all. **DPO question (O-5):** whether item factors trained before a deletion must be purged before the next nightly retrain.
- **Budget is never a feature** (`forbiddenFeatureKeys` regex exists). "Fits my budget" is a request-time filter or computed on the device (§12, §20.5). Measurements never enter recommenders, only size labels and in-stock flags.

---

## 3. Outfit generation

### 3.1 Compatibility model options

| Option | Labels | Strength | Weakness |
|---|---|---|---|
| (a) Rules + embedding templates (current `pairCompat`: colour 4, season 2, embedding 4; formality gap > 2 forbidden) | none | works now, explainable | raw cosine between, say, a shoe and a top measures *similarity*, not *compatibility* |
| (b) Type-aware embeddings: a projection per slot pair (Vasileva et al., "Learning Type-Aware Embeddings for Fashion Compatibility", ECCV 2018) | curated outfits | handles "similar is not compatible" | needs thousands of outfits |
| (c) Learned pairwise classifier over pair features (logistic/GBDT) | curated outfits + weak positives | small data, explainable features, fast | limited to pairwise |
| (d) Sequence/set models (Han et al., "Learning Fashion Compatibility with Bidirectional LSTMs", ACM MM 2017; Chen et al., "POG: Personalized Outfit Generation for Fashion Recommendation at Alibaba iFashion", KDD 2019) | large outfit corpora | whole-outfit context | data-hungry, GPU, harder to constrain |
| (e) Complete-the-Look scene-product (Kang et al., CVPR 2019; Li et al., "Bootstrapping Complete The Look at Pinterest", KDD 2020) | scene images + bootstrapped pairs | learns from lifestyle photos | needs scene photos; sellers' on-model photos are the only source |

**Decision.** Phase A ships (a'): option (a) upgraded with the OKLab harmony (1.4) and a **type-aware similarity without training**. Phase B ships (c) once at least 2,000 curated outfits exist (untuned), with (b) projections as features of (c). Options (d) and (e) are Phase C research items, only once outfit data exceeds about 50,000 (untuned).

**(a') Pair compatibility, exact.** For candidate items a, b with slots `t_a != t_b`:
```
hard gate (returns null):  |form_a - form_b| > 2   OR   (modest and either not modest_compliant)   OR   season disjoint with request season (both specific)
C(a,b) = round( w_col * Hcol(a,b) + w_sea * S(a,b) + w_emb * E(a,b) + w_form * F(a,b) )            in 0..1000
  Hcol  = pair colour score (1.4)                       0..1000
  S     = (seasonFit(a) + seasonFit(b)) / 2             0..1000 (exists)
  E     = 1000 * clip( (cos(P_{ta,tb} e_a, P_{ta,tb} e_b) - lo) / (hi - lo), 0, 1 )
          P_{t,t'} = projection onto the top-32 principal components of the matrix of [e_a ; e_b] for
                     curated/heuristic compatible pairs of slot pair (t, t');  identity until 200 pairs exist
          lo = 5th, hi = 95th percentile of the cosine for that slot pair (calibrates across slot pairs)
  F     = 1000 - 300 * |form_a - form_b|
  weights w_col = 0.35, w_sea = 0.15, w_emb = 0.30, w_form = 0.20                                  [untuned]
```
Unknown attributes give the neutral value 500 for that term (fail-soft for ordering). Unknown **modest** coverage fails the gate (fail-closed).

**(c) Learned pairwise model.** `P(compatible | a, b) = sigma(theta . phi(a,b))`, or a GBDT on the same features, where
`phi = [ |P e_a - P e_b| ; (P e_a) * (P e_b) ; Hcol ; S ; F ; same_pattern ; both_patterned ; price_ratio_band ; one-hot(slot pair) ]`. Then `C = round(1000 * P)`. The hard gate is kept on top of it.
- **Positives:** in-house stylist outfits (curated, double-reviewed); sellers' "shop the look" sets (Seller Center feature, consented); items bought in the **same order** across slots by consenting users (weak, weight 0.3); outfits added to bag from the stylist and **kept** past the return window (weak, weight 0.5). The last two are suppressed until Stage B volume.
- **Negatives:** for each positive pair, replace b with a random same-slot item (easy) and with a same-slot item of the same category but a clashing colour or formality (hard), at a 1:3 ratio (untuned).
- **Bootstrapping without user labels** (Pinterest KDD 2020 idea): train first on stylist outfits plus heuristic outfits generated by (a'), keeping only those that score in the top decile and pass every hard rule. Then retrain as kept-outfit signal accrues.
- **Gate:** pairwise AUC on held-out curated outfits at least 0.80 and fill-in-the-blank accuracy (4 choices) at least 0.55 (untuned). It must also beat (a') on both, otherwise (a') stays.

### 3.2 Outfit objective (exact)
Let O be an outfit for template `T` with n items and `p = n(n-1)/2` pairs.
```
U(i)   = A(i) + 5 * vdisc(i) - floor(price_i / 2000) + 200 - 100 * |form_i - occ_form|            (exists: unaryValue)
         A(i) = affinity (3.6) in 0..1000 when personalized, else floor(popularity_i / 2)
         vdisc(i) = verified discount percent, 0 unless price-integrity claim_allowed
Score(O) = round( (1/n) * sum_i U(i) * n_ref  +  (1/p) * sum_{i<j} C(i,j) * p_ref )  +  D(O)
         n_ref = 5, p_ref = 10        (normalises to the 5-item template)
D(O)   = - mu * sum_s fee_s * 1[ subtotal_s(O) < T_s and not plus ]  / 100,   mu = 1 point per EGP of avoidable fee [untuned]
```
- **Finding F-1 (bug-class, for the builder).** The current `scoreItems` sums U and C without normalisation. The 5-item template (top+bottom+…) has 10 pairs and the dress template has 6, so dress outfits are systematically outscored by up to about 4,000 points regardless of quality. The normalisation above removes that bias. Add a property test: for two otherwise identical candidates, template choice must not change the score by more than the per-pair maximum difference.
- **Free delivery** is valued in money (`D`) instead of the flat +50 bonus. This makes "prefer combos that unlock same-store free delivery **when cost-neutral**" (spec) precise: an outfit that pays a delivery fee loses exactly the fee's value. The budget constraint stays on merchandise (spec: `sum(price) <= budget`), and the outfit card shows delivery separately.
- **Price penalty** stays linear (1 point per 20 EGP). Alternative: relative to budget, `-200 * total/budget`. Decide offline (open decision O-6).

### 3.3 Constrained optimisation: options compared

The problem per template: choose one item per slot (multiple-choice), with `sum price <= B` (knapsack), `per-store count <= 2` unless single-store scope, every pair passing the gate, all items in size and in stock, maximising Score (a quadratic objective because of the pairs).

| Option | Exactness | Latency | Dependencies | Notes |
|---|---|---|---|---|
| Beam search width W with bound pruning (current) | exact when W covers the space; otherwise heuristic | `O(depth * W * pool)`, about 5 x 50 x 40 = 10k admits; predictable | none | explainable; deterministic if the budget counts nodes |
| ILP / MIQP (linearise pairs: `y_ij <= x_i`, `y_ij <= x_j`, `y_ij >= x_i + x_j - 1`) with HiGHS (MIT, from memory) or OR-Tools CP-SAT (Apache-2.0, from memory) | exact | variable; typically ms at this size but with long tails | solver | ideal **oracle** in tests and offline eval |
| Submodular greedy | (1 - 1/e) only for **monotone submodular** objectives (Nemhauser, Wolsey, Fisher, "An analysis of approximations for maximizing submodular set functions", Mathematical Programming 1978); with a knapsack constraint, the partial-enumeration variant (Sviridenko, "A note on maximizing a submodular set function subject to a knapsack constraint", Operations Research Letters 2004) | fast | none | **does not apply**: a sum of positive pairwise compatibilities is supermodular, so no guarantee holds for a single outfit |

**Decision: keep beam search (spec), fix the bound and the determinism, and use the ILP as the oracle.**

**Multiple-choice knapsack LP bound (replaces the current bound).** The current `bound()` adds the best unary per remaining slot regardless of the remaining budget, so it is not a knapsack bound. Proper bound for a partial state `s` at depth d with remaining budget `R = B - price(s)` and remaining slots `d..n-1`:
1. For each remaining slot t, take the items `(c_k, v_k)` with `v_k = U(k) + pairmax_k`, where `pairmax_k = sum over already-placed items of C(k, placed) + 1000 * (number of later slots)` (an upper bound on pair gain). Under the normalised objective of 3.2, scale by `n_ref/n` and `p_ref/p`.
2. Compute the upper concave hull of `(c, v)` per slot. Start each slot at its cheapest item. Collect the incremental steps `(Delta c, Delta v)` along each hull and sort all steps by `Delta v / Delta c`, descending. Fill greedily within `R - sum cheapest`, taking the last step fractionally. This is the LP relaxation of MCKP (Sinha and Zoltners, "The multiple-choice knapsack problem", Operations Research 1979).
3. `UB(s) = Score_partial(s) + LP value`. Prune if the sum of cheapest items exceeds R (infeasible) or `UB(s) < theta_k`, the k-th best complete score so far.

The cost is `O(sum pool * log)` per state; restrict it to depths <= n-2 if profiling shows overhead (untuned).

**Determinism (finding F-2).** On timeout the current optimizer's output depends on the wall clock, so the spec's determinism property cannot hold across machines. Change: the primary limit becomes a **node budget** `N_max = 200,000 admits` (untuned, sized so p99 stays under 300 ms on the target CPU). The 300 ms wall clock is only a safety net, and when it trips the result is marked `timedOut` and logged. Determinism tests run with the clock disabled (as today), and a separate test asserts that `N_max` binds before 300 ms on the CI reference machine.

**Candidate generation per slot.** ANN on the partial slot index with the request's style or anchor vector, plus availability filters, plus the cheapest 5 (exists in `capCandidates`). Cap at `perSlotCap = 40` (exists). The candidate set is retrieved once per request and cached for 60 s keyed by `hash(filters, scope, size label, model_version)`; budget is never part of the key (LLM10, §12).

### 3.4 Diversity across outfits
Options: MMR (Carbonell and Goldstein, "The use of MMR, diversity-based reranking for reordering documents and producing summaries", SIGIR 1998) or DPP greedy MAP (Kulesza and Taskar, "Determinantal Point Processes for Machine Learning", Foundations and Trends in ML 2012; Chen, Zhang, Zhou, "Fast Greedy MAP Inference for Determinantal Point Process to Improve Recommendation Diversity", NeurIPS 2018). With at most 5 picks from at most about 300 complete outfits, MMR is enough. **Decision: MMR plus the hard rule.**
```
S = {}
repeat until |S| = maxOutfits (5) or the pool is exhausted:
  O* = argmax_{O not in S, slotDiff(O, O') >= 2 for all O' in S}  lambda * Score~(O) - (1 - lambda) * max_{O' in S} sim(O, O')
  Score~ = min-max normalised score in the pool; sim(O,O') = |items(O) ∩ items(O')| / |items(O) ∪ items(O')| * 0.5 + 0.5 * mean_slot cos(z) for shared slots
  lambda = 0.7                                                                          [untuned]
ties: lower total, then lexicographic item ids (deterministic)
```
Also: at most 3 of the 5 outfits may use the same item in the hero slot (top or dress) (untuned).

### 3.5 Fairness cap and free-delivery threshold
- Per-store cap: at most 2 items per store per outfit unless the request is scoped to a single store (spec; exists in `admit`).
- **Exposure fairness across outfit sets:** no store may supply more than 40% of all items across the 5 outfits when at least 3 stores have candidates (untuned). Applied in MMR as a hard filter.
- The free-delivery threshold `T_s` is read from the store at request time (ADR-0010: merchandise subtotal after item discounts). Plus members have `fee_s = 0`, so `D = 0`. The outfit card shows "unlocks free delivery from {store}" only when `subtotal_s >= T_s` actually holds in the outfit.

### 3.6 Online learning from like / dislike / swap
Options:
1. **Rocchio-style additive update** (current `updateStyleVector`, learning rate 0.2): simple, but it has no notion of uncertainty, so one dislike can swing a new user, and it works in the full 768-d space.
2. **Bayesian linear preference model** (chosen) in a low-dimensional style space, with Thompson sampling for exploration (Chapelle and Li, "An Empirical Evaluation of Thompson Sampling", NeurIPS 2011; Agrawal and Goyal, "Thompson Sampling for Contextual Bandits with Linear Payoffs", ICML 2013). LinUCB (Li, Chu, Langford, Schapire, "A contextual-bandit approach to personalized news article recommendation", WWW 2010) is equivalent in cost.
3. A global contextual bandit over outfit features: it needs propensity logging at scale (Stage C).

**Chosen model.**
- Style space: `q_i = W^T (e_img_i - mean)` with `W` = top d = 32 PCA components of catalogue `e_img` (refit monthly; `style_space_version`), whitened. Stitch Fix "latent style" is the precedent (blog, not peer reviewed).
- Each user has `theta_u ~ N(mu_u, Sigma_u)`, and the observation is `r = q_i . theta_u + eps`, `eps ~ N(0, sigma^2)`, sigma^2 = 1 (untuned).
- Prior: `mu_0` = mean `q` of the onboarding vibe prototypes chosen (0 if none), `Sigma_0 = s0^2 I`, s0^2 = 1 (untuned).
- Update for signal r on item i (precision form):
```
Lambda_u <- Lambda_u + q_i q_i^T / sigma^2
b_u      <- b_u + r * q_i / sigma^2
mu_u      = Lambda_u^{-1} b_u           (32x32 solve; Cholesky)
```
- Signal values (untuned): like +1, dislike -1, swap_out -0.5 (applied to the removed item), swap_in +1, outfit added to bag +1 per item, kept after the return window +2, returned with a style reason -1. Returns for size reasons go to sizing (§10), **never** to style.
- **Forgetting:** each week `Lambda_u <- gamma Lambda_u`, `b_u <- gamma b_u`, gamma = 0.9 (untuned), so taste can drift.
- **Affinity used by the optimizer:** `A(i) = round(1000 * sigmoid(q_i . theta~))`, where `theta~ = mu_u` normally and, for exploration, `theta~` is a sample from `N(mu_u, Sigma_u)` for at most 1 of the 5 outfits. The explored outfit is labelled internally and counts toward the 5% exploration budget. The sample uses a seeded RNG (`seed = hash(user, day)`) so a request replays deterministically.
- **Poisoning and abuse (LLM04):** at most 60 feedback signals per user per day (the API limit exists) and at most 20 applied to the posterior per day (untuned); the rest are logged and ignored.
- **Storage:** `user_style_models(user_id, mu float4[32], lambda_upper float4[528], style_space_version, updated_at)`, P2, deleted on history clear and account deletion (as `user_style_vectors` today). The posterior is read only when `personalizationDecision` is on.
- **Migration:** the existing 768-d vectors are projected with `W` into `b`, using a weak precision (`Lambda = I`), so no user loses their history at cutover.

### 3.7 Explanation strings
Each outfit gets at most 3 explanation chips, chosen from the **largest score components**, rendered from fixed AR/EN i18n templates. No generated text. Numbers come only from DB values computed in the request.

| Component | Template key (EN shown) | Shown when |
|---|---|---|
| neutral pairing | `stylist.why.neutral` "The {colour} {item} pairs with everything here" | Hcol term in the top 2 |
| hue template | `stylist.why.harmony.{complementary,analogous,…}` | harmony >= 0.7 |
| formality | `stylist.why.occasion` "Right level for a {occasion}" | F = 1000 for all pairs |
| budget | `stylist.why.budget` "Fits your {budget} with {left} to spare" | the user typed a budget in this request (the user's own value, shown only to them) |
| free delivery | `stylist.why.free_delivery` "Free delivery from {store}" | `subtotal_s >= T_s` |
| verified discount | `stylist.why.verified` "Verified {pct}% off" | `claim_allowed` (price integrity) |
| personal | `stylist.why.style` "Close to looks you liked" | personalized and `A(i)` in the top quartile |
| owned | `wardrobe.why.owned` "Uses your {item}" | wardrobe item in the outfit |

Explanations never mention body shape, weight or age. The Arabic templates are written first; CI fails on a missing AR key (A2.15).

### 3.8 Property and unit tests (must exist before enabling)
Generated by fast-check over random catalogues (10k runs; spec):
1. **Budget:** every returned complete or partial outfit has `sum price <= B` (spec acceptance). The violation count must be exactly 0.
2. **Size and stock:** every item has `inSize = true` and `pricePiastres > 0`.
3. **Hard rules:** `checkOutfit` returns `[]` for every returned outfit (validator independence: the checker shares no code path with the scorer except `pairCompat`; add an independent re-implementation of the gate for the test).
4. **Store cap and the exposure cap.**
5. **Determinism:** same input and seed gives byte-identical output (clock disabled); input permutation gives the same output.
6. **Oracle optimality:** on catalogues with at most 6 items per slot, the beam result equals the ILP or exhaustive optimum (the exhaustive oracle exists), and the MCKP bound is >= the true best completion for every visited state.
7. **Monotonicity:** raising the budget never lowers the best score. Removing an item not in any returned outfit never changes the result.
8. **Template-length neutrality** (F-1).
9. **Modest:** with `modest = true`, no item with unknown or failing coverage appears.
10. **Personalization off:** the style model is not read (spy port), and the output equals the non-personalized output.
11. **Style update:** posterior precision is positive definite after any sequence of updates; a like moves `q_i . mu` up and a dislike moves it down; dimension mismatch is rejected.
12. **Explanation honesty:** every number in a chip equals a value in the response payload.

---

## 4. Wardrobe engine

### 4.1 Sources (with consent)
| Source | Consent | Rule |
|---|---|---|
| Manual entry | `personalization` (exists) | closed vocabulary (exists) |
| Photo | `personalization` + photo-specific notice; `kill.wardrobe_vision` | pipeline 4.2 |
| HAUL purchases | `personalization` + toggle "Add my Z-OUTLET purchases" (**default off**, open decision O-4) | added when the SellerOrder line reaches `CLOSED` (return window ended, not returned), deduplicated by `order_line_id`, attributes copied from the product (P0) |
| Browsing history | — | **not a wardrobe source.** Viewing is intent, not ownership. Browsing only updates the style model (3.6) |

### 4.2 Photo to item pipeline
1. **On device:** capture or pick, then crop to the garment. Use the platform's on-device foreground or instance segmentation where available (for example the iOS Vision foreground-instance mask; API name and minimum iOS version **VERIFY**). Downscale to a long side of at most 1024 px, re-encode to JPEG/WebP, and strip EXIF/GPS on device too. Uploading is the user's explicit act.
2. **Upload** to the in-region private bucket by signed URL (exists: `POST uploads`), then AV scan and type sniff (exists).
3. **In-region bg-removal sidecar** (exists, u2netp). The stored image is **only the masked garment on a neutral background**. The original upload is deleted once processing succeeds or within 1 h at most (untuned; it must be added to the retention job). This minimises faces, bystanders and home interiors in storage (VR-P3-13).
4. **Face handling:** no face recognition and no face embeddings. If the garment mask overlaps a detected face region (an on-device face *detector*, not recognition), that region is cropped out before upload.
5. **Embedding and attributes:** the same encoder and heads as the catalogue (1.2, 1.3). The output is a **suggestion** shown to the user (exists: `suggest-attributes`); nothing is saved until the user confirms. The vision output is Zod-validated against the closed enums (LLM05).
6. **Storage:** `wardrobe_item_embeddings(item_id, user_id, vec halfvec(768), model_version)` P2, RLS owner-scoped. These rows are **not** in the shared HNSW index (LLM08). Per-user search is brute force over at most 300 items (the cap exists), which costs about 300 dot products.
7. **Training:** wardrobe photos, embeddings and corrections are **never** used for training (spec). The attribute heads are trained only on catalogue data.

### 4.3 Dedupe
- Same purchase: idempotent on `order_line_id`.
- Same photo: dHash on the masked image with Hamming distance <= 6 of 64 (untuned) gives "this looks like a photo you already added".
- Same garment, different photo: `cos(e_new, e_k) >= 0.92` (DINOv2 or SigLIP, chosen by eval; untuned) **and** same category **and** palette overlap gives a prompt: "Is this the same as your {item}?". Never auto-merge.

### 4.4 Wear tracking
- `wardrobe_wear_log(item_id, worn_on_local_date, source manual|calendar_confirmed)` P2. Logged only by an explicit user tap, or by the user confirming a past calendar outfit ("Did you wear this?"). **Never inferred** from photos, location or purchases.
- Derived: `wear_count`, `last_worn`, `cost_per_wear = price_paid_piastres / max(1, wear_count)`. This uses integer division, rounded half-even at display, only for purchased items with a known price (manual price optional), and is shown to the owner only.
- "Not worn in 180 days" (untuned) is shown only if the user enables wear insights. It never generates selling or marketing nudges unless the resale lane (P2/P3) is opted into separately.

### 4.5 Gap analysis
**Definitions.** The user's occasion set `Occ` is derived from calendar events (next 90 days), wishlist occasions and a stated occasion preference (default {work, casual}). For each `o in Occ` with formality `f_o` and season `s_o`, an outfit is **feasible from the wardrobe** if each required slot of some template has an owned item with `itemFit >= 750` (exists in `itemFit`, untuned) and all pairs pass the hard gate.

**Gap prototypes.** Cells `g = (slot, colour_family in {neutral, warm, cool, …}, formality band, season)`. A prototype item `x_g` has the cell's attributes and the centroid embedding of catalogue items in that cell.

**Marginal gain:**
```
F(W)        = sum_{o in Occ} weight_o * min( cap, #feasible outfits for o from W )        cap = 10 [untuned]
gain(g)     = F(W ∪ {x_g}) - F(W)
report the top 3 cells with gain(g) >= 2, ordered by gain, then by the cheapest live catalogue match
```
**Copy** (AR first, template): "You have no neutral trousers. Adding one would complete 6 looks with tops you own". The copy names the slot and attribute and the count of looks, never body or size. Each gap links to "Shop this gap": catalogue items in the cell, in size, in stock, ranked by the normal pipeline. "Verified" and "% off" follow price integrity.

Gap analysis runs only with `personalization` consent and only on the user's own wardrobe. Gaps are never shared with sellers or used for ads targeting (same rule as budget data, §12).

### 4.6 Capsule planning as a coverage problem
**Problem.** Given the owned set `W` (cost 0), a candidate pool `Q` (in size, in stock, eligible), a piece limit `k` (for example 10), a budget `B` for purchases, and a target `N` outfits (for example 20):
```
maximise  f(S) = | { O in Outfits(S ∪ W) : O valid } |  (capped at N, plus epsilon * sum Score(O) as tie-break)
s.t.      S ⊆ Q, |S ∪ W_used| <= k, sum_{i in S} price_i <= B
```
**Structure.** f is monotone but **not submodular**. A bottom has zero marginal value until a top exists, then positive value (complementarity). The coverage guarantees (budgeted maximum coverage: Khuller, Moss, Naor, "The budgeted maximum coverage problem", Information Processing Letters 1999) therefore do **not** apply to single-item greedy. **Finding F-3:** the current `planCapsule` greedy evaluates single items. When the wardrobe is empty, every first gain is 0, so the first picks degrade to "cheapest item" ordering, which explains poor capsules from scratch. Related work: Hsiao and Grauman, "Creating Capsule Wardrobes from Fashion Images", CVPR 2018, which optimises compatibility plus versatility iteratively (I could not re-verify their exact submodularity claim this pass).

**Options compared.**
| Option | Quality | Latency | Notes |
|---|---|---|---|
| Single-item greedy (current) | poor from empty start | fast | stalls at zero gain |
| **Bundle greedy + 1-swap local search** | good in practice, no guarantee | fast and bounded | chosen online |
| ILP: `x_i` selected, `y_O <= x_i` for all i in O, `sum y_O <= N`, budget and cardinality constraints, maximise `sum y_O + epsilon * sum Score_O y_O` | exact | solver; seconds in the worst case | offline oracle and optional exact mode |

**Bundle greedy (online, deterministic).**
1. Enumerate the minimal **completing bundles** relative to the current `S ∪ W`: for each template and each valid outfit O in the capped pool (per slot cap 12, untuned), the bundle is `items(O) \ (S ∪ W)`. Keep bundles with cost <= remaining budget and size <= remaining pieces.
2. Pick the bundle maximising `(f(S ∪ b) - f(S)) / max(1, cost(b) in EGP)`, with ties broken by score sum, then lexicographic ids. Add it.
3. Repeat until `f >= N`, pieces are exhausted, or no bundle has positive gain.
4. **1-swap local search:** for each `i in S` and each `j in Q \ S` with a budget-feasible swap, accept the swap if f strictly increases, or f is equal and the score sum increases. Maximum 200 swap evaluations (untuned). Repeat until there is no improvement.

The cost is bounded by the pool caps; the target is p95 under 500 ms (capsule API is limited to 5 per minute).

**Evaluation:** report the gap to the ILP optimum on 1,000 synthetic instances (section 6); target median gap <= 5% and p90 <= 15% (untuned).

### 4.7 Outfit calendar integration
- Event `(date_local, type -> formality, season band, modest)` feeds `selectOwned` (exists), then the stylist gap fill for the missing slots only (owned slots cost 0 and never count toward the budget; exists).
- **Delivery feasibility:** a purchasable item is allowed only if `p80_eta(store -> address) <= event_date - 2 days` (calendar spec). Otherwise it is flagged with the cutoff date. The p80 comes from fulfillment; the address is used only server-side for ETA and never enters ML features.
- After the event date the app asks once, "Did you wear this outfit?", which feeds the wear log (4.4).

### 4.8 Deletion and retention
| Data | Delete trigger | Deadline |
|---|---|---|
| Original upload | processing done | <= 1 h (untuned; add to the retention job) |
| Masked garment image | item delete, clear wardrobe, account deletion | blob graveyard (exists), purge <= 24 h (untuned; align with ADR-0043) |
| Wardrobe embeddings, wear log, gap cache | item delete or clear | same transaction as the item row (FK cascade) |
| Style model (`user_style_models`) | history clear, personalization off and opt-out, account deletion | <= 24 h (spec §13) |
| Retention class | `user_content` (exists) | until deletion |
All of these are tagged in `data_inventory.yaml` as P2 with purpose `personalization` (CI enforces the tags).

---

## 5. Conversational stylist without an external LLM

### 5.1 What exists
`stylist/domain/chat.ts` already enforces the right shape. The model (or the rules parser) returns only a `ParsedIntent` (enum intent plus enum slots plus a numeric budget parsed deterministically), replies come from a fixed AR/EN catalogue, cards come from DB rows, and the rules parser is both the fallback and the golden-set oracle. This spec keeps that contract and **only changes what produces `ParsedIntent`**.

### 5.2 Options compared
| Option | Quality on Egyptian Arabic and Franco | Cost/latency | Safety surface | Data needed |
|---|---|---|---|---|
| A. Rules parser (exists) | good on covered phrasings, brittle elsewhere | under 5 ms CPU | minimal | none |
| B. In-house classifier: e5 embedding of the normalised turn -> multinomial logistic heads (intent, occasion, vibe, palette, season, modest, slot, scope) with a "none" class each; numbers by the deterministic parser | better recall on paraphrases | about 20-40 ms CPU (estimate) | enum output only | 3,000-5,000 labelled utterances (untuned) |
| C. Self-hosted small open-weights LLM as a **constrained classifier** (JSON-schema or grammar-constrained decoding to the `stylist_chat_intent` schema) | best on long or compound turns | GPU; 7B at 4-bit is about 100-300 ms for about 40 constrained tokens (estimate) | weights supply chain, GPU capacity | few-shot plus eval set; optional LoRA on our labelled set |
| D. Hybrid cascade A -> B -> C | best overall | most turns resolve in A or B | union | as B, C optional |

**Decision: D, shipped in phases.** Phase A uses A only (exists). Phase B ships A plus B (no GPU). Phase C adds C **only if** the eval shows that B leaves at least 10% of turns (untuned) unresolved or misparsed **and** an in-region GPU is approved (open decision O-1).

**Cascade logic (exact):**
```
r = rules(turn)                      # exists; returns ParsedIntent + coverage flag
if r.covered and r.confidence == "exact": use r
else
  p = classifier(turn)               # per-head calibrated probabilities
  if min over present heads of max_c p_head(c) >= tau_cls (0.8, untuned): use p (merged with r's numeric slots)
  elif LLM stage enabled and not kill.stylist_llm and GPU breaker closed:
       l = llm_constrained(turn, schema)          # one repair retry, then fall through
       accept l only if schema-valid AND agrees with r and p on every head where those are confident
  else: clarify (one question max; exists) using the head with the lowest confidence
```
Disagreement between a confident rules slot and the LLM always resolves to rules. The LLM never overrides a deterministic number.

### 5.3 Candidate open-weights models for stage C (licences checked on model cards 2026-10-16)
| Model | Licence | Arabic | Note |
|---|---|---|---|
| `humain-ai/ALLaM-7B-Instruct-preview` | Apache-2.0 (tag; the card points to its LICENSE file) | Arabic and English | "preview" status; Egyptian dialect quality unverified |
| `Qwen/Qwen2.5-7B-Instruct` | Apache-2.0 | listed among 29+ languages | general-purpose |
| `Qwen/Qwen2.5-1.5B-Instruct` | Apache-2.0 | yes | CPU-feasible for classification-only use; quality unverified |
| `Qwen/Qwen2.5-3B-Instruct` | **qwen-research** (not Apache) | — | **Excluded** (research licence) |
Serving: llama.cpp (MIT) or vLLM (Apache-2.0); both licences are from memory (VERIFY). Constrained decoding follows Willard and Louf, "Efficient Guided Generation for Large Language Models", arXiv 2023. Quantisation: AWQ (Lin et al., MLSys 2024) or GPTQ (Frantar et al., ICLR 2023). Weights are pinned with sha256 in `models.lock.json`, and there is no network egress from the serving pod.

### 5.4 Training data for B and C
- **Seed set:** about 3,000-5,000 utterances (untuned) written by in-house Egyptian staff across Arabic (Egyptian dialect, MSA), Franco-Arabic and English, double-labelled with the `ParsedIntent` schema. Kappa is reported per head.
- **Augmentation:** templated paraphrases (occasion x vibe x budget phrasings, Eastern and Western numerals), plus Franco transliteration of the Arabic set. This is **not** generated by an external LLM.
- **No user chat transcripts are used for training** by default (stylist-chat.md: history off by default; LLM04). A future opt-in "help improve" consent would be a separate purpose, needing a DPIA and the DPO.
- **Golden and adversarial set:** the existing `chat-golden.ts` plus injection phrasing in AR, EN and Franco, refusal topics (`REFUSAL_REASONS`) and body-image sensitivity. 100% pass on injection and refusal cases is a release gate (spec).

### 5.5 Safety mapping (OWASP Top 10 for LLM Applications 2025) for the in-house design
| Risk | Control |
|---|---|
| LLM01 prompt injection | Product and seller text **never enters** the classifier or LLM input; only the user's turn plus the structured state does. The output is enum-only, so a successful injection can at most mis-pick an enum, which the planner validates. The injection heuristics (`llm-gateway/domain/injection.ts`) still run. |
| LLM02 sensitive information | Nothing leaves the region, so the residual risk is logs: the scrubber runs before audit; turn text is stored only with history on (30 days, exists); no P3 in model input (budget as a deterministic number in state, never logged; band in events). |
| LLM03 supply chain | Pinned weights hash and licence, an SBOM entry per model, an eval before upgrade, a model registry (MLflow, §T3). |
| LLM04 data/model poisoning | Training only on curated in-house data; no user-chat training; feedback limited by rate (3.6). |
| LLM05 improper output | Zod validation of `ParsedIntent`; ids resolved in DB; templated replies; the existing numeric-claim post-check stays as defence in depth. |
| LLM06 excessive agency | Read-only tools; add-to-bag only by user tap (exists). |
| LLM07 system prompt leakage | The system prompt holds no secrets; the output is enum, so it cannot echo the prompt. |
| LLM08 vector weaknesses | Per-scope indexes; wardrobe vectors are per-user and not in shared indexes. |
| LLM09 misinformation | No generated facts; "AI suggestions" label (exists). |
| LLM10 unbounded consumption | 30 turns per day (exists), an input length cap, a GPU queue depth breaker (replaces the micro-EGP cost breaker for the self-hosted path), cache keyed by the normalised intent hash. |

### 5.6 Honest limits
- No open-ended conversation, no generated prose, no "why" beyond the template chips (3.7). Questions outside the intents get a clarify chip or a polite refusal.
- Dialect coverage is only as good as the seed set. It will miss slang until the set is extended.
- Voice input relies on on-device speech recognition; transcription errors flow into the same cascade.
- These limits are acceptable for the owner's constraints. Users can always switch to the structured stylist.

### 5.7 Budgets (untuned targets)
| Stage | p95 latency | Cost |
|---|---|---|
| Rules | < 5 ms | negligible |
| Classifier (CPU) | < 60 ms | shares the embedder pods |
| LLM (GPU, optional) | < 600 ms | about one in-region GPU node; price and availability in Egypt **VERIFY** (O-1) |
| Whole turn including optimizer | < 1.5 s (tighter than the spec's 4 s full answer) | — |

---

## 6. Offline evaluation

### 6.1 Datasets
- **Egyptian catalogue gold set** (P0): 3,000 attribute-labelled items (1.3), 500 query-product relevance pairs (1.5), 2,000 near-duplicate and similar pairs, and the fairness slice (skin tones, modest wear, patterns).
- **Curated outfits** (P0): at least 2,000 (untuned) from in-house stylists, each double-reviewed; 20% held out.
- **Interaction logs** (P2 pseudonymous, consenting users only) with a **temporal split**: train on data before `t0`, validate on `[t0, t0+7d)`, test on `[t0+7d, t0+14d)`. Only items that were sellable at the event time count as candidates.

### 6.2 Metrics (definitions)
```
Recall@k   = |top_k ∩ Rel| / |Rel|
NDCG@k     = DCG@k / IDCG@k,  DCG@k = sum_{r=1..k} (2^{rel_r} - 1) / log2(r + 1)          (exists: ndcgAtK)
MRR        = mean 1 / rank of the first relevant item                                      (exists in visual-search)
Coverage   = |distinct items recommended over the test set| / |sellable items|
Gini       = Gini coefficient of item exposure counts
ILD        = mean over lists of mean_{i<j} (1 - cos(z_i, z_j))
Novelty    = mean -log2( pop_i / sum pop )
ECE        = sum_b (|B_b|/n) * |acc(B_b) - conf(B_b)|, 15 bins                               (attribute heads; target < 0.05, untuned)
Pair AUC, FITB accuracy                                                                       (compatibility)
Outfit validity rate        = share of returned outfits with checkOutfit = []                (must be 1.0)
Budget-violation rate       = share with total > budget                                       (must be exactly 0)
Size/stock violation rate   = must be exactly 0 at generation; at add-to-bag it is reported, never hidden
Optimality gap              = (ILP optimum - returned) / ILP optimum                          (beam and capsule)
Acceptance proxy            = (likes + adds-to-bag-per-outfit) / outfits shown; kept-rate after the return window
Explanation coverage        = share of outfits with >= 1 chip
Latency                     = p50/p95/p99 per stage
```

### 6.3 Synthetic data generator (for CI; never for accuracy claims)
Reuse and extend `ranking/eval.ts generateSyntheticLogs` and `visual-search/eval/synthetic.ts`. The generator is seeded and pure:
- **Catalogue:** S stores, per-slot item counts. Price = `round(exp(N(mu_slot, 0.5)))` EGP converted to piastres. Planted style clusters `c_k` in R^d, with item embedding `normalise(c_k + sigma * epsilon)`. Colours are drawn from cluster palettes, formality is cluster-centred plus or minus 1, coverage is random with a cluster bias, sizes in stock are Bernoulli per size, and `claim_allowed` is Bernoulli(0.4) with a verified percentage of 5-60.
- **Ground-truth compatibility:** pair (a, b) is compatible if the planted cluster-pair matrix `G[k_a, k_b] = 1` **and** the hard rules pass. Curated outfits are sampled from G.
- **Users:** a latent cluster preference `theta_u` (a mixture of 1-2 clusters), an optional typed budget, a size label, and modest Bernoulli(0.3).
- **Behaviour:** view probability `softmax(beta * q_i . theta_u + log pop_i)` with position bias `1/log2(1+pos)`; like when compatible and aligned; return rate is cluster-dependent.
- **Uses:** property tests (3.8), regression gates (NDCG must recover the planted truth above a threshold), estimator unbiasedness tests (6.4), and load and latency benchmarks.

### 6.4 Counterfactual evaluation
Requires **propensity logging**: for every impression in the exploration slots and the stylist's explored outfit, store `pi_0(a | x)` (the Thompson probability, estimated by Monte Carlo with 100 seeded draws; untuned).
```
IPS     V = (1/n) sum_i r_i * pi(a_i|x_i) / pi_0(a_i|x_i)                 with weights clipped at M = 10 (exists: ipsWeight)
SNIPS   V = sum_i r_i w_i / sum_i w_i
DR      V = (1/n) sum_i [ rhat(x_i, pi) + w_i (r_i - rhat(x_i, a_i)) ]
```
References: Dudík, Langford, Li, "Doubly Robust Policy Evaluation and Learning", ICML 2011; Swaminathan and Joachims, "Counterfactual Risk Minimization", ICML 2015; Schnabel et al., "Recommendations as Treatments: Debiasing Learning and Evaluation", ICML 2016. Off-policy estimates only decide **whether to run an A/B**, never whether to ship.

### 6.5 A/B tests and guardrails
- Unit: user (pseudonymous). Assignment hash: `(experiment_id, user)`. Duration at least 14 days and covering one payday cycle. **Sample ratio mismatch** check: chi-square with p < 0.001 halts the test. Variance reduction: CUPED (Deng et al., "Improving the Sensitivity of Online Controlled Experiments by Utilizing Pre-Experiment Data", WSDM 2013).
- Primary: outfit add-to-bag rate, stylist GMV share, recommendation CTR to purchase.
- **Guardrails** (`ranking/guardrails.ts evaluateGuardrails` exists): return rate of stylist and recommended orders, complaint rate, checkout success, p95 latency, fallback rate, opt-out of personalization, budget-violation and validity rates (must stay at 0 and 1.0). Any breach halts the test.

### 6.6 Model cards and drift monitoring
**Model card** (Mitchell et al., "Model Cards for Model Reporting", FAT* 2019) per model version: intended use, out-of-scope use, training data (sources, licences, dates, P-class), evaluation results per slice (language, category, skin-tone slice for vision), thresholds and their tuning date, known failure modes, owner, `model_version`, weights sha256, and the kill switch.

**Drift** (daily batch):
```
PSI = sum_b (p_b - q_b) * ln(p_b / q_b)   over 10 quantile bins of each input feature / predicted class distribution
alert at PSI > 0.2, warn at 0.1                                                              [untuned; common rule of thumb]
embedding drift: cosine between today's mean e_img per slot and the reference mean; alert < 0.95
attribute abstain rate per head: alert if it doubles week over week
recs: coverage, Gini, NDCG on yesterday's logs vs a 28-day baseline (alert on a 10% relative drop)
```
A drift alert opens a ticket; two consecutive alerts on a ranking model auto-demote it to the previous version (the shadow/promote machinery exists in `ranking/shadow.ts`).

### 6.7 Mutation testing targets
StrykerJS at 80% or more (A2.10 lists the critical modules; these are added as stylist-critical by this spec): `stylist/optimizer.ts` (bound, admit, diversity), `stylist/compat.ts`, the new harmony and MCKP bound, `stylist/capsule.ts`, the style posterior update, `recommendations/features.ts` (`forbiddenFeatureKeys`, `personalizationDecision`), and `similar.ts` (`isSimilarForLess`). Python ml-services: mutation testing with `mutmut` (licence **VERIFY**) at 70% or more (untuned) on the colour pipeline, label aggregation and calibration code.

---

## 7. Architecture

### 7.1 Where things run
```
                       ADR-0002 region only, egress denied for every ML pod
 mobile ──► api (NestJS) ─────────────────────────────────────────────┐
             │  stylist optimizer, compat, capsule, explanations      │  pure TS domain (deterministic, property-tested)
             │  recommendations blend + ranking (exists)              │
             │  chat cascade: rules ─► intent-svc ─► (llm-svc)        │
             ├──► Postgres primary (catalog, stock, price, wardrobe, style models, RLS)
             ├──► read replica + pgvector HNSW (product z / e_img, partial per slot; item neighbours)
             └──► Redis (candidate cache, neighbour cache; never source of truth)
 workers ──► ml-services (FastAPI, Python 3.12, mypy --strict, ruff, pydantic v2):
             bg-removal  (exists)
             embedder    (SigLIP-family + e5, ONNX Runtime int8; batch + online endpoints)
             attributes  (heads + OKLab palette; same image as embedder or a separate pod)
             intent      (e5 + logistic heads; CPU)
             llm         (optional; llama.cpp or vLLM; GPU; Phase C)
             trainer     (batch jobs: clusters, co-occurrence, EASE/iALS, PCA style space, heads, calibration; HiGHS oracle)
 warehouse (ClickHouse per ADR-0002) ─► training snapshots (pseudonymous, consenting users only)
 model registry (MLflow) ─► models.lock.json per service (sha256, licences)
```

### 7.2 Batch vs online
| Job | Mode | Cadence (untuned) |
|---|---|---|
| Image and text embedding | batch backfill + online on `catalog.image_updated` / `catalog.text_updated` | event-driven, p95 under 10 min to index |
| Attribute heads + palette | with embedding | same |
| Style clusters, PCA style space | batch | weekly / monthly |
| Co-occurrence, EASE/iALS, two-tower item tower | batch | nightly (also satisfies the 24 h history-clear deadline) |
| Item neighbours (`item_neighbors`) | batch | nightly, plus incremental content-kNN for new items |
| Compatibility model | batch train, online scoring in TS (logistic weights or a tree ensemble as data, like `TreeEnsembleRanker`) | weekly |
| Style posterior update | online, in the feedback transaction | per signal |
| Outfit optimisation, capsule | online TS | per request |
| Gap analysis | online on wardrobe change, cached 24 h | per change |
| Drift and eval reports | batch | daily |

### 7.3 Feature store (Postgres-first; no new system)
Proposed tables (the builder writes the migrations; all tagged in `data_inventory.yaml`):
- `product_embeddings(product_id, image_version, model_version, e_img halfvec(768), z halfvec(1536), created_at)` P0. Index: partial HNSW per slot on the replica.
- `product_attributes(product_id, model_version, attrs jsonb, probs jsonb, abstained text[], palette jsonb, seller_confirmed bool)` P0.
- `style_clusters(cluster_id, slot, centroid halfvec(1536), version)` P0. `item_cluster(product_id, cluster_id, version)` P0.
- `cluster_cooccurrence(a, b, kind, c_ab, s_ab, version)` P1 aggregate, only for pairs with at least `k_min` distinct users.
- `item_neighbors(product_id, neighbor_id, source content|cooc|ease|two_tower, score, model_version)` P0/P1.
- `user_style_models(user_id, mu float4[32], lambda_upper float4[528], style_space_version, updated_at)` P2.
- `wardrobe_item_embeddings(item_id, user_id, vec halfvec(768), model_version)` P2 (RLS owner).
- `wardrobe_wear_log(item_id, user_id, worn_on date, source)` P2.
- `rec_impressions_propensity(request_id, item_id, position, propensity, policy_version, ts)` P1 (pseudonymous, 25-month retention per §B1 analytics).

### 7.4 Caching
- Candidate pools per slot: key `hash(slot, scope, world, size_label, modest, season, model_version)`, TTL 60 s. **Never** keyed by or containing budget or user id.
- Item neighbours: Redis, TTL 1 h, invalidated on `embedding.updated`.
- Chat intent cache: key = normalised-text hash, TTL 24 h, holding only `ParsedIntent` (exists).

### 7.5 Kill switches (polarity per ADR-0028; existing ones keep their meaning)
| Switch | Exists? | Effect when blocked |
|---|---|---|
| `kill.stylist_ml` | yes | rules fallback (`source: rules`): template + popularity + colour rules |
| `kill.stylist_llm` | yes | chat cascade stops at the classifier (or rules if the classifier is off) |
| `kill.stylist_chat` | yes | chat disabled; structured stylist remains |
| `kill.wardrobe`, `kill.wardrobe_vision` | yes | wardrobe off / manual entry only |
| `kill.ml_ranking` | yes | non-personalized baseline ranking |
| `kill.visual_search` | per visual-search spec (VERIFY the exact key) | visual search off |
| `kill.stylist_intent_classifier` | **proposed** | chat uses rules only |
| `kill.recs_collaborative` | **proposed** | recommenders use content + popularity only |
| `kill.style_exploration` | **proposed** | no Thompson sample in the stylist; mean only |
| `kill.attribute_predictions` | **proposed** | seller attributes only; predictions are hidden and unknown values stay neutral |

### 7.6 Degraded-mode matrix
| Dependency down | Behaviour |
|---|---|
| Embedder | new items get attributes from the seller only; rules compat with neutral E = 500 (exists) |
| Replica / ANN | candidate generation falls back to SQL category + popularity on the primary with a row cap (statement timeout 2 s) |
| intent-svc / llm-svc | rules parser (exists) |
| Redis | compute without cache; rate limits fail closed per ADR-0033 |
| Trainer job fails | yesterday's model stays; alert; after 3 days `item_neighbors` from content only |

### 7.7 Data residency
All inference and training run in the ADR-0002 region. ML pods have **no internet egress**; models are pulled through the build pipeline with sha256 pins, never at runtime. Nothing in this spec needs the `cross_border_ml` consent. VR-02 still gates the choice of region itself.

---

## 8. What ADR-0025 (and neighbours) would need to change

ADR-0025 currently proposes Option 1 (external hosted API with P0-only data). For the owner's direction:
1. **Decision becomes Option 3:** self-hosted open-weight models in the ADR-0002 region. Options 1 and 2 are recorded as rejected by owner direction, not on cost.
2. The **"pick provider" owner decision is replaced** by "approve the model allow-list by eval and licence" (sections 1.2, 1.5, 5.3), with a `MODEL_LICENSES.md` and `models.lock.json` per service.
3. **The scope narrows:** the LLM becomes optional and classification-only for chat (section 5). NL search parsing (`search_parse` prompt), attribute extraction, VoC narration and seller copywriting each need their own in-house design. Attribute extraction is covered here by classifiers. Search parsing can reuse the chat cascade schema approach. VoC and copywriting are **not** covered by this spec and stay off until designed (open decision O-7).
4. **Residency text:** "product text still leaves region (P0 only)" is deleted. Nothing leaves the region. `cross_border_ml` is not needed for these features. VR-P3-15 narrows to transcript retention and minimisation only, and VR-P3-13 narrows to in-region processing of user photos (no vendor question left).
5. **LLM03 changes** from "provider DPA and pinned API version" to "weights provenance, licence, training-data terms, SBOM entry, eval-before-upgrade".
6. **LLM10 changes** from the micro-EGP API cost breaker to GPU or CPU capacity: a queue-depth breaker, per-user quotas (unchanged), and capacity planning.
7. The **gateway adapter set:** `llm-gateway` keeps its scrubber, injection heuristics, schemas, audit and breaker, but its provider port gets only `residency: "in_region"` implementations. Any `external` adapter is removed from the composition, or left Unconfigured with a test that it can never be bound in production.
8. **New verify rows:** VR-ML-01 (training-data terms of SigLIP/WebLI, Marqo-FashionSigLIP, e5, ALLaM, Qwen2.5), VR-ML-02 (in-region GPU availability and cost, if Phase C goes ahead), VR-ML-03 (Egyptian Arabic and Franco quality, measured on our sets), VR-ML-04 (pgvector at least 0.8.0 on the managed Postgres in the chosen region).
9. **ADR-0023 refinement:** `halfvec`, two indexes (`e_img` 768, `z` 1536), partial HNSW per slot, `iterative_scan`, and the oversampling factor. Revisit trigger unchanged.
10. **ADR-0043 (wardrobe):** store the masked garment only, delete the original upload within 1 h, keep embeddings out of shared indexes.
11. A **new ADR** is recommended: "ADR-00xx: in-house ML platform (models, serving, registry, no egress)", to record the section 7 architecture and the staged recommender gates.

---

## 9. Open decisions and unverified points

### 9.1 Open decisions (owner or DPO)
- **O-1 GPU in region.** Approve a GPU node in the ADR-0002 region for Phase C chat (and faster fine-tuning), or stay CPU-only (stages A/B of chat, all of section 1). The default is CPU-only.
- **O-2 Curation budget.** Fund about 2,000 in-house curated outfits and the 3,000-item attribute gold set, plus 3,000-5,000 labelled chat utterances. Without these, compatibility stays rules-based and chat stays rules-only.
- **O-3 Seller "shop the look".** Whether sellers' look sets may be used as training positives (Seller Agreement wording).
- **O-4 Purchases to wardrobe.** Default off (proposed) or opt-in prompt after the first delivered order.
- **O-5 Deletion and trained aggregates (DPO).** Whether item-level models trained before a history clear must be purged before the next nightly retrain, or whether the nightly retrain is sufficient.
- **O-6 Price penalty form.** Linear in EGP (current) or relative to the typed budget.
- **O-7 Other LLM uses.** VoC narration and seller copywriting without an external LLM: design later, or drop for launch.
- **O-8 Co-occurrence training base.** Consenting users only (proposed, conservative) or all users under a separate lawful basis (counsel).

### 9.2 Unverified points
- **Training-data terms** for every open-weights model (WebLI is not public; Marqo states no dataset). Licences were checked on Hugging Face model cards only, not in LICENSE files or upstream repositories.
- The **SigLIP 2 base embedding dimension** (768) is inferred from the Transformers base default, not read from this checkpoint's full config. The SigLIP text token limit (64) is from memory.
- **ALLaM-7B-Instruct-preview** has an Apache-2.0 tag, but the card defers to a LICENSE file I did not open. "Preview" stability is unknown.
- **No model's quality on Egyptian Arabic or Franco-Arabic** fashion text was measured. There are no CLIP/SigLIP benchmarks on Egyptian catalogues.
- **All latency and throughput figures** (sections 1.6, 5.7) are estimates from model size, not measurements.
- **pgvector version** on the managed Postgres in the chosen region; `iterative_scan` needs version 0.8.0 or later.
- iOS on-device foreground-segmentation API name and minimum OS version.
- Licences of `implicit`, HiGHS, OR-Tools, llama.cpp, vLLM and mutmut are from memory.
- The OKLab constants are from memory and must be copied from the primary source.
- Hsiao and Grauman's (CVPR 2018) exact capsule objective and submodularity claim were not re-read.
- All literature citations are from memory (titles, authors, venues, years) and were not re-fetched in this pass.
- **Every threshold and weight** marked untuned (tau, lambda, omega, k_min, weights, caps, gates) must be set by section 6 and recorded in a model card.

### 9.3 Findings in existing code (hand to the builder; no code was changed)
- **F-1** `packages/domain/src/stylist/score.ts` `scoreItems`: unnormalised sums bias the 5-item template over the dress template (section 3.2).
- **F-2** `packages/domain/src/stylist/optimizer.ts`: the result after a timeout depends on the wall clock, so determinism cannot hold across machines. Use a node budget (section 3.3).
- **F-2b** `optimizer.ts` `bound()`: the upper bound ignores the remaining budget (it is a value bound, not a knapsack bound). It is valid but loose. Replace it with the MCKP LP bound (section 3.3).
- **F-3** `packages/domain/src/stylist/capsule.ts` `planCapsule`: single-item greedy on a non-submodular objective stalls at zero gain from an empty wardrobe. Use bundle greedy plus local search (section 4.6).
- **F-4** `packages/domain/src/stylist/style-vector.ts`: the update has no uncertainty and works in 768-d. Replace it with the posterior in 3.6, using the migration noted there.
