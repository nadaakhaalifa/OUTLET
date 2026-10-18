import { SignJWT, decodeJwt, decodeProtectedHeader, exportJWK, generateKeyPair, importJWK, jwtVerify, type JWK } from "jose";
import { accessClaimsSchema, checkAccessClaims, type AccessClaims, type Audience } from "@outlet/auth-core";
import type { Actor } from "@outlet/policy";
import { z } from "zod";
import type { Authenticator } from "../../../platform/ports";
import type { AccessTokenIssuer, SessionRepository, UserDirectory } from "../domain/ports";
import type { Clock } from "../application/common";
import type { SellerActorResolver } from "../seller/domain/ports";

/** Access tokens are Ed25519 (EdDSA) JWTs, typ at+jwt (RFC 9068 style), kid-addressed. ADR-0030. */
export const ACCESS_TOKEN_TYP = "at+jwt";

const PublicOkp = z.object({ kty: z.literal("OKP"), crv: z.literal("Ed25519"), x: z.string().min(1) }).passthrough();
const PrivateOkp = PublicOkp.extend({ d: z.string().min(1) });

const KeyRecordSchema = z.object({
  kid: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  publicJwk: PublicOkp,
  privateJwk: PrivateOkp.optional(),
});
const MaterialSchema = z
  .object({ activeKid: z.string(), keys: z.array(KeyRecordSchema).min(1).max(8) })
  .superRefine((m, ctx) => {
    const kids = m.keys.map((k) => k.kid);
    if (new Set(kids).size !== kids.length) ctx.addIssue({ code: "custom", message: "duplicate kid" });
    const active = m.keys.find((k) => k.kid === m.activeKid);
    if (active?.privateJwk === undefined) ctx.addIssue({ code: "custom", message: "active key has no private part" });
  });

export type TokenKeyMaterial = z.infer<typeof MaterialSchema>;
export type TokenKeyRecord = z.infer<typeof KeyRecordSchema>;

/**
 * Where signing keys come from (secret manager / KMS adapter). The production default is
 * Unconfigured (`secrets.manager`): `load()` throws, so issuing fails closed with 503 and no token
 * verifies. Rotation: add the new key, switch `activeKid`, keep the old public key for at least the
 * access token lifetime (10 min) plus skew, then remove it.
 */
export interface TokenKeySource {
  load(): Promise<TokenKeyMaterial>;
}

export class StaticTokenKeySource implements TokenKeySource {
  constructor(private material: TokenKeyMaterial) {}
  async load(): Promise<TokenKeyMaterial> {
    return this.material;
  }
  /** Test support: swap the material to simulate rotation. */
  replace(material: TokenKeyMaterial): void {
    this.material = material;
  }
}

export async function generateTokenKey(kid: string): Promise<Required<TokenKeyRecord>> {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  const publicJwk = PublicOkp.parse(await exportJWK(publicKey));
  const privateJwk = PrivateOkp.parse(await exportJWK(privateKey));
  return { kid, publicJwk, privateJwk };
}

type ImportedKey = Awaited<ReturnType<typeof importJWK>>;

interface LoadedKeys {
  readonly activeKid: string;
  readonly signing: ImportedKey;
  readonly verifying: ReadonlyMap<string, ImportedKey>;
  readonly publicJwks: readonly JWK[];
  readonly loadedAtMs: number;
}

const FORBIDDEN_HEADERS = ["jwk", "jku", "x5u", "x5c", "x5t", "x5t#S256", "crit", "b64"] as const;

export interface JoseTokenServiceDeps {
  readonly source: TokenKeySource;
  readonly sessions: SessionRepository;
  readonly users: UserDirectory;
  readonly clock: Clock;
  readonly issuer: string;
  /** How long loaded keys are trusted before the source is asked again (rotation latency). */
  readonly keyRefreshMs?: number;
  /** Resolves seller_api tokens (enrol and full sessions). Absent: seller tokens never authenticate. */
  readonly sellerActors?: SellerActorResolver;
}

export type VerifiedAccessToken = { readonly claims: AccessClaims };

export class JoseTokenService implements AccessTokenIssuer, Authenticator {
  private loaded: LoadedKeys | null = null;
  private inflight: Promise<LoadedKeys> | null = null;

  constructor(private readonly deps: JoseTokenServiceDeps) {}

