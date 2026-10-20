import type { AdmissionVerifier } from "../application/admission";

/** Structural twin of checkout's DropAdmissionPort (modules talk through ports, not imports). */
export class CheckoutDropAdmission {
  constructor(private readonly verifier: AdmissionVerifier) {}

  async redeem(i: {
    readonly userId: string;
    readonly deviceId: string | null;
    readonly token: string | null;
    readonly dropIds: readonly string[];
  }): Promise<"ok" | "required" | "invalid" | "already_used"> {
    if (i.token === null || i.deviceId === null) return "required";
    for (const dropId of i.dropIds) {
      const v = await this.verifier.verify({ token: i.token, dropId, userId: i.userId, deviceId: i.deviceId });
      if (!v.ok) return "invalid";
      const c = await this.verifier.consume(v.claims.jti);
      if (c === "already_used") return "already_used";
      if (c !== "used") return "invalid";
    }
    return "ok";
  }
}
