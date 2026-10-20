import type {
  Answer,
  DeliveredLine,
  KeysetPosition,
  ModerationStatus,
  Question,
  RatingCounts,
  Review,
  ReviewReply,
  UgcTargetType,
} from "../domain/bridge";
import type {
  EditResult,
  ImageClassifierPort,
  KeysetPage,
  ModerationLogEntry,
  PhotoUploadPort,
  ProductStorePort,
  PurchaseVerificationPort,
  Report,
  ReviewEvent,
  ReviewStore,
  ReviewerProfilePort,
  SellerIdentityPort,
  ToxicityClassifierPort,
  TransitionInput,
  UgcItem,
} from "../domain/ports";

/** Newest first by (ms, id). Keyset: strictly after the position in that order. */
function pageDesc<T>(rows: readonly T[], key: (t: T) => KeysetPosition, page: KeysetPage): T[] {
  const sorted = [...rows].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return kb.ms - ka.ms || (kb.id < ka.id ? -1 : kb.id > ka.id ? 1 : 0);
  });
  const after = page.after;
  const rest =
    after === null
      ? sorted
      : sorted.filter((r) => {
          const k = key(r);
          return k.ms < after.ms || (k.ms === after.ms && k.id < after.id);
        });
  return rest.slice(0, page.limit);
}

function pageAsc<T>(rows: readonly T[], key: (t: T) => KeysetPosition, page: KeysetPage): T[] {
  const sorted = [...rows].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka.ms - kb.ms || (ka.id < kb.id ? -1 : ka.id > kb.id ? 1 : 0);
  });
  const after = page.after;
  const rest =
    after === null
      ? sorted
      : sorted.filter((r) => {
          const k = key(r);
          return k.ms > after.ms || (k.ms === after.ms && k.id > after.id);
        });
  return rest.slice(0, page.limit);
}

export class InMemoryReviewStore implements ReviewStore {
  readonly events: ReviewEvent[] = [];
  private readonly reviews = new Map<string, Review>();
  private readonly replies = new Map<string, ReviewReply>();
  private readonly questions = new Map<string, Question>();
  private readonly answers = new Map<string, Answer>();
  private readonly reports: Report[] = [];
  private readonly log: ModerationLogEntry[] = [];

  private emit(events: readonly ReviewEvent[]): void {
    this.events.push(...events);
  }

  async insertReview(review: Review, events: readonly ReviewEvent[]): Promise<"inserted" | "exists"> {
    for (const r of this.reviews.values()) if (r.orderLineId === review.orderLineId) return "exists";
    this.reviews.set(review.id, review);
    this.emit(events);
    return "inserted";
  }

  async getReview(id: string): Promise<Review | null> {
    return this.reviews.get(id) ?? null;
  }

  async getReviewByOrderLine(orderLineId: string): Promise<Review | null> {
    for (const r of this.reviews.values()) if (r.orderLineId === orderLineId) return r;
    return null;
  }

  async editReview(input: Parameters<ReviewStore["editReview"]>[0]): Promise<EditResult> {
    const cur = this.reviews.get(input.id);
    if (cur === undefined || cur.userId !== input.userId) return { kind: "not_found" };
    if (cur.status === "SUBMITTED" || cur.status === "AUTO_CHECKED") return { kind: "busy" };
    const next: Review = {
      ...cur,
      ...input.draft,
      status: "SUBMITTED",
      holdReason: null,
      updatedAtMs: input.nowMs,
    };
    this.reviews.set(cur.id, next);
    this.log.push({
      id: input.logId,
      targetType: "review",
      targetId: cur.id,
      from: cur.status,
      to: "SUBMITTED",
      actorKind: "author",
      actorId: input.userId,
      reason: null,
      atMs: input.nowMs,
    });
    this.emit(input.events);
    return { kind: "ok", review: next, wasPublished: cur.status === "PUBLISHED" };
  }

