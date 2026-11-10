import { PageFrame } from "../../../components/PageFrame";
import { OnboardingFlow } from "../../../components/onboarding/OnboardingFlow";
import { requireLocale, type SegmentParams } from "../../../lib/segment-page";

export default async function OnboardingPage({ params }: { params: SegmentParams }) {
  const resolved = await requireLocale(params);
  return (
    <PageFrame resolved={resolved} current="onboarding">
      <OnboardingFlow locale={resolved.locale} marketId={resolved.marketId} />
    </PageFrame>
  );
}
