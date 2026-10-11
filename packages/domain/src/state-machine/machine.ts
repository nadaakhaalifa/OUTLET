import {
  GuardRejectedError,
  InvalidTransitionError,
  MachineDefinitionError,
  UnknownEventError,
  UnknownStateError,
} from "./errors";

export interface Guard<C> {
  readonly name: string;
  readonly test: (ctx: C) => boolean;
}

export interface TransitionSpec<S extends string, C> {
  readonly to: S;
  readonly guard?: Guard<C>;
}

export type TransitionTable<S extends string, E extends string, C> = Readonly<
  Record<S, Readonly<Partial<Record<E, TransitionSpec<S, C>>>>>
>;

export interface MachineDefinition<S extends string, E extends string, C> {
  readonly name: string;
  readonly states: readonly S[];
  readonly events: readonly E[];
  readonly initial: S;
  readonly terminal: readonly S[];
  readonly transitions: TransitionTable<S, E, C>;
}

/** Machines without guards use C = undefined and take no context argument. */
export type CtxArgs<C> = [C] extends [undefined] ? [] : [ctx: C];

export interface MachineAnalysis<S extends string> {
  readonly reachable: readonly S[];
  readonly unreachable: readonly S[];
  /** Non-terminal states from which no terminal state can be reached. */
  readonly deadEnds: readonly S[];
  /** Terminal states that declare outgoing transitions (not allowed). */
  readonly terminalsWithOutgoing: readonly S[];
  readonly ok: boolean;
}

export class StateMachine<S extends string, E extends string, C = undefined> {
  readonly name: string;
  readonly states: readonly S[];
  readonly events: readonly E[];
  readonly initial: S;
  readonly terminalStates: readonly S[];
  private readonly table: TransitionTable<S, E, C>;
  private readonly stateSet: ReadonlySet<string>;
  private readonly eventSet: ReadonlySet<string>;
  private readonly terminalSet: ReadonlySet<string>;

  constructor(def: MachineDefinition<S, E, C>) {
    this.name = def.name;
    this.states = def.states;
    this.events = def.events;
    this.initial = def.initial;
    this.terminalStates = def.terminal;
    this.table = def.transitions;
    this.stateSet = new Set<string>(def.states);
    this.eventSet = new Set<string>(def.events);
    this.terminalSet = new Set<string>(def.terminal);
    this.validateDefinition();
  }

  private validateDefinition(): void {
    const fail = (msg: string): never => {
      throw new MachineDefinitionError(`${this.name}: ${msg}`);
    };
    if (this.stateSet.size !== this.states.length) fail("duplicate states");
    if (this.eventSet.size !== this.events.length) fail("duplicate events");
    if (!this.stateSet.has(this.initial)) fail(`initial state "${this.initial}" is not a state`);
    for (const t of this.terminalStates) {
      if (!this.stateSet.has(t)) fail(`terminal state "${t}" is not a state`);
    }
    for (const from of this.states) {
      const row = this.table[from] as Readonly<Record<string, TransitionSpec<S, C> | undefined>> | undefined;
      if (row === undefined) fail(`missing transition row for state "${from}"`);
      for (const [event, spec] of Object.entries(row ?? {})) {
        if (!this.eventSet.has(event)) fail(`state "${from}" uses unknown event "${event}"`);
        if (spec === undefined) continue;
        if (!this.stateSet.has(spec.to)) fail(`"${from}" --${event}--> unknown state "${spec.to}"`);
      }
    }
    for (const key of Object.keys(this.table)) {
      if (!this.stateSet.has(key)) fail(`transition row for unknown state "${key}"`);
    }
  }

  isState(value: string): value is S {
    return this.stateSet.has(value);
  }

  isEvent(value: string): value is E {
    return this.eventSet.has(value);
  }

  /** Narrow a raw persisted value (for example a DB column) to a state, or throw. */
  parseState(value: string): S {
    if (!this.isState(value)) throw new UnknownStateError(this.name, value);
    return value;
  }

  isTerminal(state: S): boolean {
    return this.terminalSet.has(state);
  }

  private row(state: S): Readonly<Partial<Record<E, TransitionSpec<S, C>>>> {
    if (!this.isState(state)) throw new UnknownStateError(this.name, state);
    return this.table[state];
  }

  /** Events that have a transition declared from `state`, ignoring guards. */
  availableEvents(state: S): readonly E[] {
    return this.events.filter((e) => this.row(state)[e] !== undefined);
  }

  /** True when the event is declared for the state and its guard (if any) passes. */
  can(state: S, event: E, ...ctx: CtxArgs<C>): boolean {
    const spec = this.row(state)[event];
    if (spec === undefined) return false;
    return spec.guard === undefined || spec.guard.test(ctx[0] as C);
  }

  /** Pure: returns the next state or throws a typed error. */
  transition(state: S, event: E, ...ctx: CtxArgs<C>): S {
    if (!this.isEvent(event)) throw new UnknownEventError(this.name, event);
    const spec = this.row(state)[event];
    if (spec === undefined) {
      throw new InvalidTransitionError(this.name, state, event, this.availableEvents(state));
    }
    if (spec.guard !== undefined && !spec.guard.test(ctx[0] as C)) {
      throw new GuardRejectedError(this.name, state, event, spec.guard.name);
    }
    return spec.to;
  }

  /** The declared target, or undefined, ignoring guards. For analysis and docs. */
  target(state: S, event: E): S | undefined {
    return this.row(state)[event]?.to;
  }

  edges(): readonly { from: S; event: E; to: S; guard: string | undefined }[] {
    const out: { from: S; event: E; to: S; guard: string | undefined }[] = [];
    for (const from of this.states) {
      for (const event of this.events) {
        const spec = this.row(from)[event];
        if (spec !== undefined) out.push({ from, event, to: spec.to, guard: spec.guard?.name });
      }
    }
    return out;
  }

  analyze(): MachineAnalysis<S> {
    const edges = this.edges();
    const reachable = new Set<S>([this.initial]);
    const queue: S[] = [this.initial];
    for (let s = queue.shift(); s !== undefined; s = queue.shift()) {
      for (const e of edges) {
        if (e.from === s && !reachable.has(e.to)) {
          reachable.add(e.to);
          queue.push(e.to);
        }
      }
    }
    const canFinish = new Set<S>(this.terminalStates);
    let grew = true;
    while (grew) {
      grew = false;
      for (const e of edges) {
        if (canFinish.has(e.to) && !canFinish.has(e.from)) {
          canFinish.add(e.from);
          grew = true;
        }
      }
    }
    const unreachable = this.states.filter((s) => !reachable.has(s));
    const deadEnds = this.states.filter((s) => !this.terminalSet.has(s) && !canFinish.has(s));
    const terminalsWithOutgoing = this.terminalStates.filter((t) => edges.some((e) => e.from === t));
    return {
      reachable: this.states.filter((s) => reachable.has(s)),
      unreachable,
      deadEnds,
      terminalsWithOutgoing,
      ok: unreachable.length === 0 && deadEnds.length === 0 && terminalsWithOutgoing.length === 0,
    };
  }
}

export function defineMachine<S extends string, E extends string, C = undefined>(
  def: MachineDefinition<S, E, C>,
): StateMachine<S, E, C> {
  return new StateMachine(def);
}

export function guard<C>(name: string, test: (ctx: C) => boolean): Guard<C> {
  return { name, test };
}