  async deleteReview(id: string, userId: string, events: readonly ReviewEvent[]): Promise<boolean> {
    const cur = this.reviews.get(id);
    if (cur === undefined || cur.userId !== userId) return false;
    this.reviews.delete(id);
    this.replies.delete(id);
    this.emit(events);
    return true;
  }

  async listPublishedReviews(productId: string, page: KeysetPage): Promise<readonly Review[]> {
    const rows = [...this.reviews.values()].filter((r) => r.productId === productId && r.status === "PUBLISHED");
    return pageDesc(rows, (r) => ({ ms: r.publishedAtMs ?? 0, id: r.id }), page);
  }

  async listReviewsByUser(userId: string, page: KeysetPage): Promise<readonly Review[]> {
    const rows = [...this.reviews.values()].filter((r) => r.userId === userId);
    return pageDesc(rows, (r) => ({ ms: r.createdAtMs, id: r.id }), page);
  }

  async listReviewsByStores(storeIds: readonly string[], page: KeysetPage): Promise<readonly Review[]> {
    const rows = [...this.reviews.values()].filter((r) => storeIds.includes(r.storeId) && r.status === "PUBLISHED");
    return pageDesc(rows, (r) => ({ ms: r.publishedAtMs ?? 0, id: r.id }), page);
  }

  async ratingCounts(productId: string): Promise<RatingCounts> {
    const by: [number, number, number, number, number] = [0, 0, 0, 0, 0];
    for (const r of this.reviews.values()) {
      if (r.productId === productId && r.status === "PUBLISHED" && r.rating >= 1 && r.rating <= 5) {
        by[r.rating - 1] = (by[r.rating - 1] ?? 0) + 1;
      }
    }
    return { byStar: by };
  }

  async upsertReply(reply: ReviewReply, logId: string): Promise<void> {
    const cur = this.replies.get(reply.reviewId);
    if (cur !== undefined) {
      this.log.push({
        id: logId,
        targetType: "review_reply",
        targetId: reply.reviewId,
        from: cur.status,
        to: "SUBMITTED",
        actorKind: "author",
        actorId: reply.authorUserId,
        reason: null,
        atMs: reply.updatedAtMs,
      });
      this.replies.set(reply.reviewId, { ...reply, createdAtMs: cur.createdAtMs });
      return;
    }
    this.replies.set(reply.reviewId, reply);
  }

  async getReply(reviewId: string): Promise<ReviewReply | null> {
    return this.replies.get(reviewId) ?? null;
  }

  async publishedReplies(reviewIds: readonly string[]): Promise<ReadonlyMap<string, ReviewReply>> {
    const out = new Map<string, ReviewReply>();
    for (const id of reviewIds) {
      const r = this.replies.get(id);
      if (r !== undefined && r.status === "PUBLISHED") out.set(id, r);
    }
    return out;
  }

  async insertQuestion(question: Question): Promise<void> {
    this.questions.set(question.id, question);
  }

  async getQuestion(id: string): Promise<Question | null> {
    return this.questions.get(id) ?? null;
  }

  async listPublishedQuestions(productId: string, page: KeysetPage): Promise<readonly Question[]> {
    const rows = [...this.questions.values()].filter((q) => q.productId === productId && q.status === "PUBLISHED");
    return pageDesc(rows, (q) => ({ ms: q.publishedAtMs ?? 0, id: q.id }), page);
  }

  async listQuestionsByStores(
    storeIds: readonly string[],
    filter: { readonly unansweredOnly: boolean },
    page: KeysetPage,
  ): Promise<readonly Question[]> {
    const rows = [...this.questions.values()].filter(
      (q) => storeIds.includes(q.storeId) && q.status === "PUBLISHED" && (!filter.unansweredOnly || q.answeredAtMs === null),
    );
    return pageDesc(rows, (q) => ({ ms: q.publishedAtMs ?? 0, id: q.id }), page);
  }

