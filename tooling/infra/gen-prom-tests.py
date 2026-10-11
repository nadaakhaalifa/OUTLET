#!/usr/bin/env python3
"""Generate promtool unit-test fixtures (infra/observability/prometheus/tests/*.test.yaml).

Synthetic traffic is 600 events/min (10/s). Phases are [(minutes, bad_fraction)].
Expected alert labels/annotations are read verbatim from the rule file; thresholds are
exercised behaviourally (fast burn above the fast threshold fires, slow burn between the
slow and fast thresholds fires only the slow alert, healthy fires nothing).
"""
import re, sys, pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]
RULES = ROOT / "infra/observability/prometheus/rules"
OUT = ROOT / "infra/observability/prometheus/tests"
RATE = 600  # events per minute

# kind ratio: bad/good series label sets; kind hist: bucket le + extra labels on count
SLOS = {
    "checkout-success": dict(kind="ratio", bad='outlet_checkout_attempts_total{outcome="failed"}',
                             good='outlet_checkout_attempts_total{outcome="placed"}', fast=0.0672, slow=0.028, nodata=True),
    "mobile-crash-free": dict(kind="ratio", bad='outlet_mobile_sessions_total{crashed="true"}',
                              good='outlet_mobile_sessions_total{crashed="false"}', fast=0.02688, slow=0.0112, nodata=False),
    "refund-initiation": dict(kind="ratio", bad='outlet_refund_sla_total{outcome="missed"}',
                              good='outlet_refund_sla_total{outcome="met"}', fast=0.1344, slow=0.056, nodata=False),
    "api-read-latency": dict(kind="hist", m="http_server_request_duration_seconds", le="0.3",
                             extra='http_request_method="GET"', fast=0.672, slow=0.28, nodata=True),
    "reserve-latency": dict(kind="hist", m="outlet_reserve_duration_seconds", le="0.15", extra="", fast=0.672, slow=0.28, nodata=False),
    "payment-confirmation-latency": dict(kind="hist", m="outlet_payment_confirmation_duration_seconds", le="5", extra="", fast=0.672, slow=0.28, nodata=False),
    "search-latency": dict(kind="hist", m="outlet_search_duration_seconds", le="0.15", extra="", fast=0.672, slow=0.28, nodata=True),
}

def parse_alerts(text):
    alerts, cur, sect = {}, None, None
    for line in text.splitlines():
        m = re.match(r"\s+- alert: (\S+)", line)
        if m:
            cur = alerts.setdefault(m.group(1), dict(labels={}, ann={}, for_=None)); sect = None; continue
        if cur is None: continue
        s = line.strip()
        if s == "labels:": sect = "labels"; continue
        if s == "annotations:": sect = "ann"; continue
        m = re.match(r"for: (\S+)", s)
        if m and sect is None: cur["for_"] = m.group(1); continue
        m = re.match(r"([a-z_]+): (.*)$", s)
        if m and sect:
            v = m.group(2).strip()
            if v.startswith('"') and v.endswith('"'): v = v[1:-1]
            cur["labels" if sect == "labels" else "ann"][m.group(1)] = v
    return alerts

def q(v):  # yaml scalar, always quoted
    return '"' + str(v).replace("\\", "\\\\").replace('"', '\\"') + '"'

def series_values(phases, bad_frac, good_side):
    """Counter values at 1m steps. Returns a promtool 'a+bxN ...' string (explicit segments)."""
    vals, cur = [0], 0
    for minutes, f in phases:
        inc = round(RATE * (f if bad_frac else 1 - f))
        for _ in range(minutes):
            cur += inc; vals.append(cur)
    # compress into runs of constant increment
    segs, i = [], 0
    while i < len(vals):
        if i + 1 >= len(vals): segs.append(f"{vals[i]}"); break
        d = vals[i + 1] - vals[i]; j = i + 1
        while j + 1 < len(vals) and vals[j + 1] - vals[j] == d: j += 1
        n = j - i
        segs.append(f"{vals[i]}+{d}x{n}"); i = j + 1
    return " ".join(segs)