  private async keys(): Promise<LoadedKeys> {
    const refreshMs = this.deps.keyRefreshMs ?? 60_000;
    const now = this.deps.clock.nowMs();
    if (this.loaded !== null && now - this.loaded.loadedAtMs < refreshMs) return this.loaded;
    this.inflight ??= this.reload(now).finally(() => {
      this.inflight = null;
    });
    try {
      return await this.inflight;
    } catch (error) {
      // A transient source failure keeps serving the last good key set; a never-loaded service fails closed.
      if (this.loaded !== null) return this.loaded;
      throw error;
    }
  }

  private async reload(now: number): Promise<LoadedKeys> {
    const material = MaterialSchema.parse(await this.deps.source.load());
    const verifying = new Map<string, ImportedKey>();
    for (const k of material.keys) verifying.set(k.kid, await importJWK(k.publicJwk, "EdDSA"));
    const active = material.keys.find((k) => k.kid === material.activeKid);
    if (active?.privateJwk === undefined) throw new Error("active key has no private part");
    const signing = await importJWK(active.privateJwk, "EdDSA");
    const next: LoadedKeys = {
      activeKid: material.activeKid,
      signing,
      verifying,
      publicJwks: material.keys.map((k) => ({ kty: "OKP", crv: "Ed25519", x: k.publicJwk.x, kid: k.kid, use: "sig", alg: "EdDSA" })),
      loadedAtMs: now,
    };
    this.loaded = next;
    return next;
  }

  /** Public key set, ready to serve as /.well-known/jwks.json (no private material ever). */
  async jwks(): Promise<{ readonly keys: readonly JWK[] }> {
    return { keys: (await this.keys()).publicJwks };
  }

  async issue(claims: AccessClaims): Promise<string> {
    const parsed = accessClaimsSchema.parse(claims);
    const k = await this.keys();
    return new SignJWT({ ...parsed })
      .setProtectedHeader({ alg: "EdDSA", kid: k.activeKid, typ: ACCESS_TOKEN_TYP })
      .sign(k.signing);
  }

  /** Signature, header hygiene, issuer, audience, lifetime. Does not touch the session store. */
  async verifyClaims(token: string, audience: Audience, nowMs: number): Promise<VerifiedAccessToken | null> {
    if (token.length === 0 || token.length > 4096) return null;
    try {
      const header = decodeProtectedHeader(token);
      if (header.alg !== "EdDSA" || header.typ !== ACCESS_TOKEN_TYP || typeof header.kid !== "string") return null;
      const headerKeys = header as Record<string, unknown>;
      if (FORBIDDEN_HEADERS.some((h) => headerKeys[h] !== undefined)) return null;
      const k = await this.keys();
      const key = k.verifying.get(header.kid);
      if (key === undefined) return null;
      const { payload } = await jwtVerify(token, key, {
        algorithms: ["EdDSA"],
        issuer: this.deps.issuer,
        audience,
        currentDate: new Date(nowMs),
        clockTolerance: 30,
        requiredClaims: ["iss", "sub", "aud", "iat", "exp", "jti"],
      });
      const checked = checkAccessClaims(payload, audience, nowMs);
      return checked.ok ? { claims: checked.claims } : null;
    } catch {
      return null;
    }
  }

  async authenticate(token: string, nowMs: number): Promise<{ actor: Actor; claims: AccessClaims } | null> {
    let aud: unknown;
    try {
      aud = decodeJwt(token).aud;
    } catch {
      return null;
    }
    if (aud === "seller_api") {
      const resolver = this.deps.sellerActors;
      if (resolver === undefined) return null;
      const sv = await this.verifyClaims(token, "seller_api", nowMs);
      if (sv === null) return null;
      const actor = await resolver.resolve(sv.claims, nowMs);
      return actor === null ? null : { claims: sv.claims, actor };
    }
    const verified = await this.verifyClaims(token, "buyer_api", nowMs);
    if (verified === null) return null;
    const { claims } = verified;
    // Revocation is immediate: the session row decides, not the token's remaining lifetime.
    const stored = await this.deps.sessions.find(claims.sid);
    if (stored === null || stored.session.revokedAtMs !== null || stored.session.userId !== claims.sub) return null;
    const user = await this.deps.users.findById(claims.sub);
    if (user === null || user.status !== "active") return null;
    return {
      claims,
      actor: {
        id: user.id,
        status: user.status,
        assurance: claims.amr.includes("passkey") ? "passkey" : "basic",
        grants: [{ kind: "shopper" }],
        tokenScopes: [],
      },
    };
  }
}
