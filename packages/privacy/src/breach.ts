import type { Queryable } from "@outlet/db";
import { z } from "zod";
import { DAY_MS, HOUR_MS, resolveDeps } from "./deps.js";
import type { PrivacyDeps, ResolvedDeps } from "./deps.js";
import { authorize } from "@outlet/policy";
import type { Principal } from "@outlet/policy";
import { BreachCloseBlockedError, BreachForbiddenError, BreachNotFoundError, BreachSummaryPiiError, BreachTimestampError, InvalidTransitionError } from "./errors.js";

/** Policy actions (packages/policy): DPO and security may open; only the DPO may update and close. */
export const BREACH_OPEN_ACTION = "privacy.breach.open";
export const BREACH_MANAGE_ACTION = "breach.manage";

/** PDPL B1: PDPC notice within 72 h of detection, affected individuals within 3 days of the PDPC notice. */
export const PDPC_DEADLINE_HOURS = 72;
export const SUBJECTS_DEADLINE_DAYS = 3;

export const BREACH_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type BreachSeverity = (typeof BREACH_SEVERITIES)[number];
export type BreachStatus = "OPEN" | "TRIAGED" | "PDPC_NOTIFIED" | "SUBJECTS_NOTIFIED" | "CLOSED";

export const BREACH_TRANSITIONS: Readonly<Record<BreachStatus, readonly BreachStatus[]>> = {
  OPEN: ["TRIAGED", "PDPC_NOTIFIED"],
  TRIAGED: ["PDPC_NOTIFIED"],
  PDPC_NOTIFIED: ["SUBJECTS_NOTIFIED", "CLOSED"],
  SUBJECTS_NOTIFIED: ["CLOSED"],
  CLOSED: [],
};

const PII_PATTERNS: readonly RegExp[] = [/[^\s@]+@[^\s@]+\.[^\s@]+/, /\+?\d[\d\s-]{7,}\d/];
const summary = z.string().trim().min(1).max(2000).refine((s) => !PII_PATTERNS.some((p) => p.test(s)), { error: "pii" });

export const OpenBreachSchema = z.object({
  marketId: z.string().min(1),
  /** Defaults to the actor's user id. */
  openedBy: z.string().min(1).optional(),
  severity: z.enum(BREACH_SEVERITIES),
  summary,
  /** When the breach was detected (clock for the 72 h deadline). Defaults to now; never in the future. */
  detectedAt: z.date().optional(),
  dataCategories: z.array(z.string().min(1)).default([]),
  subjectsEstimate: z.number().int().nonnegative().optional(),
});
export type OpenBreachInput = z.input<typeof OpenBreachSchema>;

export const UpdateBreachSchema = z.object({
  severity: z.enum(BREACH_SEVERITIES).optional(),
  summary: summary.optional(),
  dataCategories: z.array(z.string().min(1)).optional(),
  subjectsEstimate: z.number().int().nonnegative().optional(),
  /** Next status; moves along BREACH_TRANSITIONS (use close() for CLOSED). */
  status: z.enum(["TRIAGED", "PDPC_NOTIFIED", "SUBJECTS_NOTIFIED"]).optional(),
  /** When the notice actually went out (PDPC_NOTIFIED / SUBJECTS_NOTIFIED). Defaults to now. */
  notifiedAt: z.date().optional(),
});
export type UpdateBreachInput = z.input<typeof UpdateBreachSchema>;

export interface BreachView {
  readonly id: string;
  readonly marketId: string;
  readonly openedBy: string;
  readonly detectedAt: Date;
  readonly openedAt: Date;
  readonly severity: BreachSeverity;
  readonly status: BreachStatus;
  readonly summary: string;
  readonly dataCategories: readonly string[];
  readonly subjectsEstimate: number | null;
  readonly pdpcDeadlineAt: Date;
  readonly pdpcNotifiedAt: Date | null;
  /** When the PDPC notice was recorded in the register (system clock; notifiedAt is the claimed send time). */
  readonly pdpcRecordedAt: Date | null;
  readonly subjectsDeadlineAt: Date | null;
  readonly subjectsNotifiedAt: Date | null;
  readonly subjectsRecordedAt: Date | null;
  readonly closedAt: Date | null;
  readonly postmortemRef: string | null;
}

