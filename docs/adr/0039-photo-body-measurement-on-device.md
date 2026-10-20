# ADR-0039: Photo-based body measurement: on-device versus cloud

- Status: **Proposed, blocked on VR-P3-06 (PDPL classification of body images and derived measurements) and model licence**
- Date: 2026-10-12
- Deciders: DPO, CTO, Product
- Spec refs: §10 (Phase 3 photo estimation), §B1, §T5, docs/specs/phase2/ sizing, ADR-0002

## Context and problem statement
Two phone photos can yield body measurements (Zalando precedent in the spec). Photos of a body are highly sensitive images; measurements are already P3 and never visible to sellers. Cloud inference would transfer images, possibly across borders (ADR-0002, VR-02).

## Considered options
1. **On-device only:** a pose and silhouette model runs in the app (Core ML, native module); only the derived numeric measurements with a confidence value leave the device after user review; images never uploaded, never stored.
2. **Cloud inference in the approved region** with immediate deletion.
3. **Hybrid:** on-device by default, cloud fallback for unsupported devices with explicit consent.

## Decision (proposed default)
Option 1. Images stay in memory, are never written to disk or logs and never transmitted. The user sees and can edit the numbers before saving; saving requires the `measurements` consent. Accuracy is reported as a range and confidence, never as exact. Option 3 is not built unless owner and DPO accept. Model choice requires a licence review (open-weight pose models vary) and an accuracy study on a consented, diverse set that includes modest-clothing and varied body types; ship only if error is within the size-chart bin width for the target share of users (threshold is an owner decision).

## Consequences
Good: smallest privacy exposure, no residency question for images. Bad: native work, device matrix, accuracy ceiling, cannot improve the model from user images.

## Owner decision required
Approve on-device only; approve accuracy threshold and the consented test-set budget.

## Safe default if no answer
Feature not built; manual measurement guide remains.
