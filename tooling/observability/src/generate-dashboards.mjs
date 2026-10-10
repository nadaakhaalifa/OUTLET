// Grafana dashboard JSON skeletons, generated so the SLO panels always match the SLO file.
// Panels outside the SLO set are proposals tied to metric names in the OTel conventions doc.
import { resolveTiers, windowToHours, errorBudget } from './burn-rate.mjs';

export const DASHBOARDS = {
  checkout: {
    title: 'Outlet NK / Checkout',
    extra: [
      ['Attempts by outcome', 'sum by (outcome) (rate(outlet_checkout_attempts_total[5m]))', 'ops'],
      ['Failures by reason', 'sum by (failure_reason) (rate(outlet_checkout_attempts_total{outcome="failed"}[15m]))', 'ops'],
      ['Attempts by payment method', 'sum by (payment_method) (rate(outlet_checkout_attempts_total[15m]))', 'ops'],
      ['Reservation expiry before payment', 'sum(rate(outlet_reservation_expired_total{reason="payment_window"}[15m]))', 'ops'],
    ],
  },
  reservation: {
    title: 'Outlet NK / Reservation',
    extra: [
      ['Reserve latency p50/p95/p99', 'histogram_quantile(0.95, sum by (le) (rate(outlet_reserve_duration_seconds_bucket[5m])))', 's'],
      ['Reserve outcomes', 'sum by (outcome) (rate(outlet_reserve_total[5m]))', 'ops'],
      ['Skip-locked misses (contention)', 'sum(rate(outlet_reserve_skip_locked_total[5m]))', 'ops'],
      ['Active reservations', 'sum(outlet_reservations_active)', 'short'],
      ['Expiry sweeper lag', 'max(outlet_reservation_sweeper_lag_seconds)', 's'],
    ],
  },
  payments: {
    title: 'Outlet NK / Payments',
    extra: [
      ['Webhook to PAID p95', 'histogram_quantile(0.95, sum by (le) (rate(outlet_payment_confirmation_duration_seconds_bucket[5m])))', 's'],
      ['PSP call errors by provider', 'sum by (provider) (rate(outlet_psp_request_errors_total[5m]))', 'ops'],
      ['PSP call latency p95 by provider', 'histogram_quantile(0.95, sum by (le, provider) (rate(outlet_psp_request_duration_seconds_bucket[5m])))', 's'],
      ['Circuit breaker state by provider', 'max by (provider) (outlet_psp_circuit_breaker_state)', 'short'],
      ['Webhook signature failures', 'sum(rate(outlet_psp_webhook_rejected_total{reason="bad_signature"}[15m]))', 'ops'],
      ['Webhook duplicates dropped', 'sum(rate(outlet_psp_webhook_rejected_total{reason="duplicate"}[15m]))', 'ops'],
    ],
  },
  api: {
    title: 'Outlet NK / API',
    extra: [
      ['Requests per second by status class', 'sum by (http_response_status_class) (rate(http_server_request_duration_seconds_count[1m]))', 'reqps'],
      ['p95 latency by route', 'histogram_quantile(0.95, sum by (le, http_route) (rate(http_server_request_duration_seconds_bucket[5m])))', 's'],
      ['5xx ratio', 'sum(rate(http_server_request_duration_seconds_count{http_response_status_code=~"5.."}[5m])) / sum(rate(http_server_request_duration_seconds_count[5m]))', 'percentunit'],
      ['Rate limited (429)', 'sum(rate(http_server_request_duration_seconds_count{http_response_status_code="429"}[5m]))', 'reqps'],
    ],
  },
  search: {
    title: 'Outlet NK / Search',
    extra: [
      ['Search latency p95', 'histogram_quantile(0.95, sum by (le) (rate(outlet_search_duration_seconds_bucket[5m])))', 's'],
      ['Postgres fallback share', 'sum(rate(outlet_search_total{backend="postgres"}[5m])) / sum(rate(outlet_search_total[5m]))', 'percentunit'],
      ['Zero-result rate', 'sum(rate(outlet_search_total{results="0"}[15m])) / sum(rate(outlet_search_total[15m]))', 'percentunit'],
      ['Index freshness lag', 'max(outlet_search_index_lag_seconds)', 's'],
    ],
  },
  mobile: {
    title: 'Outlet NK / Mobile',
    extra: [
      ['Crash-free sessions by app version', '1 - (sum by (app_version) (rate(outlet_mobile_sessions_total{crashed="true"}[1h])) / sum by (app_version) (rate(outlet_mobile_sessions_total[1h])))', 'percentunit'],
      ['Crash-free by platform', '1 - (sum by (platform) (rate(outlet_mobile_sessions_total{crashed="true"}[1h])) / sum by (platform) (rate(outlet_mobile_sessions_total[1h])))', 'percentunit'],
      ['Cold start p95', 'histogram_quantile(0.95, sum by (le) (rate(outlet_mobile_cold_start_seconds_bucket[1h])))', 's'],
      ['API errors seen by client', 'sum by (error_code) (rate(outlet_mobile_api_errors_total[15m]))', 'ops'],
    ],
  },
  reconciliation: {
    title: 'Outlet NK / Reconciliation and refunds',
    extra: [
      ['Unmatched lines by age bucket', 'max by (age_bucket) (outlet_reconciliation_unmatched_lines)', 'short'],
      ['Unmatched amount (EGP minor units)', 'sum(outlet_reconciliation_unmatched_amount_minor)', 'short'],
      ['Seconds since last successful run', 'time() - max(outlet_reconciliation_last_success_timestamp_seconds)', 's'],
      ['Refunds by SLA outcome', 'sum by (outcome) (rate(outlet_refund_sla_total[1h]))', 'ops'],
    ],
  },
};

