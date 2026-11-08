import type { CartService } from "@outlet/cart";

/** Candidates that would unlock free delivery for one store (the engine is not built: the production default answers honestly with none). */
export interface FreeDeliverySuggestionPort {
  suggest(input: { readonly userId: string; readonly storeId: string; readonly remainingMinor: bigint; readonly excludeSkuIds: readonly string[]; readonly limit: number }): Promise<readonly { readonly productId: string }[]>;
}

export interface CartServices {
  readonly cart: Pick<CartService, "get" | "addLine" | "updateQty" | "removeLine">;
  readonly suggestions: FreeDeliverySuggestionPort;
}

export const noSuggestions: FreeDeliverySuggestionPort = { suggest: () => Promise.resolve([]) };
