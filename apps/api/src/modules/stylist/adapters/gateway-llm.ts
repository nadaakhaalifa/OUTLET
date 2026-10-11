import { STYLIST_INTENT, STYLIST_RERANK, type LlmGateway } from "../../llm-gateway";
import type { Season } from "../domain/bridge";
import type { StylistLlmPort } from "../domain/ports";

/**
 * StylistLlmPort over llm-gateway. What leaves: a scrubbed note (P1), occasion and season labels
 * and candidate ids with seller titles as delimited untrusted data. No size, no measurements, no
 * exact budget, no user id (LLM02). Outputs are Zod-validated; rerank ids must be a subset of the
 * ids that were sent (LLM05). Prices are never an input or an output.
 */
export class GatewayStylistLlm implements StylistLlmPort {
  constructor(private readonly gateway: LlmGateway) {}

  async parseIntent(input: { readonly userId: string; readonly note: string }) {
    const r = await this.gateway.run({
      prompt: STYLIST_INTENT,
      userId: input.userId,
      fields: [{ name: "note", value: input.note.slice(0, 200), dataClass: "P1", trust: "untrusted" }],
      cacheKeyInput: { note: input.note.slice(0, 200) },
      crossBorderConsent: false,
    });
    if (r.kind !== "ok") return null;
    return { occasion: r.value.occasion, formality: r.value.formality, season: r.value.season as Season, modest: r.value.modest };
  }

  async rerank(input: {
    readonly userId: string;
    readonly occasion: string;
    readonly season: Season;
    readonly items: readonly { readonly id: string; readonly title: string }[];
  }): Promise<readonly string[] | null> {
    const allowed = new Set(input.items.map((i) => i.id));
    const r = await this.gateway.run({
      prompt: STYLIST_RERANK,
      userId: input.userId,
      fields: [
        { name: "occasion", value: input.occasion, dataClass: "P0", trust: "trusted" },
        { name: "season", value: input.season, dataClass: "P0", trust: "trusted" },
        ...input.items.map((i, n) => ({
          name: `item_${n}`,
          value: `${i.id}: ${i.title.slice(0, 120)}`,
          dataClass: "P0" as const,
          trust: "untrusted" as const,
        })),
      ],
      cacheKeyInput: { occasion: input.occasion, season: input.season, ids: [...allowed].sort() },
      crossBorderConsent: false,
      accept: (v) => v.ids.every((id) => allowed.has(id)),
    });
    return r.kind === "ok" ? r.value.ids : null;
  }
}
