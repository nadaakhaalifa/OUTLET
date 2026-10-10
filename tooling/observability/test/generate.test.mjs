import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { parseSloFile } from '../src/slo-schema.mjs';
import { generateRuleFiles, sliExpressions } from '../src/generate-rules.mjs';
import { generateDashboards, DASHBOARDS } from '../src/generate-dashboards.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const sloText = readFileSync(join(root, 'infra/observability/slos/slos.yaml'), 'utf8');
const file = parseSloFile(parse(sloText));
const rules = generateRuleFiles(file);
const allAlerts = (name) =>
  parse(rules[name]).groups.flatMap((g) => g.rules).filter((r) => r.alert !== undefined);

// The eight rows of the spec T8 SLO table, in order.
const T8_ROWS = [
  'T8 Checkout',
  'T8 Reserve',
  'T8 Payment confirmation',
  'T8 API',
  'T8 Search',
  'T8 Mobile',
  'T8 Refunds',
  'T8 Reconciliation',
];

test('every T8 row has exactly one SLO', () => {
  assert.deepEqual(file.slos.map((s) => s.specRow), T8_ROWS);
  assert.equal(new Set(file.slos.map((s) => s.id)).size, 8);
});

test('objectives match the T8 table', () => {
  const by = Object.fromEntries(file.slos.map((s) => [s.id, s]));
  assert.equal(by['checkout-success'].objective, 0.995);
  assert.equal(by['mobile-crash-free'].objective, 0.998);
  assert.equal(by['refund-initiation'].objective, 0.99);
  assert.equal(by['reserve-latency'].sli.thresholdSeconds, 0.15);
  assert.equal(by['reserve-latency'].sli.percentile, 0.95);
  assert.equal(by['payment-confirmation-latency'].sli.thresholdSeconds, 5);
  assert.equal(by['api-read-latency'].sli.thresholdSeconds, 0.3);
  assert.equal(by['search-latency'].sli.thresholdSeconds, 0.15);
  assert.equal(by['reconciliation-unmatched'].objective, 0);
  assert.equal(file.period, '28d');
});

test('every SLO emits a rule file and every referenced runbook and dashboard exists', () => {
  assert.equal(Object.keys(rules).length, 8);
  const dashboards = generateDashboards(file);
  for (const slo of file.slos) {
    assert.ok(rules[`slo-${slo.id}.rules.yaml`], slo.id);
    assert.ok(readFileSync(join(root, slo.runbook), 'utf8').length > 100, slo.runbook);
    assert.ok(dashboards[`${slo.dashboard}.json`], slo.dashboard);
  }
});

test('burn-rate alerts use 1h/5m and 6h/30m with 13.44x and 5.6x on a 28d period', () => {
  const alerts = allAlerts('slo-checkout-success.rules.yaml');
  const fast = alerts.find((a) => a.labels.tier === 'fast');
  const slow = alerts.find((a) => a.labels.tier === 'slow');
  assert.equal(fast.labels.burn_rate, '13.44');
  assert.equal(slow.labels.burn_rate, '5.6');
  assert.match(fast.expr, /ratio_rate1h\{slo="checkout-success"\} > 0\.0672/);
  assert.match(fast.expr, /ratio_rate5m\{slo="checkout-success"\} > 0\.0672/);
  assert.match(slow.expr, /ratio_rate6h\{slo="checkout-success"\} > 0\.028/);
  assert.match(slow.expr, /ratio_rate30m\{slo="checkout-success"\} > 0\.028/);
  assert.match(fast.expr, /\* 3600 >= 50/);
  assert.match(slow.expr, /\* 21600 >= 50/);
});

test('threshold equals burn rate times budget for every alert', () => {
  for (const slo of file.slos.filter((s) => s.kind !== 'zero_gauge')) {
    const budget = Number((1 - slo.objective).toPrecision(12));
    for (const a of allAlerts(`slo-${slo.id}.rules.yaml`).filter((r) => r.labels.burn_rate)) {
      const threshold = Number(/> ([0-9.]+)/.exec(a.expr)[1]);
      assert.ok(Math.abs(threshold - Number(a.labels.burn_rate) * budget) < 1e-9, `${slo.id} ${a.labels.tier}`);
      assert.ok(threshold < 1);
    }
  }
});

