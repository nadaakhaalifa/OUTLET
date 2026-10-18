from __future__ import annotations

import io

import numpy as np
from PIL import Image

from app.processing import (
    clean_alpha,
    crop_box,
    decontaminate,
    derive,
    mask_stats,
    subject_bbox,
    white_background,
)


def rect_alpha(h: int = 100, w: int = 80, y0: int = 20, y1: int = 80, x0: int = 20, x1: int = 60) -> np.ndarray:
    a = np.zeros((h, w), dtype=np.float32)
    a[y0:y1, x0:x1] = 1.0
    return a


def test_clean_alpha_removes_specks_and_keeps_interior() -> None:
    a = rect_alpha()
    a[2, 2] = 1.0  # isolated speck
    out = clean_alpha(a, feather_px=1.5)
    assert out[2, 2] == 0.0
    assert out[50, 40] == 1.0


def test_feather_touches_only_a_thin_band() -> None:
    a = rect_alpha()
    out = clean_alpha(a, feather_px=1.5)
    changed = np.abs(out - a) > 1e-6
    ys, xs = np.nonzero(changed)
    assert ys.size > 0
    # Every changed pixel is within 3 px of the original edge.
    assert ys.min() >= 17 and ys.max() <= 82 and xs.min() >= 17 and xs.max() <= 62
    assert out.min() >= 0.0 and out.max() <= 1.0


def test_zero_feather_is_identity_apart_from_specks() -> None:
    a = rect_alpha()
    assert np.array_equal(clean_alpha(a, feather_px=0), a)


def test_decontaminate_replaces_edge_colour_with_interior_colour() -> None:
    rgb = np.full((100, 80, 3), 255, dtype=np.uint8)  # white backdrop
    rgb[20:80, 20:60] = (10, 10, 120)  # dark blue garment
    alpha = clean_alpha(rect_alpha(), feather_px=1.5)
    # Simulate a halo: edge pixels carry the white backdrop colour.
    edge = (alpha > 0) & (alpha < 0.98)
    rgb[edge] = (255, 255, 255)
    out = decontaminate(rgb, alpha)
    assert (out[edge] == (10, 10, 120)).all()


def test_bbox_and_crop_padding_clamped() -> None:
    a = rect_alpha()
    assert subject_bbox(a) == (20, 20, 60, 80)
    assert crop_box((20, 20, 60, 80), 80, 100, 0.1) == (14, 14, 66, 86)
    assert crop_box((0, 0, 80, 100), 80, 100, 0.5) == (0, 0, 80, 100)
    assert subject_bbox(np.zeros((5, 5), dtype=np.float32)) is None


def test_stats_clean_rectangle() -> None:
    rgb = np.full((100, 80, 3), 120, dtype=np.uint8)
    s = mask_stats(rgb, rect_alpha())
    assert abs(s.coverage - 0.3) < 1e-6
    assert s.border_touch == 0.0
    assert s.components == 1
    assert s.hole_ratio == 0.0
    assert s.soft_edge_ratio == 0.0


def test_stats_detect_border_holes_components_and_white_on_white() -> None:
    rgb = np.full((100, 80, 3), 255, dtype=np.uint8)
    a = rect_alpha(y0=0)  # touches the top border
    a[40:50, 30:40] = 0.0  # hole
    a[85:95, 5:15] = 1.0  # second component
    s = mask_stats(rgb, a)
    assert s.border_touch > 0.0
    assert s.hole_ratio > 0.0
    assert s.components == 2
    assert s.subject_bright_ratio > 0.9 and s.border_bright_ratio > 0.9


def test_stats_empty_mask() -> None:
    s = mask_stats(np.zeros((10, 10, 3), dtype=np.uint8), np.zeros((10, 10), dtype=np.float32))
    assert s.coverage == 0.0 and s.components == 0


def test_white_background_downsizes_but_never_upsizes() -> None:
    big = Image.new("RGBA", (3000, 2000), (0, 0, 0, 0))
    out = white_background(big, 1600)
    assert max(out.size) == 1600 and out.getpixel((0, 0)) == (255, 255, 255)
    small = Image.new("RGBA", (300, 200), (0, 0, 0, 0))
    assert white_background(small, 1600).size == (300, 200)


def test_derive_outputs_are_valid_cropped_and_metadata_free() -> None:
    rgb = np.full((100, 80, 3), 90, dtype=np.uint8)
    d = derive(rgb, rect_alpha(), feather_px=1.5, padding_ratio=0.1, white_max_side=1600, shadow=True)
    png = Image.open(io.BytesIO(d.png))
    assert png.mode == "RGBA" and png.size[0] < 80 and png.size[1] < 100
    assert Image.open(io.BytesIO(d.white_jpg)).format == "JPEG"
    assert Image.open(io.BytesIO(d.mask)).mode == "L"
    assert d.shadow_png is not None and Image.open(io.BytesIO(d.shadow_png)).size[1] > png.size[1]
    assert not png.info.get("exif")
    none = derive(rgb, rect_alpha(), feather_px=1.5, padding_ratio=0.1, white_max_side=1600, shadow=False)
    assert none.shadow_png is None