interface Row {
  id: string;
  market_id: string;
  opened_by: string;
  detected_at: Date;
  opened_at: Date;
  severity: BreachSeverity;
  status: BreachStatus;
  summary: string;
  data_categories: string[];
  subjects_estimate: number | null;
  pdpc_deadline_at: Date;
  pdpc_notified_at: Date | null;
  pdpc_recorded_at: Date | null;
  subjects_deadline_at: Date | null;
  subjects_notified_at: Date | null;
  subjects_recorded_at: Date | null;
  closed_at: Date | null;
  postmortem_ref: string | null;
}

const d = (v: Date | string | null): Date | null => (v === null ? null : new Date(v));
const view = (r: Row): BreachView => ({
  id: r.id, marketId: r.market_id, openedBy: r.opened_by, detectedAt: new Date(r.detected_at), openedAt: new Date(r.opened_at),
  severity: r.severity, status: r.status, summary: r.summary, dataCategories: r.data_categories, subjectsEstimate: r.subjects_estimate,
  pdpcDeadlineAt: new Date(r.pdpc_deadline_at), pdpcNotifiedAt: d(r.pdpc_notified_at), pdpcRecordedAt: d(r.pdpc_recorded_at), subjectsDeadlineAt: d(r.subjects_deadline_at),
  subjectsNotifiedAt: d(r.subjects_notified_at), subjectsRecordedAt: d(r.subjects_recorded_at), closedAt: d(r.closed_at), postmortemRef: r.postmortem_ref,
});

/** Which statutory clocks are blown at `now` (a notice sent late still counts as missed). */
export const breachDeadlines = (b: BreachView, now: Date): { readonly pdpcMissed: boolean; readonly subjectsMissed: boolean } => ({
  pdpcMissed: (b.pdpcNotifiedAt ?? now).getTime() > b.pdpcDeadlineAt.getTime(),
  subjectsMissed: b.subjectsDeadlineAt !== null && (b.subjectsNotifiedAt ?? now).getTime() > b.subjectsDeadlineAt.getTime(),
});

const COLS = "id, market_id, opened_by, detected_at, opened_at, severity, status, summary, data_categories, subjects_estimate, pdpc_deadline_at, pdpc_notified_at, pdpc_recorded_at, subjects_deadline_at, subjects_notified_at, subjects_recorded_at, closed_at, postmortem_ref";

/** PDPL breach register (docs master prompt B1). Every mutation takes the acting Principal and is authorized here (privacy.breach.open to open, breach.manage to update/close) and audited (hash chain) in the same transaction. */
export class BreachRegister {
  private readonly d: ResolvedDeps;
  constructor(deps: PrivacyDeps) {
    this.d = resolveDeps(deps);
  }

  async open(actor: Principal, raw: OpenBreachInput): Promise<BreachView> {
    this.guard(actor, BREACH_OPEN_ACTION, null);
    const parsed = OpenBreachSchema.safeParse(raw);
    if (!parsed.success) {
      if (parsed.error.issues.some((i) => i.path[0] === "summary" && i.message === "pii")) throw new BreachSummaryPiiError();
      throw parsed.error;
    }
    const i = parsed.data;
    this.guard(actor, BREACH_OPEN_ACTION, i.marketId);
    const now = this.d.now();
    const detected = i.detectedAt ?? now;
    if (detected.getTime() > now.getTime()) throw new BreachTimestampError("detectedAt cannot be in the future");
    const openedBy = i.openedBy ?? actor.userId;
    if (openedBy === undefined) throw new BreachTimestampError("openedBy is required when the actor has no user id");
    const id = this.d.newId();
    const deadline = new Date(detected.getTime() + PDPC_DEADLINE_HOURS * HOUR_MS);
    return this.d.db.transaction(async (tx) => {
      const r = await tx.query<Row>(
        `INSERT INTO breach_records (id, market_id, opened_by, detected_at, opened_at, severity, status, summary, data_categories, subjects_estimate, pdpc_deadline_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,'OPEN',$7,$8,$9,$10,$5) RETURNING ${COLS}`,
        [id, i.marketId, openedBy, detected, now, i.severity, i.summary, i.dataCategories, i.subjectsEstimate ?? null, deadline],
      );
      const v = view(first(r.rows));
      await this.audit(tx, actor, "privacy.breach.opened", null, v, now);
      await this.emit(tx, "privacy.breach_opened", v, now, { severity: v.severity, pdpcDeadlineAt: deadline.toISOString() });
      return v;
    });
  }

