import { Module, type DynamicModule } from "@nestjs/common";
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
import { OutfitResolver } from "./adapters/resolvers";
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
    if (production && o.store === undefined) throw new NoProductionAdaptersError();
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
    const llm = o.llm ?? new FakeStylistLlm();
    const cfg = o.config ?? DEFAULT_STYLIST_CONFIG;

    const RUNTIME = Symbol("stylist.Runtime");
    const runtime = (clock: Clock, ids: IdGenerator) => {
      const d: StylistDeps = { store, candidates, embeddings, budget, personalization, live, flags, llm, clock, ids, cfg };
      return {
        generate: new GenerateOutfits(d),
        look: new CompleteLook(d),
        capsule: new PlanCapsule(d),
        add: new AddOutfitToBag(d, bag),
        feedback: new SubmitFeedback(d),
        clear: new ClearStylistHistory(d),
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
      controllers: [StylistController],
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
        { provide: T.STYLIST_OUTFIT_RESOLVER, useValue: new OutfitResolver(store) },
        {
          provide: RUNTIME,
          inject: [CLOCK, ID_GENERATOR],
          useFactory: (c: Clock, ids: IdGenerator) => runtime(c, ids),
        },
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
