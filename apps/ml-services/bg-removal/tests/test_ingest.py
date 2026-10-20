from __future__ import annotations

import io
import struct
import zlib
from collections.abc import Iterator

import numpy as np
import pytest
from PIL import Image, ImageCms

from app.colour import ciede2000, delta_e_stats, srgb_to_lab
from app.ingest import IngestError, ingest, sniff


@pytest.fixture(autouse=True)
def _reset_pixel_cap() -> Iterator[None]:
    saved = Image.MAX_IMAGE_PIXELS
    Image.MAX_IMAGE_PIXELS = 89_478_485
    yield
    Image.MAX_IMAGE_PIXELS = saved


def _jpeg(img: Image.Image, **kw: object) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=100, **kw)
    return buf.getvalue()


def test_sniff_by_magic_not_name() -> None:
    buf = io.BytesIO()
    Image.new("RGB", (8, 8)).save(buf, format="PNG")
    assert sniff(buf.getvalue()) == "PNG"
    with pytest.raises(IngestError) as e:
        sniff(b"GIF89a" + b"\0" * 20)
    assert e.value.code == "unsupported_type"
    with pytest.raises(IngestError):
        sniff(b"<svg xmlns='http://www.w3.org/2000/svg'/>")


def test_p3_tagged_converted_to_srgb_and_original_kept() -> None:
    profile = _display_p3()
    # P3 (0, 255, 0) is outside sRGB: it must come out as a clipped sRGB green with a different red/blue.
    src = Image.new("RGB", (16, 16), (200, 60, 60))
    data = _jpeg(src, icc_profile=profile)
    out = ingest(data)
    assert out.icc_source == "display_p3"
    assert out.original == data
    px = np.asarray(out.image)[8, 8].astype(int)
    assert abs(px - np.array([200, 60, 60])).max() > 8  # converted, not passed through
    assert "icc_profile" not in out.image.info and not out.image.getexif()


def test_srgb_tag_and_no_tag_pass_through() -> None:
    srgb = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
    a = ingest(_jpeg(Image.new("RGB", (16, 16), (10, 120, 200)), icc_profile=srgb))
    b = ingest(_jpeg(Image.new("RGB", (16, 16), (10, 120, 200))))
    assert a.icc_source in ("srgb", "other") and b.icc_source == "none"
    assert np.array_equal(
        np.asarray(b.image)[0, 0],
        np.asarray(Image.open(io.BytesIO(_jpeg(Image.new("RGB", (16, 16), (10, 120, 200))))))[0, 0],
    )


def test_garbage_icc_rejected() -> None:
    with pytest.raises(IngestError) as e:
        ingest(_jpeg(Image.new("RGB", (16, 16)), icc_profile=b"not a profile" * 10))
    assert e.value.code == "malformed_icc_profile"


def test_exif_gps_stripped_and_orientation_applied() -> None:
    img = Image.new("RGB", (40, 20), (255, 0, 0))
    exif = Image.Exif()
    exif[0x0112] = 6  # rotate 90 cw
    exif[0x010F] = "SecretMaker"
    data = _jpeg(img, exif=exif.tobytes())
    out = ingest(data)
    assert out.image.size == (20, 40)
    assert not out.image.getexif() and not out.image.info


def test_pixel_and_dimension_caps_checked_from_header() -> None:
    buf = io.BytesIO()
    Image.new("L", (3000, 3000)).save(buf, format="PNG")  # 9 Mpx, tiny on disk
    with pytest.raises(IngestError) as e:
        ingest(buf.getvalue(), max_dimension=4096, max_pixels=8_000_000)
    assert e.value.code == "too_many_pixels"
    with pytest.raises(IngestError) as e2:
        ingest(buf.getvalue(), max_dimension=2000)
    assert e2.value.code == "too_large_dimensions"


def test_bomb_header_rejected_without_decode() -> None:
    # PNG header declaring 60000x60000 with a truncated body: must fail on the header, not allocate.
    def chunk(t: bytes, d: bytes) -> bytes:
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))

    ihdr = struct.pack(">IIBBBBB", 60000, 60000, 8, 0, 0, 0, 0)
    data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IEND", b"")
    with pytest.raises(IngestError) as e:
        ingest(data, max_dimension=100_000)
    assert e.value.code == "too_many_pixels"


