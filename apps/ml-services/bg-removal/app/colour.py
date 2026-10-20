"""Colour-accuracy primitives for the studio quality gate (spec section 8).

CIEDE2000 and SSIM are implemented in numpy (public formulae, no extra dependency or licence).
Thresholds are PLACEHOLDERS: VERIFY BEFORE LAUNCH VR-STUDIO-05 (real-photo calibration).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
from numpy.typing import NDArray
from scipy import ndimage

F64 = NDArray[np.float64]
U8 = NDArray[np.uint8]
Image2D = NDArray[Any]

# VERIFY VR-STUDIO-05: placeholder thresholds, hard gates.
DELTA_E_RENDER_MEDIAN_MAX = 1.0
DELTA_E_RENDER_P95_MAX = 3.0
DELTA_E_VARIANT_MEDIAN_MAX = 2.0
DELTA_E_VARIANT_P95_MAX = 6.0
DELTA_E_CUTOUT_VS_ORIGINAL_MEDIAN_MAX = 1.0
STRUCTURE_SSIM_MIN = 0.97
MAX_SAMPLES = 50_000

_WHITE_D65 = np.array([0.95047, 1.0, 1.08883])
_M = np.array(
    [[0.4124564, 0.3575761, 0.1804375], [0.2126729, 0.7151522, 0.0721750], [0.0193339, 0.1191920, 0.9503041]]
)


def srgb_to_lab(rgb: U8) -> F64:
    """sRGB uint8 (..., 3) -> CIELAB D65."""
    c = rgb.astype(np.float64) / 255.0
    lin = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    xyz = (lin @ _M.T) / _WHITE_D65
    d = 6.0 / 29.0
    f = np.where(xyz > d**3, np.cbrt(xyz), xyz / (3 * d * d) + 4.0 / 29.0)
    return np.stack(
        [116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], axis=-1
    )


def ciede2000(lab1: F64, lab2: F64) -> F64:
    """CIEDE2000 (Sharma, Wu, Dalal 2005) with kL=kC=kH=1; arrays (..., 3)."""
    l1, a1, b1 = lab1[..., 0], lab1[..., 1], lab1[..., 2]
    l2, a2, b2 = lab2[..., 0], lab2[..., 1], lab2[..., 2]
    c1, c2 = np.hypot(a1, b1), np.hypot(a2, b2)
    cbar7 = ((c1 + c2) / 2) ** 7
    g = 0.5 * (1 - np.sqrt(cbar7 / (cbar7 + 25.0**7)))
    a1p, a2p = (1 + g) * a1, (1 + g) * a2
    c1p, c2p = np.hypot(a1p, b1), np.hypot(a2p, b2)
    h1p = np.degrees(np.arctan2(b1, a1p)) % 360
    h2p = np.degrees(np.arctan2(b2, a2p)) % 360
    dl = l2 - l1
    dc = c2p - c1p
    dh = h2p - h1p
    dh = np.where(dh > 180, dh - 360, np.where(dh < -180, dh + 360, dh))
    dh = np.where(c1p * c2p == 0, 0.0, dh)
    dhh = 2 * np.sqrt(c1p * c2p) * np.sin(np.radians(dh) / 2)
    lbar, cbar = (l1 + l2) / 2, (c1p + c2p) / 2
    hsum = h1p + h2p
    hbar = np.where(
        c1p * c2p == 0,
        hsum,
        np.where(
            np.abs(h1p - h2p) <= 180, hsum / 2, np.where(hsum < 360, (hsum + 360) / 2, (hsum - 360) / 2)
        ),
    )
    t = (
        1
        - 0.17 * np.cos(np.radians(hbar - 30))
        + 0.24 * np.cos(np.radians(2 * hbar))
        + 0.32 * np.cos(np.radians(3 * hbar + 6))
        - 0.20 * np.cos(np.radians(4 * hbar - 63))
    )
    dtheta = 30 * np.exp(-(((hbar - 275) / 25) ** 2))
    rc = 2 * np.sqrt(cbar**7 / (cbar**7 + 25.0**7))
    sl = 1 + 0.015 * (lbar - 50) ** 2 / np.sqrt(20 + (lbar - 50) ** 2)
    sc = 1 + 0.045 * cbar
    sh = 1 + 0.015 * cbar * t
    rt = -np.sin(np.radians(2 * dtheta)) * rc
    out = np.sqrt((dl / sl) ** 2 + (dc / sc) ** 2 + (dhh / sh) ** 2 + rt * (dc / sc) * (dhh / sh))
    return np.asarray(out, dtype=np.float64)


@dataclass(frozen=True)
class DeltaEStats:
    median: float
    p95: float
    samples: int


def sample_mask(
    mask: NDArray[np.bool_], erode_px: int = 3, max_samples: int = MAX_SAMPLES
) -> NDArray[np.bool_]:
    """Garment interior: eroded mask, then a deterministic regular-stride subsample (no RNG)."""
    inner = ndimage.binary_erosion(mask, iterations=erode_px) if erode_px > 0 else mask
    idx = np.flatnonzero(inner)
    if idx.size > max_samples:
        idx = idx[np.linspace(0, idx.size - 1, max_samples).astype(np.int64)]
    out = np.zeros(mask.size, dtype=bool)
    out[idx] = True
    return out.reshape(mask.shape)


def delta_e_stats(a: U8, b: U8, mask: NDArray[np.bool_]) -> DeltaEStats:
    """Median and p95 CIEDE2000 between two same-size RGB images over a (sampled) mask."""
    if a.shape != b.shape or a.ndim != 3 or a.shape[2] != 3:
        raise ValueError("images must share an (H, W, 3) shape")
    if mask.shape != a.shape[:2]:
        raise ValueError("mask shape mismatch")
    sel = sample_mask(mask, erode_px=0)
    n = int(sel.sum())
    if n == 0:
        raise ValueError("empty comparison mask")
    de = ciede2000(srgb_to_lab(a[sel]), srgb_to_lab(b[sel]))
    return DeltaEStats(float(np.median(de)), float(np.percentile(de, 95)), n)


def luminance(rgb: U8) -> F64:
    return np.asarray(rgb.astype(np.float64) @ np.array([0.299, 0.587, 0.114]), dtype=np.float64)


def ssim(a: U8, b: U8, mask: NDArray[np.bool_] | None = None) -> float:
    """Mean SSIM on luminance (gaussian window sigma 1.5, K1=0.01, K2=0.03), optionally over a mask."""
    if a.shape != b.shape:
        raise ValueError("images must share a shape")
    x, y = luminance(a), luminance(b)
    c1, c2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2

    def g(v: F64) -> F64:
        return np.asarray(ndimage.gaussian_filter(v, 1.5, truncate=3.5, mode="reflect"), dtype=np.float64)

    mx, my = g(x), g(y)
    sxx, syy, sxy = g(x * x) - mx * mx, g(y * y) - my * my, g(x * y) - mx * my
    m = ((2 * mx * my + c1) * (2 * sxy + c2)) / ((mx * mx + my * my + c1) * (sxx + syy + c2))
    if mask is None:
        return float(m.mean())
    if mask.shape != m.shape or not mask.any():
        raise ValueError("invalid ssim mask")
    return float(m[mask].mean())


def render_passes(s: DeltaEStats) -> bool:
    return s.median <= DELTA_E_RENDER_MEDIAN_MAX and s.p95 <= DELTA_E_RENDER_P95_MAX


def variant_passes(s: DeltaEStats) -> bool:
    return s.median <= DELTA_E_VARIANT_MEDIAN_MAX and s.p95 <= DELTA_E_VARIANT_P95_MAX


def cutout_vs_original_passes(s: DeltaEStats) -> bool:
    return s.median <= DELTA_E_CUTOUT_VS_ORIGINAL_MEDIAN_MAX


def structure_passes(value: float) -> bool:
    return value >= STRUCTURE_SSIM_MIN