  async update(actor: Principal, marketId: string, id: string, raw: UpdateBreachInput): Promise<BreachView> {
    this.guard(actor, BREACH_MANAGE_ACTION, marketId);
    const p = UpdateBreachSchema.safeParse(raw);
    if (!p.success) {
      if (p.error.issues.some((i) => i.path[0] === "summary" && i.message === "pii")) throw new BreachSummaryPiiError();
      throw p.error;
    }
    const patch = p.data;
    const now = this.d.now();
    return this.d.db.transaction(async (tx) => {
      const cur = await this.lock(tx, marketId, id);
      const at = patch.notifiedAt ?? now;
      if (patch.notifiedAt !== undefined) {
        if (at.getTime() < cur.detectedAt.getTime()) throw new BreachTimestampError("notifiedAt cannot be before detectedAt");
        if (at.getTime() > now.getTime()) throw new BreachTimestampError("notifiedAt cannot be in the future");
      }
      if (patch.status === "SUBJECTS_NOTIFIED" && cur.pdpcNotifiedAt !== null && at.getTime() < cur.pdpcNotifiedAt.getTime()) {
        throw new BreachTimestampError("subjects cannot be notified before the PDPC notice");
      }
      let status = cur.status;
      let pdpcAt = cur.pdpcNotifiedAt;
      let subjAt = cur.subjectsNotifiedAt;
      let pdpcRec = cur.pdpcRecordedAt;
      let subjRec = cur.subjectsRecordedAt;
      let subjDeadline = cur.subjectsDeadlineAt;
      if (patch.status !== undefined) {
        if (!BREACH_TRANSITIONS[cur.status].includes(patch.status)) throw new InvalidTransitionError("breach", cur.status, patch.status);
        status = patch.status;
        if (patch.status === "PDPC_NOTIFIED") {
          pdpcAt = at;
          pdpcRec = now;
          subjDeadline = new Date(at.getTime() + SUBJECTS_DEADLINE_DAYS * DAY_MS);
        }
        if (patch.status === "SUBJECTS_NOTIFIED") {
          subjAt = at;
          subjRec = now;
        }
      } else if (cur.status === "CLOSED") {
        throw new InvalidTransitionError("breach", "CLOSED", "CLOSED");
      }
      const r = await tx.query<Row>(
        `UPDATE breach_records SET severity = $3, summary = $4, data_categories = $5, subjects_estimate = $6, status = $7,
                pdpc_notified_at = $8, subjects_deadline_at = $9, subjects_notified_at = $10, updated_at = $11,
                pdpc_recorded_at = $12, subjects_recorded_at = $13
          WHERE id = $1 AND market_id = $2 RETURNING ${COLS}`,
        [id, marketId, patch.severity ?? cur.severity, patch.summary ?? cur.summary, patch.dataCategories ?? cur.dataCategories,
         patch.subjectsEstimate ?? cur.subjectsEstimate, status, pdpcAt, subjDeadline, subjAt, now, pdpcRec, subjRec],
      );
      const v = view(first(r.rows));
      await this.audit(tx, actor, "privacy.breach.updated", cur, v, now);
      await this.emit(tx, "privacy.breach_updated", v, now, {
        status: v.status, severity: v.severity, ...(patch.status === undefined ? {} : { transition: patch.status }),
      });
      return v;
    });
  }

  /** Needs the PDPC notice, the subject notice (unless nobody is affected) and a post-mortem reference. */
  async close(actor: Principal, marketId: string, id: string, postmortemRef: string): Promise<BreachView> {
    this.guard(actor, BREACH_MANAGE_ACTION, marketId);
    const ref = z.string().trim().min(1).max(200).parse(postmortemRef);
    const now = this.d.now();
    return this.d.db.transaction(async (tx) => {
      const cur = await this.lock(tx, marketId, id);
      if (!BREACH_TRANSITIONS[cur.status].includes("CLOSED")) {
        throw new InvalidTransitionError("breach", cur.status, "CLOSED");
      }
      const missing: string[] = [];
      if (cur.subjectsNotifiedAt === null && cur.subjectsEstimate !== 0) missing.push("subjects_notified");
      if (missing.length > 0) throw new BreachCloseBlockedError(missing);
      const r = await tx.query<Row>(
        `UPDATE breach_records SET status = 'CLOSED', closed_at = $3, postmortem_ref = $4, updated_at = $3
          WHERE id = $1 AND market_id = $2 RETURNING ${COLS}`,
        [id, marketId, now, ref],
      );
      const v = view(first(r.rows));
      await this.audit(tx, actor, "privacy.breach.closed", cur, v, now);
      await this.emit(tx, "privacy.breach_closed", v, now, { postmortemRef: ref });
      return v;
    });
  }

