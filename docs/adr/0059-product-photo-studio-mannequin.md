# ADR-0059: Product photo studio: template compositing with rigid transforms, no generative on-model step

- Status: **Proposed** (nothing built; safe defaults below; owner decisions O-1..O-8 and VR-STUDIO-01..11 open)
- Date: 2026-10-18
- Deciders: Owner, Product, CTO, ML lead, Legal, DPO
- Spec: [`docs/specs/product-photo-studio.md`](../specs/product-photo-studio.md)
- Master prompt refs: §19, §27, §11, §T3, §T5, §T10, §B1, §B5, §B7, A2.13
- Related: ADR-0002 (residency), ADR-0028 (kill-switch polarity), ADR-0029 (Unconfigured fails closed), ADR-0033 (Redis), ADR-0051 (own AI, no external AI vendor), ADR-0056 (seller entitlements); `docs/specs/phase-3/product-media-background-removal.md`; `apps/ml-services/bg-removal/MODEL_LICENSES.md`

## Context

Owner request: "I upload a t-shirt and it removes its background and maybe puts it on a mannequin too". Background removal is built (self-hosted sidecar, quality score, manual refine, versions, seller decision, link to product; kill switch default blocked; Unconfigured in production). The open question is the "mannequin" step: how to present a garment on a form, hanger or flat-lay without misrepresenting the product, inside the residency, licence and cost limits that already bind the project.

Constraints: A2.13 and CPL 181/2018 (never misleading presentation; article text VR-07/VR-REV-01); ADR-0051 (no external hosted AI vendor; self-hosted only); ADR-0002 (region open; no P2/P3 cross-border without licence and consent); GPU availability in region unverified (VR-AI-02); CPU-only sidecar today.

## Considered options for the mannequin step

| Criterion | A. Ghost mannequin from two real shots | B. Template compositing, rigid transforms only (mannequin form, hanger, flat-lay board, plinth) | C. Generative on-model or on-mannequin (diffusion try-on) |
|---|---|---|---|
| What the buyer sees | Real garment pixels from two photos, mannequin removed | Real garment pixels from one photo, placed on a commissioned template | Re-synthesised garment on a generated person or form |
| Complexity | Medium-high: two-shot capture, alignment of the inner neck patch, seller needs a physical mannequin | Low: deterministic compose in the existing sidecar, per-category anchors | High: GPU serving, model ops, evaluation sets |
| Accuracy / honesty | High (all photographed) | High (all photographed; uniform scale, ±5° rotation, translation only; ΔE and SSIM hard gates) | Low by design: can change colour, print, length, drape and fit and invents detail; fails a structure gate |
| Cost per image | CPU, about twice B | CPU, sub-second compose (estimate) | GPU, two to three orders of magnitude more energy (estimate) plus fixed GPU cost |
| Scalability | Limited by seller capture effort | High; batchable | Bounded by GPU capacity in region |
| Licence | Same as cutout models | Same as cutout models + commissioned art | Try-on models reported non-commercial; not verified (VR-STUDIO-03) |
| Residency | In-region sidecar | In-region sidecar | Needs in-region GPU (VR-AI-02); external vendor ruled out by ADR-0051 |

Secondary choices (spec section 1): server-side authoritative render vs on-device render (server chosen; device is preview only); Postgres `SKIP LOCKED` job table vs BullMQ (Postgres chosen: low volume, the row is already the state machine, Redis is never a source of truth per ADR-0033).

## Decision

**B now, A as a later phase, C not built.** Template compositing keeps every garment pixel photographed, so colour, print, cut and length cannot drift, and it runs on the CPU sidecar that already exists with no new model licence. Ghost mannequin is equally honest but needs sellers with physical mannequins, so it follows when demand shows. Generative on-model is rejected for now on honesty, licence, residency and cost grounds; `kill.photo_studio_generative` exists only as a permanently blocked switch with no adapter.

Binding rules:
1. Transforms are rigid only (uniform scale, rotation within ±5°, translation); no warp, inpainting, recolouring or detail edits. The request schema cannot express anything else; the gate re-checks it.
2. Hard gates before publish: CIEDE2000 colour (render vs cutout, cutout vs ICC-converted original, each lossy variant), SSIM structure, no crop, minimum resolution, edit label present.
3. Original always retained and viewable by any buyer (signed link ≤ 10 min). `edit_label` (`none | background_replaced | composited | ai_generated` reserved) is derived by code.
4. Templates are visibly mannequins (matte, faceless), commissioned and owned, baked into the signed image with SHA-256 pins; no SVG, no URL inputs (no SSRF surface).
5. Size-aware placement uses the product's own size chart and the photographed size; on mismatch it falls back to unscaled with no size caption. Nothing is estimated.
6. `on_model` and `detail` shots get background replacement only.
7. Residency: same egress-deny, in-region pod as the cutout sidecar; no image leaves the region.
8. Cost: ADR-0056 entitlements `media.*`, fail closed to the fallback plan; existing 200 runs/day/store abuse ceiling; queue circuit breaker.
9. Kill switches (allowed-when-true, default blocked): `kill.photo_studio`, `kill.photo_studio_ghost`, `kill.photo_studio_generative`. Blocking stops new renders only.

## Consequences

- Positive: delivers the owner's "mannequin" look without a GPU, vendor or new model licence; deterministic and auditable; reuses the cutout job, versions, graveyard and resolver.
- Negative: a flat-lay garment on a form looks less natural than a ghost-mannequin or on-model photo; template art must be commissioned (O-1); colour gates prove only that the pipeline did not change colour, not that the seller's lighting is accurate.
- Engineering gap found while writing this ADR: the sidecar strips the ICC profile on re-encode without converting to sRGB first; Display P3 phone photos may shift colour. Fix is spec task S1-1 and is needed regardless of the studio.

## Safe defaults until the owner decides

No templates until art exists (backgrounds and `none` only); neutral "About this photo" info, no on-image badge; placeholder entitlements (100 renders/month on the fallback plan); seller chooses the primary image; signed links as today; generative not built.

## Owner decisions required

O-1 template art and budget · O-2 label wording · O-3 entitlement values and studio CPU budget · O-4 generative ever · O-5 ghost-mannequin phase · O-6 kids and long templates · O-7 primary-image default · O-8 public CDN caching (spec section 20).

## VERIFY BEFORE LAUNCH

VR-STUDIO-01..11 (labelling duty, Seller Agreement image licence, generative model licences, template IP, colour and placement thresholds on real photos, Apple and on-device API, people in photos, AV engine and dependency licences, measured cost and carbon, tax if sold as an add-on), plus existing VR-P3-BG-01..06, VR-AI-01, VR-AI-02, VR-AI-04, VR-18.
