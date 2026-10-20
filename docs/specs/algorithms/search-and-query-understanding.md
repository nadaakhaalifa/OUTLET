# Algorithm spec: search relevance, Arabic and Egyptian query understanding, filters and facets

Status: **Proposed (architect draft, 2026-10-16).** Documents only. This file extends `docs/specs/search.md` (Phase 1, tested) and does not replace it. Where the two disagree, tested code wins until the builder changes it under this spec (ADR-0018). Product name is Z-OUTLET.

Master prompt refs: §4 (search), §5 (product page), §8 (wishlists, alerts), §12 (budget privacy), §20.4 (Buy Box), §20.5 (ranking), §26 (analytics), §T3 (backend), §T12 (LLM platform), A2.10 (tests), A2.12 (kill switches).

Owner constraints for this spec (from the request):
- **Built in-house.** No external AI vendor. Every model named here is open-weight, self-hosted, and runs on CPU in the approved region.
- **No personal data leaves Egypt.** ADR-0002 (residency) is still Proposed. "Approved region" below means the region ADR-0002 picks, and the owner has asked for Egypt. Model weights are downloaded once as artefacts. No query text, click or profile data is ever sent out.

## 0. Conventions and evidence labels

| Label | Meaning |
|---|---|
| **[REPO]** | Read from the working tree on 2026-10-16 (file path given). |
| **[DOC]** | Backed by a cited paper, standard or vendor document (see §10). |
| **[INF]** | My inference. No source. |
| **[U]** | An untuned parameter. Every number marked [U] is a starting value to be tuned offline (§6) before launch. |
| **[VERIFY]** | A claim I could not confirm. It must be checked before the builder depends on it. |

**All numeric parameters in this document are untuned inferences unless they say otherwise.** Money is integer piastres (`bigint`) everywhere. Percentages are integers. Scores are IEEE doubles, and they are used for ordering only: no score is ever shown to a shopper or turned into money.

### 0.1 Current state the design starts from [REPO]

- `packages/domain/src/search/arabic.ts` has `normalizeSearchText`. It applies NFKC, lower-case, digit folding, diacritics, tatweel, alef, ya, hamza-carrier, Persian kaf and ta marbuta, iterates to a fixed point, and is property-tested as idempotent.
- `packages/domain/src/search/lexicon.ts` has 41 concepts: 21 categories, 13 colours and 7 materials, each with AR/EN/Franco forms. It has a `foldLatin` Franco key (o/u, e/i, y/i, repeated letters collapsed), and `lookupConcept` strips a leading `ال` when at least 3 letters remain.
- `packages/domain/src/search/parser.ts` is a deterministic phrase table. It handles price markers (max/min/between/`من X الي Y`), flags, noise words, currency words, `1.5k`, an EGP 10,000,000 cap and `unparsed` fragments.
- `packages/domain/src/search/filter.ts` has 22 domain keys. 21 are wire facets in `apps/api/src/modules/search/domain/schema.ts`, which is `.strict()`, enforces the 30-facet cap, and limits arrays to 30.
- `packages/domain/src/search/filter.ts` also holds `RELAXATION_ORDER` (15 keys, max 5 steps).
- `packages/domain/src/search/sponsored.ts` has `capSponsored` and `SponsoredRanker`: at most 2 sponsored items in the global top 10, enforced across pages.
- `packages/domain/src/search/suggest.ts` has `didYouMean`: Levenshtein against the lexicon vocabulary, with an allowance of 0, 1 or 2 edits by token length.
- `apps/api/src/modules/search/adapters/postgres-fts.ts` uses `to_tsquery('simple')` with prefix match and `ts_rank`. When FTS finds nothing, it rescues with `word_similarity >= 0.5` if `pg_trgm` is installed.
- `apps/api/src/modules/search/adapters/typesense.ts` is a stub. It has no transport, so it always answers `SearchUnavailableError`. Production therefore runs on Postgres today.
- **ADR-0022 (Proposed):** stay on Postgres FTS until a 500-query golden-set gate shows that Typesense is needed.
- **ADR-0023 (Proposed):** pgvector HNSW on a dedicated read replica for embeddings.
- Kill switches in `packages/feature-flags/src/registry.ts`: `kill.search_engine` (Typesense off, Postgres serves) and `kill.llm_search_parse`. The gateway prompt `search_parse` exists in `apps/api/src/modules/llm-gateway/domain/prompts.ts`.
- Ranking v2 (`packages/domain/src/ranking/features.ts`) has a closed feature vector with 11 names. It has no budget feature. `personalized=false` zeroes the affinity features.
- In `apps/api/src/modules/search/application/search.ts`, relaxation runs **serially**, one engine call per step, up to 5 steps.

### 0.2 Defects and gaps found while reading (input to the builder)

| # | Finding | Evidence | Fix in this spec |
|---|---|---|---|
| G1 | Zero-width and format characters (ZWNJ U+200C, ZWJ, LRM/RLM, ALM U+061C) and combining marks outside the diacritics regex (for example U+0610–U+061A) are turned into a **space**, which splits a word in two. Node test: `"فس‌تان"` → `"فس تان"`. | `arabic.ts` `NOT_WORD` | §2.1 rule N0.3: delete `\p{Cf}` and every remaining `\p{M}`; do not replace them with a space. |
| G2 | Category concepts are pushed to `acc.categories` and then dropped. Only keywords carry them, and `categoryIds` (UUIDs) is never filled from text. | `parser.ts` | §3.4: the concept→taxonomy map, plus category as a ranking boost, not a hard filter. |
| G3 | Mobile `MAX_QUERY_LENGTH = 100`, server 300. | `apps/mobile/src/features/search/model.ts:60`, `filter.ts` | Pick one (open decision D9). |
| G4 | `ts_rank` has no collection IDF, so a common token weighs the same as a rare one in the fallback. | PostgreSQL docs, text search ranking [DOC] | §7.4: accepted degradation, partly compensated by the in-app re-ranker. |
| G5 | Relaxation is serial: up to 6 engine round trips on a zero-result query. | `application/search.ts` | §3.8: parallel count-only probes. |
| G6 | Some lexicon Franco forms collide with English words or are risky: `satan` (satin), `bunny`/`benny` (brown), `bot` (boots), `mov`. | `lexicon.ts` | §2.6.4: an English-vocabulary guard, and each form carries a weight and a type. |
| G7 | No production writer fills `colors`/`materials` on `IndexedProduct`. | `research_notes/.../facets_and_repo_readiness.md` §1 | §5.4 and §7.1: the colour and material normaliser is part of the index feeder. |
| G8 | Retention conflict: `search_queries` keeps 13 months, then aggregates. Master prompt §B1 keeps analytics events 25 months. | `docs/privacy/data_inventory.yaml` | Open decision D7. |
| G9 | No facet counts, histogram or server-side sort in `GET /v1/search`. | report "Fashion listing filters benchmark" | §5 defines them as an additive contract. |

---

## 1. End-to-end pipeline

```
request (q, filters, cursor, locale, personalized)
  │
  ├─ Q1 normalise (N0..N2, §2.1)            pure, domain
  ├─ Q2 tokenise + script tag (§2.5)        pure, domain
  ├─ Q3 number and price grammar (§3.3)     pure, domain
  ├─ Q4 gazetteer span tagging (Viterbi, §3.2): concepts, sizes, departments, brands, stores, flags
  ├─ Q5 Franco candidates for Latin tokens (§2.6)
  ├─ Q6 spell candidates for unknown tokens (§3.5)
  ├─ Q7 intent scores (§3.6)
  ├─ Q8 build SearchFilter → filterToWire → SearchFilterSchema.parse (Zod)  ← the only output gate
  ├─ Q9 merge with explicit filters (explicit wins), record provenance per key
  │
  ├─ R1 lexical retrieval top N_lex (engine: Typesense or Postgres)     ┐ parallel
  ├─ R2 dense retrieval top N_dense (pgvector, Phase 2b, flag)         ┤
  ├─ F1 facet counts + price histogram (disjunctive, §5)               ┘
  ├─ R3 fusion (§4.4) → R4 business re-rank (§4.5) → R5 diversity + duplicates (§4.6)
  ├─ R6 sponsored slotting (cap 2 in top 10, labelled) (§4.7)
  ├─ R7 live facts re-check for the page only (price, stock, store open), drop failures
  └─ zero results → recovery ladder (§3.8)
```

**Placement rule [INF].** Steps Q1–Q9 and R3–R6 run in our own TypeScript (domain + application layers). Steps R1, R2 and F1 are the only engine-dependent steps. As a result, Typesense, Postgres and the in-memory fake give the same query understanding and the same final ordering logic. Only the candidate sets and lexical scores differ. This is the property that makes the Postgres fallback "reduced features" rather than "different product".

---

## 2. Arabic text pipeline

### 2.1 Normalisation: three levels

Every level is a pure function. It is idempotent (f∘f = f) and applied identically at index time and at query time. Each level is stored as a separate index field, so a query can match on the strictest form available and fall back to the looser one.

**N0 (Unicode hygiene, both scripts).**
1. NFKC. This folds presentation forms such as U+FEFB ﻻ to لا [REPO].
2. Lower-case. JavaScript `toLowerCase` is locale-independent.
3. **Delete** (not space): every `\p{Cf}` (ZWNJ, ZWJ, LRM, RLM, ALM, BOM, soft hyphen) and every `\p{M}` combining mark left after the steps below. This fixes G1.
4. Map digits: Eastern Arabic-Indic U+0660–U+0669 and Persian U+06F0–U+06F9 → ASCII 0–9 [REPO]. Map Arabic decimal separator U+066B → `.` and Arabic thousands separator U+066C → `,` [REPO].
5. Map Arabic comma U+060C, semicolon U+061B and question mark U+061F → space. The current code maps `،` → `,`, which can glue two numbers together ("١٠٠،٢٠٠"). Commas are kept only between digits as a thousands separator. Every other comma becomes a space.

**N1 (strict Arabic orthographic folding, the current behaviour plus loanword letters).**

| Input | Output | Why |
|---|---|---|
| U+064B–U+065F, U+0670, U+0610–U+061A, U+06D6–U+06ED (harakat, superscript alef, Quranic marks) | deleted | Diacritics are rare in queries and vary in titles [DOC: Darwish & Magdy 2014] |
| U+0640 tatweel | deleted | Decorative |
| أ إ آ ٱ | ا | Hamza-on-alef is inconsistently typed [DOC: Larkey et al. 2002] |
| ى (U+0649), ی (U+06CC), ې | ي | Egyptian writing often uses ى for final ي (كحلى) [INF] |
| ة | ه | Final ta marbuta/ha confusion [DOC: Larkey et al. 2002] |
| ؤ → و, ئ → ي | carrier | [REPO] |
| ک → ك | | Persian kaf [REPO] |
| **ڤ (U+06A4) → ف**, **پ → ب**, **چ → ج**, **گ → ج** | new | Egyptian loanwords (ڤيسكوز, چينز). In Egyptian, ج is /g/, so گ and چ collapse onto it [INF, needs a native reviewer] |

**N2 (loose key, for recall fields and the lexicon only).** N1, then:
- Delete standalone hamza ء in word-final position after ا. Egyptian drops it, for example بيضاء → بيضا.
- Collapse a doubled letter produced by a missing shadda variant? **No.** Arabic doubled letters are meaningful and rare in typing. Skip it [INF].
- Fold ه at word end into ة-class. This is already done by N1.
- Fold ذ → ز, ث → س, ظ → ض at **N2 only**. These are Egyptian pronunciation-driven spellings, for example "ازرق" is fine but "بزلة" stands for بدلة/بذلة. The folds are lossy, so N2 is never the only field matched [INF].

**Latin folding L1 (English) and L2 (Franco key).** L1 = N0 plus NFKD and deletion of combining marks, so café → cafe. L2 = `foldLatin` from `lexicon.ts` (o/u, e/i, y/i, repeated letters collapsed, apostrophes and hyphens removed) [REPO]. L2 is used only for lexicon and Franco lookups, never for English matching.

**Fixed-point guarantee.** Each level runs its pass until the output is stable, with a cap of 4 passes, as in the current code [REPO]. The property tests in §6.4 cover each level separately.

### 2.2 Tokenisation and clitics

Tokens are the whitespace-split output of N0–N1, with `.` and `,` kept only inside numbers [REPO]. Arabic proclitics (و، ف، ب، ك، ل، ال and combinations) and enclitics (ه، ها، هم، ي، ك) are handled by the light stemmer in §2.3. The tokeniser does not split them.

### 2.3 Stemming: options compared