def test_animated_rejected() -> None:
    frames = [Image.new("RGB", (16, 16), (i * 40, 0, 0)) for i in range(3)]
    buf = io.BytesIO()
    frames[0].save(buf, format="WEBP", save_all=True, append_images=frames[1:], duration=50)
    with pytest.raises(IngestError) as e:
        ingest(buf.getvalue())
    assert e.value.code == "animated_not_supported"
    buf = io.BytesIO()
    frames[0].save(buf, format="PNG", save_all=True, append_images=frames[1:])
    with pytest.raises(IngestError):
        ingest(buf.getvalue())


def test_truncated_and_low_resolution() -> None:
    good = _jpeg(Image.new("RGB", (64, 64), (1, 2, 3)))
    with pytest.raises(IngestError) as e:
        ingest(good[: len(good) // 2])
    assert e.value.code == "malformed_image"
    assert ingest(good).studio_eligible is False
    assert ingest(_jpeg(Image.new("RGB", (900, 100)))).studio_eligible is True


def test_alpha_flattened_on_white() -> None:
    rgba = Image.new("RGBA", (16, 16), (255, 0, 0, 0))
    buf = io.BytesIO()
    rgba.save(buf, format="PNG")
    assert tuple(np.asarray(ingest(buf.getvalue()).image)[0, 0]) == (255, 255, 255)


def test_p3_roundtrip_colour_within_tolerance() -> None:
    """Converting a P3-tagged pixel to sRGB matches a direct ImageCms transform (colour gate input)."""
    profile = _display_p3()
    arr = np.full((8, 8, 3), (180, 90, 40), dtype=np.uint8)
    src = Image.fromarray(arr, "RGB")
    out = ingest(_jpeg(src, icc_profile=profile))
    ref = ImageCms.profileToProfile(
        src, ImageCms.ImageCmsProfile(io.BytesIO(profile)), ImageCms.createProfile("sRGB"), outputMode="RGB"
    )
    assert ref is not None
    stats = delta_e_stats(np.asarray(out.image), np.asarray(ref), np.ones((8, 8), dtype=bool))
    assert stats.median <= 1.5  # JPEG q100 only
    assert ciede2000(srgb_to_lab(arr), srgb_to_lab(np.asarray(out.image))).max() > 1.0  # it did change


def _display_p3() -> bytes:
    """Display P3 ICC (matrix/TRC v2) written by hand: ~500 bytes, generated in memory."""

    def s15(v: float) -> bytes:
        return struct.pack(">i", round(v * 65536))

    def xyz(x: float, y: float, z: float) -> bytes:
        return b"XYZ \0\0\0\0" + s15(x) + s15(y) + s15(z)

    # D50-adapted P3 primaries (Apple Display P3 values).
    tags: list[tuple[bytes, bytes]] = [
        (
            b"desc",
            b"desc\0\0\0\0" + struct.pack(">I", 11) + b"Display P3\0" + b"\0" * 4 + b"\0" * 3 + b"\0" * 67,
        ),
        (b"wtpt", xyz(0.96420, 1.0, 0.82491)),
        (b"rXYZ", xyz(0.51512, 0.24120, -0.00105)),
        (b"gXYZ", xyz(0.29198, 0.69225, 0.04189)),
        (b"bXYZ", xyz(0.13430, 0.06655, 0.78410)),
        (b"cprt", b"text\0\0\0\0test\0"),
    ]
    curve = (
        b"curv\0\0\0\0"
        + struct.pack(">I", 1024)
        + b"".join(
            struct.pack(
                ">H",
                round(
                    65535
                    * (((i / 1023) / 12.92) if i / 1023 <= 0.04045 else ((i / 1023 + 0.055) / 1.055) ** 2.4)
                ),
            )
            for i in range(1024)
        )
    )
    tags += [(b"rTRC", curve), (b"gTRC", curve), (b"bTRC", curve)]
    table = b""
    body = b""
    off = 128 + 4 + 12 * len(tags)
    for sig, data in tags:
        pad = (-len(data)) % 4
        table += sig + struct.pack(">II", off + len(body), len(data))
        body += data + b"\0" * pad
    size = off + len(body)
    hdr = bytearray(128)
    hdr[0:4] = struct.pack(">I", size)
    hdr[8:12] = b"\x02\x40\x00\x00"
    hdr[12:16] = b"mntr"
    hdr[16:20] = b"RGB "
    hdr[20:24] = b"XYZ "
    hdr[36:40] = b"acsp"
    hdr[68:80] = s15(0.9642) + s15(1.0) + s15(0.8249)
    return bytes(hdr) + struct.pack(">I", len(tags)) + table + body


def _srgb_eotf(c: float) -> float:
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
