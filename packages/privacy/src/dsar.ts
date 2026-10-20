import { z } from 'zod';
import { DsarTransitionError, InvalidInputError } from './errors.js';
import { addDays, type Clock, toIso } from './ports.js';

export const DSAR_TYPES = ['export', 'delete', 'rectify'] as const;
export type DsarType = (typeof DSAR_TYPES)[number];

export const DSAR_STATES = [
  'received',
  'verifying_identity',
  'in_progress',
  'completed',
  'rejected',
  'cancelled',
] as const;
export type DsarState = (typeof DSAR_STATES)[number];

/** VERIFY BEFORE LAUNCH: statutory deadline under PDPL 151/2020 and Executive Regulations. */
export const DEFAULT_DSAR_SLA_DAYS = 30;
/** Product target for export readiness (B1: ready <= 72h). Not a statutory figure. */
export const EXPORT_TARGET_HOURS = 72;

const TRANSITIONS: Readonly<Record<DsarState, readonly DsarState[]>> = {
  received: ['verifying_identity', 'rejected', 'cancelled'],
  verifying_identity: ['in_progress', 'rejected', 'cancelled'],
  in_progress: ['completed', 'rejected', 'cancelled'],
  completed: [],
  rejected: [],
  cancelled: [],
};

export const TERMINAL_DSAR_STATES: readonly DsarState[] = ['completed', 'rejected', 'cancelled'];

export const DsarRequestSchema = z
  .object({
    id: z.string().min(1),
    userId: z.string().min(1),
    type: z.enum(DSAR_TYPES),
    state: z.enum(DSAR_STATES),
    receivedAt: z.iso.datetime(),
    dueAt: z.iso.datetime(),
    slaDays: z.number().int().positive(),
    /** Present for export requests only. */
    exportTargetAt: z.iso.datetime().optional(),
    updatedAt: z.iso.datetime(),
    /** Required when rejected; a reason code, never free-text PII. */
    rejectionReason: z.string().min(1).optional(),
  })
  .strict();
export type DsarRequest = z.infer<typeof DsarRequestSchema>;

export interface DsarConfig {
  readonly slaDays: number;
}
export const DEFAULT_DSAR_CONFIG: DsarConfig = { slaDays: DEFAULT_DSAR_SLA_DAYS };

export function createDsar(
  input: { readonly id: string; readonly userId: string; readonly type: DsarType },
  clock: Clock,
  config: DsarConfig = DEFAULT_DSAR_CONFIG,
): DsarRequest {
  if (!Number.isInteger(config.slaDays) || config.slaDays < 1) {
    throw new InvalidInputError('slaDays must be a positive integer');
  }
  const receivedAt = toIso(clock.now());
  const base = {
    id: input.id,
    userId: input.userId,
    type: input.type,
    state: 'received' as const,
    receivedAt,
    dueAt: addDays(receivedAt, config.slaDays),
    slaDays: config.slaDays,
    updatedAt: receivedAt,
  };
  const withTarget =
    input.type === 'export'
      ? { ...base, exportTargetAt: new Date(Date.parse(receivedAt) + EXPORT_TARGET_HOURS * 3_600_000).toISOString() }
      : base;
  return DsarRequestSchema.parse(withTarget);
}

export function canTransition(from: DsarState, to: DsarState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function transitionDsar(
  req: DsarRequest,
  to: DsarState,
  clock: Clock,
  opts: { readonly rejectionReason?: string } = {},
): DsarRequest {
  if (!canTransition(req.state, to)) {
    throw new DsarTransitionError(`DSAR ${req.id}: ${req.state} -> ${to} is not allowed`);
  }
  if (to === 'rejected' && (opts.rejectionReason === undefined || opts.rejectionReason.length === 0)) {
    throw new DsarTransitionError(`DSAR ${req.id}: rejection requires a reason`);
  }
  const next = { ...req, state: to, updatedAt: toIso(clock.now()) };
  return DsarRequestSchema.parse(
    to === 'rejected' && opts.rejectionReason !== undefined ? { ...next, rejectionReason: opts.rejectionReason } : next,
  );
}

export function isOverdue(req: DsarRequest, clock: Clock): boolean {
  return !TERMINAL_DSAR_STATES.includes(req.state) && clock.now().getTime() > Date.parse(req.dueAt);
}

/** Whole days remaining (can be negative). For the DPO queue. */
export function daysRemaining(req: DsarRequest, clock: Clock): number {
  return Math.floor((Date.parse(req.dueAt) - clock.now().getTime()) / 86_400_000);
}
