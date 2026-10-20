"""Pure image maths: edge cleanup, colour decontamination, crop, derivatives and mask statistics.

Everything here works on numpy arrays and has no model or network dependency, so it is unit-tested with
synthetic masks. Alpha is float32 in 0..1, RGB is uint8.
"""

from __future__ import annotations

import io
from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray
from PIL import Image, ImageDraw
from scipy import ndimage

F32 = NDArray[np.float32]
U8 = NDArray[np.uint8]
Bool = NDArray[np.bool_]

NEAR_WHITE_MIN = 235
NEAR_WHITE_CHROMA = 14


@dataclass(frozen=True)
class MaskStats:
    width: int
    height: int
    coverage: float
    border_touch: float
    components: int
    hole_ratio: float
    soft_edge_ratio: float
    subject_bright_ratio: float
    border_bright_ratio: float


def clean_alpha(alpha: F32, feather_px: float, speck_ratio: float = 0.0005) -> F32:
    """Removes isolated specks and feathers only the boundary band (1-2 px), leaving the interior untouched."""
    a = np.clip(alpha, 0.0, 1.0).astype(np.float32)
    binary: Bool = a > 0.5
    if not binary.any():
        return a
    labels, n = ndimage.label(binary)
    if n > 1:
        sizes = ndimage.sum(binary, labels, index=np.arange(1, n + 1))
        min_px = max(4.0, speck_ratio * a.size)
        for idx, size in enumerate(np.asarray(sizes), start=1):
            if size < min_px:
                a[labels == idx] = 0.0
        binary = a > 0.5
    if feather_px <= 0:
        return a
    band_r = max(1, int(round(feather_px)) + 1)
    outer = ndimage.binary_dilation(binary, iterations=band_r)
    inner = ndimage.binary_erosion(binary, iterations=band_r)
    band = outer & ~inner
    sigma = max(0.3, feather_px / 2.0)
    # Pull the boundary in by one pixel first: it removes the light halo the model leaves around dark garments.
    shrunk = ndimage.grey_erosion(a, size=(3, 3))
    smooth = ndimage.gaussian_filter(shrunk, sigma=sigma).astype(np.float32)
    out = np.where(band, smooth, a).astype(np.float32)
    return np.clip(out, 0.0, 1.0)


def decontaminate(rgb: U8, alpha: F32) -> U8:
    """Replaces the colour of partially transparent edge pixels with the nearest solid interior colour.

    Removes the background colour that bleeds into soft edges (a white halo on a dark shirt, a green fringe).
    """
    solid: Bool = alpha >= 0.98
    if not solid.any():
        return rgb
    edge: Bool = (alpha > 0.0) & (alpha < 0.98)
    if not edge.any():
        return rgb
    _, (iy, ix) = ndimage.distance_transform_edt(~solid, return_indices=True)
    out = rgb.copy()
    out[edge] = rgb[iy[edge], ix[edge]]
    return out


def subject_bbox(alpha: F32, threshold: float = 0.05) -> tuple[int, int, int, int] | None:
    ys, xs = np.nonzero(alpha > threshold)
    if ys.size == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def crop_box(
    bbox: tuple[int, int, int, int], width: int, height: int, padding_ratio: float
) -> tuple[int, int, int, int]:
    x0, y0, x1, y1 = bbox
    pad = int(round(max(x1 - x0, y1 - y0) * max(0.0, padding_ratio)))
    return max(0, x0 - pad), max(0, y0 - pad), min(width, x1 + pad), min(height, y1 + pad)