  async get(marketId: string, id: string): Promise<BreachView> {
    const r = await this.d.db.query<Row>(`SELECT ${COLS} FROM breach_records WHERE id = $1 AND market_id = $2`, [id, marketId]);
    const row = r.rows[0];
    if (!row) throw new BreachNotFoundError(id);
    return view(row);
  }

  async list(marketId: string, status?: BreachStatus): Promise<readonly BreachView[]> {
    const r = await this.d.db.query<Row>(
      `SELECT ${COLS} FROM breach_records WHERE market_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY detected_at DESC, id DESC`,
      [marketId, status ?? null],
    );
    return r.rows.map(view);
  }

  /** Open breaches whose PDPC or subject deadline has passed without the notice (for the DPO dashboard and paging). */
  async overdue(marketId: string): Promise<readonly BreachView[]> {
    const now = this.d.now();
    const open = await this.list(marketId);
    return open.filter((b) => b.status !== "CLOSED" && ((b.pdpcNotifiedAt === null && now > b.pdpcDeadlineAt) || (b.subjectsDeadlineAt !== null && b.subjectsNotifiedAt === null && now > b.subjectsDeadlineAt)));
  }

  private guard(actor: Principal, action: string, marketId: string | null): void {
    if (authorize(actor, action, { type: "breach", marketId: marketId ?? actor.marketId }).effect !== "allow") throw new BreachForbiddenError(action);
  }

  /** Hash-chain entry in the caller's transaction. Ids, enums and timestamps only: no summary, categories or other free text. */
  private async audit(tx: Queryable, actor: Principal, action: string, before: BreachView | null, after: BreachView, at: Date): Promise<void> {
    if (this.d.audit === undefined) throw new Error("BreachRegister requires an audit store (PrivacyDeps.audit)");
    const snap = (b: BreachView): Record<string, string | null> => ({
      status: b.status, severity: b.severity, detectedAt: b.detectedAt.toISOString(), pdpcNotifiedAt: b.pdpcNotifiedAt?.toISOString() ?? null,
      pdpcRecordedAt: b.pdpcRecordedAt?.toISOString() ?? null, subjectsNotifiedAt: b.subjectsNotifiedAt?.toISOString() ?? null,
      subjectsRecordedAt: b.subjectsRecordedAt?.toISOString() ?? null, closedAt: b.closedAt?.toISOString() ?? null,
    });
    await this.d.audit.appendIn(tx, {
      marketId: after.marketId, actorType: actor.kind === "admin" ? "staff" : actor.kind === "system" ? "system" : "user", actorId: actor.userId ?? null,
      action, targetType: "breach", targetId: after.id, diff: { before: before === null ? null : snap(before), after: { ...snap(after), at: at.toISOString() } },
      ipHash: null, deviceId: null, requestId: null,
    });
  }

  private async lock(tx: Queryable, marketId: string, id: string): Promise<BreachView> {
    const r = await tx.query<Row>(`SELECT ${COLS} FROM breach_records WHERE id = $1 AND market_id = $2 FOR UPDATE`, [id, marketId]);
    const row = r.rows[0];
    if (!row) throw new BreachNotFoundError(id);
    return view(row);
  }

  private emit(tx: Queryable, type: string, b: BreachView, at: Date, payload: Record<string, string>): Promise<unknown> {
    return this.d.outbox.append(tx, {
      id: this.d.newId(),
      type,
      aggregateType: "breach",
      aggregateId: b.id,
      marketId: b.marketId,
      occurredAt: at.toISOString(),
      payload: { breachId: b.id, ...payload },
    });
  }
}

const first = <T>(rows: readonly T[]): T => {
  const r = rows[0];
  if (r === undefined) throw new Error("expected one row");
  return r;
};
