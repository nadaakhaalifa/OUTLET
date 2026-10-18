import { Module, type DynamicModule } from "@nestjs/common";
import { LLM_GATEWAY, type LlmGateway } from "../llm-gateway";
import { GatewayChatIntent, InjectionSignalingLlm } from "./adapters/gateway-chat";
import { InMemoryChatStore, NullChatIntent } from "./adapters/in-memory-chat";
import { StylistChatController } from "./adapters/chat.controller";
import { StylistInclusionController } from "./adapters/inclusion.controller";
import { DEFAULT_CHAT_CONFIG, StylistChat, type ChatConfig } from "./application/chat";
import type { StylistChatIntentPort, StylistChatStore } from "./domain/chat-ports";
import { GetStoreInclusion } from "./application/inclusion";
import type { AppConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import type { Clock, IdGenerator } from "../../platform/ports";
import { CLOCK, ID_GENERATOR } from "../../platform/tokens";
import { AddOutfitToBag } from "./application/bag";
import { ClearStylistHistory, SubmitFeedback } from "./application/feedback";
import { CompleteLook, GenerateOutfits, PlanCapsule } from "./application/generate";
import { DEFAULT_STYLIST_CONFIG, type StylistConfig, type StylistDeps } from "./application/shared";
import {
  FakeBag,
  FakeBudget,
  FakeCandidateSource,
  FakeEmbeddings,
  FakeLivePrices,
  FakePersonalization,
  FakeStylistLlm,
  InMemoryStylistStore,
  StaticStylistFlags,
} from "./adapters/in-memory";
import { ChatSessionResolver, OutfitResolver, SellerStoreResolver } from "./adapters/resolvers";
import { StylistController } from "./adapters/stylist.controller";
import * as T from "./adapters/tokens";
import type {
  BagPort,
  BudgetPort,
  CandidateSourcePort,
  EmbeddingPort,
  LivePricePort,
  PersonalizationPort,
  StylistFlagPort,
  StylistLlmPort,
  StylistStore,
} from "./domain/ports";

export interface StylistModuleOptions {
  readonly config?: StylistConfig;
  readonly store?: StylistStore;
  readonly candidates?: CandidateSourcePort;
  readonly embeddings?: EmbeddingPort;
  readonly budget?: BudgetPort;
  readonly personalization?: PersonalizationPort;
  readonly live?: LivePricePort;
  readonly bag?: BagPort;
  readonly flags?: StylistFlagPort;
  readonly llm?: StylistLlmPort;
  /** Stylist chat (spec P3-07). Required outside dev: chat transcripts must not live in process memory. */
  readonly chatStore?: StylistChatStore;
  /** Override the intent port. Default: llm-gateway when composed, else rules only. */
  readonly chatIntent?: StylistChatIntentPort;
  readonly chatConfig?: ChatConfig;
}

/**
 * Thrown outside test mode when a port owned by another module is missing: the stylist must never
 * recommend from an empty fixture catalog, and never decide "in stock" from a stub.
 */
export class MissingStylistPortsError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`StylistModule requires real ${missing.join(", ")} outside test mode`);
    this.name = "MissingStylistPortsError";
  }
}

