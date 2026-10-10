import {
  isQaOverdue,
  validateShortText,
  type Answer,
  type FieldError,
  type ModerationStatus,
  type Question,
} from "../domain/bridge";
import type { ProductStorePort, ReviewerProfilePort } from "../domain/ports";
import type { ModerationPipeline } from "./moderation";
import { initialOf, keyset, type PageOutcome, type ReviewDeps } from "./shared";

export interface QuestionView {
  readonly question: Question;
  readonly askerInitial: string | null;
  readonly answers: readonly Answer[];
  readonly overdue: boolean;
}

export type AskResult =
  | { readonly kind: "ok"; readonly id: string; readonly status: ModerationStatus }
  | { readonly kind: "invalid"; readonly errors: readonly FieldError[] }
  | { readonly kind: "not_found" };

export class AskQuestion {
  constructor(
    private readonly d: ReviewDeps,
    private readonly products: ProductStorePort,
    private readonly pipeline: ModerationPipeline,
  ) {}

  async execute(input: { readonly userId: string; readonly productId: string; readonly body: string }): Promise<AskResult> {
    const storeId = await this.products.storeOfProduct(input.productId);
    if (storeId === null) return { kind: "not_found" };
    const v = validateShortText("body", input.body, "question");
    if (!v.ok) return { kind: "invalid", errors: v.errors };
    const q: Question = {
      id: this.d.ids.uuidV7(),
      productId: input.productId,
      storeId,
      userId: input.userId,
      body: v.value,
      status: "SUBMITTED",
      holdReason: null,
      createdAtMs: this.d.clock.nowMs(),
      publishedAtMs: null,
      slaDueAtMs: null,
      answeredAtMs: null,
      slaBreachedAtMs: null,
    };
    await this.d.store.insertQuestion(q);
    const status = (await this.pipeline.run("question", q.id)) ?? "SUBMITTED";
    return { kind: "ok", id: q.id, status };
  }
}

async function views(
  d: ReviewDeps,
  profiles: ReviewerProfilePort,
  qs: readonly Question[],
): Promise<QuestionView[]> {
  const answers = await d.store.publishedAnswers(qs.map((q) => q.id));
  const now = d.clock.nowMs();
  const out: QuestionView[] = [];
  for (const q of qs) {
    out.push({
      question: q,
      askerInitial: await initialOf(profiles, q.userId),
      answers: answers.get(q.id) ?? [],
      overdue: isQaOverdue(q, now),
    });
  }
  return out;
}

export class ListProductQuestions {
  constructor(
    private readonly d: ReviewDeps,
    private readonly profiles: ReviewerProfilePort,
  ) {}

  async execute(productId: string, cursor: string | null, limit: number): Promise<PageOutcome<QuestionView>> {
    const page = await keyset(
      cursor,
      limit,
      (p) => this.d.store.listPublishedQuestions(productId, p),
      (q) => ({ ms: q.publishedAtMs ?? 0, id: q.id }),
    );
    if (page.kind === "invalid_cursor") return page;
    return { kind: "ok", items: await views(this.d, this.profiles, page.items), nextCursor: page.nextCursor };
  }
}

export class ListSellerQuestions {
  constructor(
    private readonly d: ReviewDeps,
    private readonly profiles: ReviewerProfilePort,
  ) {}

  async execute(
    storeIds: readonly string[],
    unansweredOnly: boolean,
    cursor: string | null,
    limit: number,
  ): Promise<PageOutcome<QuestionView>> {
    const page = await keyset(
      cursor,
      limit,
      (p) => this.d.store.listQuestionsByStores(storeIds, { unansweredOnly }, p),
      (q) => ({ ms: q.publishedAtMs ?? 0, id: q.id }),
    );
    if (page.kind === "invalid_cursor") return page;
    return { kind: "ok", items: await views(this.d, this.profiles, page.items), nextCursor: page.nextCursor };
  }
}

export type AnswerResult =
  | { readonly kind: "ok"; readonly status: ModerationStatus }
  | { readonly kind: "invalid"; readonly errors: readonly FieldError[] }
  | { readonly kind: "not_found" };

export class AnswerQuestion {
  constructor(
    private readonly d: ReviewDeps,
    private readonly pipeline: ModerationPipeline,
  ) {}

  async execute(input: {
    readonly questionId: string;
    readonly actorUserId: string;
    readonly actorStoreIds: readonly string[];
    readonly body: string;
  }): Promise<AnswerResult> {
    const q = await this.d.store.getQuestion(input.questionId);
    if (q === null || q.status !== "PUBLISHED" || !input.actorStoreIds.includes(q.storeId)) return { kind: "not_found" };
    const v = validateShortText("body", input.body, "answer");
    if (!v.ok) return { kind: "invalid", errors: v.errors };
    const now = this.d.clock.nowMs();
    await this.d.store.upsertAnswer(
      {
        id: this.d.ids.uuidV7(),
        questionId: q.id,
        storeId: q.storeId,
        authorUserId: input.actorUserId,
        body: v.value,
        status: "SUBMITTED",
        holdReason: null,
        createdAtMs: now,
        updatedAtMs: now,
      },
      this.d.ids.uuidV7(),
    );
    const stored = await this.d.store.getAnswerByQuestionStore(q.id, q.storeId);
    if (stored === null) return { kind: "not_found" };
    const status = (await this.pipeline.run("answer", stored.id)) ?? "SUBMITTED";
    return { kind: "ok", status };
  }
}

/** Flags published questions whose 48h response window passed. Each question fires once. */
export class SweepQaSla {
  constructor(private readonly d: ReviewDeps) {}

  async execute(limit = 200): Promise<number> {
    const now = this.d.clock.nowMs();
    const due = await this.d.store.listOverdueQuestions(now, limit);
    let n = 0;
    for (const q of due) {
      const marked = await this.d.store.markSlaBreached(q.id, now, [
        { type: "qa.sla_breached", questionId: q.id, storeId: q.storeId, dueAtMs: q.slaDueAtMs ?? now },
      ]);
      if (marked) n += 1;
    }
    return n;
  }
}