| Option | What it does | Self-hosted / licence | Fit for short fashion titles and queries |
|---|---|---|---|
| (a) Normalise only | §2.1 | ours | Misses plurals (فساتين), ال-prefixes, possessives |
| (b) **Light stemmer** (Light10 family) | Strips a closed set of prefixes and suffixes | ours (pure TS); the algorithm is published | Best documented IR effect for Arabic: light stemming beat root stemming on TREC Arabic [DOC: Larkey, Ballesteros, Connell 2002; Aljlayl & Frieder 2002] |
| (c) ISRI root stemmer | Root extraction without a dictionary | NLTK implementation, Apache-2.0 [VERIFY licence] | Over-conflates in a catalogue: كتب/مكتب/كتاب, and fashion nouns are often loanwords with no Arabic root (بنطلون، بلوزة، جينز) [DOC: Taghva et al. 2005 for the algorithm; INF for fit] |
| (d) Snowball Arabic | Rule-based light-to-medium stemmer | BSD [VERIFY that Arabic is in the release Typesense bundles] | Viable alternative to (b). Typesense's `stem` uses Snowball keyed by `locale`, but Arabic `locale` support is **not documented** [DOC: Typesense 30.2 collections page lists ja, zh, ko, th, el, ru, sr, uk, be only] |
| (e) Farasa segmenter | Statistical clitic segmentation | Java, self-contained; research use free, **commercial use needs an HBKU/QCRI licence** [DOC: farasapy README notice; VERIFY in writing] | Accurate on MSA. Licence friction and a JVM in the hot path [DOC: Abdelali et al. 2016] |
| (f) CAMeL Tools (morphological analyser + disambiguator, MADAMIRA successor) | Full morphology, includes dialect resources | Code MIT [DOC: CAMeL-Lab GitHub]. **Data packages (for example Egyptian morphology databases) carry their own licences** [VERIFY] | Python service; heavy for a 150 ms path; best offline for building lexicon variants [DOC: Obeid et al. 2020] |
| (g) MADAMIRA | Morphological analysis and disambiguation, MSA + EGY | Java; licence from Columbia, non-commercial by default [VERIFY] | Same as (f), with worse licence terms [DOC: Pasha et al. 2014] |
| (h) Qalsadi | Morphological analyser (Zerrouki) | Python, GPL [VERIFY] | GPL is incompatible with the closed codebase unless it is isolated as a separate service; MSA-oriented |
| (i) Character n-grams (3–4) | Sub-word matching without linguistics | ours, or `pg_trgm` | Robust to spelling variation and dialect, but noisy ranking [DOC: Mustafa & Al-Radaideh 2004]. Good as a recall field, poor as the main one |

**Choice:** (b) a light stemmer of our own, indexed as a second field next to the unstemmed N1 field, plus (i) trigrams as a typo-recall field. (f) CAMeL Tools is used **offline only**, to propose dialect variants and broken-plural pairs for human review into the lexicon.
**Why:** the light stemmer has the strongest Arabic IR evidence, runs in microseconds inside the domain package, and has no licence risk. Root stemmers over-conflate a loanword-heavy catalogue. Morphological analysers are too heavy and too licence-encumbered for the request path, but they are valuable for building data.

#### 2.3.1 Light stemmer LS (exact procedure, after N1)

Prefixes P, tried longest first, removed at most once: `وال، بال، كال، فال، لل، ال، و`. A prefix is removed only if the remainder has length ≥ 3 for the first six and ≥ 4 for `و` alone.

Suffixes S, tried longest first and applied repeatedly up to 2 times: `ات، ان، ين، ون، يه، ها، هم، ه، ي`. A suffix is removed only if the remainder has length ≥ 3.

These are the Light10 sets [DOC: Larkey et al. 2007], adapted: `ة` is already `ه` after N1, and `هم` is added for Egyptian possessives. Changes to the published sets are [INF].

