import type { Queryable } from "@outlet/db";
import { z } from "zod";
import { DAY_MS, HOUR_MS, resolveDeps } from "./deps.js";
import type { PrivacyDeps, ResolvedDeps } from "./deps.js";
import { BreachCloseBlockedError, BreachNotFoundError, BreachSummaryPiiError, InvalidTransitionError } from "./errors.js";

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
  openedBy: z.string().min(1),
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
  readonly subjectsDeadlineAt: Date | null;
  readonly subjectsNotifiedAt: Date | null;
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
  subjects_deadline_at: Date | null;
  subjects_notified_at: Date | null;
  closed_at: Date | null;
  postmortem_ref: string | null;
}

const d = (v: Date | string | null): Date | null => (v === null ? null : new Date(v));
const view = (r: Row): BreachView => ({
  id: r.id, marketId: r.market_id, openedBy: r.opened_by, detectedAt: new Date(r.detected_at), openedAt: new Date(r.opened_at),
  severity: r.severity, status: r.status, summary: r.summary, dataCategories: r.data_categories, subjectsEstimate: r.subjects_estimate,
  pdpcDeadlineAt: new Date(r.pdpc_deadline_at), pdpcNotifiedAt: d(r.pdpc_notified_at), subjectsDeadlineAt: d(r.subjects_deadline_at),
  subjectsNotifiedAt: d(r.subjects_notified_at), closedAt: d(r.closed_at), postmortemRef: r.postmortem_ref,
});

/** Which statutory clocks are blown at `now` (a notice sent late still counts as missed). */
export const breachDeadlines = (b: BreachView, now: Date): { readonly pdpcMissed: boolean; readonly subjectsMissed: boolean } => ({
  pdpcMissed: (b.pdpcNotifiedAt ?? now).getTime() > b.pdpcDeadlineAt.getTime(),
  subjectsMissed: b.subjectsDeadlineAt !== null && (b.subjectsNotifiedAt ?? now).getTime() > b.subjectsDeadlineAt.getTime(),
});

const COLS = "id, market_id, opened_by, detected_at, opened_at, severity, status, summary, data_categories, subjects_estimate, pdpc_deadline_at, pdpc_notified_at, subjects_deadline_at, subjects_notified_at, closed_at, postmortem_ref";

/** PDPL breach register (docs master prompt B1). Authorization (privacy.breach.open / breach.manage) is the caller's job. */
export class BreachRegister {
  private readonly d: ResolvedDeps;
  constructor(deps: PrivacyDeps) {
    this.d = resolveDeps(deps);
  }

  async open(raw: OpenBreachInput): Promise<BreachView> {
    const parsed = OpenBreachSchema.safeParse(raw);
    if (!parsed.success) {
      if (parsed.error.issues.some((i) => i.path[0] === "summary" && i.message === "pii")) throw new BreachSummaryPiiError();
      throw parsed.error;
    }
    const i = parsed.data;
    const now = this.d.now();
    const detected = i.detectedAt ?? now;
    if (detected.getTime() > now.getTime()) throw new RangeError("detectedAt cannot be in the future");
    const id = this.d.newId();
    const deadline = new Date(detected.getTime() + PDPC_DEADLINE_HOURS * HOUR_MS);
    return this.d.db.transaction(async (tx) => {
      const r = await tx.query<Row>(
        `INSERT INTO breach_records (id, market_id, opened_by, detected_at, opened_at, severity, status, summary, data_categories, subjects_estimate, pdpc_deadline_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,'OPEN',$7,$8,$9,$10,$5) RETURNING ${COLS}`,
        [id, i.marketId, i.openedBy, detected, now, i.severity, i.summary, i.dataCategories, i.subjectsEstimate ?? null, deadline],
      );
      const v = view(first(r.rows));
      await this.emit(tx, "privacy.breach_opened", v, now, { severity: v.severity, pdpcDeadlineAt: deadline.toISOString() });
      return v;
    });
  }

  async update(marketId: string, id: string, raw: UpdateBreachInput): Promise<BreachView> {
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
      let status = cur.status;
      let pdpcAt = cur.pdpcNotifiedAt;
      let subjAt = cur.subjectsNotifiedAt;
      let subjDeadline = cur.subjectsDeadlineAt;
      if (patch.status !== undefined) {
        if (!BREACH_TRANSITIONS[cur.status].includes(patch.status)) throw new InvalidTransitionError("breach", cur.status, patch.status);
        status = patch.status;
        if (patch.status === "PDPC_NOTIFIED") {
          pdpcAt = at;
          subjDeadline = new Date(at.getTime() + SUBJECTS_DEADLINE_DAYS * DAY_MS);
        }
        if (patch.status === "SUBJECTS_NOTIFIED") subjAt = at;
      } else if (cur.status === "CLOSED") {
        throw new InvalidTransitionError("breach", "CLOSED", "CLOSED");
      }
      const r = await tx.query<Row>(
        `UPDATE breach_records SET severity = $3, summary = $4, data_categories = $5, subjects_estimate = $6, status = $7,
                pdpc_notified_at = $8, subjects_deadline_at = $9, subjects_notified_at = $10, updated_at = $11
          WHERE id = $1 AND market_id = $2 RETURNING ${COLS}`,
        [id, marketId, patch.severity ?? cur.severity, patch.summary ?? cur.summary, patch.dataCategories ?? cur.dataCategories,
         patch.subjectsEstimate ?? cur.subjectsEstimate, status, pdpcAt, subjDeadline, subjAt, now],
      );
      const v = view(first(r.rows));
      await this.emit(tx, "privacy.breach_updated", v, now, {
        status: v.status, severity: v.severity, ...(patch.status === undefined ? {} : { transition: patch.status }),
      });
      return v;
    });
  }

  /** Needs the PDPC notice, the subject notice (unless nobody is affected) and a post-mortem reference. */
  async close(marketId: string, id: string, postmortemRef: string): Promise<BreachView> {
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