def mask_stats(rgb: U8, raw_alpha: F32) -> MaskStats:
    """Statistics of the model's raw alpha (before feathering) for the quality score."""
    h, w = raw_alpha.shape
    fg: Bool = raw_alpha > 0.5
    fg_px = int(fg.sum())
    total = h * w
    if fg_px == 0:
        return MaskStats(w, h, 0.0, 0.0, 0, 0.0, 0.0, 0.0, 0.0)
    ring = np.zeros((h, w), dtype=bool)
    ring[0, :] = ring[-1, :] = True
    ring[:, 0] = ring[:, -1] = True
    border_touch = float(fg[ring].mean())
    labels, n = ndimage.label(fg)
    sizes = np.asarray(ndimage.sum(fg, labels, index=np.arange(1, n + 1)))
    components = int((sizes >= 0.005 * fg_px).sum())
    filled = ndimage.binary_fill_holes(fg)
    hole_ratio = float((filled & ~fg).sum()) / fg_px
    soft = (raw_alpha > 0.1) & (raw_alpha < 0.9)
    soft_ratio = float(soft.sum()) / max(1, int((raw_alpha > 0.1).sum()))
    mx = rgb.max(axis=2).astype(np.int16)
    mn = rgb.min(axis=2).astype(np.int16)
    white = (mn >= NEAR_WHITE_MIN) & ((mx - mn) <= NEAR_WHITE_CHROMA)
    subject_bright = float(white[fg].mean())
    near_bg = ~ndimage.binary_dilation(fg, iterations=max(3, int(0.01 * max(h, w))))
    border_bright = float(white[near_bg].mean()) if near_bg.any() else 0.0
    return MaskStats(
        width=w,
        height=h,
        coverage=fg_px / total,
        border_touch=border_touch,
        components=components,
        hole_ratio=min(1.0, hole_ratio),
        soft_edge_ratio=min(1.0, soft_ratio),
        subject_bright_ratio=subject_bright,
        border_bright_ratio=border_bright,
    )


def compose_rgba(rgb: U8, alpha: F32) -> Image.Image:
    a8 = np.rint(np.clip(alpha, 0.0, 1.0) * 255.0).astype(np.uint8)
    return Image.fromarray(np.dstack([rgb, a8]), mode="RGBA")


def white_background(rgba: Image.Image, max_side: int) -> Image.Image:
    """Composites on pure white and downsizes (never upsizes) so the longest side is at most `max_side`."""
    canvas = Image.new("RGB", rgba.size, (255, 255, 255))
    canvas.paste(rgba, mask=rgba.getchannel("A"))
    longest = max(canvas.size)
    if longest > max_side:
        scale = max_side / longest
        canvas = canvas.resize(
            (max(1, round(canvas.width * scale)), max(1, round(canvas.height * scale))),
            Image.Resampling.LANCZOS,
        )
    return canvas


def with_ground_shadow(rgba: Image.Image) -> Image.Image:
    """Transparent PNG with a soft elliptical contact shadow under the subject (opacity <= 0.28)."""
    w, h = rgba.size
    extra = max(4, int(h * 0.08))
    out = Image.new("RGBA", (w, h + extra), (0, 0, 0, 0))
    yy, xx = np.mgrid[0 : h + extra, 0:w]
    cx, cy = w / 2.0, h + extra * 0.35
    rx, ry = max(2.0, w * 0.40), max(2.0, extra * 0.45)
    d = ((xx - cx) / rx) ** 2 + ((yy - cy) / ry) ** 2
    shadow = np.clip(1.0 - d, 0.0, 1.0) ** 1.5 * 0.28
    shadow = ndimage.gaussian_filter(shadow, sigma=max(1.0, extra * 0.15)).astype(np.float32)
    layer = np.zeros((h + extra, w, 4), dtype=np.uint8)
    layer[..., 3] = np.rint(shadow * 255).astype(np.uint8)
    out = Image.alpha_composite(out, Image.fromarray(layer, mode="RGBA"))
    out.alpha_composite(rgba, dest=(0, 0))
    return out


def encode_png(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=False, compress_level=6)
    return buf.getvalue()


def encode_jpeg(img: Image.Image, quality: int = 92) -> bytes:
    buf = io.BytesIO()
    img.convert("RGB").save(
        buf, format="JPEG", quality=quality, optimize=True, progressive=True, subsampling=0
    )
    return buf.getvalue()


# --------------------------------------------------------------------------------------------------------
# Matte refinement: guided filter, hole fill, speck removal, sigmoid, edge shift, despill, user strokes.
# --------------------------------------------------------------------------------------------------------

DEFAULT_SMOOTH = 0.5
DEFAULT_HOLE_RATIO = 0.005
DEFAULT_SPECK_KEEP = 0.01


