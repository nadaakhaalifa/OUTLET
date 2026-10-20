import {
  suppressSmallCells,
  validateChart,
  type ChartError,
  type LengthUnit,
} from "../domain/bridge";
import type { Clock, IdGenerator } from "../../../platform/ports";
import type {
  DemandRepository,
  Page,
  SizeChartRepository,
  SizingEventPublisher,
  StoredChart,
} from "../domain/ports";

export interface ChartSubmission {
  readonly productType: string;
  readonly unit: LengthUnit;
  readonly rows: readonly { sizeLabel: string; measurements: Readonly<Record<string, number>> }[];
}

/** A chart that fails validation is saved as a draft: it only blocks recommendations. */
export class CreateSizeChart {
  constructor(
    private readonly repo: SizeChartRepository,
    private readonly events: SizingEventPublisher,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(storeId: string, input: ChartSubmission): Promise<StoredChart> {
    const v = validateChart({ productType: input.productType, unit: input.unit, rows: input.rows });
    const chart: StoredChart = {
      id: this.ids.uuidV7(),
      storeId,
      productType: input.productType,
      chartVersion: await this.repo.nextVersion(storeId, input.productType),
      unitEntered: input.unit,
      rows: v.rows,
      validated: v.validated,
      validationErrors: v.errors as readonly ChartError[],
      createdAtMs: this.clock.nowMs(),
    };
    await this.repo.insert(chart);
    await this.events.publish({ type: "size_chart.validated", chartId: chart.id, storeId, validated: chart.validated });
    return chart;
  }
}

export class ListSizeCharts {
  constructor(private readonly repo: SizeChartRepository) {}

  execute(storeId: string, page: { cursor: string | null; limit: number }): Promise<Page<StoredChart> | "invalid_cursor"> {
    return this.repo.listForStore(storeId, page);
  }
}

export interface DemandCellView {
  readonly productType: string;
  readonly sizeLabel: string;
  readonly week: string;
  readonly demandCount: number;
}

/** Seller facing aggregate. Cells below k = 50 are cut here and cannot exist in the table. */
export class GetSizeDemand {
  constructor(private readonly repo: DemandRepository) {}

  async execute(storeId: string): Promise<readonly DemandCellView[]> {
    const cells = await this.repo.cellsForStore(storeId);
    return suppressSmallCells(cells).map((c) => ({
      productType: c.productType,
      sizeLabel: c.sizeLabel,
      week: c.week,
      demandCount: c.demandCount,
    }));
  }
}
