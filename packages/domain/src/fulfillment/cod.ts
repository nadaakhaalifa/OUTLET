import { equals, type Money } from "../money";

export const COD_MATCH_STATUSES = ["MATCHED", "AMOUNT_DIFF", "UNKNOWN_AWB", "NOT_COD"] as const;
export type CodMatchStatus = (typeof COD_MATCH_STATUSES)[number];

export type CodStatus = "NONE" | "PENDING" | "COLLECTED" | "REMITTED" | "MISMATCH";

export interface CodShipmentFacts {
  /** Null when the shipment is not cash on delivery. */
  readonly expected: Money | null;
}

/**
 * Matches one remittance line to the shipment it names. No money moves: the result only decides
 * the record's match status and whether the shipment may take the REMIT_COD transition.
 */
export function matchCodLine(shipment: CodShipmentFacts | null, collected: Money): CodMatchStatus {
  if (shipment === null) return "UNKNOWN_AWB";
  if (shipment.expected === null) return "NOT_COD";
  return equals(shipment.expected, collected) ? "MATCHED" : "AMOUNT_DIFF";
}
