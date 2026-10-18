import { ROLES, type Role, type RoleChoicePort } from "./model";
import { parseRole } from "./model";

export interface RoleStorage {
  get(): Promise<string | null>;
  set(v: string): Promise<void>;
}
/** The funnel call; matches generated recordOnboardingPath({ body: { path } }). */
export type FunnelRecorder = (role: Role) => Promise<unknown>;

/** Device-persisted role + optional funnel recording. A failing funnel call never blocks the user. */
export class DeviceRoleChoicePort implements RoleChoicePort {
  /** Roles chosen while signed out: the funnel call waits for a session (a guest makes no server call). */
  private pending: Role | null = null;
  constructor(
    private readonly store: RoleStorage,
    private readonly funnel: FunnelRecorder | null,
    /** True only with a session. Default: never, so a guest never reaches the server. */
    private readonly canSend: () => Promise<boolean> = async () => false,
  ) {}
  async load(): Promise<Role | null> {
    try {
      return parseRole(await this.store.get());
    } catch {
      return null;
    }
  }
  async choose(role: Role): Promise<void> {
    if (!ROLES.includes(role)) return;
    try {
      await this.store.set(role);
    } catch {
      // Not persisted: the choice is asked again next launch, which is safe.
    }
    this.pending = role;
    await this.flushFunnel();
  }

  /** Sends the queued role once a session exists. Safe to call repeatedly; the queue empties on success. */
  async flushFunnel(): Promise<void> {
    const role = this.pending;
    if (role === null || this.funnel === null) return;
    try {
      if (!(await this.canSend())) return;
      await this.funnel(role);
      this.pending = null;
    } catch {
      // Funnel analytics only; stays queued.
    }
  }
}
