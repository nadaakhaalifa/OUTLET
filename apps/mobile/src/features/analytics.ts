import {
  ConsentGatedTracker,
  RotatingPseudonymousId,
  mayInitialise,
  type AnalyticsEventInput,
  type AnalyticsEventName,
  type ConsentChecker,
  type ConsentHistory,
  type ConsentPurpose,
  type IdGenerator,
  type PrivacyClock,
  type PseudonymState,
  type PseudonymStore,
  type Transport,
} from "../workspace";
import { analyticsStepFor, type OnboardingStep } from "./flow";

export interface ConsentSource {
  readonly userId: string;
  history(): ConsentHistory;
  isGranted(purpose: ConsentPurpose): boolean;
}

export interface AnalyticsSession {
  readonly transport: Transport;
  /** Stops the SDK and releases everything it held. */
  stop(): void;
}

export interface ClientAnalyticsDeps {
  readonly consent: ConsentSource;
  readonly versions: Readonly<Record<ConsentPurpose, number>>;
  readonly clock: PrivacyClock;
  readonly ids: IdGenerator;
  /** Called only after consent allows it. Nothing analytics-related exists before that. */
  readonly start: () => AnalyticsSession;
}

class MemoryPseudonymStore implements PseudonymStore {
  private state: unknown = undefined;
  read(): unknown {
    return this.state;
  }
  write(state: PseudonymState): void {
    this.state = state;
  }
  clear(): void {
    this.state = undefined;
  }
}

/**
 * Analytics lifecycle. The SDK/transport is created only when the `analytics` consent (the
 * requirement of the `posthog` gated item in @outlet/privacy) is granted, and torn down, with the
 * pseudonymous id reset, as soon as it is withdrawn. Call sync() after every consent change.
 */
export class ClientAnalytics {
  private session: AnalyticsSession | null = null;
  private tracker: ConsentGatedTracker | null = null;
  private pseudonym: RotatingPseudonymousId | null = null;

  constructor(private readonly deps: ClientAnalyticsDeps) {}

  get running(): boolean {
    return this.session !== null;
  }

  sync(): "started" | "stopped" | "unchanged" {
    const { consent, versions } = this.deps;
    const decision = mayInitialise("posthog", consent.history(), consent.userId, versions);
    if (decision.allowed && this.session === null) {
      const session = this.deps.start();
      const pseudonym = new RotatingPseudonymousId({
        clock: this.deps.clock,
        ids: this.deps.ids,
        store: new MemoryPseudonymStore(),
      });
      const checker: ConsentChecker = { isGranted: (p) => consent.isGranted(p) };
      this.pseudonym = pseudonym;
      this.session = session;
      this.tracker = new ConsentGatedTracker({
        origin: "client",
        consent: checker,
        transport: session.transport,
        clock: this.deps.clock,
        ids: this.deps.ids,
        pseudonymousId: pseudonym,
      });
      return "started";
    }
    if (!decision.allowed && this.session !== null) {
      const session = this.session;
      this.pseudonym?.reset();
      this.session = null;
      this.tracker = null;
      this.pseudonym = null;
      try {
        session.stop();
      } catch {
        // Teardown failure must not keep the tracker alive: references are already dropped.
      }
      return "stopped";
    }
    return "unchanged";
  }

  /** Never throws. Returns false when the event was not handed to the tracker or was dropped. */
  async track<N extends AnalyticsEventName>(name: N, properties: AnalyticsEventInput<N>): Promise<boolean> {
    const tracker = this.tracker;
    if (tracker === null) return false;
    try {
      const result = await tracker.track(name, properties);
      return result.status === "sent";
    } catch {
      return false;
    }
  }

  async trackOnboardingStep(step: OnboardingStep, skipped: boolean): Promise<boolean> {
    const mapped = analyticsStepFor(step);
    if (mapped === null) return false;
    return this.track("onboarding_step_completed", { step: mapped, skipped });
  }
}
