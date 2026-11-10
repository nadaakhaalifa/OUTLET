import { ListRoute } from "../../../../components/lists/ListRoute";
import type { SegmentParams } from "../../../../lib/segment-page";

export default async function DisputesRoute({ params, searchParams }: { params: SegmentParams; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return await ListRoute({ kind: "disputes", params, searchParams });
}