@Module({})
export class StylistModule {
  static forRoot(config: AppConfig, o: StylistModuleOptions = {}): DynamicModule {
    const production = config.adapters !== "in-memory-dev";
    if (production && (o.store === undefined || o.chatStore === undefined)) throw new NoProductionAdaptersError();
    if (production || config.env !== "test") {
      const missing: string[] = [];
      if (o.candidates === undefined) missing.push("candidates (catalog, sizing, inventory)");
      if (o.live === undefined) missing.push("live (price and stock re-validation)");
      if (o.bag === undefined) missing.push("bag (cart)");
      if (o.personalization === undefined) missing.push("personalization (consent)");
      if (o.budget === undefined) missing.push("budget (budget suite)");
      if (o.flags === undefined) missing.push("flags (feature-flags)");
      if (missing.length > 0) throw new MissingStylistPortsError(missing);
    }
    const store = o.store ?? new InMemoryStylistStore();
    const candidates = o.candidates ?? new FakeCandidateSource();
    const embeddings = o.embeddings ?? new FakeEmbeddings();
    const budget = o.budget ?? new FakeBudget();
    const personalization = o.personalization ?? new FakePersonalization();
    const live = o.live ?? new FakeLivePrices();
    const bag = o.bag ?? new FakeBag();
    const flags = o.flags ?? new StaticStylistFlags();
    const chatStore = o.chatStore ?? new InMemoryChatStore();
    // Seller text that is about to reach a model is scanned for instruction-like content (LLM01 signal).
    const llm = new InjectionSignalingLlm(o.llm ?? new FakeStylistLlm(), chatStore);
    const cfg = o.config ?? DEFAULT_STYLIST_CONFIG;
    const chatCfg = o.chatConfig ?? DEFAULT_CHAT_CONFIG;

    const RUNTIME = Symbol("stylist.Runtime");
    const runtime = (clock: Clock, ids: IdGenerator, gateway: LlmGateway | null) => {
      const d: StylistDeps = { store, candidates, embeddings, budget, personalization, live, flags, llm, clock, ids, cfg };
      const intent: StylistChatIntentPort = o.chatIntent ?? (gateway === null ? new NullChatIntent() : new GatewayChatIntent(gateway));
      return {
        chat: new StylistChat({ d, chat: chatStore, intent, cfg: chatCfg }),
        generate: new GenerateOutfits(d),
        look: new CompleteLook(d),
        capsule: new PlanCapsule(d),
        add: new AddOutfitToBag(d, bag),
        feedback: new SubmitFeedback(d),
        clear: new ClearStylistHistory(d, chatStore),
      };
    };
    type Runtime = ReturnType<typeof runtime>;
    const from = (token: symbol, pick: (r: Runtime) => unknown) => ({
      provide: token,
      inject: [RUNTIME],
      useFactory: (r: Runtime) => pick(r),
    });

    return {
      module: StylistModule,
      controllers: [StylistController, StylistChatController, StylistInclusionController],
      providers: [
        { provide: T.STYLIST_STORE, useValue: store },
        { provide: T.STYLIST_CANDIDATES, useValue: candidates },
        { provide: T.STYLIST_EMBEDDINGS, useValue: embeddings },
        { provide: T.STYLIST_BUDGET, useValue: budget },
        { provide: T.STYLIST_PERSONALIZATION, useValue: personalization },
        { provide: T.STYLIST_LIVE_PRICES, useValue: live },
        { provide: T.STYLIST_BAG, useValue: bag },
        { provide: T.STYLIST_FLAGS, useValue: flags },
        { provide: T.STYLIST_LLM, useValue: llm },
        { provide: T.STYLIST_CHAT_STORE, useValue: chatStore },
        { provide: T.STYLIST_CHAT_SESSION_RESOLVER, useValue: new ChatSessionResolver(chatStore) },
        { provide: T.STYLIST_SELLER_RESOLVER, useValue: new SellerStoreResolver() },
        { provide: T.GET_STORE_INCLUSION, useValue: new GetStoreInclusion(store) },
        { provide: T.STYLIST_OUTFIT_RESOLVER, useValue: new OutfitResolver(store) },
        {
          provide: RUNTIME,
          inject: [CLOCK, ID_GENERATOR, { token: LLM_GATEWAY, optional: true }],
          useFactory: (c: Clock, ids: IdGenerator, gateway: LlmGateway | undefined) => runtime(c, ids, gateway ?? null),
        },
        from(T.STYLIST_CHAT, (r) => r.chat),
        from(T.GENERATE_OUTFITS, (r) => r.generate),
        from(T.COMPLETE_LOOK, (r) => r.look),
        from(T.PLAN_CAPSULE, (r) => r.capsule),
        from(T.ADD_OUTFIT_TO_BAG, (r) => r.add),
        from(T.SUBMIT_FEEDBACK, (r) => r.feedback),
        from(T.CLEAR_STYLIST_HISTORY, (r) => r.clear),
      ],
    };
  }
}
