"""Quality score 0-100 for a cutout, a line-for-line port of apps/api/src/modules/product-media/domain/quality.ts.

Parity is enforced by fixtures/quality-cases.json, which is asserted by both the TypeScript unit test and
`python bench.py --selftest`. Change both implementations and the fixture together.
"""

from __future__ import annotations

from typing import Any

READY_THRESHOLD = 70


def _clamp(n: float, lo: float, hi: float) -> float:
    return min(hi, max(lo, n))


def _finite(n: float) -> float:
    return n if n == n and n not in (float("inf"), float("-inf")) else 0.0


def assess(stats: dict[str, Any]) -> tuple[int, list[str], float]:
    coverage = _clamp(_finite(stats["coverage"]), 0, 1)
    border = _clamp(_finite(stats["border_touch"]), 0, 1)
    holes = _clamp(_finite(stats["hole_ratio"]), 0, 1)
    soft = _clamp(_finite(stats["soft_edge_ratio"]), 0, 1)
    white = _clamp(_finite(stats["subject_bright_ratio"]), 0, 1) * _clamp(_finite(stats["border_bright_ratio"]), 0, 1)
    reasons: list[str] = []
    score = 100.0
    if coverage < 0.005:
        return 0, ["no_subject_detected"], white
    if coverage < 0.05:
        score -= 50
        reasons.append("subject_too_small")
    elif coverage < 0.15:
        score -= 20
        reasons.append("subject_small")
    elif coverage > 0.95:
        score -= 30
        reasons.append("subject_fills_frame")
    if border > 0.15:
        score -= 35
        reasons.append("subject_cut_by_frame")
    elif border > 0.02:
        score -= 20
        reasons.append("subject_touches_border")
    if stats["components"] > 1:
        score -= min(30, 10 * (stats["components"] - 1))
        reasons.append("multiple_components")
    if holes > 0.1:
        score -= 30
        reasons.append("mask_holes")
    elif holes > 0.03:
        score -= 15
        reasons.append("mask_small_holes")
    if soft > 0.2:
        score -= 25
        reasons.append("soft_edges")
    elif soft > 0.08:
        score -= 10
        reasons.append("slightly_soft_edges")
    if white > 0.5:
        score -= 25
        reasons.append("white_on_white_risk")
    elif white > 0.25:
        score -= 10
        reasons.append("low_contrast_backdrop")
    return int(_clamp(round(score), 0, 100)), reasons, white


def is_ready(score: int, reasons: list[str]) -> bool:
    return score >= READY_THRESHOLD and "no_subject_detected" not in reasons
