import {
  recommendSize,
  type ChartRow,
  type Explanation,
  type FitResult,
  type Stretch,
} from "../domain/bridge";
import type { Clock } from "../../../platform/ports";
import type {
  DemandRepository,
  FeedbackRepository,
  FitCatalogPort,
  MeasurementsConsentPort,
  SizeChartRepository,
  SizeProfileRepository,
  SizingEventPublisher,
} from "../domain/ports";
import type { ProfileCodec } from "./codec";
import { explain, type LocalizedText, alternativeReason } from "./explain";

export const FIT_MODEL = "fit-v1";

export interface FitRecommendationView {
  readonly size: string;
  readonly confidence: number;
  readonly explanation: readonly LocalizedText[];
  readonly alternatives: readonly { size: string; reason: LocalizedText }[];
  readonly communityFit: { tendency: "runs_small" | "true_to_size" | "runs_large"; sampleSize: number } | null;
  readonly model: string;
}

export type RecommendOutcome =
  | { readonly kind: "ok"; readonly view: FitRecommendationView }
  | { readonly kind: "profile_not_found" }
  | { readonly kind: "product_not_found" }
  | { readonly kind: "fit_unavailable" }
  | { readonly kind: "consent_required" }
  | { readonly kind: "measurements_required" };

/** ISO week key (YYYY-Www, Monday based, UTC) used as the demand aggregation bucket. */
export function isoWeek(ms: number): string {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 3));
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const week =
    1 + Math.round(((thursday.getTime() - firstThursday.getTime()) / 86_400_000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export class RecommendFit {
  constructor(
    private readonly profiles: SizeProfileRepository,
    private readonly codec: ProfileCodec,
    private readonly consent: MeasurementsConsentPort,
    private readonly catalog: FitCatalogPort,
    private readonly charts: SizeChartRepository,
    private readonly feedback: FeedbackRepository,
    private readonly demand: DemandRepository,
    private readonly events: SizingEventPublisher,
    private readonly clock: Clock,
  ) {}

  async execute(userId: string, productId: string, profileId: string): Promise<RecommendOutcome> {
    const rec = await this.profiles.get(userId, profileId);
    if (rec === null) return { kind: "profile_not_found" };
    const facts = await this.catalog.productFitFacts(productId);
    if (facts === null) return { kind: "product_not_found" };
    const chart = await this.charts.latestValidated(facts.storeId, facts.productType);
    if (chart === null) return { kind: "fit_unavailable" };
    // Consent is checked at use time, every time (a withdrawal must take effect immediately).
    if (!(await this.consent.isGranted(userId))) return { kind: "consent_required" };

    const profile = await this.codec.open(rec);
    const usual =
      profile.usualSize !== null && (profile.usualSize.brandId === null || profile.usualSize.brandId === facts.brandId)
        ? profile.usualSize.sizeLabel
        : null;
    const hasBody = profile.measurements !== null && Object.keys(profile.measurements).length > 0;
    if (!hasBody && usual === null) return { kind: "measurements_required" };

    const counts = await this.feedback.itemCounts(productId, chart.id);
    const history = await this.feedback.historyFor(userId, facts.brandId);
    const stretch: Stretch = facts.stretch;
    const result = recommendSize({
      rows: chart.rows as readonly ChartRow[],
      profile: {
        measurements: profile.measurements ?? {},
        fitPreference: profile.fitPreference,
        modestFit: profile.modestFit,
        usualSizeLabel: usual,
      },
      stretch,
      itemCounts: counts,
      history,
    });
    if (result.kind === "no_data") return { kind: "measurements_required" };

    await this.demand.record(facts.storeId, facts.productType, result.size, isoWeek(this.clock.nowMs()), userId);
    await this.events.publish({ type: "size_recommended", productId, confidence: result.confidence });
    return { kind: "ok", view: toView(result) };
  }
}

function toView(r: FitResult): FitRecommendationView {
  const explanation: readonly Explanation[] = r.explanation;
  return {
    size: r.size,
    confidence: r.confidence,
    explanation: explanation.map(explain),
    alternatives: r.alternatives.map((a) => ({ size: a.size, reason: alternativeReason(a.direction) })),
    communityFit: r.communityFit,
    model: FIT_MODEL,
  };
}
