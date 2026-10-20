import type { LlmGatewayPort } from "../../search";
import { LlmUnavailableError } from "../../search";
import type { LlmGateway } from "../application/gateway";
import { SEARCH_PARSE } from "../domain/prompts";

/**
 * Implements the search module's LlmGatewayPort through llm-gateway (spec 4: NL query parsing).
 * Free text is never executed: the model returns a strict JSON object that the search module
 * validates again with its own SearchFilter schema, and the deterministic rule parser stays the
 * fallback (the search module already uses it whenever this returns null or throws
 * LlmUnavailableError). Only the scrubbed query text (P0) is sent.
 */
export class GatewaySearchRefiner implements LlmGatewayPort {
  constructor(private readonly gateway: LlmGateway, private readonly userIdOf: () => string) {}

  async refineSearchParse(input: { readonly text: string; readonly locale: "ar" | "en" }): Promise<unknown | null> {
    const r = await this.gateway.run({
      prompt: SEARCH_PARSE,
      userId: this.userIdOf(),
      fields: [
        { name: "query", value: input.text.slice(0, 300), dataClass: "P0", trust: "untrusted" },
        { name: "locale", value: input.locale, dataClass: "P0", trust: "trusted" },
      ],
      cacheKeyInput: { text: input.text.slice(0, 300), locale: input.locale },
      crossBorderConsent: false,
    });
    if (r.kind === "ok") return r.value;
    if (r.reason === "provider_error" || r.reason === "timeout") throw new LlmUnavailableError();
    return null;
  }
}