const DS = { type: 'prometheus', uid: '${DS_PROMETHEUS}' };

function panel(id, type, title, exprs, gridPos, extra = {}) {
  return {
    id,
    type,
    title,
    description: 'SKELETON: panel layout and thresholds are placeholders until the metric is instrumented.',
    datasource: DS,
    gridPos,
    targets: exprs.map((e, i) => ({
      refId: String.fromCharCode(65 + i),
      expr: e.expr,
      legendFormat: e.legend ?? '',
    })),
    ...extra,
  };
}

function sloPanels(slo, file, startId, startY) {
  const period = file.period;
  const periodHours = windowToHours(period);
  const out = [];
  let id = startId;
  if (slo.kind === 'zero_gauge') {
    out.push(
      panel(id++, 'stat', `${slo.title}: current`, [{ expr: slo.sli.gauge }], { h: 4, w: 6, x: 0, y: startY }, {
        fieldConfig: {
          defaults: { thresholds: { mode: 'absolute', steps: [{ color: 'green', value: null }, { color: 'red', value: 1 }] } },
          overrides: [],
        },
      }),
    );
    return { panels: out, nextId: id, height: 4 };
  }
  const tiers = resolveTiers({ objective: slo.objective, periodHours, tiers: file.tiers });
  const slowest = tiers[tiers.length - 1];
  out.push(
    panel(
      id++,
      'stat',
      `${slo.title}: SLI over ${period}`,
      [{ expr: `1 - slo:sli_error:ratio_rate${period}{slo="${slo.id}"}` }],
      { h: 4, w: 6, x: 0, y: startY },
      {
        fieldConfig: {
          defaults: {
            unit: 'percentunit',
            thresholds: { mode: 'absolute', steps: [{ color: 'red', value: null }, { color: 'green', value: slo.objective }] },
          },
          overrides: [],
        },
      },
    ),
    panel(
      id++,
      'gauge',
      `${slo.title}: error budget remaining (${period})`,
      [{ expr: `1 - (slo:sli_error:ratio_rate${period}{slo="${slo.id}"} / ${errorBudget(slo.objective)})` }],
      { h: 4, w: 6, x: 6, y: startY },
      { fieldConfig: { defaults: { unit: 'percentunit', min: 0, max: 1 }, overrides: [] } },
    ),
    panel(
      id++,
      'timeseries',
      `${slo.title}: error ratio against alert thresholds`,
      [
        { expr: `slo:sli_error:ratio_rate${tiers[0].long}{slo="${slo.id}"}`, legend: `${tiers[0].long} error ratio` },
        { expr: `slo:sli_error:ratio_rate${slowest.long}{slo="${slo.id}"}`, legend: `${slowest.long} error ratio` },
        ...tiers.map((t) => ({ expr: `vector(${t.threshold})`, legend: `${t.name} threshold (burn ${t.burnRate}x)` })),
      ],
      { h: 8, w: 12, x: 12, y: startY },
      { fieldConfig: { defaults: { unit: 'percentunit' }, overrides: [] } },
    ),
  );
  return { panels: out, nextId: id, height: 8 };
}

export function generateDashboards(file) {
  const out = {};
  for (const [key, def] of Object.entries(DASHBOARDS)) {
    const panels = [];
    let id = 1;
    let y = 0;
    const slos = file.slos.filter((s) => s.dashboard === key);
    for (const slo of slos) {
      const r = sloPanels(slo, file, id, y);
      panels.push(...r.panels);
      id = r.nextId;
      y += r.height;
    }
    def.extra.forEach(([title, expr, unit], i) => {
      panels.push(
        panel(
          id++,
          'timeseries',
          title,
          [{ expr }],
          { h: 8, w: 12, x: (i % 2) * 12, y: y + Math.floor(i / 2) * 8 },
          { fieldConfig: { defaults: { unit }, overrides: [] } },
        ),
      );
    });
    out[`${key}.json`] =
      JSON.stringify(
        {
          __inputs: [{ name: 'DS_PROMETHEUS', label: 'Prometheus', type: 'datasource', pluginId: 'prometheus' }],
          title: def.title,
          uid: `outlet-${key}`,
          tags: ['outlet-nk', 'generated', 'skeleton'],
          schemaVersion: 39,
          timezone: 'Africa/Cairo',
          time: { from: 'now-6h', to: 'now' },
          refresh: '1m',
          annotations: { list: [] },
          templating: { list: [] },
          links: [],
          panels,
        },
        null,
        2,
      ) + '\n';
  }
  return out;
}
