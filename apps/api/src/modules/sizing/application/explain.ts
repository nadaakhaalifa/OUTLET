import type { Explanation } from "../domain/bridge";

export interface LocalizedText {
  readonly ar: string;
  readonly en: string;
}

const s = (v: string | number | undefined): string => (v === undefined ? "" : String(v));

/** Arabic first copy. Numbers and size labels only come from the engine, no free text. */
export function explain(e: Explanation): LocalizedText {
  const p = e.params;
  switch (e.code) {
    case "not_sure":
      return {
        ar: "لسنا متأكدين من المقاس المناسب، راجع جدول المقاسات.",
        en: "We are not sure about this size. Check the size chart.",
      };
    case "chart_match":
      return {
        ar: `أقرب مقاس لقياساتك هو ${s(p["size"])}.`,
        en: `${s(p["size"])} is the closest size to your measurements.`,
      };
    case "usual_size_only":
      return {
        ar: `اعتمدنا على مقاسك المعتاد ${s(p["size"])} لعدم وجود قياسات كافية.`,
        en: `Based on your usual size ${s(p["size"])}, because we do not have enough measurements.`,
      };
    case "between_sizes_smaller":
      return {
        ar: "قياساتك بين مقاسين، اخترنا الأصغر حسب تفضيلك لقصّة الملابس ومرونة القماش.",
        en: "You are between two sizes. We chose the smaller one based on your fit preference and the fabric stretch.",
      };
    case "between_sizes_larger":
      return {
        ar: "قياساتك بين مقاسين، اخترنا الأكبر حسب تفضيلك لقصّة الملابس ومرونة القماش.",
        en: "You are between two sizes. We chose the larger one based on your fit preference and the fabric stretch.",
      };
    case "item_runs_small":
      return {
        ar: `هذا المنتج يميل إلى الصغر حسب ${s(p["n"])} مشتريًا، لذلك رفعنا المقاس.`,
        en: `This item runs small according to ${s(p["n"])} buyers, so we sized up.`,
      };
    case "item_runs_large":
      return {
        ar: `هذا المنتج يميل إلى الاتساع حسب ${s(p["n"])} مشتريًا، لذلك خفضنا المقاس.`,
        en: `This item runs large according to ${s(p["n"])} buyers, so we sized down.`,
      };
    case "history_too_small":
      return {
        ar: `أبلغت ${s(p["count"])} مرات أن مقاسات هذه العلامة صغيرة عليك، لذلك رفعنا المقاس.`,
        en: `You reported "too small" ${s(p["count"])} times for this brand, so we sized up.`,
      };
    case "history_too_large":
      return {
        ar: `أبلغت ${s(p["count"])} مرات أن مقاسات هذه العلامة واسعة عليك، لذلك خفضنا المقاس.`,
        en: `You reported "too large" ${s(p["count"])} times for this brand, so we sized down.`,
      };
  }
}

export function alternativeReason(direction: "smaller" | "larger"): LocalizedText {
  return direction === "larger"
    ? { ar: "لو تفضّل قصّة أوسع.", en: "If you prefer a looser fit." }
    : { ar: "لو تفضّل قصّة أضيق.", en: "If you prefer a snugger fit." };
}