Guards:
- Tokens that hit the lexicon or gazetteer **before** stemming are not stemmed. The lexicon form wins. This prevents بنطلون → بنطل.
- Latin tokens are never stemmed. English plurals are covered by the lexicon and by an English s/es/ies stemmer on `title_en` (Snowball English, or the engine's) [INF].
- Broken plurals (فساتين ← فستان، جزم ← جزمه، شنط ← شنطه، قمصان ← قميص، بناطيل ← بنطلون، طرح ← طرحه) are **lexicon pairs**, not stemmer output [REPO: several are already forms in `CONCEPTS`].

### 2.4 Egyptian dialect handling

Dialect handling is data, not code. The lexicon becomes a versioned data file, with each concept a set of weighted forms:

```
Concept { id, kind, forms: [{ text, script: ar|lat, type, weight }] }
type ∈ { canonical_en, canonical_ar, msa, egyptian, plural, broken_plural, franco, misspelling, hyponym_of }
```

Default weights [U]:

| Type | Weight |
|---|---|
| canonical / msa / egyptian / plural / broken_plural | 1.0 |
| franco | 0.85 |
| misspelling | 0.7 |

Cross-language matching is resolved through concept ids (§7.2), so it needs no separate weight.

**Seed variant classes for native review [INF; each needs a native Egyptian reviewer before it ships]:**
- **Request verbs and question words (noise):** عايز، عاوز، عايزه، عاوزه، محتاج، نفسي في، ازاي، فين، بكام، ابغى (Gulf), اريد (MSA), "3ayez", "3awez", "ana 3ayza".
- **Footwear:** جزمه/جزم (Egyptian) ≡ حذاء/احذيه (MSA); كوتشي ≡ حذاء رياضي ≡ sneakers; شبشب ≡ slippers/flip-flops (a separate concept from صندل).
- **Bags:** شنطه/شنط ≡ حقيبه/حقائب.
- **Head coverings:** طرحه ≡ حجاب (hijab) ≡ اسكارف/ايشارب (scarf). These are separate concepts with a `related` link at weight 0.5, because a scarf is not always a hijab.
- **Trousers:** بنطلون/بناطيل ≡ سروال (MSA, rare in Egypt).
- **Tracksuits:** ترينج ≡ tracksuit; سويت شيرت ≡ sweatshirt; شورت ≡ shorts.
- **Colours** (each must also map to the palette in §5.4): لبني (light blue), زيتي (olive), نبيتي (burgundy → red family), بمبي (pink), كافيه / بني فاتح (light brown), اوف وايت (off-white → white), منت (mint → green), فوشيا (fuchsia → pink), سيمون (salmon → pink/orange).
- **Materials:** شيفون (chiffon), ستان/ساتان (satin), قطيفه (velvet), تريكو (knit), جبردين (gabardine), كريب (crepe), ليكرا (lycra), جلد طبيعي (genuine leather) vs جلد صناعي/ليزر (faux leather, its own concept, so a "leather" query does not imply genuine).
- **Departments:** حريمي/ستاتي (women), رجالي (men), ولادي (boys → kids), بناتي (girls → kids), اطفال/بيبي (kids).
- **Sizes:** سمول، ميديم، لارج، اكس لارج، اكسترا لارج، 2 اكس، دبل اكس، فري سايز (one size).

**Concept hierarchy (one-way, hyponyms).** shoes ⊃ {sneakers, boots, sandals, slippers, heels}; top ⊃ {blouse, shirt, tshirt}; and similar groups. A query for the parent expands to the children at weight 0.7 [U]. A query for a child does **not** expand to the parent. This is the "one-way synonym" pattern, applied in our code.

### 2.5 Script tagging and code-switching

Each token gets a class:
- `AR`: all letters in the Arabic block after N1.
- `LAT`: `[a-z]+`.
- `FRANCO_D`: Latin letters mixed with Franco digits from {2,3,5,6,7,8,9}, for example "3abaya", "a7mar". This is a strong Franco signal.
- `NUM`: digits with optional `,` `.` `k`.
- `MIX`: Arabic and Latin in one token, for example "فستانdress" from a missing space. MIX tokens are split at the script boundary and re-tagged [INF].

Queries are processed **token by token**. Markers, numbers and concepts may each come from a different script, for example "dress أبيض تحت 1500" [REPO: spec edge case]. Query language (for analytics and for choosing the display-locale tie-break) = the majority script among AR, LAT and FRANCO_D tokens, with ties going to the request `locale`.

### 2.6 Franco-Arabic ("3arabizi") transliteration

#### 2.6.1 Options compared

| Option | Description | Data needed | Notes |
|---|---|---|---|
| (a) Lexicon only (current) | Folded Latin key → concept | curated | Exact for curated words; zero coverage outside the lexicon [REPO] |
| (b) **Rule-based weighted transducer + vocabulary-constrained decoding** | Latin units → Arabic letter options with costs; beam search restricted to a trie of real catalogue words | the mapping table below + the catalogue vocabulary | Deterministic, explainable, no training data. Precision comes from the vocabulary constraint |
| (c) Learned character model (seq2seq/transformer) | Trained on Arabizi→Arabic pairs | thousands of pairs; Egyptian corpora exist in research [DOC: Al-Badrashiny et al. 2014 "3ARRIB"; Darwish 2014] | Better coverage of free text, but non-deterministic and opaque; licences of training corpora vary [VERIFY] |
| (d) Learned costs for (b) | EM over alignments of mined pairs (Franco query → clicked Arabic title) to re-estimate the unit costs of (b) | query logs, after launch | Keeps (b)'s structure and adds data-driven weights [INF] |

**Choice:** (b) now, with (a) as the first lookup, and (d) once at least 5,000 mined pairs exist [U]. (c) is not planned.
**Why:** the catalogue is a closed vocabulary, so constraining decoding to real catalogue words gives high precision without a model. (d) improves it with our own logs, in-region, with no new runtime component.

#### 2.6.2 Unit mapping table (seed costs [U]; c = −ln p)

Latin units are matched longest first: `3'`, `gh`, `kh`, `sh`, `ch`, `th`, `dh`, `ou`, `oo`, `ee`, `ei`, `aa`, then single characters.

| Unit | Arabic options (cost) |
|---|---|
| 2 | ق (0.4, Egyptian glottal stop for /q/: azra2 = أزرق), ء/ا (0.6) |
| 3 | ع (0.05) |
| 3' or gh | غ (0.1) |
| 5 or kh | خ (0.1) |
| 6 | ط (0.2) |
| 7 | ح (0.05) |
| 8 | ق (0.5), غ (0.9) — rare in Egypt |
| 9 | ص (0.5), ق (1.2) — rare in Egypt |
| sh, ch | ش (0.1) |
| th | ث (0.7), ت (0.5) |
| dh | ض (0.6), ذ (0.7), د (0.9) |
| g | ج (0.1, Egyptian /g/), غ (1.5) |
| j | ج (0.1) |
| q | ق (0.1) |
| k | ك (0.2), ق (0.9) |
| h | ه (0.4), ح (0.7) |
| s | س (0.2), ص (0.9) |
| t | ت (0.2), ط (0.9) |
| d | د (0.2), ض (0.9) |
| z | ز (0.2), ظ (1.2) |
| p | ب (0.1) |
| v | ف (0.2) |
| b f l m n r w y | ب ف ل م ن ر و ي (0.05) |
| a, aa | ا (0.5), ε (0.6), ع (1.6), word-final ه (0.7) |
| e, i, ee, ei | ي (0.6), ε (0.5), ا (1.2 word-initial only) |
| o, u, oo, ou | و (0.5), ε (0.7) |

ε = no letter (a short vowel). Word-initial vowels get an extra option, ا (cost 0.3), because Arabic needs a seat for the initial vowel.

#### 2.6.3 Decoding

1. Build a trie over the N1-normalised Arabic vocabulary V_ar. Sources: index-side tokens from `title_ar`, brand AR names and all lexicon AR forms. Each word w has document frequency df(w).
2. Beam search left to right over Latin units. A state is (trie node, accumulated cost). Expanding a unit adds its cost. **A state is dropped if its trie node is null**: the output must stay a prefix of a real word. Beam width B = 32 [U]. At most 3 consecutive ε insertions.
3. Final states at a word-terminal node get the score
   `s(a | x) = −C(x→a) + λ · ln((df(a) + 1) / (N_docs + |V_ar|))`, with λ = 0.3 [U].
4. Candidate posterior: `p(a | x) = exp(s(a|x)) / Σ_{a'∈K} exp(s(a'|x))` over the top K = 5 finals.
5. Keep candidates with p ≥ 0.2 [U], at most 3. Expansion weight = `w_franco · p(a|x)`, with w_franco = 0.85 [U].

**Worked example [INF].** "fostan" → units f, o, s, t, a, n. The path ف ε س ت ا ن has cost 0.05 + 0.7 + 0.2 + 0.2 + 0.5 + 0.05 = 1.70 and is a terminal "فستان" in V_ar. The path ف و س ت ا ن is not in the trie and is dropped. The output is فستان with p ≈ 1, the only candidate, so its weight is 0.85.

#### 2.6.4 Is the token English, Franco or a brand?

For a `LAT` token x, three hypotheses are compared with log-scores:
- `E(x) = ln P_en(x)`, from the English catalogue vocabulary plus a curated fashion EN word list (smoothed df).
- `F(x) = max_a s(a|x) + δ_digits`, where δ_digits = +3 if x is `FRANCO_D` [U].
- `B(x)`: an exact or near-exact (L1, edit distance ≤ 1) hit in the brand/store gazetteer gives +4 [U].

The winning hypothesis decides how x is treated. If |E − F| < 1 [U], **both** readings are kept as an OR group, each weighted by its normalised share. This is what stops `satan` (satin) or `bunny` (brown) from overriding a real English word (G6): when x is an English word that is not in the fashion list, `E` dominates unless a Franco digit is present.

### 2.7 Expansion model and weights

Each surviving query token t becomes a **group** G(t) = {(form, field-set, weight)}:

| Source | Weight [U] |
|---|---|
| exact N1 form | 1.00 |
| light-stem form (LS) on `*_stem` fields | 0.90 |
| concept id on the `concepts` field (§7.2) | 1.00 |
| lexicon same-concept form (dialect, MSA, plural) | via concept id, 1.00 |
| hyponym expansion (parent query → child concepts) | 0.70 |
| `related` concepts | 0.50 |
| Franco candidate a | 0.85 · p(a|x) |
| spelling correction c (§3.5) | 0.70 · conf(c) |
| N2 loose form on `*_loose` fields | 0.60 |
| trigram (fallback only) | 0.40 · similarity |

**Scoring rule:** within a group take the **maximum**, and across groups **sum** (an AND-ish behaviour, governed by minimum-should-match in §4.2). A bilingual title that contains both "فستان" and "dress" must not score twice for one query word [INF].

---

## 3. Query understanding

### 3.1 Contract

```
ParsedQueryV2 {
  normalized: string                      // N1
  filter: SearchFilter                    // ALWAYS the output of SearchFilterSchema.parse(filterToWire(raw))
  provenance: Record<FilterKey, {source: "text"|"explicit", span: [start,end], confidence: number}>
  keywordGroups: Group[]                  // §2.7, for retrieval
  boosts: { categoryConcepts[], brandIds[], storeIds[] }   // soft signals, never filters
  intents: { product, category, brand, store, help } // §3.6, sum to 1
  corrections: { from, to, conf, applied: boolean }[]
  unparsed: string[]
  parserVersion: string
}
```

**Safety invariants (tests in §6.4):**
1. The parser output passes through the same `SearchFilterSchema` as user input. An unknown key, an out-of-range value or more than 30 facets makes the schema throw, and the parser then returns the last valid prefix of its filter, never an invalid one [INF].
2. Free text is never executed, interpolated into SQL, or used as an engine filter expression. It reaches engines only as tokens restricted to `[\p{L}\p{N}]` (as `toTsQuery` does today [REPO]) or as Typesense `q` text, which the engine treats as text.
3. The parser **never sets** `budgetMax`, `fitsRemainingBudget`, `monthlyMax`, `payableWithStoreCredit` or `storeIds` from text. Budget is on-device or request-time only (§12, §20.5). A phrase like "في حدود ميزانيتي" returns a UI hint `suggest_budget_toggle`, not a filter. `mySizeOnly` from "مقاسي/my size" stays, as today [REPO], because it is an explicit shopper request and fails closed without a profile.

### 3.2 Gazetteer span tagging (Viterbi over spans)

Gazetteers:
- lexicon concepts (category, colour, material, occasion later);
- departments;
- size tokens;
- conditions ("جديد بالتيكت" = new_with_tags);
- brands and stores (active only, refreshed from outbox events);
- flags (free delivery, installments, COD);
- noise words.

Each entry has a token sequence (N1, or L2 for Latin) and a weight w_e.

For tokens t₁..tₙ, compute

```
best[0] = 0
best[i] = max( best[i−1] + s_kw(t_i),
               max over gazetteer spans e covering t_{j+1..i}:  best[j] + w_e · (1 + 0.15·(i−j−1)) )
```

s_kw = 0 for an untagged keyword. The term 0.15 per extra token [U] prefers the longer match ("فستان سهره" as one concept over two). Ties go first to the longer span, then to the lexicon declaration order (deterministic, matching the current "first declaration wins" [REPO]). Complexity is O(n · L_max) with L_max = 4 tokens.

**Ambiguity rules [INF]:**
- A colour or material token becomes a **hard** filter only if (a) it is not also a brand or store gazetteer hit, and (b) the query has at least one other content token: a category, another attribute or a keyword. A query that is only "black" becomes a keyword plus a boost, not a filter, so stores or brands with that word are not hidden.
- A brand/store hit never becomes a filter. It goes to `boosts` and to intent (§3.6).

### 3.3 Number and price grammar

EBNF over tokens after N0 (digits already ASCII):

```
price_expr  := max_m amount | min_m amount | amount post_max | amount post_min
             | between_m amount and_m amount | from_m amount to_m amount
             | around_m amount
max_m       := "under"|"below"|"less than"|"up to"|"max"|"within"|"cheaper than"|"taht"|"ta7t"
             | "تحت"|"اقل من"|"اقل"|"حتي"|"لحد"|"لغايه"|"مش اكتر من"|"ميزيدش عن"
min_m       := "over"|"above"|"more than"|"min"|"fo2"|"فوق"|"اكتر من"|"اكثر من"|"من اول"
between_m   := "between"|"بين"
from_m      := "from"|"من"
to_m        := "to"|"الي"|"لـ"|"ل"|"لحد"|"-"
and_m       := "and"|"و"
around_m    := "around"|"about"|"حوالي"|"في حدود"|"تقريبا"
amount      := number [scale] [currency]
number      := digits | digits "," ddd ("," ddd)* | digits "." d{1,2} | word_number
scale       := "k" | "الف"|"آلاف"|"الاف"
currency    := "egp"|"le"|"l.e"|"pounds"|"جنيه"|"جنيهات"|"ج"|"جم"|"ج.م"
discount    := ("خصم"|"off"|"discount") pct | pct ("خصم"|"off")    → minVerifiedDiscountPct
pct         := digits "%" | digits "في الميه" | "نص" (=50)
monthly     := "قسط"|"installment" amount ("في الشهر"|"/month"|"شهري")   → monthlyMax  [parser may NOT set; see 3.1.3 → returns hint only]
size_expr   := ("مقاس"|"size"|"سايز") size_token        → sizes facet (when it exists)
```

Several Egyptian markers are new [INF; native review]: `لحد`, `لغايه`, `مش اكتر من`, `ميزيدش عن`, `لـ`/`ل` as "to", `في حدود`, `في الميه`, `نص`.

**Word numbers (Egyptian and MSA) [INF; native review].** Units: واحد 1, اتنين/اثنين 2, تلاته/ثلاثه 3, اربعه 4, خمسه 5, سته 6, سبعه 7, تمنيه/ثمانيه 8, تسعه 9, عشره 10. Hundreds: ميه/مائه/مية 100, ميتين/مئتين 200, تلتميه 300, ربعميه 400, خمسميه 500, ستميه 600, سبعميه 700, تمنميه 800, تسعميه 900. Thousands: الف 1000, الفين 2000, `<unit> آلاف` = unit × 1000. The value is the sum of the parts, joined by و ("الف و خمسميه" = 1500). Anything outside this closed grammar stays a keyword.

**Semantics:**
- `max_m X` → priceMax = X.
- `min_m X` → priceMin = X.
- `between`/`from..to` → [min(X,Y), max(X,Y)] [REPO].
- `around X` → [⌊0.8X⌋, ⌈1.2X⌉] rounded to the nearest 10 EGP [U].
- The cap is EGP 10,000,000; above it the amount is unparsed [REPO].
- Two conflicting max markers: the last one wins and the earlier one goes to `unparsed`.
- `1.5k` = 1500 [REPO]. `٢ الف` = 2000.
- A **bare number** without a marker:
  - with a footwear concept and a value in 33..48 → a size-facet candidate, used as a boost only;
  - with "مقاس/size" → a size filter;
  - otherwise it stays a keyword but is **excluded from lexical AND matching** (it is in no group), because prices are almost never in titles [INF].

### 3.4 Concept → filter mapping

| Concept kind | Becomes |
|---|---|
| colour | `colors` (palette id, §5.4), subject to §3.2 rules |
| material | `materials` |
| department | `departments` |
| condition | `conditions` |
| category | **a boost plus a lexical group, not `categoryIds`** (G2): the concept→taxonomy table maps a concept to the set of category UUIDs used for boosting. A hard category filter comes only from the sheet. A text query "فستان" should still show an abaya-dress listed under "abaya" [INF] |
| size | `sizes` (new facet; the schema gains it in Phase C of the filter report) |
| flags | as today [REPO] |

### 3.5 Spell correction

| Option | Description | Notes |
|---|---|---|
| (a) Levenshtein scan (current) | O(|V|·L²) per token | Fine for 300 lexicon words; too slow at a 50k catalogue vocabulary [REPO] |
| (b) Symmetric delete (SymSpell) candidate generation | Precompute all deletes up to distance d of every vocabulary word; look up deletes of the query token | Sub-millisecond lookup; memory ~ |V| · C(L,d) [DOC: Garbe, SymSpell, MIT] |
| (c) **(b) + noisy-channel scoring** | Rank candidates by P(c)·P(w|c) with an Arabic/Egyptian confusion model | Classic and well-founded [DOC: Kernighan, Church & Gale 1990; Brill & Moore 2000] |
| (d) Neural corrector | char seq2seq | Needs data and a GPU or a big CPU budget; opaque |

**Choice:** (c), with SymSpell for candidate generation, a weighted Damerau-Levenshtein error model, and a vocabulary built from the catalogue.
**Why:** it needs no training data on day one, reaches sub-millisecond latency, and every correction is explainable. The confusion weights can later be learned from logged reformulation pairs, staying in-region.

**Vocabulary V.** V = tokens from `title_ar`, `title_en`, brand and category names, and all lexicon forms. Query-log terms are added only if they appeared in ≥ 20 distinct sessions [U] **and** retrieved ≥ 1 in-stock product, which keeps private strings out (§7.5). Prior: `P(c) = (df(c) + 1) / (Σ df + |V|)`.

**Error model.** d_w(w, c) is a weighted Damerau-Levenshtein distance with these costs [U]:
- substitution within an Egyptian phonetic class {س,ص}, {ت,ط}, {د,ض}, {ز,ذ,ظ}, {ق,ء,ا} or {ه,ح} costs 0.3;
- Arabic keyboard neighbours (on the standard Arabic 101 layout) and QWERTY neighbours for Latin cost 0.6;
- any other substitution costs 1.0;
- inserting or deleting a long-vowel letter (ا و ي) costs 0.5;
- any other insertion or deletion costs 1.0;
- transposition costs 0.7.

The channel is `ln P(w|c) = −β · d_w(w,c)` with β = 2.0 [U].

**Decision:**
1. Candidates are generated with raw edit distance ≤ k(len), where k = 0 for length ≤ 3, 1 for 4–6 and 2 for ≥ 7 [REPO: `suggest.ts` allowance].
2. `score(c) = ln P(c) + ln P(w|c)`.
3. The query token w itself scores `ln P(w) + 0`; for w ∉ V, P(w) = 1/(Σdf + |V|).
4. Accept c* if `score(c*) − score(w) ≥ θ`, with θ = ln 3 [U].
5. Never correct numbers, tokens tagged by the gazetteer, or brand/store hits.

**Application policy:**
- If the original query returns ≥ 1 result → show "did you mean c*" as a link only (`applied=false`).
- If it returns 0 → re-run with the correction as an OR group with weight 0.7·conf. The response shows "Showing results for X · Search instead for Y". `conf = σ(score(c*) − score(w) − θ)`.
- The "search instead" click rate is logged as the auto-correction regret metric (§7.6).

### 3.6 Intent classification

| Option | Notes |
|---|---|
| (a) **Gazetteer + rule scores** | Works at launch; deterministic |
| (b) Linear classifier (fastText-style bag of character n-grams) on weak labels from clicks | Self-hosted, CPU, MIT [DOC: Joulin et al. 2017]; needs ≥ 50k labelled queries [U] |

**Choice:** (a) now, (b) when the label volume exists. Both produce the same distribution contract.
**Why:** at launch there is no click volume to learn from, and rules over the store, brand and category gazetteers already resolve the navigational cases that matter.

Rule scores (before normalisation) [U]:
- `store = 3·sim_store` if the whole normalised query, or the query minus noise, matches an active store name with similarity sim ≥ 0.85. sim = 1 − d_w/len.
- `brand = 2.5·sim_brand`, same rule.
- `category = 2` if every content token is consumed by category concepts.
- `help = 3` if it matches the help gazetteer (طلباتي, مرتجع, return, refund, order). In that case the UI shows a Help shortcut and still searches products.
- `product = 1` always.

Normalise to sum 1. **Effects (never a hard filter):**
- store ≥ 0.6 → a store card at position 0 (separate from the product list, not counted in the sponsored window);
- brand ≥ 0.6 → a suggested "Brand: X" chip;
- category ≥ 0.6 → category-boost weight doubled in §4.5.

### 3.7 Optional self-hosted model (later, behind `kill.llm_search_parse`)

| Option | Notes |
|---|---|
| (a) None | Grammar and gazetteer only |
| (b) **Sequence tagger (CRF or small BiLSTM-CRF, BIO tags: COLOR, MATERIAL, CATEGORY, PRICE_MAX, …)** | CPU, milliseconds, trained on synthetic + logged queries; deterministic at inference [DOC: Lafferty et al. 2001] |
| (c) Small open-weight instruction LLM, self-hosted, with grammar-constrained decoding to the SearchFilter JSON | Higher coverage of free phrasing. GPU or a large CPU budget; 1.5 s timeout already set in the prompt registry [REPO]; licences of open weights vary [VERIFY per model] |

**Choice:** (b) as the Phase 3 candidate, **only if** the golden-set parser accuracy of the grammar is below 90% exact-match on non-trivial queries [U].
**Why:** a tagger fills exactly the gap the gazetteer leaves (unseen attribute words) at a fraction of an LLM's cost, and it cannot emit structure outside its tag set.

The existing `search_parse` prompt stays bound only to an in-region self-hosted provider, and `kill.llm_search_parse` stays blocked by default. If it is ever enabled, its output is merged only into keys the rule parser left empty, after `SearchFilterSchema`, and any disagreement is counted [INF].

### 3.8 No-result recovery ladder

The existing relaxation order and the hard-constraint list stay as they are [REPO]. Three changes:

1. **Provenance-aware order.** Text-derived filters are relaxed before sheet-chosen filters. The sort key is `(source == "explicit", RELAXATION_ORDER index)`. Hard constraints (world, storeIds, priceMax, budgetMax, fitsRemainingBudget, mySizeOnly) are never relaxed from either source [REPO].
2. **Keyword relaxation comes before filter relaxation**, through minimum-should-match. With n keyword groups, require m = n, then n−1, down to max(1, ⌈n/2⌉). The group dropped first is the one with **the highest IDF among unrecognised tokens** (a rare unknown token is most likely a typo or noise). Recognised concept groups are dropped last [INF].
3. **Parallel probes (fixes G5).** All ladder steps (spell fix, m-relaxations, filter relaxations, up to 6 probes [U]) are issued concurrently as **count-only** queries (`per_page=0`, or `count(*)` with `LIMIT 0` semantics). The first step **in ladder order** with count ≥ 1 is chosen, and only that step is fetched. The zero-result path has its own budget, p95 < 350 ms [U].

**Ladder:**

| Step | Action |
|---|---|
| L0 | spell auto-correction (§3.5) |
| L1..Lk | min-should-match relaxations |
| Lk+1.. | filter relaxations (max 5, as today) |
| final | "No exact matches": category-level popular verified items for the detected category, labelled honestly; else an empty state with suggestions |

Every applied step is returned in `relaxed_filter`/`relaxed_terms`, and `search_no_result` is logged once with the raw zero (§6.2).

---

## 4. Retrieval and ranking

### 4.1 Options compared

| Option | Quality on Arabic/EN/Franco short queries | Cost and latency | Self-hosted | Notes |
|---|---|---|---|---|
| BM25 / **BM25F** over our pre-normalised fields | Strong baseline; IDF and length normalisation per field [DOC: Robertson & Zaragoza 2009; Robertson, Zaragoza & Taylor 2004] | ms | yes | Not native in Postgres (`ts_rank` lacks IDF) or in Typesense |
| Typesense text match | Typo tolerance, prefix, field weights, exact-match priority [DOC: Typesense docs] | ms | yes | The exact scoring is a vendor heuristic, not BM25 [VERIFY]; use it as a rank signal only |
| Postgres `ts_rank`/`ts_rank_cd` | Weak: no collection IDF [DOC: PostgreSQL text-search docs] | ms | yes | Fallback only |
| Learned sparse (SPLADE family; BGE-M3 sparse head) | Good term expansion | GPU for document encoding; heavier | yes | Official SPLADE checkpoints are under a non-commercial licence [VERIFY]; BGE-M3 is MIT [DOC: Chen et al. 2024] |
| Dense bi-encoder: multilingual-e5 small/base (MIT), paraphrase-multilingual-mpnet-base-v2 (Apache-2.0), LaBSE (Apache-2.0), BGE-M3 dense (MIT) | Cross-lingual and vague-intent recall; weaker on exact attributes and numbers [DOC: Wang et al. 2024; Reimers & Gurevych 2020; Feng et al. 2022; Chen et al. 2024] | query embedding on CPU, ~10–30 ms for a short query [INF, VERIFY by benchmark] | yes | Egyptian-dialect and Franco coverage of these models is **unknown** [VERIFY on the golden set] |
| Hybrid fusion: RRF | Robust, parameter-light [DOC: Cormack, Clarke & Büttcher 2009] | trivial | yes | Ignores score magnitudes |
| Hybrid fusion: **convex combination of normalised scores** | Reported to beat RRF and to be sample-efficient to tune [DOC: Bruch, Gai & Ingber 2023] | trivial | yes | Needs score normalisation |
| Learned fusion (LTR over both scores + business features) | Best once labels exist | GBDT CPU | yes | That is ranking v2 (`docs/specs/phase-3/ranking-v2.md`) |

**Choice, phased:**
- **Phase 1–2:** BM25F-style lexical scoring over concept + text fields, computed by the engine as candidate generation and **re-scored in-app**.
- **Phase 2b (flag `search_dense`):** add multilingual-e5-small (or base, decided by the golden set) on pgvector per ADR-0023, fused by convex combination.
- **Phase 3:** fusion weights and business features learned by the ranking-v2 GBDT.

**Why:** lexical-with-concepts already solves cross-lingual exact intent, which is most fashion queries. Dense adds value only for vague and cross-lingual phrasing and must prove it offline. Convex combination has the better published evidence, and doing fusion in-app keeps the Typesense and Postgres paths identical.

### 4.2 Lexical candidate generation and in-app BM25F

**Fields and weights w_f [U]:**

| Field | w_f | b_f |
|---|---|---|
| `concepts` | 3.0 | 0.0 |
| `title_ar` (N1) | 3.0 | 0.3 |
| `title_en` (L1) | 3.0 | 0.3 |
| `brand` | 2.5 | 0.0 |
| `title_ar_stem` (LS) | 2.0 | 0.3 |
| `category_names` (AR+EN) | 2.0 | 0.2 |
| `attr_names` (colour/material labels AR+EN) | 1.5 | 0.2 |
| `title_ar_loose` (N2) | 1.2 | 0.3 |
| `description` | 0.5 | 0.75 |

`concepts` holds the language-independent concept ids, see §7.2. k1 = 1.2 [U].

```
tf~(t,d)   = Σ_f  w_f · tf(t,f,d) / (1 − b_f + b_f · len(f,d)/avglen(f))
idf(t)     = ln( 1 + (N − df(t) + 0.5) / (df(t) + 0.5) )
s(t,d)     = idf(t) · tf~(t,d) / (k1 + tf~(t,d))
S_lex(q,d) = Σ_{g ∈ groups(q)}  max_{(t,w) ∈ g}  w · s(t,d)   +  0.2 · S_lex_max_g · prox(q,d)
```

- prox = 1 if all group matches in `title_*` fall within a 3-token window, else 0 [U].
- Matching requires at least m groups to match (minimum-should-match; m = n for the first pass, §3.8).
- df and avglen statistics are recomputed nightly from `search_documents` and cached. They are corpus statistics, not personal data.

**Engine role.** The engine returns the top N_lex = 300 [U] candidates with all filters applied. Each candidate carries the matched-field info, or the app re-tokenises the stored fields, which is cheap for 300 docs. The app computes S_lex. **Typesense `text_match` or Postgres `ts_rank` order is used only to pick the 300.** Below position 300, ordering falls back to the engine's order (§4.8).

### 4.3 Dense retrieval (Phase 2b, behind a flag)

- **Model:** multilingual-e5-small first (MIT; 384-d [VERIFY]). Base is tried if it gains ≥ 2% NDCG@10 on the AR and Franco slices [U]. ADR-0023 assumes 768-d image/text embeddings. The text-query index is a **separate** column with its own `model_version`.
- **Document text:** `"passage: " + title_ar + " | " + title_en + " | " + brand + " | " + category path + " | " + attribute labels`. The query is `"query: " + normalised text` (the e5 prefix convention [DOC: Wang et al. 2024; VERIFY for the chosen checkpoint]).
- **Index:** pgvector HNSW, cosine, M = 16, ef_construction = 200, ef_search = 80 [U]. Typesense's defaults are M 16 and ef_construction 200, with ef 10 at query time [DOC: Typesense 30.2 vector search], which is low for filtered recall [INF].
- **Filtered ANN:** filters are applied in SQL with over-fetch, `k' = min(4·N_dense, 1000)` [U], or with pgvector iterative index scans if the deployed version supports them [VERIFY version]. A filter whose selectivity is below 2% of the corpus [U] falls back to exact search over the filtered set. This is the same idea as Typesense `flat_search_cutoff` [DOC]. HNSW reference: [DOC: Malkov & Yashunin 2020].
- N_dense = 200 [U]. A distance threshold of cosine similarity < 0.75 [U] drops weak semantic hits, so they never pad results on an exact query.

### 4.4 Fusion

For each candidate d in C = top_lex ∪ top_dense:

```
ŝ_lex(d)   = S_lex(d) / max_{d'∈C} S_lex(d')                 (0 if not retrieved lexically)
ŝ_den(d)   = (cos(d) − 0.75) / (1 − 0.75), clipped to [0,1]  ("theoretical" min-max per Bruch et al.)
S_rel(d)   = α · ŝ_lex(d) + (1 − α) · ŝ_den(d),   α = 0.75 [U]
```

When dense is off, α = 1. The fallback fusion, when a score is unavailable (for example Typesense native hybrid is used for some reason), is RRF: `Σ 1/(60 + rank)` [DOC: Cormack et al. 2009, k = 60].

Typesense native hybrid documents `rank_fusion_score = 0.7·K + 0.3·S` over ranks, with `alpha` adjustable [DOC: Typesense 30.2 vector search]. **It is not used**, so that fusion stays engine-independent [INF].

### 4.5 Business re-ranking

Relevance dominates, and business signals reorder only among relevant items:

```
R(d) = S_rel(d) · gate(d) + β · B(d) + γ · A(d) · 1[personalized]
gate(d) = 1 if S_rel(d) ≥ 0.35 · max S_rel, else 0.5         [U]  (weakly relevant items cannot ride on business signals)
β = 0.30, γ = 0.10                                            [U]
B(d) = Σ_i w_i · φ_i(d),   Σ w_i = 1, each φ_i ∈ [0,1]
```

| φ | Definition | w_i [U] |
|---|---|---|
| φ_disc (verified discount quality) | `claim_allowed ? min(pct, 70)/70 · trust : 0`, where trust = price_trust/100. Seller-claimed or unverified discounts score 0 (§9) | 0.25 |
| φ_pop (virality/popularity) | Wilson lower bound (z = 1.645) of p = kept_orders/views over 28-day exponentially decayed counts (half-life 7 d), times `ln(1+kept_orders)/ln(1+max_kept_in_category)`. Counts come only from closed, non-returned orders by distinct verified buyers, the same anti-gaming basis as the store virality report [REPO: reports/Viral store recommendations home.md; DOC: Wilson 1927; Evan Miller 2009] | 0.20 |
| φ_stock | Non-personalised: the share of the product's size run in stock. Personalised and consented with a size profile: 1 if the recommended size is in stock, else 0.2 | 0.15 |
| φ_trust | price_trust / 100 | 0.10 |
| φ_health | seller_health normalised to [0,1] | 0.10 |
| φ_fresh | 1 / (1 + age_days/7), the same curve as ranking-v2 `freshness` [REPO] | 0.10 |
| φ_return | 1 − min(return_rate, 0.6)/0.6 | 0.10 |
| A(d) (affinity) | 0.5·category_affinity + 0.5·store_affinity, from user features; **0 when personalized = false** [REPO: ranking-v2 contract]; plus the category-intent boost from §3.6 (non-personal, so outside the indicator; added to B as +0.1 when matched) | — |

**Never inputs:** budget, affordability, installment amounts, measurements, age band and identity fields. They are absent by construction, reusing `forbiddenFeatureKeys` [REPO].

**Personalisation toggle.** When `personalized = false`, the user feature store is not read, A = 0, φ_stock uses the non-personal form, and the cache key carries no user id. An integration test asserts that the feature read port is never called [REPO: §13 acceptance].

**Kill switch `kill.ml_ranking`** (exists): any learned model is bypassed and this linear formula is used. A proposed `kill.search_business_rerank` sets β = γ = 0, giving relevance plus a tie-break by freshness.

**Tie-breaks**, for a total and stable order: R desc, then S_rel desc, then listed_at desc, then product_id asc.

### 4.6 Diversity and duplicates

1. **Duplicate collapse.** Items in the same Buy Box group (§20.4: identical item from several sellers) or the same pHash cluster: only the best-scoring item is kept in the top 50, and the others go behind an "Other sellers" link [INF].
2. **Store run constraint** (§20.5: at most 2 consecutive per store). Walk the sorted list greedily. If placing the next item would create a third consecutive item from one store, pick the highest-ranked eligible item within the next W = 10 [U]. If none exists, place the item anyway: never drop.
3. **Optional MMR** on dense vectors, only when dense is on: `λ·R − (1−λ)·max_sim_to_selected`, λ = 0.85 [U] [DOC: Carbonell & Goldstein 1998]. It is off by default, and the golden set decides.

### 4.7 Sponsored slots

- Sponsored candidates come from the ads module (`docs/specs/phase2/10-sponsored-products.md`). They must pass **the same filters and live re-check** [REPO], and a relevance floor: S_rel(ad) ≥ S_rel of the organic item at rank 20, or ≥ 0.35·max S_rel [U].
- Target slots are positions 4 and 9 (1-based) [U]. The cap of 2 in the global top 10 stays enforced by `SponsoredRanker` [REPO]. Every sponsored item carries `sponsored: true` and the "Sponsored" label.
- **De-duplication.** An item appears once. If its organic rank is better than or equal to its ad slot, it is shown organically, unlabelled because it is not paid placement there, and the slot goes to the next eligible ad. If no eligible ad remains, the slot stays organic.
- Ads never enter organic scoring, position-bias training labels (§6.1) or popularity counts. Sponsored clicks are excluded from φ_pop [INF].

### 4.8 Pagination stability

The re-ranked list of the top 300 is computed once per fingerprint `(normalised query, canonical filter, personalized, ranker_version, index_epoch)`. It is cached for 5 minutes [U] in Redis, in-region, holding product ids only. For personalised requests the key includes a salted hash of the user id, and the entry is TTL-only. Pages read from it. Beyond 300, the engine order continues. The cursor already carries offset and sponsored state [REPO], and it gains the fingerprint and index epoch. A changed epoch produces a fresh list, and the client's page boundary may then shift, which is accepted and documented [INF].

Over-fetch for the live re-check: request `⌈1.3 · limit⌉` [U] ids from the cached list per page, so that dropped (sold-out) items do not leave short pages.

### 4.9 Position bias (serving and learning)

- **Serving:** no correction is applied to the ranking itself.
- **Learning and evaluation:** clicks are reweighted by inverse propensity (§6.1).
- **Propensities** are estimated by intervention harvesting from the natural variation between ranker versions [DOC: Agarwal et al. 2019]. They are complemented by **adjacent-pair randomisation** (swap ranks k and k+1, for k in 2..9) on 1% of non-personalised, non-sponsored-slot traffic [U] [DOC: Joachims et al. 2017; Wang et al. 2018].
- The swap never moves a sponsored item and never alters the content shown, only the order of two organic items, so honesty rules are unaffected [INF].
- Until estimates exist, use p_k = (1/k)^η with η = 1.0 [U], clipped so 1/p_k ≤ 10. This matches ranking-v2 "fixed examination curve, replaced by experiment data later" [REPO].

---

## 5. Filters and facets

### 5.1 Facet counts: disjunctive computation

Notation: D(q, F) is the set of matching docs for query q and filter set F, and F_X is the selection on facet X.
- **Conjunctive count** for a value v of facet X when X has no selection: `|D(q, F ∪ {X=v})|`.
- **Disjunctive (multi-select) count:** `count_X(v) = |D(q, F \ F_X ∪ {X = v})|`. Each facet's counts exclude that facet's own selection, so the shopper sees what adding v would give under OR-within-facet semantics [DOC: Ben-Yitzhak et al. 2008; REPO: `FACET_NOTE` "any of within a facet, AND across facets"].

**Procedure.** Let S = {X : F_X ≠ ∅}. Issue 1 + |S| facet queries:
- one with all filters, giving counts for every facet ∉ S and the result list;
- one per X ∈ S with F_X removed, giving counts for X only.

On Typesense this is a `multi_search` with `per_page=0` for the facet-only queries [VERIFY: `multi_search`, `facet_by` and `max_facet_values` behaviour in the deployed version]. On Postgres it is a single scan of the base set `D(q, F \ ∪_{X∈S} F_X)` with conditional aggregation per facet: `count(*) FILTER (WHERE <all selections except X>)` grouped by the unnested value [INF].

**Rules:**
- Counts are computed over the index, so they are **exact with respect to the index**, which is at most 60 s stale. They are never inflated, extrapolated or estimated by sampling. A count shown can differ from the live re-check by sold-out items, and that drift is measured (§7.6) [INF].
- Display: integers in the shopper's numeral preference; > 999 shows "999+" [U].
- **Privacy-scoped facets:**
  - `my_size_only`: a count is computed at request time only for an authenticated shopper with a profile, and is never logged.
  - Budget: no server facet; the on-device filter is unchanged [REPO].
  - Logged-out search keeps rejecting these facets [REPO].
- Per-value cap: 20 values shown, up to 100 behind "show more" (API4).

### 5.2 Zero-count values

- A **selected** value is always shown, even at count 0, so it can be deselected.
- **Closed, small vocabularies** (palette ≤ 16, sizes within a size group, conditions, departments, discount steps): show the value **disabled in place**, with a visible "0" count and `accessibilityState.disabled`. This keeps layout and spatial memory stable [REPO: the filter report reasons from Baymard's finding that most sites keep chosen options in place; the disable-vs-hide choice is an INF recorded there, ADR proposed below].
- **Open vocabularies** (brands, stores, categories beyond the top level): hide zero-count values.
- A **whole facet section** is hidden when no value has count > 0 in the base set and nothing is selected (spec rule: no fake data) [REPO].

### 5.3 Value ordering

- **Ordinal and closed vocabularies:** canonical order always. Sizes ascending within a system. Discount steps 10/20/30/50. Conditions in the schema order. Colours in fixed palette order, achromatic first and then by hue. Count never reorders them [INF].
- **Open vocabularies:** sort by count desc, then by a non-personal popularity prior (the store/brand Wilson quality from the store virality report), then by locale collation (`ar` or `en`). Selected values are pinned to the top of long lists that have "show more" [INF].

### 5.4 Colour normalisation to the palette

The palette is the 16 ids proposed in the filter report: black, white, grey, beige, brown, navy, blue, light_blue, green, olive, yellow, orange, red, pink, purple, multi. The first 13 match the lexicon ids [REPO]. The hex values there are uncited proposals, so their Lab coordinates (sRGB → CIELAB, D65) are derived from those hexes and need design sign-off.

Procedure per SKU, run in the index feeder (G7):
1. **Text first.** Map the seller colour string through the lexicon (all scripts and dialect forms, §2.4) plus a colour-synonym table (burgundy, wine, نبيتي → red; mint → green; off-white, اوف وايت → white; camel, كاميل → beige; fuchsia, فوشيا → pink; and so on). "Multi", "printed", "مشجر" or ≥ 3 named colours → multi.
2. **Image check** (Phase 2, requires the background-removed product image from `docs/specs/phase-3/product-media-background-removal.md`):
   - Run k-means with k = 5 in CIELAB on foreground pixels.
   - The dominant cluster needs a share ≥ 0.40 [U].
   - Assign it the palette entry with the smallest CIEDE2000 distance ΔE₀₀ [DOC: Sharma, Wu & Dalal 2005].
   - Achromatic rule: chroma C* < 8 → black if L* < 22, white if L* > 88, else grey [U].
   - If the nearest ΔE₀₀ > 20 → unknown [U].
   - If the second cluster has share ≥ 0.30 and ΔE₀₀(c1, c2) > 30 → a second colour tag [U].
3. **Conflict.** The text colour wins. If text and image disagree with ΔE₀₀ > 25 [U], the SKU is flagged for seller data quality and the colour is still indexed from the text. The disagreement is never shown to shoppers.
4. A product's facet colours = the union over its in-stock SKUs.

### 5.5 Size normalisation

Canonical model per SKU: `(size_system, size_value, size_group)`.

| size_system | Examples |
|---|---|
| alpha | XXS…5XL, ONE_SIZE |
| eu_women_num | 32–52 |
| eu_men_num | 44–60 |
| waist_in | 24–44 |
| waist_inseam | W32 L34 |
| shoe_eu | 35–48, with halves |
| shoe_uk, shoe_us_m, shoe_us_w | |
| kids_age | 0-3m … 12-14y |
| kids_height_cm | |

The value lists are proposals from the filter report [REPO], not standards.

**Seller-label parser (grammar, deterministic):**
- alpha tokens in Latin or Egyptian transliteration (سمول، ميديم، لارج، اكس لارج = XL, 2 اكس لارج/XXL = 2XL, فري سايز = ONE_SIZE);
- combined labels "S/M" → both values;
- "W32 L34" and "32/34" in a trouser category → waist_inseam;
- a bare number → system by category (shoes → shoe_eu if 33–48; women's tops → eu_women_num; trousers → waist_in if 24–44, else eu);
- "UK 8" or "US 9" → explicit system.

Anything unparsed is `unknown` and is excluded from size facets. It stays visible on the product page.

**Display and conversion:**
- Facet groups are per system and never merged, following Baymard's advice to keep alpha and numeric separate [REPO: the filter report cites Baymard].
- Cross-system translation (alpha ↔ numeric, EU ↔ UK ↔ US shoes) is shown **only** from the brand's own size chart (§10 `size_charts`).
- Without a chart, a default shoe table may be shown as a hint labelled "approximate". Its approximations are [INF/VERIFY]:
  - EU (Paris points, 2/3 cm) ≈ 1.5 × (foot length cm + 1.5);
  - UK adult ≈ 3 × last length in inches − 25;
  - US men ≈ UK + 1, US women ≈ UK + 2.

  Standards to check: ISO 9407 (Mondopoint) and EN 13402 (clothing body dimensions) [VERIFY content].
- **My size** (`my_size_only`) does not use these tables. It is the live fact `inMySize` from the sizing module [REPO].

### 5.6 Price histogram and slider

**Bucketing options:**

| Method | Bin width | Pros | Cons |
|---|---|---|---|
| Equal width | (max−min)/k | Simple | Skewed prices put almost everything in 1–2 bins [INF] |
| Quantile (equal frequency) | edges at F⁻¹(i/k) | Every bin populated | Bars all the same height, so the chart carries no shape |
| Freedman–Diaconis | h = 2·IQR·n^(−1/3) [DOC: Freedman & Diaconis 1981] | Robust to outliers | On raw prices still dominated by the long tail |
| **FD on log price + "nice" edges** | h = 2·IQR(ln p)·n^(−1/3) | Shape visible across 100 to 10,000 EGP; robust | Edges must be snapped to round numbers |

**Choice:** Freedman–Diaconis on log price, clipped to [P1, P99], with k = clamp(⌈(ln P99 − ln P1)/h⌉, 8, 24) [U] and edges snapped to the 1–2–2.5–5 × 10^m sequence. Edges are **precomputed nightly** per (top-level category, world) from in-stock prices. Per request, only range counts are computed.
**Why:** off-price fashion prices are right-skewed [INF]. Log-FD keeps the histogram informative without a per-request distribution pass, and range-count queries are cheap in both engines.

Procedure:
1. Nightly, compute x = ln(price_egp) over in-stock docs per segment, with n ≥ 50; otherwise use the parent segment, then global.
2. Compute P1, P99 and IQR, then h, then k.
3. Raw edges are e_i = exp(ln P1 + i·(ln P99 − ln P1)/k), each snapped to the nearest nice number. Duplicates are removed. Open-ended first and last bins are added.
4. Edges are stored in integer piastres. Bins are [lo, hi), and the last bin is closed.
5. Per request, count docs per bin **excluding the price filter itself** (disjunctive, §5.1), so the histogram shows the full shape while the slider narrows it.

**Slider mapping.** The handle position is u ∈ [0, 1]. Linear in price is rejected (skew), and pure log is the fallback.
- Default: **piecewise-linear quantile mapping.** With bins b₀..b_{k−1} and cumulative counts C_i, `price(u)` interpolates linearly inside the bin where C_i ≤ u·C_total < C_{i+1}. Equal handle travel then covers equal numbers of products.
- If C_total < 50, use the log mapping `price(u) = exp(ln lo + u·(ln hi − ln lo))`.
- Snap step [U]: 10 EGP below 500, 50 below 2,000, 100 below 10,000, 500 above.
- Text inputs accept typed values, which override the snap.
- The inverse `u(price)` must round-trip within one snap step (property test).
- In RTL the min handle sits on the right [REPO: filter report].

---

## 6. Evaluation

### 6.1 Relevance judgments

**Grades:**

| Grade | Meaning |
|---|---|
| 3 | Exact: category matches and every explicit constraint is satisfied |
| 2 | Good substitute: category matches and one soft attribute differs |
| 1 | Related, for example the parent category |
| 0 | Irrelevant, or violates an explicit constraint (price, colour, size) |

**Sources:**
- **(a) Human judges.** Native Egyptian annotators judge pooled top-20s from each candidate ranker, following written guidelines. Agreement is measured with Krippendorff's α, target ≥ 0.6 [U]. Disagreements are adjudicated. This is the gold standard.
- **(b) Click-derived labels**, position-corrected, for monitoring and LTR:

  ```
  r̂(q,d) = (1/n_imp(q,d)) · Σ_i  u_i / p_{k_i},  with u_i = 1 click, 2 add-to-bag, 4 kept purchase (after the return window)   [U]
  ```

  p_k is from §4.9, and the clip is 1/p_k ≤ 10.
  - Pairs with fewer than 30 impressions are discarded [U].
  - Grades come from per-query quantiles of r̂: top 10% → 3, next 20% → 2, next 30% → 1, rest → 0 [U].
  - Sponsored impressions, bot-scored sessions (score ≥ 700‰, as ranking-v2 [REPO]) and the randomised-swap traffic before propensity estimation are excluded.
  - Click-model alternatives are DBN and cascade [DOC: Chapelle & Zhang 2009; Craswell et al. 2008]. IPS is chosen because it plugs directly into ranking-v2's existing approach [REPO].
- **(c) LLM judges are excluded** (no external vendor). A self-hosted judge is not planned.

### 6.2 Offline and online metrics (exact)

**Offline:**
- `DCG@k = Σ_{i=1..k} (2^{g_i} − 1) / log₂(i + 1)`; `NDCG@k = DCG@k / IDCG@k` [DOC: Järvelin & Kekäläinen 2002]. NDCG@10 is the primary metric. ranking-v2 uses exponential gain too [REPO].
- `MRR = mean_q 1/rank_q`, where rank_q is the first result with g ≥ 2 (0 if none in the top 50).
- `Recall@50 = |{d ∈ top50 : g_d ≥ 2}| / |{d ∈ pool : g_d ≥ 2}|`. The pool is the union of the top 50s of all systems judged.
- **Parser exact match:** the share of golden queries whose canonical `SearchFilter` equals the expected one. Field-level precision and recall are reported per facet key.

**Online:**
- `ZRR_raw` = searches with 0 results before recovery / all searches.
- `ZRR_final` = searches with 0 results after recovery / all searches.
- The master prompt target of "no-result rate < 8%" is applied to **ZRR_raw**, the stricter reading (open decision D6).
- **Reformulation rate** = searches followed, in the same session within 120 s [U] and with no click or add-to-bag in between, by another search whose token Jaccard with the first is ≥ 0.2, or whose normalised edit distance is ≤ 0.6 [U] / all searches.
- Also: CTR@10, add-to-bag per search, time to first click, abandonment, auto-correction regret ("search instead" clicks / auto-corrections), and the facet-apply rate.

**Slices (all metrics):** AR, EN, Franco, mixed-script, dialect-marked, contains numerals, contains a price expression, head/torso/tail by query frequency, logged-in vs public, personalised vs not, degraded engine.

**Release gate [U]:**
- overall NDCG@10 ≥ baseline;
- no slice worse by more than 1% relative;
- ZRR_raw not higher;
- parser exact match not lower;
- p95 budget met;
- significance by paired randomisation test, p < 0.05 [DOC: Smucker, Allan & Carterette 2007].

ADR-0022's engine gate (Postgres within 5% NDCG@10 of a Typesense prototype on 500 queries) reuses this harness [REPO].

### 6.3 Synthetic catalogue and query-log generator (spec for `tooling/search-eval/`)

Seeded PRNG (the same seed gives the same corpus). Output: JSONL files for documents, queries and qrels. Synthetic data only, consistent with the current phase [REPO: CLAUDE.md].

**Catalogue generator.**
- Category templates × attributes: colour from the palette, material, department, brand from a synthetic brand list with AR and EN names, condition, size run per system, and stock per size.
- **Titles.** Arabic always present. English present with probability 0.6 [U]. Templates per category in AR (MSA and Egyptian variants) and EN, for example "فستان {material} {color} {style}" and "{brand} {color} linen dress".
- **Orthographic noise in titles** (seller behaviour) [U]:

  | Noise | Rate |
  |---|---|
  | ة written as ه | 0.3 |
  | ي written as ى | 0.3 |
  | hamza dropped | 0.4 |
  | tatweel inserted | 0.02 |
  | diacritics present | 0.03 |
  | Franco title fragment | 0.05 |
  | ZWNJ inside a word | 0.01 |
  | Eastern digits in sizes | 0.2 |

- **Prices.** Log-normal per category, ln p ~ N(μ_c, σ_c) [U], for example dresses μ = ln 900, σ = 0.6, converted to piastres. Verified discount on 35% of items [U], with price_trust ~ Beta(8, 2).
- Popularity follows Zipf (s = 1.1) [U] over products.

**Query generator.** The query intent is sampled first, then a surface form. The query carries its own constraints, which make the labels.
- **Intent template:** category [+ colour] [+ material] [+ department] [+ price expression] [+ size] [+ brand], where each optional slot appears with probability 0.3–0.5 [U].
- **Surface language mix** [U]:

  | Surface form | Share |
  |---|---|
  | AR (Egyptian) | 0.45 |
  | AR (MSA) | 0.10 |
  | EN | 0.25 |
  | Franco | 0.12 |
  | mixed | 0.08 |

- **Surface variants:**
  - Franco variants are drawn from the inverse of §2.6.2 by sampling units with probability ∝ exp(−cost).
  - Eastern digits appear in AR price expressions with probability 0.5.
  - Word numbers (الف و خمسميه) appear with probability 0.1.
  - Request-verb prefix (عايز / I want) appears with probability 0.2.
- **Typo channel** [U]:
  - per token, with probability 0.08, apply one weighted edit drawn from the §3.5 confusion classes;
  - with probability 0.02, apply two edits;
  - keyboard-neighbour substitutions use the Arabic 101 layout and QWERTY.
- **Automatic qrels:**

  | Grade | Condition |
  |---|---|
  | 3 | all constraints met |
  | 2 | category met and exactly one soft constraint (colour or material) missed |
  | 1 | parent category |
  | 0 | otherwise, and any hard constraint (price, size) violated |

  **Synthetic metrics are a regression signal only, never a launch claim.**
- **Click simulator** for testing the IPS pipeline: a position-based model with known p_k = (1/k)^0.9. The test checks that the estimator recovers η within ±0.1 [U].

**Golden sets (human-authored, versioned in-repo, PII-free):**
- **Retrieval golden set:** 500 queries, split 250 AR (≥ 100 Egyptian-dialect), 150 EN and 100 Franco/mixed. This matches ADR-0022.
- **Parser golden set:** ≥ 300 query → expected `SearchFilter` cases, covering every marker in §3.3, every word number, every dialect class in §2.4 and adversarial inputs (SQL fragments, JSON, prompt-injection text, 300-character inputs, emoji, RTL/LTR marks).
- **Normalisation golden table:** ≥ 200 (input, N1, N2, LS) rows reviewed by a native speaker.

### 6.4 Property tests (fast-check; extend `packages/domain/src/search/search.test.ts`)

1. **Idempotence:** `N_i(N_i(x)) = N_i(x)` for N0, N1, N2, L1 and L2, over arbitrary Unicode strings including surrogate pairs, Cf and M characters [REPO for N1].
2. **Closure:** the output of N1 contains no character in {أ إ آ ٱ ى ی ة ؤ ئ ک ـ U+064B–U+065F U+0670 U+0660–U+0669 U+06F0–U+06F9 U+200C–U+200F U+061C}.
3. **Folding equivalence classes:** for every class in §2.1 and every variant v of canonical c, `N1(prefix + v + suffix) = N1(prefix + c + suffix)`.
4. **Format-character transparency (G1):** `N1(insertAt(x, i, ZWNJ)) = N1(x)` for any i inside a word.
5. **Whitespace homomorphism:** `N1(a + " " + b) = N1(N1(a) + " " + N1(b))`.
6. **Stemmer safety:** `|LS(t)| ≥ 3`, or LS(t) = t; LS never changes lexicon tokens or Latin tokens.
7. **Parser totality:** for any string of length ≤ 1,000, `parse` returns without throwing in < 5 ms (p99 in CI) [U].
8. **Parser output validity (never an unknown facet):** `SearchFilterSchema.safeParse(filterToWire(parse(x).filter)).success === true` for all x. `countFacets ≤ 30`.
9. **Privacy keys:** `parse(x).filter` never contains budgetMax, fitsRemainingBudget, monthlyMax, payableWithStoreCredit or storeIds.
10. **Price sanity:** if priceMin and priceMax are both set, priceMin ≤ priceMax; amounts ≤ the cap; amounts are bigint.
11. **Cross-language equivalence:** for generator pairs (AR, EN, Franco) with the same intent, the canonical filters are equal [REPO: the acceptance test for "فستان ابيض لينين تحت ١٥٠٠"].
12. **Digit-script invariance:** replacing ASCII digits with Eastern or Persian digits leaves `parse` unchanged.
13. **Spell safety:** corrections never touch numbers, gazetteer tokens or tokens in V. A correction c* is always in V.
14. **Franco closure:** every transliteration candidate ∈ V_ar. `p` sums to ≤ 1. Weights ∈ (0, 1].
15. **Ranking determinism and stability:** the same inputs give the same order. A permutation of candidate input order gives the same output order (total order by tie-breaks).
16. **Personalisation:** with `personalized=false`, the output is invariant to the user feature values.
17. **Sponsored:** at most 2 in the global top 10 across arbitrary page splits [REPO]. An item is never shown twice.
18. **Store run:** no 3 consecutive items from one store unless the candidate set makes it unavoidable.
19. **Disjunctive facets:**
    - for a selected value v of X, `count_X(v) = |D(q, F \ F_X ∪ {X=v})|`;
    - for an unselected scalar facet, `Σ_v count(v) = |D(q,F)|` minus docs lacking the attribute;
    - for array facets, `Σ ≥` that number;
    - a value with count 0, when applied, yields 0 results.
20. **Relaxation:**
    - it never removes a hard constraint;
    - the result count is non-decreasing along the ladder;
    - it has at most 5 filter steps [REPO].
21. **Histogram:** bins partition [min, max], edges are strictly increasing integer piastres, and counts sum to the total of priced docs.
22. **Slider:** `price(u)` is monotone non-decreasing, and `|price(u(p)) − p| ≤ snap(p)`.
23. **Colour mapping:** deterministic. Every output ∈ palette ∪ {unknown}. Text-only input never consults the image.

### 6.5 Mutation targets (StrykerJS)

The master prompt names ledger, pricing, promotions, reservation, refunds and billing as ≥ 80% [REPO: A2.10]. This spec **adds** search modules at ≥ 80% [U], because they hold honesty and privacy rules:
- `arabic.ts` (all levels);
- light stemmer;
- `lexicon` lookup and Franco decoder;
- price grammar;
- `filter.ts` (relaxation, canonicalisation, facet counting);
- `sponsored.ts`;
- the re-rank scorer (the forbidden-feature guard, gate, tie-breaks);
- disjunctive facet merge;
- histogram edge builder and slider mapping;
- colour mapper.

Surviving mutants on boundary constants, such as `≥` vs `>` at the 0.35 gate or on the allowance thresholds, must be killed by boundary unit tests.

---

## 7. Architecture

### 7.1 Indexing via outbox (staleness SLO 60 s)

**Events consumed** (by the inbox-deduplicated consumer `search-sync`): `product.published|updated|unlisted`, `price.changed`, `price_claim.scored`, `inventory.level_changed`, `store.status_changed`, `seller.health_changed`, and the nightly `popularity.recomputed`.

Procedure per event:
1. Load the product's current projection from the catalog (by id, not from the event payload).
2. Build `IndexedProduct` v2 with the domain functions. N0/N1/N2/LS fields, `concepts`, palette colours (§5.4), normalised sizes (§5.5), φ inputs (verified pct, trust, health, return rate, popularity, size-run stock), `normalizer_version` and `lexicon_version`.
3. Upsert to **both** the primary engine and `search_documents`, so the fallback stays warm.
4. Apply only if `doc_version > stored_version`. The doc version is the catalog row version, which protects against out-of-order events [INF].

**SLO:** p99 of `indexed_at − event.occurred_at` < 60 s over 28 days [REPO target; p99 choice INF]. It is measured on every write and alerted by multi-window burn rate (§T8).

**Index lifecycle:**
- A normaliser or lexicon change that affects index-side fields bumps `normalizer_version`. That triggers a **blue/green full reindex**: build a new collection or table, run the consistency check, then swap an alias (Typesense collection alias [VERIFY]) or rename the table in one transaction (Postgres).
- Query-side-only changes, such as expansion weights, need no reindex.
- Nightly consistency check per store: count and an xor-hash of (product_id, doc_version) between catalog and index. A drift above 0.1% [U] alerts.

### 7.2 Concept indexing and the Typesense schema (if ADR-0022 adopts it)

**Key design: concept indexing [INF].** The feeder runs the same span tagger (§3.2) over titles and attribute fields and writes canonical concept ids, such as `dress`, `white` or `linen`, into a `concepts` string-array field. A query in any script maps to the same ids. Cross-lingual and dialect matching then becomes an exact token match.

This solves three problems:
- Typesense `q` is a single text string, with no weighted OR groups [INF; VERIFY whether any query-time OR syntax exists];
- Typesense synonyms are unweighted [VERIFY];
- the Postgres and Typesense paths behave identically.

**Proposed collection** (all text pre-normalised by us):

| Field | Type | Options |
|---|---|---|
| id | string | |
| store_id, world, condition, department | string | facet |
| title_ar, title_ar_stem, title_ar_loose, title_en, brand, category_names, attr_names, description | string | `locale` left default; `stem: false` because we stem [DOC: Typesense `stem`/`locale` options; Arabic locale support undocumented] |
| concepts | string[] | facet: false |
| colors, materials, sizes, category_ids, brand_id | string[] / string | facet |
| price_amount | int64 (piastres) | facet for range counts [VERIFY range facets] |
| verified_discount_pct, price_trust, seller_health, popularity_q, return_rate_permille, size_run_stock_permille | int32 | |
| lowest_30d, free_delivery_eligible, in_stock, sponsored | bool | |
| listed_at | int64 | default sort |
| doc_version, normalizer_version | int32 | |

Collection options: `token_separators: ["-", "/"]`, `symbols_to_index: []` [DOC: Typesense collection options].

Query parameters:
- `query_by` = concepts, title_ar, title_en, brand, title_ar_stem, category_names, attr_names, title_ar_loose, with `query_by_weights` mirroring §4.2 [VERIFY that the weights semantics fit];
- `num_typos` per field: 0 for concepts, 1 for Arabic fields, 2 for Latin [U; VERIFY that per-field lists are supported];
- `prioritize_exact_match: true`;
- `drop_tokens_threshold: 0`, because recovery is ours (§3.8);
- `per_page` ≤ 250 per call, so N_lex = 300 needs 2 pages or a smaller N [VERIFY the max per_page].

**Synonyms:** none in Typesense. All expansion is query-side (§2.7) [INF].

The Postgres `search_documents` gains `concepts text[]` (GIN), `title_ar_stem`, `title_ar_loose`, a weighted tsvector (setweight A = title/concepts, B = brand/category, C = attributes, D = description), and `sizes text[]`. These are additive expand/contract migrations [REPO: §T3].

### 7.3 Latency and cost budget (server-side, p95 target < 150 ms)

| Stage | p95 budget [U] | Notes |
|---|---|---|
| Q1–Q9 query understanding | 5 ms | Pure TS. SymSpell and trie lookups in memory |
| R1 lexical top-300 | 40 ms | Parallel with R2 and F1 |
| R2 dense (query embed ~15 ms + ANN ~20 ms) | 40 ms | Phase 2b only. CPU ONNX runtime [VERIFY by benchmark] |
| F1 facets (1 + \|S\| queries) | 40 ms | Parallel. Skipped when the client asks for no counts |
| R3–R6 fusion, re-rank, diversity, sponsored | 5 ms | In memory over ≤ 500 ids |
| R7 live re-check (one batched SQL by ids) | 30 ms | Must hit the primary or a replica with lag below 5 s (§5 PDP staleness rule) [REPO] |
| Serialisation | 5 ms | |
| **Critical path** | ≈ 5 + 40 + 5 + 30 + 5 = **85 ms** | Leaves ~65 ms headroom |

**Engine timeout.** The current timeout is 300 ms before fallback [REPO]. Proposed: 120 ms [U], plus a circuit breaker that opens after 5 failures in 10 s and half-opens after 30 s [U], so that a sick primary does not add 120 ms to every request. This is open decision D8, because the change touches the tested adapter.

**Cost [INF].** All components are CPU and self-hosted: Typesense node(s) if adopted, the pgvector replica (ADR-0023), and one stateless ONNX embedding service. There is no per-query vendor fee. Memory sizing for Typesense and HNSW needs a benchmark on the real catalogue size [VERIFY].

### 7.4 Degraded mode (Postgres FTS/trigram) and what degrades

| Capability | Primary | Postgres fallback (`kill.search_engine` or outage) |
|---|---|---|
| Normalisation, stemming, Franco, dialect, concepts, parser, spell correction | in-app | **unchanged** (in-app) |
| Lexical candidate scoring | engine text match → in-app BM25F | `ts_rank_cd` with setweight → in-app BM25F over the same 300 candidates. IDF comes from the nightly stats, so the final order is close; **candidate recall is lower** because `ts_rank` (no IDF) picks the 300 (G4) |
| Typo tolerance | engine typos + spell correction | spell correction + trigram rescue only when FTS returns 0 [REPO] |
| Dense hybrid | pgvector (separate replica) | **still available** if the replica is healthy, since it does not depend on Typesense |
| Facet counts | multi-search | closed vocabularies + histogram only. Open-vocabulary facets (brand, store) are omitted. `facets_degraded: true` |
| Re-rank, diversity, sponsored cap, live re-check | in-app | unchanged |
| Response flag | — | `degraded: true` [REPO] |

Both engines down → 503 `search_unavailable` [REPO].

**Kill switches.** Existing: `kill.search_engine`, `kill.llm_search_parse` (default blocked), `kill.ml_ranking`. Proposed additions to `packages/feature-flags/src/registry.ts`, all fail-closed to the simpler behaviour:

| Switch | Effect |
|---|---|
| `kill.search_dense` | α = 1 |
| `kill.search_business_rerank` | β = γ = 0 |
| `kill.search_autocorrect` | suggest only, never apply |
| `kill.search_facet_counts` | total only, for load shedding during drops |

### 7.5 Privacy

- **Query logs (`search_queries`):**
  - no user id;
  - a pseudonymous session id rotated daily [INF];
  - fields: locale, script class, result counts (raw and final), relaxation steps, latency, engine, ranker_version and personalized flag.
- `query_text` stays **P2** until the scrubber is proven [REPO: `data_inventory.yaml`]. The scrubber runs before storage:
  - redact Egyptian mobile numbers (`(\+?20|0)1[0125]\d{8}`);
  - redact emails, URLs and 14-digit national-ID-shaped runs;
  - redact any digit run ≥ 7;
  - store `term_char_count` as the events already do [REPO: `docs/analytics/events.md`].
- **Tail protection:** a normalised query string is retained beyond 90 days [U] only if seen in ≥ 20 distinct sessions [U]. Otherwise only its hash and counts survive, until the aggregation horizon (13 months in the inventory vs 25 months in §B1, open decision D7).
- Seller-facing search terms keep the existing k ≥ 50 release rule [REPO: `data_inventory.yaml` line ~3865].
- **Click logs for IPS:** (query hash, product id, position, ranker version, randomised flag, propensity bucket, clicked/bagged/kept). No user id. 30-day retention, like ranking shadow logs [REPO].
- **Never logged or used in ranking:** budget values, size-profile values, measurements, `my_size_only` counts, affordability [REPO: §12, ranking-v2].
- **Residency:** the embedding model, spell vocabularies, the Franco decoder, all logs and the caches run and live in the approved region. Model weights are artefacts, not personal data. Their licences are recorded in a model-card stub per model before deployment [INF]. `cross_border_ml` consent is not needed, because nothing crosses a border.

### 7.6 Observability

**Metrics** (OpenTelemetry, tags: engine, degraded, locale, script_class, personalized):
- `search_latency_ms{stage}` histogram;
- `search_zero_raw_total`, `search_zero_final_total`, `search_relaxation_steps` histogram;
- `search_autocorrect_applied_total`, `search_autocorrect_undo_total` (regret);
- `search_franco_detected_total`, `search_dialect_marker_total`;
- `search_index_staleness_seconds` histogram (SLO), `search_index_drift_ratio`;
- `search_recheck_drop_ratio` (index said in stock, live said no; alert above 2% [U]);
- `search_facet_latency_ms`, `search_facet_degraded_total`;
- `search_sponsored_top10_violations_total` (must be 0) [REPO metric];
- `search_rerank_cache_hit_ratio`;
- `search_parser_unparsed_total{reason}`.

**Traces:** one span per stage (Q, R1, R2, F1, R3–R6, R7) with business tags. Raw query text never appears in spans or logs; the hash only, at INFO.

**Dashboards:** an Admin search-health page (§23 "search health") with ZRR by slice, the reformulation rate and top zero-result normalised queries (k ≥ 20 only).

---

## 8. Hand-off plan for the builder (each step testable; tier per the delegation table)

| # | Step | Tier | Done when |
|---|---|---|---|
| 1 | Normaliser N0–N2, L1 and the G1 fix; light stemmer LS | Builder (Sonnet) + Tester | Property tests 1–6 green; golden normalisation table green; mutation ≥ 80% |
| 2 | Lexicon to a versioned data file with weighted forms and hierarchy; dialect seed (native review required before merge) | Builder; native reviewer (owner) | Lexicon schema test; no duplicate key conflicts; G6 guard tests |
| 3 | Viterbi span tagger, price grammar (Egyptian markers, word numbers), concept→filter mapping, ParsedQueryV2 with provenance | Builder + Tester | Parser golden set ≥ 300 cases; property tests 7–12 |
| 4 | Franco decoder (trie-constrained beam) + English/Franco/brand decision | Architect review of costs, then Builder | Property test 14; Franco slice exact match ≥ 85% [U] |
| 5 | SymSpell + noisy channel spell correction with the application policy | Builder | Property test 13; regret metric wired |
| 6 | Index feeder v2: concepts, palette colours (text path), sizes, φ inputs, versioning, dual write (fixes G7) | Builder; Architect review of the event set | Staleness histogram exported; drift check job; outbox replay idempotency test |
| 7 | In-app BM25F re-scoring, fusion stub (α = 1), business re-rank, diversity, sponsored slots, cache + cursor fingerprint | Builder + Tester | Property tests 15–18; personalisation integration test |
| 8 | Disjunctive facet counts + log-FD histogram + quantile slider contract (additive OpenAPI: `facet_counts`, `price_histogram`, `sort`) | Architect writes the OpenAPI delta; Builder implements | Property tests 19, 21, 22; Postgres and in-memory adapters agree with a reference implementation |
| 9 | Parallel recovery ladder (fixes G5) | Builder | Property test 20; zero-path p95 < 350 ms in k6 |
| 10 | Eval harness: generator, golden sets, metrics, IPS estimator | Tester + Architect | Reproducible report; click-simulator recovery test |
| 11 | ADR-0022 gate run (Postgres vs Typesense prototype) | Architect | Gate verdict recorded in ADR-0022 |
| 12 | Phase 2b dense retrieval (pgvector, e5) behind `kill.search_dense` | Architect benchmark first, then Builder | Release gate in §6.2 passes, or the feature stays off |
| 13 | Image colour check (Phase 2, needs background removal) | Builder | Property test 23; ΔE thresholds tuned on a labelled set |

A chief-reviewer checkpoint is advised at steps 6–8 and 12 for the privacy rules (§7.5): personal-data flow into ranking and logs.

---

## 9. Open decisions and unverified points

### 9.1 Open decisions (owner or architect)

| ID | Decision | Safe default if no answer |
|---|---|---|
| D1 | ADR-0022: Typesense now, or after the gate | Postgres primary with the gate (ADR-0022 default) |
| D2 | Native Egyptian reviewer for the dialect lexicon, Franco costs, word numbers and colour names (**required before the AR/Franco slices ship**) | Ship only the reviewed subset |
| D3 | Dense retrieval at all (Phase 2b): adopt only if the release gate shows a gain | Off |
| D4 | Disable-in-place vs hide for zero-count closed-vocabulary values (needs an ADR, as the filter report says) | Disable in place |
| D5 | Category from text as a boost (this spec) vs a hard filter | Boost |
| D6 | The "< 8% no-result" target applied to ZRR_raw or ZRR_final | ZRR_raw |
| D7 | `search_queries` retention: 13 months (inventory) vs 25 months (§B1 analytics); the raw tail horizon of 90 days | The shorter: 13 months aggregated, 90 days raw |
| D8 | Engine timeout 300 ms → 120 ms + circuit breaker | Keep 300 ms until a load test |
| D9 | Query length cap: mobile 100 vs server 300 (G3) | Server 300; mobile raised to 300 |
| D10 | Ad slot positions 4 and 9, and the ad relevance floor | As specified, behind config |
| D11 | Palette hex values and Arabic colour names (design and native sign-off) | The filter report proposal, marked provisional |
| D12 | Sizes facet in the wire schema (new key `sizes`, counts toward the 30-facet cap) | Add in Phase C of the filter report |

### 9.2 Unverified points

1. Typesense Arabic support: `locale: "ar"` tokenisation and Snowball Arabic stemming are **not listed** in the 30.2 docs (the listed locales are ja, zh, ko, th, el, ru, sr, uk, be, non-exhaustive). The design avoids depending on them by pre-normalising and stemming in-app.
2. Which Typesense version the repo would target: the repo has a stub and no pinned version. The docs read were 30.2 (2026-10-16).
3. Typesense features this design touches:
   - per-field `num_typos` lists;
   - `query_by_weights` semantics;
   - range facets on int64;
   - the max `per_page`;
   - collection aliases;
   - `multi_search` limits;
   - synonym weighting (assumed absent);
   - the exact `text_match` formula.
4. Typesense hybrid: the docs state `rank_fusion_score = 0.7·K + 0.3·S` over ranks with `alpha`, and HNSW defaults M 16, ef_construction 200, ef 10, plus `distance_threshold` and `flat_search_cutoff` [DOC: read 2026-10-16]. Whether K and S are raw ranks or reciprocal ranks was not confirmed. This does not matter, because the design fuses in-app.
5. Licences: Farasa (research-only per a wrapper notice; commercial terms need written confirmation from HBKU/QCRI), MADAMIRA (assumed non-commercial default), Qalsadi (assumed GPL), ISRI in NLTK (assumed Apache-2.0), CAMeL Tools data packages (code is MIT; data licences unchecked), SPLADE checkpoints (assumed non-commercial), multilingual-e5 / BGE-M3 (assumed MIT), mpnet / LaBSE (assumed Apache-2.0).
6. The multilingual-e5-small dimension (assumed 384) and CPU latency (assumed 10–30 ms per short query): both need a benchmark.
7. Coverage of Egyptian dialect and Franco in any open embedding model: unknown, so it must be measured on the golden set.
8. pgvector version and whether iterative index scans for filtered HNSW are available on the managed Postgres the repo targets.
9. Size conversion approximations (Paris point and UK barleycorn formulas, US = UK + 1/+2) and the contents of ISO 9407 / EN 13402: not read.
10. Egyptian pronunciation-based confusion classes, Franco digit conventions (2 → ق in Egyptian) and the dialect word lists are my inference and need a native linguist.
11. The skewness of Z-OUTLET prices is assumed. The current data is synthetic.
12. The assumption that `ts_rank` has no collection-wide IDF comes from the PostgreSQL text-search documentation as I recall it. It was not re-read today.

---

## 10. References

**Arabic IR, morphology and dialect**
- Larkey, L. S., Ballesteros, L., Connell, M. E. (2002). *Improving Stemming for Arabic Information Retrieval: Light Stemming and Co-occurrence Analysis.* SIGIR.
- Larkey, L. S., Ballesteros, L., Connell, M. E. (2007). *Light Stemming for Arabic Information Retrieval.* In Soudi, van den Bosch, Neumann (eds.), Arabic Computational Morphology, Springer.
- Aljlayl, M., Frieder, O. (2002). *On Arabic Search: Improving the Retrieval Effectiveness via a Light Stemming Approach.* CIKM.
- Taghva, K., Elkhoribi, R., Coombs, J. (2005). *Arabic Stemming Without a Root Dictionary* (ISRI). ITCC.
- Darwish, K., Magdy, W. (2014). *Arabic Information Retrieval.* Foundations and Trends in IR.
- Abdelali, A., Darwish, K., Durrani, N., Mubarak, H. (2016). *Farasa: A Fast and Furious Segmenter for Arabic.* NAACL Demos.
- Obeid, O. et al. (2020). *CAMeL Tools: An Open Source Python Toolkit for Arabic Natural Language Processing.* LREC. Repository: CAMeL-Lab/camel_tools (MIT).
- Pasha, A. et al. (2014). *MADAMIRA: A Fast, Comprehensive Tool for Morphological Analysis and Disambiguation of Arabic.* LREC.
- Zerrouki, T. *Qalsadi Arabic morphological analyzer* (software, GitHub linuxscout/qalsadi).
- Snowball project. *Arabic stemming algorithm* (snowballstem.org, BSD).
- Mustafa, S. H., Al-Radaideh, Q. A. (2004). *Using N-grams for Arabic Text Searching.* JASIST 55(11).
- Habash, N., Diab, M., Rambow, O. (2012). *Conventional Orthography for Dialectal Arabic.* LREC.
- Darwish, K. (2014). *Arabizi Detection and Conversion to Arabic.* ANLP Workshop at EMNLP.
- Al-Badrashiny, M., Eskander, R., Habash, N., Rambow, O. (2014). *Automatic Transliteration of Romanized Dialectal Arabic.* CoNLL.

**Query understanding**
- Kernighan, M. D., Church, K. W., Gale, W. A. (1990). *A Spelling Correction Program Based on a Noisy Channel Model.* COLING.
- Brill, E., Moore, R. C. (2000). *An Improved Error Model for Noisy Channel Spelling Correction.* ACL.
- Garbe, W. *SymSpell* (software, MIT, 2012 onward).
- Norvig, P. (2007). *How to Write a Spelling Corrector* (essay).
- Joulin, A., Grave, E., Bojanowski, P., Mikolov, T. (2017). *Bag of Tricks for Efficient Text Classification.* EACL.
- Lafferty, J., McCallum, A., Pereira, F. (2001). *Conditional Random Fields.* ICML.

**Retrieval, fusion, ANN, diversity**
- Robertson, S., Zaragoza, H. (2009). *The Probabilistic Relevance Framework: BM25 and Beyond.* FnTIR.
- Robertson, S., Zaragoza, H., Taylor, M. (2004). *Simple BM25 Extension to Multiple Weighted Fields.* CIKM.
- Formal, T., Piwowarski, B., Clinchant, S. (2021). *SPLADE: Sparse Lexical and Expansion Model for First Stage Ranking.* SIGIR.
- Chen, J. et al. (2024). *BGE M3-Embedding: Multi-Lingual, Multi-Functionality, Multi-Granularity Text Embeddings Through Self-Knowledge Distillation.* arXiv:2402.03216.
- Wang, L. et al. (2024). *Multilingual E5 Text Embeddings: A Technical Report.* arXiv:2402.05672.
- Reimers, N., Gurevych, I. (2020). *Making Monolingual Sentence Embeddings Multilingual using Knowledge Distillation.* EMNLP.
- Feng, F. et al. (2022). *Language-agnostic BERT Sentence Embedding.* ACL.
- Cormack, G., Clarke, C., Büttcher, S. (2009). *Reciprocal Rank Fusion Outperforms Condorcet and Individual Rank Learning Methods.* SIGIR.
- Bruch, S., Gai, S., Ingber, A. (2023). *An Analysis of Fusion Functions for Hybrid Retrieval.* ACM TOIS.
- Malkov, Y., Yashunin, D. (2020). *Efficient and Robust Approximate Nearest Neighbor Search Using Hierarchical Navigable Small World Graphs.* IEEE TPAMI.
- Carbonell, J., Goldstein, J. (1998). *The Use of MMR, Diversity-Based Reranking for Reordering Documents and Producing Summaries.* SIGIR.
- Ben-Yitzhak, O. et al. (2008). *Beyond Basic Faceted Search.* WSDM.

**Bias, evaluation, statistics**
- Joachims, T., Swaminathan, A., Schnabel, T. (2017). *Unbiased Learning-to-Rank with Biased Feedback.* WSDM.
- Wang, X., Bendersky, M., Metzler, D., Najork, M. (2016). *Learning to Rank with Selection Bias in Personal Search.* SIGIR.
- Wang, X. et al. (2018). *Position Bias Estimation for Unbiased Learning to Rank in Personal Search.* WSDM.
- Agarwal, A. et al. (2019). *Estimating Position Bias without Intrusive Interventions.* WSDM.
- Chapelle, O., Zhang, Y. (2009). *A Dynamic Bayesian Network Click Model for Web Search Ranking.* WWW.
- Craswell, N., Zoeter, O., Taylor, M., Ramsey, B. (2008). *An Experimental Comparison of Click Position-Bias Models.* WSDM.
- Järvelin, K., Kekäläinen, J. (2002). *Cumulated Gain-Based Evaluation of IR Techniques.* ACM TOIS.
- Smucker, M., Allan, J., Carterette, B. (2007). *A Comparison of Statistical Significance Tests for Information Retrieval Evaluation.* CIKM.
- Wilson, E. B. (1927). *Probable Inference, the Law of Succession, and Statistical Inference.* JASA. Miller, E. (2009). *How Not To Sort By Average Rating* (essay).
- Freedman, D., Diaconis, P. (1981). *On the Histogram as a Density Estimator: L2 Theory.* Z. Wahrscheinlichkeitstheorie verw. Gebiete.
- Sharma, G., Wu, W., Dalal, E. (2005). *The CIEDE2000 Color-Difference Formula: Implementation Notes, Supplementary Test Data, and Mathematical Observations.* Color Research & Application.

**Vendor and tool documentation (read 2026-10-16 unless noted)**
- Typesense (2026). *Collections API* (v30.2 docs): `locale`, `stem` (Snowball), `token_separators`, `symbols_to_index`.
- Typesense (2026). *Vector Search* (v30.2): hybrid `rank_fusion_score = 0.7·K + 0.3·S`, `alpha`, HNSW `M` = 16, `ef_construction` = 200, `ef` = 10, `distance_threshold`, `flat_search_cutoff`.
- Typesense (2026). *Semantic search guide*: built-in models ts/all-MiniLM-L12-v2, ts/e5-small-v2, ts/gte-small, ts/paraphrase-multilingual-mpnet-base-v2.
- PostgreSQL Global Development Group. *Text Search: Ranking Search Results*; *pg_trgm*. Not re-read today.
- pgvector project. *README: HNSW, IVFFlat, filtering.* Not re-read today; version-specific features [VERIFY].
- farasapy (PyPI/GitHub). README licence notice for the Farasa toolkit (research only; commercial use by contacting the creators).

**Repo sources:** `docs/haul-master-prompt-v3.md` §4, §5, §8, §12, §20.5, §26, §T3, §T12; `docs/specs/search.md`; `docs/adr/0022-search-engine-primary.md`; `docs/adr/0023-recommendation-retrieval-store.md`; `docs/specs/phase-3/ranking-v2.md`; `reports/Fashion listing filters benchmark.md`; `research_notes/Fashion listing filters benchmark/facets_and_repo_readiness.md`; `reports/Viral store recommendations home.md`; `docs/privacy/data_inventory.yaml`; `docs/analytics/events.md`; the code paths listed in §0.1.