@dataclass(frozen=True)
class Stroke:
    """A brush stroke in pixel space. `radius_px` is the brush radius."""

    mode: str  # "erase" | "restore"
    radius_px: float
    points: tuple[tuple[float, float], ...]


def _box(x: F32, r: int) -> F32:
    """Mean over a (2r+1)^2 window (edge-replicated), via separable uniform filters."""
    size = 2 * r + 1
    return np.asarray(
        ndimage.uniform_filter(x, size=(size, size) + (1,) * (x.ndim - 2), mode="nearest"), dtype=np.float32
    )


def guided_filter(guide_rgb: F32, p: F32, radius: int, eps: float, subsample: int = 1) -> F32:
    """Colour guided filter (He et al.) with the fast variant: coefficients solved at 1/subsample resolution.

    guide_rgb is HxWx3 float32 in 0..1, p is HxW float32. Returns HxW float32 (unclipped).
    """
    h, w = p.shape
    s = max(1, subsample)
    if s > 1:
        gi = np.asarray(ndimage.zoom(guide_rgb, (1 / s, 1 / s, 1), order=1), dtype=np.float32)
        pi = np.asarray(ndimage.zoom(p, (1 / s, 1 / s), order=1), dtype=np.float32)
    else:
        gi, pi = guide_rgb, p
    r = max(1, int(round(radius / s)))
    mean_i = _box(gi, r)  # HxWx3
    mean_p = _box(pi, r)
    mean_ip = _box(gi * pi[..., None], r)
    cov_ip = mean_ip - mean_i * mean_p[..., None]

    # Covariance of the guide (symmetric 3x3): rr rg rb gg gb bb.
    def corr(a: int, b: int) -> F32:
        return _box(gi[..., a] * gi[..., b], r) - mean_i[..., a] * mean_i[..., b]

    rr, rg, rb = corr(0, 0) + eps, corr(0, 1), corr(0, 2)
    gg, gb, bb = corr(1, 1) + eps, corr(1, 2), corr(2, 2) + eps
    c00 = gg * bb - gb * gb
    c01 = rb * gb - rg * bb
    c02 = rg * gb - rb * gg
    c11 = rr * bb - rb * rb
    c12 = rg * rb - rr * gb
    c22 = rr * gg - rg * rg
    det = rr * c00 + rg * c01 + rb * c02
    det = np.where(np.abs(det) < 1e-12, 1e-12, det).astype(np.float32)
    ip0, ip1, ip2 = cov_ip[..., 0], cov_ip[..., 1], cov_ip[..., 2]
    a0 = (c00 * ip0 + c01 * ip1 + c02 * ip2) / det
    a1 = (c01 * ip0 + c11 * ip1 + c12 * ip2) / det
    a2 = (c02 * ip0 + c12 * ip1 + c22 * ip2) / det
    b = mean_p - a0 * mean_i[..., 0] - a1 * mean_i[..., 1] - a2 * mean_i[..., 2]
    ma = _box(np.stack([a0, a1, a2], axis=-1).astype(np.float32), r)
    mb = _box(b.astype(np.float32), r)
    if s > 1:
        ma = np.asarray(ndimage.zoom(ma, (h / ma.shape[0], w / ma.shape[1], 1), order=1), dtype=np.float32)
        mb = np.asarray(ndimage.zoom(mb, (h / mb.shape[0], w / mb.shape[1]), order=1), dtype=np.float32)
        ma, mb = ma[:h, :w], mb[:h, :w]
    q = (ma * guide_rgb).sum(axis=-1) + mb
    return np.asarray(q, dtype=np.float32)


