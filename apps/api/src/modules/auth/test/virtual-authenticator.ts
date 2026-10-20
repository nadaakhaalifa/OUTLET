import { createHash, generateKeyPairSync, sign, randomBytes, type KeyObject } from "node:crypto";

/**
 * Software WebAuthn authenticator for tests, built only from node:crypto (no browser, no library
 * under test). It produces what a real platform authenticator sends:
 *   - COSE_Key (ES256, P-256) and an `attestationObject` with fmt "none" (CBOR, encoded below),
 *   - authenticatorData = SHA-256(rpId) | flags | signCount (u32 BE) [| AAGUID | credIdLen | credId | COSE key],
 *   - clientDataJSON with type / challenge / origin,
 *   - assertions signed over authData || SHA-256(clientDataJSON) with ECDSA P-256 (DER), as WebAuthn requires.
 * Flags: UP 0x01, UV 0x04, BE 0x08, BS 0x10, AT 0x40. Tests tamper with the knobs on the options to
 * produce wrong origin, wrong RP ID, missing UV, rolled-back counters, foreign keys and flag flips.
 */

type Cbor = number | string | Uint8Array | Cbor[] | Map<Cbor, Cbor>;

function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
  throw new RangeError("fixture CBOR encoder: value too large");
}

export function cbor(v: Cbor): Buffer {
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") {
    const b = Buffer.from(v, "utf8");
    return Buffer.concat([head(3, b.length), b]);
  }
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cbor)]);
  return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
}

const sha256 = (b: Buffer | string): Buffer => createHash("sha256").update(b).digest();

export interface VirtualOptions {
  readonly rpId: string;
  readonly origin: string;
  /** Set UV (user verification). Default true. */
  readonly userVerified?: boolean;
  readonly backupEligible?: boolean;
  readonly backedUp?: boolean;
}

export class VirtualAuthenticator {
  readonly credentialId = randomBytes(16);
  private readonly privateKey: KeyObject;
  private readonly x: Buffer;
  private readonly y: Buffer;
  signCount = 0;

  constructor(private readonly opts: VirtualOptions) {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: "jwk" });
    this.x = Buffer.from(String(jwk.x), "base64url");
    this.y = Buffer.from(String(jwk.y), "base64url");
  }

  get id(): string {
    return this.credentialId.toString("base64url");
  }

  private flags(attested: boolean, o: Partial<VirtualOptions>): number {
    const uv = (o.userVerified ?? this.opts.userVerified ?? true) ? 0x04 : 0;
    const be = (o.backupEligible ?? this.opts.backupEligible ?? false) ? 0x08 : 0;
    const bs = (o.backedUp ?? this.opts.backedUp ?? false) ? 0x10 : 0;
    return 0x01 | uv | be | bs | (attested ? 0x40 : 0);
  }

  private authData(attested: boolean, rpId: string, counter: number, o: Partial<VirtualOptions>): Buffer {
    const counterBuf = Buffer.alloc(4);
    counterBuf.writeUInt32BE(counter);
    const base = Buffer.concat([sha256(rpId), Buffer.from([this.flags(attested, o)]), counterBuf]);
    if (!attested) return base;
    const cose = cbor(new Map<Cbor, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, this.x], [-3, this.y]]));
    const idLen = Buffer.alloc(2);
    idLen.writeUInt16BE(this.credentialId.length);
    return Buffer.concat([base, Buffer.alloc(16), idLen, this.credentialId, cose]);
  }

  private clientData(type: "webauthn.create" | "webauthn.get", challenge: string, origin: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  /** Registration response JSON as `navigator.credentials.create()` would yield (RegistrationResponseJSON). */
  register(challenge: string, o: Partial<VirtualOptions> & { origin?: string; rpId?: string } = {}) {
    const clientDataJSON = this.clientData("webauthn.create", challenge, o.origin ?? this.opts.origin);
    const authData = this.authData(true, o.rpId ?? this.opts.rpId, this.signCount, o);
    const attestationObject = cbor(new Map<Cbor, Cbor>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key" as const,
      response: { clientDataJSON: clientData64(clientDataJSON), attestationObject: attestationObject.toString("base64url"), transports: ["internal"] },
      clientExtensionResults: {},
    };
  }

  /** Assertion response JSON as `navigator.credentials.get()` would yield. */
  assert(
    challenge: string,
    o: Partial<VirtualOptions> & { origin?: string; rpId?: string; counter?: number; signWith?: KeyObject; userHandle?: string | null } = {},
  ) {
    const counter = o.counter ?? ++this.signCount;
    if (o.counter === undefined) this.signCount = counter;
    const clientDataJSON = this.clientData("webauthn.get", challenge, o.origin ?? this.opts.origin);
    const authData = this.authData(false, o.rpId ?? this.opts.rpId, counter, o);
    const signature = sign("sha256", Buffer.concat([authData, sha256(clientDataJSON)]), { key: o.signWith ?? this.privateKey, dsaEncoding: "der" });
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key" as const,
      response: {
        clientDataJSON: clientData64(clientDataJSON),
        authenticatorData: authData.toString("base64url"),
        signature: signature.toString("base64url"),
        ...(o.userHandle === null || o.userHandle === undefined ? {} : { userHandle: Buffer.from(o.userHandle, "utf8").toString("base64url") }),
      },
      clientExtensionResults: {},
    };
  }

  /** A second key pair, to sign an assertion with a key the server never registered. */
  static foreignKey(): KeyObject {
    return generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
  }
}

const clientData64 = (b: Buffer): string => b.toString("base64url");