def input_series(cfg, phases):
    out = []
    if cfg["kind"] == "ratio":
        out.append((cfg["bad"], series_values(phases, True, False)))
        out.append((cfg["good"], series_values(phases, False, True)))
    else:
        ex = (cfg["extra"] + ",") if cfg["extra"] else ""
        out.append((f'{cfg["m"]}_bucket{{{ex}le="{cfg["le"]}"}}', series_values(phases, False, True)))
        out.append((f'{cfg["m"]}_count{{{cfg["extra"]}}}' if cfg["extra"] else f'{cfg["m"]}_count',
                    series_values([(m, 0) for m, _ in phases], False, False) if False else
                    series_values([(m, 0.0) for m, _ in phases], False, True)))
    return out

def exp_block(a, name, indent):
    p = " " * indent
    lab = dict(a["labels"])
    s = f"{p}- exp_labels:\n{p}    alertname: {q(name)}\n" if False else ""
    s = f"{p}- exp_labels:\n"
    for k, v in lab.items(): s += f"{p}    {k}: {q(v)}\n"
    s += f"{p}  exp_annotations:\n"
    for k, v in a["ann"].items(): s += f"{p}    {k}: {q(v)}\n"
    return s

def gen(slo, cfg):
    fname = f"slo-{slo}.rules.yaml"
    alerts = parse_alerts((RULES / fname).read_text())
    fast = next(n for n in alerts if n.startswith("SLOFastBurn"))
    slow = next(n for n in alerts if n.startswith("SLOSlowBurn"))
    nodata = next((n for n in alerts if n.startswith("SLONoData")), None)
    hi = round(min(1.0, cfg["fast"] * 1.1), 5)   # just above the fast threshold
    lo = round(cfg["fast"] * 0.95, 5)           # just below the fast threshold, well above slow
    under = round(cfg["slow"] * 0.9, 5)         # just below the slow threshold
    tests = []

    def case(name, phases, checks, extra_recording=None):
        t = f"  - interval: 1m\n    input_series:\n"
        for sel, vals in input_series(cfg, phases):
            t += f"      - series: {q(sel)}\n        values: {q(vals)}\n"
        t += f"    # {name}\n"
        t += f"    alert_rule_test:\n"
        for at, an, exp in checks:
            t += f"      - eval_time: {at}\n        alertname: {an}\n"
            if exp is None: t += "        exp_alerts: []\n"
            else: t += "        exp_alerts:\n" + exp_block(alerts[an], an, 10)
        if extra_recording:
            t += "    promql_expr_test:\n" + extra_recording
        tests.append(t)

    # 1 fast burn: 3h healthy then 100% bad. 60m into the burn the 1h and 5m windows are > threshold.
    case("fast burn pages", [(180, 0.0), (65, hi)],
         [("170m", fast, None), ("245m", fast, exp_block_for(alerts, fast))])
    # 2 slow burn: ratio between the slow and fast thresholds for 7h => slow fires, fast never.
    case("slow burn fires slow only", [(420, lo)],
         [("420m", slow, exp_block_for(alerts, slow)), ("420m", fast, None), ("200m", fast, None)])
    case("just under the slow threshold fires nothing", [(480, under)],
         [("480m", fast, None), ("480m", slow, None)])
    # 3 healthy
    case("healthy fires nothing", [(480, 0.0)],
         [("480m", fast, None), ("480m", slow, None)])
    # 4 resolve: fast burn for 60m then recovery; 5m window clears so fast resolves
    case("fast burn resolves", [(180, 0.0), (60, hi), (60, 0.0)],
         [("238m", fast, exp_block_for(alerts, fast)), ("255m", fast, None)])
    # 5 slow resolves: 7h at lo then healthy; 30m window clears
    case("slow burn resolves", [(420, 1.0), (37, 0.0)],
         [("420m", slow, exp_block_for(alerts, slow)), ("457m", slow, None)])
    # 5b slow burn just above the slow threshold fires (catches an inflated slow threshold) and honours `for`
    just = round(cfg["slow"] * 1.1, 5)
    case("slow burn just above threshold", [(420, just)],
         [("10m", slow, None), ("25m", slow, exp_block_for(alerts, slow)), ("420m", slow, exp_block_for(alerts, slow)), ("420m", fast, None)])
    # 6 recording rules: steady 25% bad at 10 ev/s
    rec = ""
    for w in ("5m", "30m", "1h"):
        rec += (f"      - expr: slo:sli_error:ratio_rate{w}{{slo={q(slo)}}}\n        eval_time: 90m\n        exp_samples:\n"
                f"          - labels: 'slo:sli_error:ratio_rate{w}{{slo=\"{slo}\", journey=\"{alerts[fast]['labels']['journey']}\"}}'\n            value: 0.25\n"
                f"      - expr: slo:sli_events:rate{w}{{slo={q(slo)}}}\n        eval_time: 90m\n        exp_samples:\n"
                f"          - labels: 'slo:sli_events:rate{w}{{slo=\"{slo}\", journey=\"{alerts[fast]['labels']['journey']}\"}}'\n            value: 10\n")
    case("recording rules compute the ratio", [(90, 0.25)], [], rec)
    if nodata:
        case("no data fires the absent alert", [(1, 0.0)] , [])  # placeholder replaced below
        tests.pop()
        t = ("  - interval: 1m\n    input_series: []\n    # no series at all\n    alert_rule_test:\n"
             f"      - eval_time: 2m\n        alertname: {nodata}\n        exp_alerts: []\n"
             f"      - eval_time: 80m\n        alertname: {nodata}\n        exp_alerts:\n"
             + exp_block({"labels": {**alerts[nodata]["labels"]}, "ann": alerts[nodata]["ann"]}, nodata, 10))
        tests.append(t)
    head = (f"# Generated by tooling/infra/gen-prom-tests.py. Synthetic series, 600 events/min.\n"
            f"# Run: promtool test rules infra/observability/prometheus/tests/{slo}.test.yaml\n"
            f"rule_files:\n  - ../rules/{fname}\n\nevaluation_interval: 30s\n\ntests:\n")
    (OUT / f"{slo}.test.yaml").write_text(head + "\n".join(tests))

