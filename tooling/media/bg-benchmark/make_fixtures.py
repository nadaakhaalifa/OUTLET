#!/usr/bin/env python3
"""Writes small synthetic 'garment' PNGs (standard library only) into fixtures/synthetic/<category>/.

They exercise the pipeline and the harness; they are NOT a quality benchmark (a polygon is not a t-shirt).
Categories mirror the real photo set the owner must supply: flat_lay, white_on_white, dark_on_dark, hanger,
ghost_mannequin.
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

W, H = 256, 320


def tshirt(x: int, y: int) -> bool:
    body = 70 <= x <= 186 and 90 <= y <= 290
    sleeves = 20 <= x <= 236 and 70 <= y <= 140 and (abs(x - 128) * 0.6 + (y - 70)) < 100 + 60
    neck = (abs(x - 128) < 26) and (y < 96) and ((x - 128) ** 2 + (y - 70) ** 2 < 26 * 26 + 400)
    shoulders = 70 <= x <= 186 and 60 <= y <= 90
    return (body or sleeves or shoulders) and not (abs(x - 128) < 24 and y < 82)


def hanger(x: int, y: int) -> bool:
    return (abs(x - 128) < 3 and 8 <= y < 40) or (abs(abs(x - 128) - (y - 40) * 2.2) < 3 and 40 <= y <= 62)


def png(path: Path, pix: list[list[tuple[int, int, int]]]) -> None:
    raw = b"".join(b"\x00" + b"".join(bytes(p) for p in row) for row in pix)

    def chunk(tag: bytes, data: bytes) -> bytes:
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    )


def render(bg: tuple[int, int, int], fg: tuple[int, int, int], with_hanger: bool = False, ghost: bool = False) -> list[list[tuple[int, int, int]]]:
    rows = []
    for y in range(H):
        row = []
        for x in range(W):
            shade = (x * 3 + y * 2) % 7  # a little texture so edges are not perfectly flat
            if tshirt(x, y) and not (ghost and 100 < y < 130 and 100 < x < 156):
                row.append((max(0, fg[0] - shade), max(0, fg[1] - shade), max(0, fg[2] - shade)))
            elif with_hanger and hanger(x, y):
                row.append((60, 60, 60))
            else:
                row.append(bg)
        rows.append(row)
    return rows


def main() -> None:
    out = Path(__file__).parent / "fixtures" / "synthetic"
    png(out / "flat_lay" / "tee_red_on_grey.png", render((205, 205, 205), (190, 40, 50)))
    png(out / "white_on_white" / "tee_white_on_white.png", render((252, 252, 252), (240, 240, 240)))
    png(out / "dark_on_dark" / "tee_black_on_charcoal.png", render((48, 48, 52), (18, 18, 20)))
    png(out / "hanger" / "tee_blue_hanger.png", render((236, 232, 224), (40, 80, 170), with_hanger=True))
    png(out / "ghost_mannequin" / "tee_green_ghost.png", render((245, 245, 245), (50, 140, 90), ghost=True))
    print(f"wrote 5 fixtures under {out}")


if __name__ == "__main__":
    main()
