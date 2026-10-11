import type { FitRating } from "../domain/bridge";
import type { Clock, IdGenerator } from "../../../platform/ports";
import type {
  FeedbackRepository,
  OrderLineFitPort,
  SizeProfileRepository,
  SizingEventPublisher,
} from "../domain/ports";

export interface FeedbackInput {
  readonly rating: FitRating;
  readonly area: string | null;
  /** Optional, the user's own profile the feedback was about. */
  readonly profileId: string | null;
}

export type FeedbackOutcome =
  | { readonly kind: "recorded" }
  | { readonly kind: "not_found" }
  | { readonly kind: "not_delivered" }
  | { readonly kind: "duplicate" };

export class SubmitFitFeedback {
  constructor(
    private readonly lines: OrderLineFitPort,
    private readonly repo: FeedbackRepository,
    private readonly profiles: SizeProfileRepository,
    private readonly events: SizingEventPublisher,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(userId: string, orderLineId: string, input: FeedbackInput): Promise<FeedbackOutcome> {
    const found = await this.lines.lineFor(userId, orderLineId);
    // Unknown line and another user's line are indistinguishable (API1).
    if (found === null) return { kind: "not_found" };
    if (found.kind === "not_delivered") return { kind: "not_delivered" };
    const l = found.line;
    let profileId: string | null = null;
    if (input.profileId !== null) {
      const own = await this.profiles.get(userId, input.profileId);
      profileId = own === null ? null : own.id;
    }
    const r = await this.repo.insert({
      id: this.ids.uuidV7(),
      orderLineId: l.orderLineId,
      userId,
      profileId,
      productId: l.productId,
      brandId: l.brandId,
      productType: l.productType,
      sizeChartId: l.sizeChartId,
      sizeLabel: l.sizeLabel,
      rating: input.rating,
      area: input.area,
      submittedAtMs: this.clock.nowMs(),
    });
    if (r === "duplicate") return { kind: "duplicate" };
    await this.events.publish({
      type: "fit_feedback.submitted",
      orderLineId: l.orderLineId,
      productId: l.productId,
      brandId: l.brandId,
      rating: input.rating,
    });
    return { kind: "recorded" };
  }
}
