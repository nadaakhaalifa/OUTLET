import { z } from "zod";
import { PayoutsError } from "./errors.js";

export const SETTLEMENT_KINDS = ["capture", "refund", "fee", "chargeback", "payout"] as const;
export type SettlementKind = (typeof SETTLEMENT_KINDS)[number];

const digits = z.string().regex(/^\d{1,18}$/, "amount must be non-negative integer piastres");
const LineSchema = z.strictObject({
  provider_ref: z.string().min(1).max(200),
  kind: z.enum(SETTLEMENT_KINDS),
  amount_minor: digits,
  fee_minor: digits.default("0"),
  currency: z.string().regex(/^[A-Z]{3}$/),
  value_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export interface SettlementLineInput {
  readonly providerRef: string;
  readonly kind: SettlementKind;
  readonly amountMinor: bigint;
  readonly feeMinor: bigint;
  readonly currency: string;
  readonly valueDate: string;
}

export const MAX_SETTLEMENT_ROWS = 50_000;
const CSV_HEADER = ["provider_ref", "kind", "amount_minor", "fee_minor", "currency", "value_date"];

const toLine = (raw: unknown, where: string): SettlementLineInput => {
  const p = LineSchema.safeParse(raw);
  if (!p.success) throw new PayoutsError("INVALID_INPUT", `settlement ${where}: ${p.error.issues[0]?.message ?? "invalid"}`);
  const d = p.data;
  if (Number.isNaN(Date.parse(`${d.value_date}T00:00:00Z`))) throw new PayoutsError("INVALID_INPUT", `settlement ${where}: invalid value_date`);
  return { providerRef: d.provider_ref, kind: d.kind, amountMinor: BigInt(d.amount_minor), feeMinor: BigInt(d.fee_minor), currency: d.currency, valueDate: d.value_date };
};

/** Header row required (provider_ref,kind,amount_minor,fee_minor,currency,value_date). No quoting: provider refs never contain commas. */
export const parseSettlementCsv = (content: string): SettlementLineInput[] => {
  const rows = content.split(/\r?\n/).filter((r) => r.trim().length > 0);
  const [head, ...body] = rows;
  if (head?.split(",").map((h) => h.trim()).join(",") !== CSV_HEADER.join(",")) {
    throw new PayoutsError("INVALID_INPUT", `settlement csv header must be ${CSV_HEADER.join(",")}`);
  }
  if (body.length > MAX_SETTLEMENT_ROWS) throw new PayoutsError("INVALID_INPUT", "settlement file too large");
  return body.map((row, i) => {
    const cells = row.split(",").map((c) => c.trim());
    if (cells.length !== CSV_HEADER.length) throw new PayoutsError("INVALID_INPUT", `settlement row ${String(i + 1)}: expected ${String(CSV_HEADER.length)} cells`);
    return toLine(Object.fromEntries(CSV_HEADER.map((h, j) => [h, cells[j]])), `row ${String(i + 1)}`);
  });
};

export const parseSettlementJson = (content: string): SettlementLineInput[] => {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new PayoutsError("INVALID_INPUT", "settlement json is not valid JSON");
  }
  if (!Array.isArray(raw)) throw new PayoutsError("INVALID_INPUT", "settlement json must be an array of lines");
  if (raw.length > MAX_SETTLEMENT_ROWS) throw new PayoutsError("INVALID_INPUT", "settlement file too large");
  return raw.map((r: unknown, i) => toLine(r, `line ${String(i + 1)}`));
};

export const parseSettlement = (format: "csv" | "json", content: string): SettlementLineInput[] =>
  format === "csv" ? parseSettlementCsv(content) : parseSettlementJson(content);
