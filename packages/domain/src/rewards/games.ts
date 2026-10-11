import { InvalidOddsTableError } from "./errors";

/** Parts per million. An odds table always sums to exactly 1_000_000. */
export const PPM = 1_000_000;

/** Games are free to play and award coins or vouchers only. There is deliberately no cash kind. */
export const GAMES = ["daily_spin", "scratch_card"] as const;
export type Game = (typeof GAMES)[number];

export const OUTCOME_KINDS = ["nothing", "coins", "voucher"] as const;
export type OutcomeKind = (typeof OUTCOME_KINDS)[number];

export interface OddsOutcome {
  readonly id: string;
  readonly kind: OutcomeKind;
  readonly ppm: number;
  /** Coins awarded, kind coins only. */
  readonly coins: bigint | null;
  /** Voucher template (promotions module), kind voucher only. */
  readonly voucherTemplateId: string | null;
}

export interface OddsTable {
  readonly outcomes: readonly OddsOutcome[];
}

export function validateOddsTable(t: OddsTable, maxCoins: bigint): OddsTable {
  const bad = (m: string): never => {
    throw new InvalidOddsTableError(m);
  };
  if (t.outcomes.length < 1 || t.outcomes.length > 20) bad("1..20 outcomes required");
  const seen = new Set<string>();
  let sum = 0;
  for (const o of t.outcomes) {
    if (!/^[a-z0-9_]{1,40}$/.test(o.id)) bad(`bad outcome id ${o.id}`);
    if (seen.has(o.id)) bad(`duplicate outcome id ${o.id}`);
    seen.add(o.id);
    if (!(OUTCOME_KINDS as readonly string[]).includes(o.kind)) bad(`unsupported outcome kind ${String(o.kind)} (no cash outcomes)`);
    if (!Number.isInteger(o.ppm) || o.ppm < 0 || o.ppm > PPM) bad(`bad ppm for ${o.id}`);
    sum += o.ppm;
    if (o.kind === "coins") {
      if (o.coins === null || o.coins <= 0n || o.coins > maxCoins) bad(`coins out of range for ${o.id}`);
      if (o.voucherTemplateId !== null) bad(`coins outcome ${o.id} must not carry a voucher`);
    } else if (o.kind === "voucher") {
      if (o.voucherTemplateId === null || o.voucherTemplateId.length === 0) bad(`voucher outcome ${o.id} needs a template`);
      if (o.coins !== null) bad(`voucher outcome ${o.id} must not carry coins`);
    } else if (o.coins !== null || o.voucherTemplateId !== null) {
      bad(`nothing outcome ${o.id} must carry no reward`);
    }
  }
  if (sum !== PPM) bad(`probabilities must sum to ${PPM} ppm, got ${sum}`);
  return t;
}

/** Maps a roll in [0, 1_000_000) to an outcome by cumulative ppm in table order. Pure. */
export function selectOutcome(t: OddsTable, roll: number): OddsOutcome {
  if (!Number.isInteger(roll) || roll < 0 || roll >= PPM) throw new InvalidOddsTableError("roll out of range");
  let acc = 0;
  for (const o of t.outcomes) {
    acc += o.ppm;
    if (roll < acc) return o;
  }
  throw new InvalidOddsTableError("table does not cover the roll (invalid table)");
}

const LIMIT_48 = Math.floor(2 ** 48 / PPM) * PPM;

/**
 * Unbiased roll from random bytes by rejection sampling over 48-bit blocks. `nextBlock` returns at
 * least 6 bytes. A block at or above the largest multiple of 1e6 below 2^48 is discarded.
 */
export function rollFromBlocks(nextBlock: (index: number) => Uint8Array): number {
  for (let i = 0; i < 64; i += 1) {
    const b = nextBlock(i);
    if (b.length < 6) throw new InvalidOddsTableError("random block shorter than 6 bytes");
    let x = 0;
    for (let k = 0; k < 6; k += 1) x = x * 256 + (b[k] as number);
    if (x < LIMIT_48) return x % PPM;
  }
  throw new InvalidOddsTableError("random source rejected 64 consecutive blocks");
}

export interface OddsDisclosureLine {
  readonly id: string;
  readonly kind: OutcomeKind;
  readonly coins: bigint | null;
  readonly voucherTemplateId: string | null;
  readonly ppm: number;
  /** Exact decimal string, for example "12.5%" (ppm / 10000, no rounding). */
  readonly percent: string;
}

/** The odds page. Exact: ppm is divisible into a decimal string without rounding. */
export function oddsDisclosure(t: OddsTable): OddsDisclosureLine[] {
  return t.outcomes.map((o) => {
    const whole = Math.floor(o.ppm / 10_000);
    const frac = String(o.ppm % 10_000).padStart(4, "0").replace(/0+$/, "");
    return {
      id: o.id,
      kind: o.kind,
      coins: o.coins,
      voucherTemplateId: o.voucherTemplateId,
      ppm: o.ppm,
      percent: `${whole}${frac.length > 0 ? `.${frac}` : ""}%`,
    };
  });
}

/** Expected coins per play in micro-coins (coins * ppm), for the published disclosure and monitoring. */
export function expectedMicroCoins(t: OddsTable): bigint {
  let sum = 0n;
  for (const o of t.outcomes) if (o.kind === "coins" && o.coins !== null) sum += o.coins * BigInt(o.ppm);
  return sum;
}

/**
 * The message an auditable draw HMACs (B-7: auditable, not provably fair; the seed hash is not
 * committed to the player before the draw, so no copy may claim provable fairness).
 */
/** The message of the draw HMAC. Everything that identifies the play, nothing secret. */
export function drawMessage(input: {
  readonly userId: string;
  readonly game: Game;
  readonly dayKey: string;
  readonly seq: number;
  readonly oddsVersionId: string;
}): string {
  return `${input.userId}|${input.game}|${input.dayKey}|${input.seq}|${input.oddsVersionId}`;
}
