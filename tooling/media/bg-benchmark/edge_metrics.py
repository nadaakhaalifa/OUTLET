"""Optional edge metrics (needs numpy, scipy and Pillow; bench.py works without them, minus these columns).

All three are reference-free so they run on real photos too:
  halo_dist      mean RGB distance between boundary-ring colours of the cutout and the median interior colour
                 (lower = less old-background halo)
  edge_jaggies   boundary length divided by the length of the same mask after a 5 px Gaussian smoothing
                 (1.0 = smooth; higher = ragged/noisy outline)
  specks         connected components smaller than 1% of the largest (floating debris)
"""

from __future__ import annotations

import io
from typing import Any

try:
    import numpy as np
    from PIL import Image
    from scipy import ndimage

    HAVE = True
except ImportError:  # pragma: no cover
    HAVE = False


def _perimeter(m: Any) -> float:
    gy = np.abs(np.diff(m.astype(np.int8), axis=0)).sum()
    gx = np.abs(np.diff(m.astype(np.int8), axis=1)).sum()
    return float(gx + gy)


def compute(png: bytes) -> dict[str, float]:
    if not HAVE:
        return {}
    rgba = np.asarray(Image.open(io.BytesIO(png)).convert("RGBA"))
    a = rgba[..., 3].astype(np.float32) / 255.0
    core = a > 0.5
    if not core.any():
        return {"halo_dist": 0.0, "edge_jaggies": 1.0, "specks": 0.0}
    interior = ndimage.binary_erosion(core, iterations=4)
    ring = ndimage.binary_dilation(core, iterations=1) & ~ndimage.binary_erosion(core, iterations=2) & (a > 0.05)
    rgb = rgba[..., :3].astype(np.float32)
    ref = np.median(rgb[interior], axis=0) if interior.any() else np.median(rgb[core], axis=0)
    halo = float(np.linalg.norm(rgb[ring] - ref, axis=1).mean()) if ring.any() else 0.0
    sm = ndimage.gaussian_filter(core.astype(np.float32), 5.0) > 0.5
    jag = _perimeter(core) / max(1.0, _perimeter(sm))
    labels, n = ndimage.label(core)
    sizes = np.asarray(ndimage.sum(core, labels, index=np.arange(1, n + 1)))
    specks = float((sizes < 0.01 * sizes.max()).sum()) if n else 0.0
    return {"halo_dist": round(halo, 2), "edge_jaggies": round(jag, 3), "specks": specks}