def remove_specks(alpha: F32, keep_ratio: float = DEFAULT_SPECK_KEEP) -> F32:
    """Drops connected components smaller than keep_ratio of the largest one (alpha > 0.5)."""
    core: Bool = alpha > 0.5
    labels, n = ndimage.label(core)
    if n <= 1:
        return alpha
    sizes = np.asarray(ndimage.sum(core, labels, index=np.arange(1, n + 1)), dtype=np.float64)
    drop_ids = np.nonzero(sizes < keep_ratio * sizes.max())[0] + 1
    if drop_ids.size == 0:
        return alpha
    drop = np.isin(labels, drop_ids)
    drop = ndimage.binary_dilation(drop, iterations=2)
    out = alpha.copy()
    # Dilation must not eat the main subject: only clear pixels not connected to a kept component.
    keep = ndimage.binary_dilation(
        np.isin(labels, np.nonzero(sizes >= keep_ratio * sizes.max())[0] + 1), iterations=1
    )
    out[drop & ~keep] = 0.0
    return out


def fill_small_holes(alpha: F32, max_ratio: float = DEFAULT_HOLE_RATIO) -> F32:
    """Fills enclosed holes below max_ratio of the subject area. Large holes (neck, arm gap) stay."""
    core: Bool = alpha > 0.5
    subject = int(core.sum())
    if subject == 0:
        return alpha
    holes = ndimage.binary_fill_holes(core) & ~core
    if not holes.any():
        return alpha
    labels, n = ndimage.label(holes)
    sizes = np.asarray(ndimage.sum(holes, labels, index=np.arange(1, n + 1)), dtype=np.float64)
    small = np.nonzero(sizes <= max_ratio * subject)[0] + 1
    if small.size == 0:
        return alpha
    fill = ndimage.binary_dilation(np.isin(labels, small), iterations=1)
    out = alpha.copy()
    out[fill] = 1.0
    return out


