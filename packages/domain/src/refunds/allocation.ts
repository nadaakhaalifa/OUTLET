import { money, type Money } from "../money";
import { InvalidRefundInputError } from "./errors";

export interface LineNet {
  readonly orderLineId: string;
  readonly net: Money;
}

export interface LegAmount {
  readonly legKey: string;
  readonly amount: Money;
}

export interface LegLineShare {
  readonly legKey: string;
  readonly orderLineId: string;
  readonly amount: Money;
}

/**
 * Attributes each routed leg to order lines (for refund_lines, ETA credit notes and seller
 * statements). Waterfall fill: legs and lines are consumed in order, so both marginals are exact,
 * every part is an integer and the parts sum to the total. Comparison: proportional split per leg
 * would need a rounding rule per cell and cannot guarantee that line sums stay exact.
 */
export function attributeLegsToLines(lines: readonly LineNet[], legs: readonly LegAmount[]): LegLineShare[] {
  const lineTotal = lines.reduce((a, l) => a + l.net.amount, 0n);
  const legTotal = legs.reduce((a, l) => a + l.amount.amount, 0n);
  if (lineTotal !== legTotal) {
    throw new InvalidRefundInputError(`legs ${legTotal} differ from lines ${lineTotal}`);
  }
  for (const l of lines) if (l.net.amount < 0n) throw new InvalidRefundInputError("negative line net");
  for (const l of legs) if (l.amount.amount < 0n) throw new InvalidRefundInputError("negative leg amount");
  const left = lines.map((l) => l.net.amount);
  const out: LegLineShare[] = [];
  let li = 0;
  for (const leg of legs) {
    let need = leg.amount.amount;
    while (need > 0n) {
      const have = left[li];
      const line = lines[li];
      if (have === undefined || line === undefined) throw new InvalidRefundInputError("lines exhausted");
      if (have === 0n) {
        li += 1;
        continue;
      }
      const take = have < need ? have : need;
      out.push({ legKey: leg.legKey, orderLineId: line.orderLineId, amount: money(take) });
      left[li] = have - take;
      need -= take;
    }
  }
  return out;
}
