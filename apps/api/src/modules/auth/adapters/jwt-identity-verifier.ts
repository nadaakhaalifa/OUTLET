import { createPublicKey, verify as cryptoVerify, type JsonWebKey } from "node:crypto";
import {
  constantTimeEqual,
  sha256Hex,
  type AppleIdentityVerifier,
  type GoogleIdentityVerifier,
  type IdentityVerification,
} from "@outlet/auth-core";
import { z } from "zod";
import type { Clock } from "../application/common";

/**
 * Supplies the provider's public key for a `kid`. The production adapter fetches and caches the
 * provider JWKS document (Apple: appleid.apple.com/auth/keys, Google: googleapis.com/oauth2/v3/certs)
 * and refreshes on an unknown kid; it is not built yet (no network in Phase 0). Returns null when
 * the provider has no such key; throws when the provider is unreachable.
 */
export interface JwksKeyFetcher {
  getKey(provider: "apple" | "google", kid: string): Promise<JsonWebKey | null>;
}

export interface JwtIdentityVerifierConfig {
  readonly provider: "apple" | "google";
  /** Accepted `iss` values (Google issues two spellings). */
  readonly issuers: readonly string[];
  /** The client / service id this app is registered as. */
  readonly audience: string;
  readonly keys: JwksKeyFetcher;
  readonly clock: Clock;
  readonly clockSkewSeconds?: number;
}

const HeaderSchema = z.object({ alg: z.string(), kid: z.string().min(1).max(256), typ: z.string().optional() });

const BoolLike = z.union([z.boolean(), z.enum(["true", "false"]).transform((v) => v === "true")]);

const ClaimsSchema = z.object({
  iss: z.string(),
  aud: z.union([z.string(), z.array(z.string())]),
  sub: z.string().min(1).max(255),
  exp: z.number(),
  iat: z.number().optional(),
  nonce: z.string().optional(),
  email: z.string().email().optional(),
  email_verified: BoolLike.optional(),
  is_private_email: BoolLike.optional(),
});

function decodeSegment(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as unknown;
}

/**
 * RS256 ID-token verifier for Sign in with Apple and Google. Algorithm is pinned (no `none`, no
 * HS256 key confusion); signature, issuer, audience, expiry and nonce are all required.
 */
export class JwtIdentityVerifier implements AppleIdentityVerifier, GoogleIdentityVerifier {
  constructor(private readonly cfg: JwtIdentityVerifierConfig) {}

  verify(input: { identityToken: string; expectedNonce: string }): Promise<IdentityVerification>;
  verify(input: { idToken: string; expectedNonce: string }): Promise<IdentityVerification>;
  async verify(
    input: { identityToken: string; expectedNonce: string } | { idToken: string; expectedNonce: string },
  ): Promise<IdentityVerification> {
    const token = "identityToken" in input ? input.identityToken : input.idToken;
    const c = this.cfg;
    if (token.length > 8192) return { ok: false, reason: "invalid_token" };
    const parts = token.split(".");
    if (parts.length !== 3) return { ok: false, reason: "invalid_token" };
    const [h, p, s] = parts as [string, string, string];

    let header: z.infer<typeof HeaderSchema>;
    let rawClaims: unknown;
    try {
      header = HeaderSchema.parse(decodeSegment(h));
      rawClaims = decodeSegment(p);
    } catch {
      return { ok: false, reason: "invalid_token" };
    }
    if (header.alg !== "RS256") return { ok: false, reason: "invalid_token" };

    let jwk: JsonWebKey | null;
    try {
      jwk = await c.keys.getKey(c.provider, header.kid);
    } catch {
      return { ok: false, reason: "provider_unavailable" };
    }
    if (jwk === null) return { ok: false, reason: "invalid_token" };

    let signatureOk: boolean;
    try {
      signatureOk = cryptoVerify(
        "RSA-SHA256",
        Buffer.from(`${h}.${p}`, "utf8"),
        createPublicKey({ key: jwk, format: "jwk" }),
        Buffer.from(s, "base64url"),
      );
    } catch {
      signatureOk = false;
    }
    if (!signatureOk) return { ok: false, reason: "invalid_token" };

    const parsed = ClaimsSchema.safeParse(rawClaims);
    if (!parsed.success) return { ok: false, reason: "invalid_token" };
    const claims = parsed.data;

    const skew = c.clockSkewSeconds ?? 30;
    const nowS = Math.floor(c.clock.nowMs() / 1000);
    if (!c.issuers.includes(claims.iss)) return { ok: false, reason: "issuer_mismatch" };
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(c.audience)) return { ok: false, reason: "audience_mismatch" };
    if (nowS - skew >= claims.exp) return { ok: false, reason: "expired" };
    if (claims.iat !== undefined && claims.iat > nowS + skew) return { ok: false, reason: "invalid_token" };

    if (claims.nonce === undefined || input.expectedNonce.length === 0) return { ok: false, reason: "nonce_mismatch" };
    // Apple embeds the SHA-256 of the raw nonce the app generated; Google echoes it verbatim.
    const accepted = c.provider === "apple" ? [input.expectedNonce, sha256Hex(input.expectedNonce)] : [input.expectedNonce];
    const nonceOk = accepted.some((n) => n.length === claims.nonce?.length && constantTimeEqual(n, claims.nonce));
    if (!nonceOk) return { ok: false, reason: "nonce_mismatch" };

    const email = claims.email ?? null;
    return {
      ok: true,
      identity: {
        provider: c.provider,
        subject: claims.sub,
        email,
        emailVerified: email !== null && claims.email_verified === true,
        isPrivateRelay:
          claims.is_private_email === true || (email?.endsWith("@privaterelay.appleid.com") ?? false),
      },
    };
  }
}
