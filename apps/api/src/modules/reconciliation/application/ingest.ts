import { sha256Hex } from "@outlet/idempotency";
import type { Clock, IdGenerator } from "../../../platform/ports";
import type { FileFormat, FileKind, ReconStore, SettlementFilePort, SettlementFileRecord } from "../domain/ports";
import { MAX_SETTLEMENT_LINES, type SettlementLine } from "../domain/bridge";

export const MAX_FILE_BYTES = 5_000_000;

export type IngestResult =
  | { readonly kind: "stored"; readonly file: SettlementFileRecord }
  | { readonly kind: "duplicate"; readonly file: SettlementFileRecord }
  | { readonly kind: "rejected"; readonly file: SettlementFileRecord; readonly codes: readonly string[] }
  | { readonly kind: "too_large" };

/**
 * Takes a provider file (PSP settlement, COD remittance, BNPL statement), parses it strictly and
 * stores the outcome. Idempotent by content checksum. A file that fails parsing is stored as
 * `rejected` with codes (never matched) so Finance sees it. Never throws on bad content.
 */
export class IngestSettlementFile {
  constructor(
    private readonly store: ReconStore,
    private readonly parser: SettlementFilePort,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(input: {
    readonly kind: FileKind;
    readonly provider: string;
    readonly format: FileFormat;
    readonly content: string;
  }): Promise<IngestResult> {
    if (Buffer.byteLength(input.content, "utf8") > MAX_FILE_BYTES) return { kind: "too_large" };
    const checksum = sha256Hex(`${input.kind}\n${input.provider}\n${input.content}`);
    const receivedAtMs = this.clock.nowMs();
    const parsed = this.parser.parse({ format: input.format, provider: input.provider, content: input.content });
    const id = this.ids.uuidV7();

    if (parsed.ok) {
      const f = parsed.file;
      if (f.lines.length > MAX_SETTLEMENT_LINES) return this.reject(input, checksum, receivedAtMs, id, ["too_many_lines"]);
      const clash = await this.store.findParsedBySettlement(input.kind, input.provider, f.settlementId);
      if (clash !== null && clash.checksum !== checksum) {
        return this.reject(input, checksum, receivedAtMs, id, ["settlement_id_conflict"]);
      }
      const lines: SettlementLine[] = [...f.lines];
      const saved = await this.store.saveFile({
        record: {
          id,
          kind: input.kind,
          provider: input.provider,
          settlementId: f.settlementId,
          checksum,
          status: "parsed",
          lineCount: lines.length,
          gross: f.totals.gross,
          fee: f.totals.fee,
          net: f.totals.net,
          errorCodes: [],
          receivedAtMs,
        },
        lines,
      });
      return saved.kind === "stored" ? { kind: "stored", file: saved.file } : { kind: "duplicate", file: saved.file };
    }
    return this.reject(input, checksum, receivedAtMs, id, [...new Set(parsed.errors.map((e) => e.code))].sort());
  }

  private async reject(
    input: { readonly kind: FileKind; readonly provider: string },
    checksum: string,
    receivedAtMs: number,
    id: string,
    codes: readonly string[],
  ): Promise<IngestResult> {
    const saved = await this.store.saveFile({
      record: {
        id,
        kind: input.kind,
        provider: input.provider,
        settlementId: null,
        checksum,
        status: "rejected",
        lineCount: 0,
        gross: null,
        fee: null,
        net: null,
        errorCodes: codes,
        receivedAtMs,
      },
      lines: [],
    });
    if (saved.kind === "duplicate") return { kind: "duplicate", file: saved.file };
    return { kind: "rejected", file: saved.file, codes };
  }
}