def _disk(n: int) -> Bool:
    yy, xx = np.mgrid[-n : n + 1, -n : n + 1]
    return np.asarray(yy * yy + xx * xx <= n * n + n // 2, dtype=bool)


def shift_edge(alpha: F32, px: float) -> F32:
    """Erodes (px < 0) or dilates (px > 0) the matte by a possibly fractional number of pixels."""
    if abs(px) < 1e-3:
        return alpha
    n = int(np.floor(abs(px)))
    frac = abs(px) - n

    def op(a: F32, k: int) -> F32:
        if k == 0:
            return a
        fp = _disk(k)
        res = ndimage.grey_dilation(a, footprint=fp) if px > 0 else ndimage.grey_erosion(a, footprint=fp)
        return np.asarray(res, dtype=np.float32)

    lo = op(alpha, n)
    if frac < 1e-3:
        return lo
    hi = op(alpha, n + 1)
    return np.asarray(lo * (1 - frac) + hi * frac, dtype=np.float32)


def sharpen_sigmoid(alpha: F32, k: float) -> F32:
    """Contrast curve centred on 0.5 that keeps 0 and 1 fixed."""
    if k <= 0:
        return alpha
    lo = 1.0 / (1.0 + np.exp(k * 0.5))
    hi = 1.0 / (1.0 + np.exp(-k * 0.5))
    s = 1.0 / (1.0 + np.exp(-k * (alpha - 0.5)))
    return np.asarray((s - lo) / (hi - lo), dtype=np.float32)


def feather_band(alpha: F32, feather_px: float) -> F32:
    """Gaussian feather applied only to the boundary band; interior and exterior are untouched."""
    if feather_px <= 0:
        return alpha
    core: Bool = alpha > 0.5
    if not core.any():
        return alpha
    r = max(1, int(round(feather_px)) + 1)
    band = ndimage.binary_dilation(core, iterations=r) & ~ndimage.binary_erosion(core, iterations=r)
    smooth = ndimage.gaussian_filter(alpha, sigma=max(0.3, feather_px / 2.0)).astype(np.float32)
    return np.asarray(np.where(band, smooth, alpha), dtype=np.float32)


def refine_alpha(
    rgb: U8,
    alpha: F32,
    *,
    smooth: float = DEFAULT_SMOOTH,
    edge_shift_px: float = 0.0,
    fill_holes: bool = True,
    feather_px: float = 1.5,
    hole_ratio: float = DEFAULT_HOLE_RATIO,
    speck_keep_ratio: float = DEFAULT_SPECK_KEEP,
    protect: Bool | None = None,
) -> F32:
    """Matte post-processing. `smooth` 0 keeps the raw matte shape (only cleanup + feather), 1 is strongest.

    `protect` marks pixels the user edited by hand: cleanup (specks, hole filling) never overrides them.
    """
    a = np.clip(alpha, 0.0, 1.0).astype(np.float32)
    if not (a > 0.5).any():
        return a
    pre = a
    a = remove_specks(a, speck_keep_ratio)
    if fill_holes:
        a = fill_small_holes(a, hole_ratio)
    if protect is not None and protect.any():
        a = np.asarray(np.where(protect, pre, a), dtype=np.float32)
    h, w = a.shape
    sm = float(np.clip(smooth, 0.0, 1.0))
    if sm > 0:
        longest = max(h, w)
        radius = max(2, int(round(1 + sm * 0.006 * longest)))
        eps = 1e-4 + sm * 1e-3
        guide = rgb.astype(np.float32) / 255.0
        sub = max(1, int(np.ceil(longest / 1024)))
        q = guided_filter(guide, a, radius, eps, sub)
        a = sharpen_sigmoid(np.clip(q, 0.0, 1.0), 4.0 + 8.0 * sm)
    a = shift_edge(a, edge_shift_px)
    a = feather_band(a, feather_px)
    # Kill numerical dust so the PNG compresses well and no ghost pixels survive.
    a = np.where(a < 0.02, 0.0, np.where(a > 0.98, 1.0, a)).astype(np.float32)
    return np.clip(a, 0.0, 1.0)


def despill(rgb: U8, alpha: F32, max_dist: int = 6) -> U8:
    """Edge colour decontamination: pixels that are not confidently foreground take the (locally averaged)
    colour of the nearest confident foreground pixels, which removes the halo of the old background.

    Confident = alpha >= 0.98 after a 1 px erosion, so the outermost solid ring (which still contains
    background colour from the original anti-aliasing) is replaced too. Pixels with no confident neighbour
    within `max_dist` keep their colour, so thin structures such as laces and straps are not destroyed.
    """
    solid: Bool = alpha >= 0.98
    if not solid.any():
        return rgb
    confident: Bool = ndimage.binary_erosion(solid, iterations=1)
    if not confident.any():
        confident = solid
    target: Bool = (alpha > 0.0) & ~confident
    if not target.any():
        return rgb
    dist, (iy, ix) = ndimage.distance_transform_edt(~confident, return_indices=True)
    m = confident.astype(np.float32)
    f = rgb.astype(np.float32)
    num = ndimage.gaussian_filter(f * m[..., None], sigma=(2.0, 2.0, 0))
    den = ndimage.gaussian_filter(m, sigma=2.0)
    avg = num / np.maximum(den, 1e-4)[..., None]
    nearest = f[iy, ix]
    repl = np.where((den > 0.02)[..., None], avg, nearest)
    use = target & (np.asarray(dist) <= max_dist)
    out = rgb.copy()
    out[use] = np.clip(np.rint(repl[use]), 0, 255).astype(np.uint8)
    return out


def stroke_weight(shape: tuple[int, int], stroke: Stroke) -> F32:
    """Brush coverage 0..1 for one stroke: 1 inside 60% of the radius, smooth falloff to 0 at the radius."""
    h, w = shape
    r = max(0.5, stroke.radius_px)
    xs = [p[0] for p in stroke.points]
    ys = [p[1] for p in stroke.points]
    x0 = max(0, int(np.floor(min(xs) - r - 1)))
    y0 = max(0, int(np.floor(min(ys) - r - 1)))
    x1 = min(w, int(np.ceil(max(xs) + r + 2)))
    y1 = min(h, int(np.ceil(max(ys) + r + 2)))
    out = np.zeros((h, w), dtype=np.float32)
    if x1 <= x0 or y1 <= y0:
        return out
    canvas = Image.new("L", (x1 - x0, y1 - y0), 0)
    draw = ImageDraw.Draw(canvas)
    pts = [(px - x0, py - y0) for px, py in stroke.points]
    if len(pts) == 1:
        draw.point(pts[0], fill=255)
    else:
        draw.line(pts, fill=255, width=1)
    line = np.asarray(canvas) > 0
    dist = np.asarray(ndimage.distance_transform_edt(~line), dtype=np.float32)
    t = np.clip((r - dist) / (0.4 * r), 0.0, 1.0)
    out[y0:y1, x0:x1] = t * t * (3.0 - 2.0 * t)
    return out


def apply_strokes(alpha: F32, strokes: list[Stroke]) -> tuple[F32, Bool]:
    """Applies strokes in order: erase pulls alpha toward 0, restore toward 1. Colours always come from the
    original image because the cutout is rebuilt from the original pixels. Returns (alpha, touched)."""
    a = np.clip(alpha, 0.0, 1.0).astype(np.float32)
    touched = np.zeros(a.shape, dtype=bool)
    for s in strokes:
        wgt = stroke_weight((a.shape[0], a.shape[1]), s)
        touched |= wgt > 0
        a = a * (1.0 - wgt) if s.mode == "erase" else a + (1.0 - a) * wgt
    return a.astype(np.float32), touched


def render_background(rgba: Image.Image, kind: str, max_side: int) -> tuple[bytes, str]:
    """Preview render of the cutout over a backdrop. Returns (bytes, mime). transparent -> the RGBA PNG."""
    if kind == "transparent":
        return encode_png(rgba), "image/png"
    if kind == "white":
        return encode_jpeg(white_background(rgba, max_side)), "image/jpeg"
    # studio: soft vertical+radial light grey gradient with the contact shadow.
    shadowed = with_ground_shadow(rgba)
    w, h = shadowed.size
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    d = np.sqrt(((xx - w / 2) / (w * 0.75)) ** 2 + ((yy - h * 0.45) / (h * 0.75)) ** 2)
    lum = np.clip(246.0 - 26.0 * d**1.5, 214.0, 246.0).astype(np.uint8)
    bg = Image.fromarray(
        np.dstack([lum, lum, np.clip(lum.astype(np.int16) + 2, 0, 255).astype(np.uint8)]), mode="RGB"
    )
    bg.paste(shadowed, mask=shadowed.getchannel("A"))
    longest = max(bg.size)
    if longest > max_side:
        sc = max_side / longest
        bg = bg.resize((max(1, round(w * sc)), max(1, round(h * sc))), Image.Resampling.LANCZOS)
    return encode_jpeg(bg), "image/jpeg"


@dataclass(frozen=True)
class Derived:
    png: bytes
    mask: bytes
    white_jpg: bytes
    shadow_png: bytes | None
    stats: MaskStats
    rgba: Image.Image


def derive(
    rgb: U8,
    raw_alpha: F32,
    *,
    feather_px: float,
    padding_ratio: float,
    white_max_side: int,
    shadow: bool,
    smooth: float = DEFAULT_SMOOTH,
    edge_shift_px: float = 0.0,
    fill_holes: bool = True,
    protect: Bool | None = None,
    stats_alpha: F32 | None = None,
) -> Derived:
    """Full post-processing from a raw alpha. Metadata is dropped: pixels are re-encoded from arrays."""
    stats = mask_stats(rgb, stats_alpha if stats_alpha is not None else raw_alpha)
    alpha = refine_alpha(
        rgb,
        raw_alpha,
        smooth=smooth,
        edge_shift_px=edge_shift_px,
        fill_holes=fill_holes,
        feather_px=feather_px,
        protect=protect,
    )
    clean_rgb = despill(rgb, alpha)
    h, w = alpha.shape
    bbox = subject_bbox(alpha)
    x0, y0, x1, y1 = crop_box(bbox, w, h, padding_ratio) if bbox is not None else (0, 0, w, h)
    rgba = compose_rgba(clean_rgb, alpha).crop((x0, y0, x1, y1))
    mask_img = Image.fromarray(np.rint(np.clip(alpha, 0, 1) * 255).astype(np.uint8), mode="L")
    return Derived(
        png=encode_png(rgba),
        mask=encode_png(mask_img),
        white_jpg=encode_jpeg(white_background(rgba, white_max_side)),
        shadow_png=encode_png(with_ground_shadow(rgba)) if shadow else None,
        stats=stats,
        rgba=rgba,
    )
