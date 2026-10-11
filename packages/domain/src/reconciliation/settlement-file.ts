export const SETTLEMENT_LINE_KINDS = ["capture", "refund", "chargeback", "remittance", "adjustment"] as const;
export type SettlementLineKind = (typeof SETTLEMENT_LINE_KINDS)[number];

export interface SettlementLine {
  readonly lineNo: number;
  readonly kind: SettlementLineKind;
  readonly providerRef: string;
  /** Signed: refunds and chargebacks are negative. */
  readonly gross: bigint;
  readonly fee: bigint;
  readonly net: bigint;
  readonly occurredAtMs: number;
}

export interface SettlementTotals {
  readonly gross: bigint;
  readonly fee: bigint;
  readonly net: bigint;
}

export interface ParsedSettlement {
  readonly settlementId: string;
  readonly provider: string;
  readonly lines: readonly SettlementLine[];
  readonly totals: SettlementTotals;
}

export const PARSE_ERROR_CODES = [
  "empty_file",
  "too_many_lines",
  "bad_header",
  "quotes_unsupported",
  "bad_column_count",
  "bad_settlement_id",
  "settlement_id_mismatch",
  "provider_mismatch",
  "bad_line_no",
  "duplicate_line_no",
  "bad_kind",
  "bad_ref",
  "bad_amount",
  "negative_fee",
  "line_arithmetic",
  "sign_mismatch",
  "bad_currency",
  "bad_timestamp",
  "missing_total",
  "total_mismatch",
] as const;
export type ParseErrorCode = (typeof PARSE_ERROR_CODES)[number];

export interface ParseError {
  readonly code: ParseErrorCode;
  /** 1-based line of the content, 0 for whole-file errors. */
  readonly line: number;
}

export type ParseResult =
  | { readonly ok: true; readonly file: ParsedSettlement }
  | { readonly ok: false; readonly errors: readonly ParseError[] };

export const MAX_SETTLEMENT_LINES = 100_000;

/** FIXTURE FORMAT, not any provider's real one (VERIFY BEFORE LAUNCH, VR-F1-11). */
export const SETTLEMENT_CSV_HEADER =
  "settlement_id,provider,line_no,kind,provider_ref,gross,fee,net,currency,occurred_at";

const AMOUNT = /^-?\d{1,15}$/;
const REF = /^[A-Za-z0-9._:-]{1,64}$/;
const SETTLEMENT_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

function signOk(kind: SettlementLineKind, gross: bigint): boolean {
  switch (kind) {
    case "capture":
    case "remittance":
      return gross > 0n;
    case "refund":
    case "chargeback":
      return gross < 0n;
    case "adjustment":
      return gross !== 0n;
  }
}

/**
 * Strict parser for the fixture CSV: integer piastres, no quoting, trailing TOTAL row, every
 * problem reported by code and line. It never throws and never evaluates content.
 */
export function parseSettlementCsv(content: string, expect: { readonly provider: string }): ParseResult {
  const errors: ParseError[] = [];
  const err = (code: ParseErrorCode, line: number): void => {
    errors.push({ code, line });
  };
  const rows = content.split(/\r?\n/);
  while (rows.length > 0 && (rows[rows.length - 1] ?? "").trim() === "") rows.pop();
  if (rows.length === 0) return { ok: false, errors: [{ code: "empty_file", line: 0 }] };
  if (rows.length > MAX_SETTLEMENT_LINES + 2) return { ok: false, errors: [{ code: "too_many_lines", line: 0 }] };
  if ((rows[0] ?? "").trim() !== SETTLEMENT_CSV_HEADER) return { ok: false, errors: [{ code: "bad_header", line: 1 }] };

  const lines: SettlementLine[] = [];
  const seenNo = new Set<number>();
  let settlementId: string | null = null;
  let declared: SettlementTotals | null = null;

  for (let idx = 1; idx < rows.length; idx += 1) {
    const lineNo = idx + 1;
    const raw = rows[idx] ?? "";
    if (raw.includes('"')) {
      err("quotes_unsupported", lineNo);
      continue;
    }
    const c = raw.split(",").map((s) => s.trim());
    if (c.length !== 10) {
      err("bad_column_count", lineNo);
      continue;
    }
    const [sid = "", provider = "", no = "", kind = "", ref = "", gross = "", fee = "", net = "", currency = "", at = ""] = c;
    if (sid === "TOTAL") {
      if (idx !== rows.length - 1 || !AMOUNT.test(gross) || !AMOUNT.test(fee) || !AMOUNT.test(net)) {
        err("missing_total", lineNo);
      } else {
        declared = { gross: BigInt(gross), fee: BigInt(fee), net: BigInt(net) };
      }
      continue;
    }
    if (!SETTLEMENT_ID.test(sid)) err("bad_settlement_id", lineNo);
    else if (settlementId === null) settlementId = sid;
    else if (settlementId !== sid) err("settlement_id_mismatch", lineNo);
    if (provider !== expect.provider) err("provider_mismatch", lineNo);
    const n = /^\d{1,9}$/.test(no) ? Number(no) : 0;
    if (n < 1) err("bad_line_no", lineNo);
    else if (seenNo.has(n)) err("duplicate_line_no", lineNo);
    else seenNo.add(n);
    const k = (SETTLEMENT_LINE_KINDS as readonly string[]).includes(kind) ? (kind as SettlementLineKind) : null;
    if (k === null) err("bad_kind", lineNo);
    if (!REF.test(ref)) err("bad_ref", lineNo);
    if (!AMOUNT.test(gross) || !AMOUNT.test(fee) || !AMOUNT.test(net)) {
      err("bad_amount", lineNo);
      continue;
    }
    const g = BigInt(gross);
    const f = BigInt(fee);
    const nn = BigInt(net);
    if (f < 0n) err("negative_fee", lineNo);
    if (g - f !== nn) err("line_arithmetic", lineNo);
    if (k !== null && !signOk(k, g)) err("sign_mismatch", lineNo);
    if (currency !== "EGP") err("bad_currency", lineNo);
    const ms = ISO_UTC.test(at) ? Date.parse(at) : Number.NaN;
    if (Number.isNaN(ms)) err("bad_timestamp", lineNo);
    if (k !== null && n >= 1 && !Number.isNaN(ms)) {
      lines.push({ lineNo: n, kind: k, providerRef: ref, gross: g, fee: f, net: nn, occurredAtMs: ms });
    }
  }

  if (lines.length === 0 && errors.length === 0) err("empty_file", 0);
  const computed: SettlementTotals = {
    gross: lines.reduce((a, l) => a + l.gross, 0n),
    fee: lines.reduce((a, l) => a + l.fee, 0n),
    net: lines.reduce((a, l) => a + l.net, 0n),
  };
  if (declared === null) {
    if (!errors.some((e) => e.code === "missing_total")) err("missing_total", 0);
  } else if (declared.gross !== computed.gross || declared.fee !== computed.fee || declared.net !== computed.net) {
    err("total_mismatch", rows.length);
  }
  if (errors.length > 0 || settlementId === null) {
    return { ok: false, errors: errors.length > 0 ? errors : [{ code: "bad_settlement_id", line: 0 }] };
  }
  return {
    ok: true,
    file: { settlementId, provider: expect.provider, lines: [...lines].sort((a, b) => a.lineNo - b.lineNo), totals: computed },
  };
}
