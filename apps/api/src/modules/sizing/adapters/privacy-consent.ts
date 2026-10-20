import { latestConsent } from "@outlet/privacy";
import type { ConsentRepository } from "../../privacy";
import type { MeasurementsConsentPort } from "../domain/ports";

/** Reads the `measurements` consent from the privacy module's append-only history (public index only). Unknown or withdrawn is not granted. */
export class PrivacyMeasurementsConsent implements MeasurementsConsentPort {
  constructor(private readonly consents: Pick<ConsentRepository, "history">) {}
  async isGranted(userId: string): Promise<boolean> {
    const r = latestConsent(await this.consents.history(userId), userId, "measurements");
    return r !== undefined && r.granted;
  }
}