test('fast tier always pages; slow tier follows the SLO', () => {
  for (const slo of file.slos.filter((s) => s.kind !== 'zero_gauge')) {
    const alerts = allAlerts(`slo-${slo.id}.rules.yaml`);
    assert.equal(alerts.find((a) => a.labels.tier === 'fast').labels.severity, 'page');
    assert.equal(alerts.find((a) => a.labels.tier === 'slow').labels.severity, slo.slowSeverity);
  }
});

test('latency SLI is built from histogram bucket and count', () => {
  const slo = file.slos.find((s) => s.id === 'reserve-latency');
  const { error, events } = sliExpressions(slo, '5m');
  assert.equal(
    error,
    '1 - (sum(rate(outlet_reserve_duration_seconds_bucket{le="0.15"}[5m])) / sum(rate(outlet_reserve_duration_seconds_count[5m])))',
  );
  assert.equal(events, 'sum(rate(outlet_reserve_duration_seconds_count[5m]))');
  const api = sliExpressions(file.slos.find((s) => s.id === 'api-read-latency'), '1h');
  assert.match(api.error, /_bucket\{http_request_method="GET",le="0\.3"\}/);
});

test('reconciliation alerts on any non-zero value and escalates', () => {
  const alerts = allAlerts('slo-reconciliation-unmatched.rules.yaml');
  assert.equal(alerts.length, 2);
  assert.ok(alerts.every((a) => / > 0$/.test(a.expr)));
  assert.deepEqual(alerts.map((a) => a.labels.severity), ['ticket', 'page']);
});

test('recording rules exist for every window the alerts read', () => {
  const groups = parse(rules['slo-checkout-success.rules.yaml']).groups;
  const recorded = new Set(groups.flatMap((g) => g.rules).filter((r) => r.record).map((r) => r.record));
  for (const w of ['5m', '30m', '1h', '6h', '28d']) {
    assert.ok(recorded.has(`slo:sli_error:ratio_rate${w}`), w);
    assert.ok(recorded.has(`slo:sli_events:rate${w}`), w);
  }
});

test('committed generated files match the generator output', () => {
  for (const [name, content] of Object.entries(rules)) {
    assert.equal(readFileSync(join(root, 'infra/observability/prometheus/rules', name), 'utf8'), content, name);
  }
  for (const [name, content] of Object.entries(generateDashboards(file))) {
    assert.equal(readFileSync(join(root, 'infra/observability/grafana/dashboards', name), 'utf8'), content, name);
  }
  assert.equal(readdirSync(join(root, 'infra/observability/prometheus/rules')).length, 8);
  assert.equal(readdirSync(join(root, 'infra/observability/grafana/dashboards')).length, 7);
});

test('dashboards are valid JSON with unique panel ids and the seven required boards', () => {
  const boards = generateDashboards(file);
  assert.deepEqual(
    Object.keys(boards).sort(),
    ['api', 'checkout', 'mobile', 'payments', 'reconciliation', 'reservation', 'search'].map((n) => `${n}.json`),
  );
  assert.equal(Object.keys(DASHBOARDS).length, 7);
  for (const [name, text] of Object.entries(boards)) {
    const d = JSON.parse(text);
    const ids = d.panels.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length, name);
    assert.ok(d.panels.length >= 4, name);
    assert.equal(d.uid, `outlet-${name.replace('.json', '')}`);
    assert.ok(d.panels.every((p) => p.targets.every((t) => t.expr.length > 0)));
  }
});

test('schema rejects bad SLO files', () => {
  const clone = () => structuredClone(parse(sloText));
  const dup = clone();
  dup.slos.push(dup.slos[0]);
  assert.throws(() => parseSloFile(dup), /duplicate/);

  const mismatch = clone();
  mismatch.slos.find((s) => s.id === 'reserve-latency').objective = 0.99;
  assert.throws(() => parseSloFile(mismatch), /must equal the percentile/);

  const unfireable = clone();
  unfireable.slos.find((s) => s.id === 'search-latency').objective = 0.5;
  unfireable.slos.find((s) => s.id === 'search-latency').sli.percentile = 0.5;
  assert.throws(() => parseSloFile(unfireable), /could never fire/);

  const unknown = clone();
  unknown.slos[0].extra = 1;
  assert.throws(() => parseSloFile(unknown));

  const noRunbook = clone();
  noRunbook.slos[0].runbook = '../etc/passwd';
  assert.throws(() => parseSloFile(noRunbook));
});