def exp_block_for(alerts, name): return exp_block(alerts[name], name, 10)

def gen_recon():
    fname = "slo-reconciliation-unmatched.rules.yaml"
    alerts = parse_alerts((RULES / fname).read_text())
    a5, a24 = "SLOZeroBreachReconciliationUnmatchedAfter5m", "SLOZeroBreachReconciliationUnmatchedAfter24h"
    sel = q('outlet_reconciliation_unmatched_lines{age_bucket="gt_3d"}')
    def case(vals, checks, comment):
        t = f"  - interval: 1m\n    # {comment}\n    input_series:\n      - series: {sel}\n        values: {q(vals)}\n    alert_rule_test:\n"
        for at, an, fire in checks:
            t += f"      - eval_time: {at}\n        alertname: {an}\n"
            t += ("        exp_alerts:\n" + exp_block(alerts[an], an, 10)) if fire else "        exp_alerts: []\n"
        return t
    tests = [
        case("0+0x1500", [("1400m", a5, False), ("1400m", a24, False)], "healthy: zero unmatched lines"),
        case("0+0x10 3+0x1700", [("10m", a5, False), ("20m", a5, True), ("1440m", a24, False), ("1470m", a24, True), ("1560m", a24, True)], "non-zero from t=11m: ticket after 5m, page after 24h"),
        case("0+0x10 2+0x20 0+0x60", [("30m", a5, True), ("60m", a5, False)], "resolves when the count returns to zero"),
    ]
    (OUT / "reconciliation-unmatched.test.yaml").write_text(
        f"# Generated by tooling/infra/gen-prom-tests.py.\nrule_files:\n  - ../rules/{fname}\n\nevaluation_interval: 30s\n\ntests:\n" + "\n".join(tests))

OUT.mkdir(parents=True, exist_ok=True)
for s, c in SLOS.items(): gen(s, c)
gen_recon()
