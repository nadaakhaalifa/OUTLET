export const CONDITION_GRADES = ["new_with_tags", "new_with_imperfections", "sample", "open_box", "refurbished", "pre_owned"] as const;
export type ConditionGradeCode = (typeof CONDITION_GRADES)[number];

/** Grades that need a defect card (ADR-0009): everything except new_with_tags and sample. Loaded rows are authoritative; this is the seed default. */
export const DEFECT_GRADES: readonly ConditionGradeCode[] = ["new_with_imperfections", "open_box", "refurbished", "pre_owned"];

export const STOCK_REASONS = ["previous_season", "overstock", "end_of_line", "customer_return", "near_expiry"] as const;

/** Arabic script letters (basic block + supplements); a title with none is not an Arabic title (CPL 181/2018). */
export const hasArabicLetters = (s: string): boolean => /[ء-يٮ-ۓݐ-ݿ]/u.test(s);
