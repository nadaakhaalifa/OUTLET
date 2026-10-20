import { z } from "zod";
import { RANKING_FEATURE_NAMES, vectorViolations } from "./bridge";

const NUM = z.number().finite();

/**
 * Wire/log schema of the v2 feature vector. `.strict()` means an unknown key (a budget field, for
 * instance) fails parsing; the refinement repeats the domain check so both layers agree.
 */
export const FeatureValuesSchema = z
  .object(Object.fromEntries(RANKING_FEATURE_NAMES.map((n) => [n, NUM])) as Record<(typeof RANKING_FEATURE_NAMES)[number], z.ZodNumber>)
  .strict();

export const FeatureVectorSchema = z
  .object({
    productId: z.string().min(1).max(64),
    storeId: z.string().min(1).max(64),
    personalized: z.boolean(),
    values: FeatureValuesSchema,
  })
  .strict()
  .refine((v) => vectorViolations(v).length === 0, { message: "forbidden_feature_key" })
  .refine((v) => v.personalized || (v.values.category_affinity === 0 && v.values.store_affinity === 0), {
    message: "user_features_present_when_not_personalized",
  });

export const GuardrailConfigSchema = z
  .object({
    minOrdersPerArm: z.number().int().min(1).max(10_000_000),
    maxReturnRateIncreaseBps: z.number().int().min(0).max(10_000),
    maxComplaintRateIncreaseBps: z.number().int().min(0).max(10_000),
  })
  .strict();

export const ArmOutcomeSchema = z
  .object({
    orders: z.number().int().min(0).max(1_000_000_000),
    returned: z.number().int().min(0),
    complaints: z.number().int().min(0),
  })
  .strict()
  .refine((a) => a.returned <= a.orders && a.complaints <= a.orders, { message: "count_exceeds_orders" });
