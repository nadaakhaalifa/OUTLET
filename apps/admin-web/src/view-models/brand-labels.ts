import type { MessageKey, Translator } from "../i18n";

/**
 * The only strings sent to the review client components (not the whole catalog). Keep it explicit: a key used by a
 * client component must be listed here or the label renders as its key and the UI test notices.
 */
export const BRAND_CLIENT_KEYS = [
  "common.cancel", "common.choose", "common.reason", "brand.reason.label", "brand.act.claim", "brand.act.release", "brand.act.approve",
  "brand.act.reject", "brand.act.needsInfo", "brand.act.cosign", "brand.act.resolve", "brand.act.lookup", "brand.act.confirm",
  "brand.claim.body", "brand.release.body", "brand.lookup.body", "brand.approve.title", "brand.approve.slug", "brand.approve.slugHint",
  "brand.approve.cosignFirst", "brand.approve.thenCreates", "brand.approve.createsStore", "brand.approve.createsOwner", "brand.approve.notifies",
  "brand.reject.title", "brand.reject.reapply", "brand.needsInfo.title", "brand.needsInfo.items", "brand.needsInfo.itemsHint",
  "brand.msg.ar", "brand.msg.en", "brand.msg.hint", "brand.note.label", "brand.note.optional", "brand.cosign.title", "brand.cosign.requestedBy",
  "brand.cosign.body", "brand.conflict.title", "brand.conflict.outcome", "brand.conflict.body", "brand.outcome.keep_first",
  "brand.outcome.replace_with_this", "brand.outcome.both_valid", "brand.outcome.reject_all", "brand.errors.summary", "brand.cand.clarification",
  "brand.cand.domain_verification", "brand.err.decision", "brand.err.reason", "brand.err.approveReason", "brand.err.messageAr",
  "brand.err.messageArScript", "brand.err.messageEn", "brand.err.messageEnScript", "brand.err.items", "brand.err.itemsInvalid",
  "brand.err.tooLong", "brand.err.reapply", "brand.err.slug", "brand.err.note", "brand.doc.view", "brand.doc.viewTitle", "brand.doc.viewBody",
  "brand.doc.reasonLabel", "brand.doc.request", "brand.doc.close", "brand.doc.expiresIn", "brand.doc.expired", "brand.doc.loading",
  "brand.doc.watermark", "brand.doc.noOrigin", "brand.doc.pdfNote", "brand.doc.none", "brand.doc.badUrl", "brand.doc.notViewable",
  "brand.doc.pickOne", "brand.doc.reason.kyc_review", "brand.doc.reason.appeal_review", "brand.doc.reason.fraud_investigation",
  "brand.doc.reason.legal_request", "state.forbidden", "state.notFound", "state.conflict", "state.rateLimited", "state.offline",
  "state.error", "state.unavailable", "state.sessionExpired", "state.notConfigured", "flash.validation", "brand.flash.alreadyClaimed",
  "brand.flash.reviewerIsApplicant", "brand.flash.stale", "brand.sc.title", "brand.sc.next", "brand.sc.prev", "brand.sc.open",
  "brand.sc.claim", "brand.sc.release", "brand.sc.approve", "brand.sc.reject", "brand.sc.needsInfo", "brand.sc.mine", "brand.sc.queue",
  "brand.sc.help", "brand.sc.close",
] as const satisfies readonly MessageKey[];

export type BrandLabelKey = (typeof BRAND_CLIENT_KEYS)[number];
export type BrandLabels = Readonly<Record<BrandLabelKey, string>>;

export function pickBrandLabels(t: Translator): BrandLabels {
  return Object.fromEntries(BRAND_CLIENT_KEYS.map((k) => [k, t(k)])) as BrandLabels;
}