  async upsertAnswer(answer: Answer, logId: string): Promise<void> {
    for (const a of this.answers.values()) {
      if (a.questionId === answer.questionId && a.storeId === answer.storeId) {
        this.log.push({
          id: logId,
          targetType: "answer",
          targetId: a.id,
          from: a.status,
          to: "SUBMITTED",
          actorKind: "author",
          actorId: answer.authorUserId,
          reason: null,
          atMs: answer.updatedAtMs,
        });
        this.answers.set(a.id, { ...answer, id: a.id, createdAtMs: a.createdAtMs });
        return;
      }
    }
    this.answers.set(answer.id, answer);
  }

  async getAnswer(id: string): Promise<Answer | null> {
    return this.answers.get(id) ?? null;
  }

  async getAnswerByQuestionStore(questionId: string, storeId: string): Promise<Answer | null> {
    for (const a of this.answers.values()) if (a.questionId === questionId && a.storeId === storeId) return a;
    return null;
  }

  async publishedAnswers(questionIds: readonly string[]): Promise<ReadonlyMap<string, readonly Answer[]>> {
    const out = new Map<string, Answer[]>();
    for (const a of this.answers.values()) {
      if (a.status !== "PUBLISHED" || !questionIds.includes(a.questionId)) continue;
      const list = out.get(a.questionId) ?? [];
      list.push(a);
      out.set(a.questionId, list);
    }
    for (const list of out.values()) list.sort((x, y) => x.createdAtMs - y.createdAtMs || (x.id < y.id ? -1 : 1));
    return out;
  }

  async listOverdueQuestions(nowMs: number, limit: number): Promise<readonly Question[]> {
    const rows = [...this.questions.values()]
      .filter(
        (q) =>
          q.status === "PUBLISHED" &&
          q.answeredAtMs === null &&
          q.slaBreachedAtMs === null &&
          q.slaDueAtMs !== null &&
          q.slaDueAtMs <= nowMs,
      )
      .sort((a, b) => (a.slaDueAtMs ?? 0) - (b.slaDueAtMs ?? 0) || (a.id < b.id ? -1 : 1));
    return rows.slice(0, limit);
  }

  async markSlaBreached(id: string, nowMs: number, events: readonly ReviewEvent[]): Promise<boolean> {
    const q = this.questions.get(id);
    if (q === undefined || q.slaBreachedAtMs !== null || q.answeredAtMs !== null) return false;
    this.questions.set(id, { ...q, slaBreachedAtMs: nowMs });
    this.emit(events);
    return true;
  }

  async getUgc(type: UgcTargetType, id: string): Promise<UgcItem | null> {
    switch (type) {
      case "review": {
        const r = this.reviews.get(id);
        if (r === undefined) return null;
        return {
          type,
          id,
          status: r.status,
          holdReason: r.holdReason,
          authorUserId: r.userId,
          storeId: r.storeId,
          productId: r.productId,
          text: r.title === null ? r.body : `${r.title}\n${r.body}`,
          photoIds: r.photoIds,
          createdAtMs: r.createdAtMs,
        };
      }
      case "review_reply": {
        const p = this.replies.get(id);
        const r = p === undefined ? undefined : this.reviews.get(p.reviewId);
        if (p === undefined || r === undefined) return null;
        return {
          type,
          id,
          status: p.status,
          holdReason: p.holdReason,
          authorUserId: p.authorUserId,
          storeId: p.storeId,
          productId: r.productId,
          text: p.body,
          photoIds: [],
          createdAtMs: p.createdAtMs,
        };
      }
      case "question": {
        const q = this.questions.get(id);
        if (q === undefined) return null;
        return {
          type,
          id,
          status: q.status,
          holdReason: q.holdReason,
          authorUserId: q.userId,
          storeId: q.storeId,
          productId: q.productId,
          text: q.body,
          photoIds: [],
          createdAtMs: q.createdAtMs,
        };
      }
      case "answer": {
        const a = this.answers.get(id);
        const q = a === undefined ? undefined : this.questions.get(a.questionId);
        if (a === undefined || q === undefined) return null;
        return {
          type,
          id,
          status: a.status,
          holdReason: a.holdReason,
          authorUserId: a.authorUserId,
          storeId: a.storeId,
          productId: q.productId,
          text: a.body,
          photoIds: [],
          createdAtMs: a.createdAtMs,
        };
      }
    }
  }

