import { z } from "zod";
import { CatalogError } from "./errors.js";

export const ATTRIBUTE_TYPES = ["enum", "text", "number", "boolean", "size_run"] as const;
export type AttributeType = (typeof ATTRIBUTE_TYPES)[number];

export interface AttributeDef {
  readonly code: string;
  readonly dataType: AttributeType;
  /** For enum attributes: the allowed value codes. */
  readonly enumCodes: readonly string[];
  readonly required: boolean;
}

/** A size run: ordered sizes with a garment/body measure that must strictly increase (monotonic, plausible, unique labels). */
export const sizeRunSchema = z
  .array(z.strictObject({ label: z.string().trim().min(1).max(20), cm: z.number().positive().max(300) }))
  .min(1)
  .max(30)
  .superRefine((run, ctx) => {
    const seen = new Set<string>();
    run.forEach((s, i) => {
      if (seen.has(s.label)) ctx.addIssue({ code: "custom", message: "size labels must be unique", path: [i, "label"] });
      seen.add(s.label);
      const prev = run[i - 1];
      if (prev !== undefined && s.cm <= prev.cm) ctx.addIssue({ code: "custom", message: "size run must be strictly increasing", path: [i, "cm"] });
    });
  });
export type SizeRun = z.infer<typeof sizeRunSchema>;

const valueIssue = (def: AttributeDef, value: unknown): string | undefined => {
  switch (def.dataType) {
    case "enum":
      return typeof value === "string" && def.enumCodes.includes(value) ? undefined : `${def.code}: must be one of ${def.enumCodes.join(", ")}`;
    case "text":
      return typeof value === "string" && value.trim().length > 0 && value.length <= 500 ? undefined : `${def.code}: must be non-empty text up to 500 chars`;
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? undefined : `${def.code}: must be a finite number`;
    case "boolean":
      return typeof value === "boolean" ? undefined : `${def.code}: must be true or false`;
    case "size_run": {
      const r = sizeRunSchema.safeParse(value);
      return r.success ? undefined : `${def.code}: ${r.error.issues.map((i) => i.message).join("; ")}`;
    }
  }
};

/** All problems of `attrs` against the attribute set. `complete` also demands every required attribute. */
export const attributeIssues = (set: readonly AttributeDef[], attrs: Readonly<Record<string, unknown>>, complete: boolean): string[] => {
  const byCode = new Map(set.map((d) => [d.code, d] as const));
  const out: string[] = [];
  for (const [code, value] of Object.entries(attrs)) {
    const def = byCode.get(code);
    if (def === undefined) out.push(`${code}: not an attribute of this category`);
    else {
      const issue = valueIssue(def, value);
      if (issue !== undefined) out.push(issue);
    }
  }
  if (complete) for (const d of set) if (d.required && !Object.hasOwn(attrs, d.code)) out.push(`${d.code}: required`);
  return out;
};

/** Throws CatalogError("validation") listing every problem. */
export const assertAttributes = (set: readonly AttributeDef[], attrs: Readonly<Record<string, unknown>>, complete: boolean): void => {
  const issues = attributeIssues(set, attrs, complete);
  if (issues.length > 0) throw new CatalogError("validation", "attributes do not match the category attribute set", issues);
};

/**
 * Variant option values (size, colour) validated against the product's attributes and the set:
 * only `size` and `colour` are variant axes; size must be a label of the product's size_run; colour must be a valid colour code.
 */
export const optionValueIssues = (set: readonly AttributeDef[], productAttrs: Readonly<Record<string, unknown>>, options: Readonly<Record<string, unknown>>): string[] => {
  const out: string[] = [];
  for (const k of Object.keys(options)) if (k !== "size" && k !== "colour") out.push(`${k}: not a variant axis`);
  const size = options.size;
  if (size !== undefined) {
    const run = sizeRunSchema.safeParse(productAttrs.size_run);
    if (typeof size !== "string") out.push("size: must be text");
    else if (!run.success) out.push("size: the product has no valid size_run");
    else if (!run.data.some((s) => s.label === size)) out.push(`size: ${size} is not in the product size run`);
  }
  const colour = options.colour;
  if (colour !== undefined) {
    const def = set.find((d) => d.code === "colour");
    if (def === undefined) out.push("colour: not an attribute of this category");
    else {
      const issue = valueIssue(def, colour);
      if (issue !== undefined) out.push(issue);
    }
  }
  return out;
};
