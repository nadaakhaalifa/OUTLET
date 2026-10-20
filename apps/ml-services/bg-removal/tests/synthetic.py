"""Synthetic garment fixtures: a navy shirt on white with a neck opening, buttons holes, specks and a halo."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray
from scipy import ndimage

SHIRT_RGB = (20, 30, 90)
W, H = 400, 500


@dataclass(frozen=True)
class Shirt:
    rgb: NDArray[np.uint8]
    true_alpha: NDArray[np.float32]
    raw_alpha: NDArray[np.float32]  # what a mediocre model would return
    neck: tuple[int, int, int, int]  # y0, y1, x0, x1 of the neck opening (a real hole to keep)
    button: tuple[int, int]  # centre of a small hole that should be filled
    speck: tuple[int, int]


def make_shirt() -> Shirt:
    yy, xx = np.mgrid[0:H, 0:W]
    body = (yy > 120) & (yy < 440) & (xx > 110) & (xx < 290)
    sleeves = (yy > 120) & (yy < 230) & (xx > 40) & (xx < 360)
    shirt = body | sleeves
    neck = (yy - 125) ** 2 / 40.0**2 + (
        xx - 200
    ) ** 2 / 45.0**2 < 1.0  # open at the top edge -> enclosed below
    # Enclosed neck hole (ghost-mannequin interior): moved down so it does not touch the border.
    neck = (yy - 160) ** 2 / 28.0**2 + (xx - 200) ** 2 / 40.0**2 < 1.0
    button = (320, 200)
    btn = (yy - button[0]) ** 2 + (xx - button[1]) ** 2 < 5**2
    true = (shirt & ~neck & ~btn).astype(np.float32)
    soft = ndimage.gaussian_filter(true, 1.0).astype(np.float32)
    rgb_f = np.empty((H, W, 3), dtype=np.float32)
    for c in range(3):
        rgb_f[..., c] = soft * SHIRT_RGB[c] + (1.0 - soft) * 255.0
    rgb = np.rint(rgb_f).astype(np.uint8)
    # Mediocre model: blurry, 2 px too generous, plus noise-ish specks far from the subject.
    raw = ndimage.gaussian_filter(ndimage.binary_dilation(true > 0.5, iterations=2).astype(np.float32), 2.0)
    raw = raw.astype(np.float32)
    speck = (30, 30)
    raw[28:33, 28:33] = 1.0
    return Shirt(
        rgb=rgb, true_alpha=true, raw_alpha=raw, neck=(135, 185, 160, 240), button=button, speck=speck
    )


def edge_colour_distance(rgb: NDArray[np.uint8], alpha: NDArray[np.float32]) -> float:
    """Mean RGB distance to the garment colour over the visible pixels that lie on the matte boundary."""
    core = alpha > 0.5
    ring = (
        ndimage.binary_dilation(core, iterations=2)
        & ~ndimage.binary_erosion(core, iterations=2)
        & (alpha > 0.05)
    )
    ref = np.array(SHIRT_RGB, dtype=np.float32)
    return float(np.linalg.norm(rgb[ring].astype(np.float32) - ref, axis=1).mean())