  async transition(t: TransitionInput): Promise<"ok" | "stale"> {
    const hold = t.to === "HELD" || t.to === "REJECTED" ? t.reason : null;
    switch (t.type) {
      case "review": {
        const r = this.reviews.get(t.id);
        if (r === undefined || r.status !== t.from) return "stale";
        this.reviews.set(t.id, {
          ...r,
          status: t.to,
          holdReason: hold,
          updatedAtMs: t.nowMs,
          publishedAtMs: t.to === "PUBLISHED" ? (r.publishedAtMs ?? t.nowMs) : r.publishedAtMs,
          rewardIntentAtMs: t.markRewardIntent && r.rewardIntentAtMs === null ? t.nowMs : r.rewardIntentAtMs,
        });
        break;
      }
      case "review_reply": {
        const p = this.replies.get(t.id);
        if (p === undefined || p.status !== t.from) return "stale";
        this.replies.set(t.id, { ...p, status: t.to, holdReason: hold, updatedAtMs: t.nowMs });
        break;
      }
      case "question": {
        const q = this.questions.get(t.id);
        if (q === undefined || q.status !== t.from) return "stale";
        const first = t.to === "PUBLISHED" && q.publishedAtMs === null;
        this.questions.set(t.id, {
          ...q,
          status: t.to,
          holdReason: hold,
          publishedAtMs: first ? t.nowMs : q.publishedAtMs,
          slaDueAtMs: first ? t.nowMs + t.slaMs : q.slaDueAtMs,
        });
        break;
      }
      case "answer": {
        const a = this.answers.get(t.id);
        if (a === undefined || a.status !== t.from) return "stale";
        this.answers.set(t.id, { ...a, status: t.to, holdReason: hold, updatedAtMs: t.nowMs });
        if (t.to === "PUBLISHED") {
          const q = this.questions.get(a.questionId);
          if (q !== undefined && q.answeredAtMs === null) this.questions.set(q.id, { ...q, answeredAtMs: t.nowMs });
        }
        break;
      }
    }
    this.log.push({
      id: t.logId,
      targetType: t.type,
      targetId: t.id,
      from: t.from,
      to: t.to,
      actorKind: t.actorKind,
      actorId: t.actorId,
      reason: t.reason,
      atMs: t.nowMs,
    });
    this.emit(t.events);
    return "ok";
  }

  async listModeration(
    filter: { readonly statuses: readonly ModerationStatus[]; readonly type: UgcTargetType | null },
    page: KeysetPage,
  ): Promise<readonly UgcItem[]> {
    const types: readonly UgcTargetType[] = filter.type === null ? ["review", "review_reply", "question", "answer"] : [filter.type];
    const out: UgcItem[] = [];
    for (const type of types) {
      const ids =
        type === "review"
          ? [...this.reviews.keys()]
          : type === "review_reply"
            ? [...this.replies.keys()]
            : type === "question"
              ? [...this.questions.keys()]
              : [...this.answers.keys()];
      for (const id of ids) {
        const item = await this.getUgc(type, id);
        if (item !== null && filter.statuses.includes(item.status)) out.push(item);
      }
    }
    return pageAsc(out, (i) => ({ ms: i.createdAtMs, id: i.id }), page);
  }

  async moderationLog(type: UgcTargetType, id: string): Promise<readonly ModerationLogEntry[]> {
    return this.log.filter((l) => l.targetType === type && l.targetId === id);
  }

