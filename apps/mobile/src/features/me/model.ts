/** Me tab view models: profile header, Shopping/Brand mode entry (port owned by the brand-mode agent). Pure. */
import type { Tier } from "../rewards/model";

export interface ProfileInput {
  readonly displayName: string | null;
  readonly phoneE164: string | null;
  readonly tier: Tier | null;
  /** Optional profile data; null/undefined when the account has none (production hides them). */
  readonly email?: string | null;
  readonly photoUrl?: string | null;
}

export interface ProfileView {
  /** One letter (or digit) for the initial avatar; "" when nothing is known (the avatar then shows a neutral glyph). */
  readonly initial: string;
  readonly title: string | null;
  /** Masked phone, shown under the name or as the title when no name is set. */
  readonly maskedPhone: string | null;
  readonly tier: Tier | null;
  readonly displayName: string | null;
  readonly email: string | null;
  readonly photoUrl: string | null;
}

/** "+201012345678" -> "+20 10• ••• ••78": keeps the country code, first two national digits and the last two. */
export function maskPhone(e164: string | null): string | null {
  if (e164 === null) return null;
  const m = /^\+(20)(\d{10})$/.exec(e164.trim());
  if (m === null || m[1] === undefined || m[2] === undefined) return null;
  return `+${m[1]} ${m[2].slice(0, 2)}• ••• ••${m[2].slice(-2)}`;
}

export function profileView(input: ProfileInput): ProfileView {
  const name = input.displayName?.trim() ?? "";
  const masked = maskPhone(input.phoneE164);
  const first = name !== "" ? [...name][0] : undefined;
  const initial = first !== undefined ? first.toLocaleUpperCase() : "";
  const email = input.email?.trim() ?? "";
  const photo = input.photoUrl?.trim() ?? "";
  return {
    initial, title: name !== "" ? name : masked, maskedPhone: name !== "" ? masked : null, tier: input.tier,
    displayName: name !== "" ? name : null, email: email !== "" ? email : null, photoUrl: photo !== "" ? photo : null,
  };
}

/** An approved brand the signed-in person can switch to. Another agent owns brand mode itself. */
export interface BrandModeEntry {
  readonly brandId: string;
  readonly name: string;
  readonly status: "approved";
}

export interface BrandModePort {
  /** The person's approved brand, or null when they have none (or it is not approved yet). */
  entry(): Promise<BrandModeEntry | null>;
  /** Switches the app into brand mode (navigation is owned by the brand-mode agent). */
  enter(entry: BrandModeEntry): void;
}

/** Dev/default fake: nobody has a brand, so the mode switcher stays hidden. */
export class InMemoryBrandModePort implements BrandModePort {
  constructor(private readonly brand: BrandModeEntry | null = null) {}
  entry(): Promise<BrandModeEntry | null> {
    return Promise.resolve(this.brand);
  }
  enter(): void {
    // The default fake has nowhere to go: the switcher is hidden whenever there is no brand.
  }
}

let brandPort: BrandModePort = new InMemoryBrandModePort();
/** The brand-mode agent calls `setBrandModePort` with its real adapter; Me only reads through this. */
export function getBrandModePort(): BrandModePort {
  return brandPort;
}
export function setBrandModePort(p: BrandModePort | null): void {
  brandPort = p ?? new InMemoryBrandModePort();
}

export type ModeId = "shopping" | "brand";

/** The Shopping / Brand switcher exists only for an approved brand. */
export function modeSwitcher(entry: BrandModeEntry | null): readonly ModeId[] | null {
  return entry !== null && entry.status === "approved" ? ["shopping", "brand"] : null;
}

export interface SignOutDeps {
  /** Revokes the session on the server (POST /v1/auth/logout). Null in fake mode: nothing to revoke. */
  readonly revokeRemote: (() => Promise<void>) | null;
  /** Clears tokens and any other local session state. Always runs. */
  readonly clearLocal: () => Promise<void>;
}

export interface SignOutResult {
  /** False when the server could not be reached: the local session is still cleared, the token expires on its own. */
  readonly remoteRevoked: boolean;
}

/** Server revoke first (best effort, offline must never trap the person signed in), then the local clear. */
export async function signOut(deps: SignOutDeps): Promise<SignOutResult> {
  let remoteRevoked = deps.revokeRemote === null;
  if (deps.revokeRemote !== null) {
    try {
      await deps.revokeRemote();
      remoteRevoked = true;
    } catch {
      remoteRevoked = false;
    }
  }
  await deps.clearLocal();
  return { remoteRevoked };
}
