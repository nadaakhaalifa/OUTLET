"""Upload hardening and colour-profile normalisation (spec product-photo-studio section 3, S1-1/S1-2).

Order matters: sniff magic bytes, read the header only (size and pixel caps against decompression bombs),
reject animated or odd formats, then decode, apply EXIF orientation to pixels, convert the embedded ICC
profile to sRGB (a missing profile is treated as sRGB) and return pixels only. Re-encoding from pixels drops
EXIF, GPS, XMP, IPTC and thumbnails. The caller keeps the untouched original bytes; this module never mutates
them.
"""

from __future__ import annotations

import io
from dataclasses import dataclass
from typing import Literal

from PIL import Image, ImageCms, ImageOps, UnidentifiedImageError

MAX_PIXELS = 24_000_000
STUDIO_MIN_LONG_SIDE = 800
IccSource = Literal["none", "srgb", "display_p3", "other"]

_PNG = b"\x89PNG\r\n\x1a\n"


class IngestError(ValueError):
    """Carries a stable machine code (the API maps it to a 422 detail)."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class Ingested:
    image: Image.Image  # RGB, sRGB, orientation applied, no metadata
    icc_source: IccSource
    studio_eligible: bool  # False -> background-only, reason low_resolution
    original: bytes  # untouched upload bytes


def sniff(data: bytes) -> Literal["JPEG", "PNG", "WEBP"]:
    """Format from magic bytes only; the declared type is ignored."""
    if data[:3] == b"\xff\xd8\xff":
        return "JPEG"
    if data[:8] == _PNG:
        return "PNG"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "WEBP"
    raise IngestError("unsupported_type")


_SRGB = ImageCms.createProfile("sRGB")


def _classify(profile: ImageCms.ImageCmsProfile) -> IccSource:
    try:
        desc = (ImageCms.getProfileDescription(profile) or "").lower()
    except ImageCms.PyCMSError:
        return "other"
    if "display p3" in desc or "display-p3" in desc:
        return "display_p3"
    if "srgb" in desc:
        return "srgb"
    return "other"


def to_srgb(img: Image.Image) -> tuple[Image.Image, IccSource]:
    """Convert from the embedded ICC profile to sRGB. Malformed profiles are rejected, not ignored."""
    raw = img.info.get("icc_profile")
    rgb = img.convert("RGB") if img.mode != "RGB" else img
    if not raw:
        return rgb, "none"
    try:
        src = ImageCms.ImageCmsProfile(io.BytesIO(raw))
        source = _classify(src)
        if source == "srgb":
            return rgb, "srgb"
        out = ImageCms.profileToProfile(
            rgb, src, _SRGB, renderingIntent=ImageCms.Intent.RELATIVE_COLORIMETRIC, outputMode="RGB"
        )
    except (ImageCms.PyCMSError, OSError, ValueError) as e:
        raise IngestError("malformed_icc_profile") from e
    if out is None:
        raise IngestError("malformed_icc_profile")
    return out, source


def ingest(
    data: bytes,
    *,
    max_dimension: int = 4096,
    max_pixels: int = MAX_PIXELS,
) -> Ingested:
    fmt = sniff(data)
    try:
        probe = Image.open(io.BytesIO(data))
        if probe.format != fmt:
            raise IngestError("unsupported_type")
        w, h = probe.size  # header only, nothing decoded yet
        if w <= 0 or h <= 0 or w > max_dimension or h > max_dimension:
            raise IngestError("too_large_dimensions")
        if w * h > max_pixels:
            raise IngestError("too_many_pixels")
        if getattr(probe, "is_animated", False) or getattr(probe, "n_frames", 1) > 1:
            raise IngestError("animated_not_supported")
        probe.verify()
        decoded = Image.open(io.BytesIO(data))
        decoded.load()
        img: Image.Image = decoded
    except IngestError:
        raise
    except Image.DecompressionBombError as e:
        raise IngestError("too_many_pixels") from e
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError) as e:
        raise IngestError("malformed_image") from e
    if img.mode not in ("RGB", "RGBA", "L", "LA", "P", "CMYK"):
        raise IngestError("unsupported_mode")
    if img.mode == "RGBA" or img.mode == "LA" or (img.mode == "P" and "transparency" in img.info):
        # Flatten onto white so transparent junk cannot hide behind the garment.
        rgba = img.convert("RGBA")
        bg = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        bg.alpha_composite(rgba)
        base = bg.convert("RGB")
        base.info["icc_profile"] = img.info.get("icc_profile", b"")
        img = base
    oriented = ImageOps.exif_transpose(img)
    oriented.info["icc_profile"] = img.info.get("icc_profile", b"")
    srgb, source = to_srgb(oriented)
    clean = Image.frombytes("RGB", srgb.size, srgb.tobytes())  # pixels only: no info, no EXIF
    return Ingested(
        image=clean,
        icc_source=source,
        studio_eligible=max(clean.size) >= STUDIO_MIN_LONG_SIDE,
        original=data,
    )