  async addReport(report: Report, events: readonly ReviewEvent[]): Promise<"added" | "duplicate"> {
    const dup = this.reports.some(
      (r) => r.targetType === report.targetType && r.targetId === report.targetId && r.reporterId === report.reporterId,
    );
    if (dup) return "duplicate";
    this.reports.push(report);
    this.emit(events);
    return "added";
  }

  async countReportsBy(reporterId: string, sinceMs: number): Promise<number> {
    return this.reports.filter((r) => r.reporterId === reporterId && r.createdAtMs >= sinceMs).length;
  }

  async countDistinctReporters(type: UgcTargetType, id: string): Promise<number> {
    return new Set(this.reports.filter((r) => r.targetType === type && r.targetId === id).map((r) => r.reporterId)).size;
  }
}

// ---- fakes for ports owned by other modules ---------------------------------------------------

export class FakePurchaseVerification implements PurchaseVerificationPort {
  private readonly lines = new Map<string, DeliveredLine>();
  add(line: DeliveredLine): void {
    this.lines.set(line.orderLineId, line);
  }
  async findDeliveredLine(orderLineId: string): Promise<DeliveredLine | null> {
    return this.lines.get(orderLineId) ?? null;
  }
}

export class FakeSellerIdentity implements SellerIdentityPort {
  private readonly stores = new Map<string, string[]>();
  grant(userId: string, storeId: string): void {
    this.stores.set(userId, [...(this.stores.get(userId) ?? []), storeId]);
  }
  async storeIdsOf(userId: string): Promise<readonly string[]> {
    return this.stores.get(userId) ?? [];
  }
}

export class FakeProductStore implements ProductStorePort {
  private readonly byProduct = new Map<string, string>();
  set(productId: string, storeId: string): void {
    this.byProduct.set(productId, storeId);
  }
  async storeOfProduct(productId: string): Promise<string | null> {
    return this.byProduct.get(productId) ?? null;
  }
}

export class FakeReviewerProfiles implements ReviewerProfilePort {
  private readonly names = new Map<string, string>();
  set(userId: string, firstName: string): void {
    this.names.set(userId, firstName);
  }
  async firstName(userId: string): Promise<string | null> {
    return this.names.get(userId) ?? null;
  }
}

export class FakePhotoUploads implements PhotoUploadPort {
  private readonly owned = new Map<string, Set<string>>();
  add(userId: string, uploadId: string): void {
    const s = this.owned.get(userId) ?? new Set<string>();
    s.add(uploadId);
    this.owned.set(userId, s);
  }
  async areOwnedImages(userId: string, uploadIds: readonly string[]): Promise<boolean> {
    const s = this.owned.get(userId);
    return uploadIds.every((id) => s?.has(id) === true);
  }
}

/**
 * Deterministic AR/EN toxicity fake: scores by marker words so tests choose the outcome by text.
 * "[[toxic]]" -> 95, "[[borderline]]" -> 60, "[[down]]" -> classifier outage.
 */
export class FakeToxicityClassifier implements ToxicityClassifierPort {
  async score(text: string): Promise<number> {
    if (text.includes("[[down]]")) throw new Error("classifier unavailable");
    if (text.includes("[[toxic]]")) return 95;
    if (text.includes("[[borderline]]")) return 60;
    return 3;
  }
}

/** Upload ids registered with `flag` decide the scores; everything else is clean. */
export class FakeImageClassifier implements ImageClassifierPort {
  private readonly flagged = new Map<string, { nsfw: number; violence: number } | "down">();
  flag(uploadId: string, v: { nsfw: number; violence: number } | "down"): void {
    this.flagged.set(uploadId, v);
  }
  async scores(uploadId: string): Promise<{ readonly nsfw: number; readonly violence: number }> {
    const f = this.flagged.get(uploadId);
    if (f === "down") throw new Error("classifier unavailable");
    return f ?? { nsfw: 1, violence: 1 };
  }
}
