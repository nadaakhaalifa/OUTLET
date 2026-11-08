import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";

const sha256 = (b: Uint8Array): Buffer => createHash("sha256").update(b).digest();
const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};

/** A software authenticator (ES256, "none" attestation, user verified) for ceremony tests. */
export class VirtualAuthenticator {
  readonly credentialId = randomBytes(32);
  private readonly keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
  counter = 0;
  constructor(private readonly rpId: string, private readonly origin: string) {}

  get id(): string {
    return isoBase64URL.fromBuffer(Uint8Array.from(this.credentialId));
  }

  private clientData(type: string, challenge: string, origin: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  create(challenge: string, o: { origin?: string } = {}): RegistrationResponseJSON {
    const jwk = this.keys.publicKey.export({ format: "jwk" });
    const cose = isoCBOR.encode(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x ?? "", "base64url")], [-3, Buffer.from(jwk.y ?? "", "base64url")]]) as never);
    const idLen = Buffer.alloc(2);
    idLen.writeUInt16BE(this.credentialId.length);
    const authData = Buffer.concat([sha256(Buffer.from(this.rpId)), Buffer.from([0x45]), u32(this.counter), Buffer.alloc(16), idLen, this.credentialId, Buffer.from(cose)]);
    const attestationObject = isoCBOR.encode(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]) as never);
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: { clientDataJSON: isoBase64URL.fromBuffer(Uint8Array.from(this.clientData("webauthn.create", challenge, o.origin ?? this.origin))), attestationObject: isoBase64URL.fromBuffer(attestationObject) },
      clientExtensionResults: {},
    };
  }

  get(challenge: string, o: { origin?: string; counter?: number } = {}): AuthenticationResponseJSON {
    this.counter = o.counter ?? this.counter + 1;
    const authData = Buffer.concat([sha256(Buffer.from(this.rpId)), Buffer.from([0x05]), u32(this.counter)]);
    const clientDataJSON = this.clientData("webauthn.get", challenge, o.origin ?? this.origin);
    const signature = sign("sha256", Buffer.concat([authData, sha256(clientDataJSON)]), this.keys.privateKey);
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: { clientDataJSON: isoBase64URL.fromBuffer(Uint8Array.from(clientDataJSON)), authenticatorData: isoBase64URL.fromBuffer(Uint8Array.from(authData)), signature: isoBase64URL.fromBuffer(Uint8Array.from(signature)) },
      clientExtensionResults: {},
    };
  }
}
