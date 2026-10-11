import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  windowToHours,
  errorBudget,
  burnRateFor,
  budgetConsumed,
  errorRateThreshold,
  hoursToExhaustion,
  maxBurnRate,
  resolveTiers,
} from '../src/burn-rate.mjs';

const TIERS = [
  { name: 'fast', long: '1h', short: '5m', budgetFraction: 0.02, for: '2m' },
  { name: 'slow', long: '6h', short: '30m', budgetFraction: 0.05, for: '15m' },
];

test('window parsing', () => {
  assert.equal(windowToHours('5m'), 5 / 60);
  assert.equal(windowToHours('6h'), 6);
  assert.equal(windowToHours('28d'), 672);
  for (const bad of ['', '5', '0m', 'h', '1w', '-1h', '1.5h']) {
    assert.throws(() => windowToHours(bad), RangeError, bad);
  }
});

test('SRE Workbook reference values for a 30d period', () => {
  const periodHours = 30 * 24;
  // 2% of budget in 1h -> burn rate 14.4; 5% in 6h -> 6; 10% in 3d -> 1.
  assert.equal(burnRateFor({ budgetFraction: 0.02, periodHours, windowHours: 1 }), 14.4);
  assert.equal(burnRateFor({ budgetFraction: 0.05, periodHours, windowHours: 6 }), 6);
  assert.equal(burnRateFor({ budgetFraction: 0.1, periodHours, windowHours: 72 }), 1);
});

test('28d period values used by the SLO file', () => {
  const periodHours = 28 * 24;
  assert.equal(burnRateFor({ budgetFraction: 0.02, periodHours, windowHours: 1 }), 13.44);
  assert.equal(burnRateFor({ budgetFraction: 0.05, periodHours, windowHours: 6 }), 5.6);
});

test('error budget and thresholds', () => {
  assert.equal(errorBudget(0.995), 0.005);
  assert.equal(errorBudget(0.998), 0.002);
  assert.equal(errorBudget(0.95), 0.05);
  assert.equal(errorRateThreshold({ burnRate: 13.44, objective: 0.995 }), 0.0672);
  assert.equal(errorRateThreshold({ burnRate: 5.6, objective: 0.995 }), 0.028);
  assert.equal(errorRateThreshold({ burnRate: 13.44, objective: 0.998 }), 0.02688);
  assert.throws(() => errorBudget(1), RangeError);
  assert.throws(() => errorBudget(-0.1), RangeError);
});

test('burning at the alert rate for the whole long window consumes exactly the configured fraction', () => {
  const periodHours = 672;
  for (const t of TIERS) {
    const windowHours = windowToHours(t.long);
    const burnRate = burnRateFor({ budgetFraction: t.budgetFraction, periodHours, windowHours });
    assert.equal(budgetConsumed({ burnRate, periodHours, windowHours }), t.budgetFraction);
  }
});

test('time to exhaustion at the alert rates', () => {
  assert.equal(hoursToExhaustion({ burnRate: 13.44, periodHours: 672 }), 50);
  assert.equal(hoursToExhaustion({ burnRate: 5.6, periodHours: 672 }), 120);
  assert.equal(hoursToExhaustion({ burnRate: 1, periodHours: 672 }), 672);
  assert.throws(() => hoursToExhaustion({ burnRate: 0, periodHours: 672 }), RangeError);
});

test('maximum burn rate is 1 / budget', () => {
  assert.equal(maxBurnRate(0.995), 200);
  assert.equal(maxBurnRate(0.95), 20);
});

test('constant error rate simulation agrees with the closed form', () => {
  // Hourly simulation: error ratio e against budget b exhausts a 672h period after 672 * b / e hours.
  const objective = 0.995;
  const periodHours = 672;
  const e = 0.0672; // fast-tier threshold
  let consumed = 0;
  let hours = 0;
  while (consumed < 1) {
    consumed += e / errorBudget(objective) / periodHours;
    hours += 1;
  }
  assert.equal(hours, Math.ceil(hoursToExhaustion({ burnRate: e / 0.005, periodHours })));
});

test('resolveTiers rejects invalid windows and returns thresholds below 1 for the SLO set', () => {
  assert.throws(
    () =>
      resolveTiers({
        objective: 0.99,
        periodHours: 672,
        tiers: [{ name: 'fast', long: '5m', short: '1h', budgetFraction: 0.02, for: '2m' }],
      }),
    /must be shorter/,
  );
  for (const objective of [0.995, 0.998, 0.99, 0.95]) {
    for (const t of resolveTiers({ objective, periodHours: 672, tiers: TIERS })) {
      assert.ok(t.threshold < 1, `${objective} ${t.name}`);
    }
  }
});

test('multi-window rule: brief spike and recovered outage do not fire, sustained burn does', () => {
  const threshold = 0.0672;
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const minutes = (n, ratio) => Array.from({ length: n }, () => ratio);
  const fires = (series) => mean(series.slice(-60)) > threshold && mean(series.slice(-5)) > threshold;

  // 5 minutes at 50% errors: the 5m window is hot but the 1h mean is 0.0417, below threshold.
  assert.equal(fires([...minutes(55, 0), ...minutes(5, 0.5)]), false);
  // 30 minutes at 50% errors, recovered 10 minutes ago: 1h mean is high, 5m mean is 0.
  assert.equal(fires([...minutes(20, 0), ...minutes(30, 0.5), ...minutes(10, 0)]), false);
  // Sustained 10% errors for the whole hour: both windows above threshold.
  assert.equal(fires(minutes(60, 0.1)), true);
});
