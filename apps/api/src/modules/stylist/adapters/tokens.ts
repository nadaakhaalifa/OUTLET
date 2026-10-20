export const STYLIST_STORE = Symbol("stylist.StylistStore");
export const STYLIST_CANDIDATES = Symbol("stylist.CandidateSourcePort");
export const STYLIST_EMBEDDINGS = Symbol("stylist.EmbeddingPort");
export const STYLIST_BUDGET = Symbol("stylist.BudgetPort");
export const STYLIST_PERSONALIZATION = Symbol("stylist.PersonalizationPort");
export const STYLIST_LIVE_PRICES = Symbol("stylist.LivePricePort");
export const STYLIST_BAG = Symbol("stylist.BagPort");
export const STYLIST_FLAGS = Symbol("stylist.StylistFlagPort");
export const STYLIST_LLM = Symbol("stylist.StylistLlmPort");

export const STYLIST_OUTFIT_RESOLVER = Symbol("stylist.OutfitResolver");

export const GENERATE_OUTFITS = Symbol("stylist.GenerateOutfits");
export const COMPLETE_LOOK = Symbol("stylist.CompleteLook");
export const PLAN_CAPSULE = Symbol("stylist.PlanCapsule");
export const ADD_OUTFIT_TO_BAG = Symbol("stylist.AddOutfitToBag");
export const SUBMIT_FEEDBACK = Symbol("stylist.SubmitFeedback");
export const CLEAR_STYLIST_HISTORY = Symbol("stylist.ClearStylistHistory");
export const STYLIST_SELLER_RESOLVER = Symbol("stylist.SellerResolver");
export const GET_STORE_INCLUSION = Symbol("stylist.GetStoreInclusion");

// Stylist chat (spec P3-07)
export const STYLIST_CHAT_STORE = Symbol("stylist.StylistChatStore");
export const STYLIST_CHAT_INTENT_PORT = Symbol("stylist.StylistChatIntentPort");
export const STYLIST_CHAT = Symbol("stylist.StylistChat");
export const STYLIST_CHAT_SESSION_RESOLVER = Symbol("stylist.ChatSessionResolver");
