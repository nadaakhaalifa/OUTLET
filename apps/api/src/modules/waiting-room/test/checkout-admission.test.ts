import { describe, expect, it } from "vitest";
import { AdmissionVerifier } from "../application/admission";
import { mintToken } from "../application/admission";
import { CheckoutDropAdmission } from "../adapters/checkout-admission";
import { FakeSecrets, InMemoryAdmissionStore } from "../adapters/in-memory";
import { jwtAdmissionCodec } from "../adapters/jwt";
import { deviceHash } from "../application/shared";

const NOW = 1_800_000_000_000;
const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

async function setup() {
  const secrets = new FakeSecrets();
  const store = new InMemoryAdmissionStore();
  const clock = { nowMs: () => NOW };
  const rec = {
    jti: U(1),
    ticketId: U(2),
    dropId: U(3),
    userId: U(4),
    deviceHash: deviceHash("device-number-1"),
    joinedAtMs: NOW - 5000,
    issuedAtMs: NOW,
    expiresAtMs: NOW + 900_000,
    usedAtMs: null,
  };
  await store.recordAdmission(rec, []);
  const token = await mintToken(secrets, jwtAdmissionCodec, rec);
  return { port: new CheckoutDropAdmission(new AdmissionVerifier(secrets, store, clock, jwtAdmissionCodec)), token };
}

describe("CheckoutDropAdmission", () => {
  it("accepts a valid token exactly once", async () => {
    const { port, token } = await setup();
    const i = { userId: U(4), deviceId: "device-number-1", token, dropIds: [U(3)] };
    expect(await port.redeem(i)).toBe("ok");
    expect(await port.redeem(i)).toBe("already_used");
  });
  it("rejects missing token, other user, other device, other drop and tampering", async () => {
    const { port, token } = await setup();
    const base = { userId: U(4), deviceId: "device-number-1", token, dropIds: [U(3)] };
    expect(await port.redeem({ ...base, token: null })).toBe("required");
    expect(await port.redeem({ ...base, userId: U(5) })).toBe("invalid");
    expect(await port.redeem({ ...base, deviceId: "device-number-2" })).toBe("invalid");
    expect(await port.redeem({ ...base, dropIds: [U(9)] })).toBe("invalid");
    expect(await port.redeem({ ...base, token: `${token}x` })).toBe("invalid");
    expect(await port.redeem(base)).toBe("ok");
  });
});
