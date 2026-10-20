import { describe, expect, it } from "vitest";
import { DEFAULT_REVIEW_CONFIG, type Review } from "./domain/bridge";
import {
  FakeImageClassifier,
  FakePhotoUploads,
  FakePurchaseVerification,
  FakeReviewerProfiles,
  FakeSellerIdentity,
  FakeToxicityClassifier,
  InMemoryReviewStore,
} from "./adapters/in-memory";
import { ModerationPipeline, ProcessModerationBacklog } from "./application/moderation";
import { SubmitReview } from "./application/reviews";
import type { ReviewDeps } from "./application/shared";
import { loadConfig } from "../../config/env";
import { MissingReviewsPortsError, ReviewsModule } from "./reviews.module";

const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
let n = 0;
const ids = { uuidV7: (): string => `00000000-0000-7000-8000-${String(++n).padStart(12, "0")}` };

function setup(nowMs = 1_800_000_000_000) {
  const clock = { ms: nowMs, nowMs() { return this.ms; } };
  const store = new InMemoryReviewStore();
  const d: ReviewDeps = { store, clock, ids, cfg: DEFAULT_REVIEW_CONFIG };
  const purchases = new FakePurchaseVerification();
  const sellers = new FakeSellerIdentity();
  const pipeline = new ModerationPipeline(d, new FakeToxicityClassifier(), new FakeImageClassifier());
  const submit = new SubmitReview(
    d,
    { purchases, sellers, profiles: new FakeReviewerProfiles(), photos: new FakePhotoUploads() },
    pipeline,
  );
  return { clock, store, d, purchases, sellers, pipeline, submit };
}

const stuck = (status: Review["status"], createdAtMs: number): Review => ({
  id: U(1),
  orderLineId: U(2),
  userId: U(3),
  storeId: U(4),
  productId: U(5),
  rating: 5,
  title: null,
  body: "Stuck mid pipeline for a while",
  purchasedSize: null,
  fit: null,
  fitArea: null,
  photoIds: [],
  status,
  holdReason: null,
  rewardIntentAtMs: null,
  createdAtMs,
  updatedAtMs: createdAtMs,
  publishedAtMs: null,
});

describe("moderation backlog", () => {
  it("resumes items stuck in SUBMITTED or AUTO_CHECKED, but not fresh ones", async () => {
    const s = setup();
    await s.store.insertReview(stuck("AUTO_CHECKED", s.clock.nowMs() - 5 * 60_000), []);
    await s.store.insertReview({ ...stuck("SUBMITTED", s.clock.nowMs() - 1000), id: U(11), orderLineId: U(12) }, []);
    const backlog = new ProcessModerationBacklog(s.d, s.pipeline);
    expect(await backlog.execute()).toBe(1);
    expect((await s.store.getReview(U(1)))?.status).toBe("PUBLISHED");
    expect((await s.store.getReview(U(11)))?.status).toBe("SUBMITTED");
  });

  it("a run that loses the race returns the current state without a second publish", async () => {
    const s = setup();
    await s.store.insertReview(stuck("SUBMITTED", s.clock.nowMs() - 5 * 60_000), []);
    const [a, b] = await Promise.all([s.pipeline.run("review", U(1)), s.pipeline.run("review", U(1))]);
    expect([a, b].every((x) => x === "PUBLISHED" || x === "AUTO_CHECKED")).toBe(true);
    expect(s.store.events.filter((e) => e.type === "review.reward_intent")).toHaveLength(1);
    expect(s.store.events.filter((e) => e.type === "review.published")).toHaveLength(1);
  });
});

describe("SubmitReview", () => {
  it("treats store staff as the seller even when the seller port does not know them", async () => {
    const s = setup();
    s.purchases.add({ orderLineId: U(20), userId: U(30), storeId: U(40), productId: U(50), sizeLabel: "L", deliveredAtMs: s.clock.nowMs() - 1000 });
    const r = await s.submit.execute({
      userId: U(30),
      actorStoreIds: [U(40)],
      orderLineId: U(20),
      draft: { rating: 5, body: "I work here and love it so much" },
    });
    expect(r.kind).toBe("self_review");
    expect(await s.store.getReviewByOrderLine(U(20))).toBeNull();
  });
});

describe("ReviewsModule wiring", () => {
  it("refuses to boot outside test mode without real ports", () => {
    const cfg = loadConfig({ NODE_ENV: "development" });
    expect(() => ReviewsModule.forRoot(cfg, {})).toThrow(MissingReviewsPortsError);
  });
});
