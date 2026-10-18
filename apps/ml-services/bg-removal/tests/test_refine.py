from __future__ import annotations

import base64
import io
import json
from typing import Any

import numpy as np
from fastapi.testclient import TestClient
from PIL import Image

from app.processing import (
    Stroke,
    apply_strokes,
    despill,
    fill_small_holes,
    guided_filter,
    refine_alpha,
    remove_specks,
    shift_edge,
)
from tests.conftest import FakeMatter
from tests.synthetic import H, W, edge_colour_distance, make_shirt


def _png(arr: np.ndarray, mode: str) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(arr, mode=mode).save(buf, format="PNG")
    return buf.getvalue()


def _b64(b: bytes) -> str:
    return base64.b64encode(b).decode()


def _decode_gray(b64: str) -> np.ndarray:
    return np.asarray(Image.open(io.BytesIO(base64.b64decode(b64))).convert("L"), dtype=np.float32) / 255.0


def test_despill_reduces_edge_halo() -> None:
    s = make_shirt()
    alpha = refine_alpha(s.rgb, s.raw_alpha, smooth=0.5, edge_shift_px=0, fill_holes=True, feather_px=1.5)
    before = edge_colour_distance(s.rgb, alpha)
    after = edge_colour_distance(despill(s.rgb, alpha), alpha)
    assert before > 20.0
    assert after < 0.5 * before


def test_small_hole_filled_neck_kept() -> None:
    s = make_shirt()
    a = refine_alpha(s.rgb, s.raw_alpha, smooth=0.5, fill_holes=True)
    by, bx = s.button
    ny0, ny1, nx0, nx1 = s.neck
    assert a[by, bx] > 0.9  # button-sized hole filled
    assert a[(ny0 + ny1) // 2, (nx0 + nx1) // 2] < 0.1  # neck opening kept
    off = refine_alpha(s.rgb, s.raw_alpha, smooth=0.0, fill_holes=False)
    assert off[by, bx] < 0.9


def test_hole_ratio_is_configurable() -> None:
    s = make_shirt()
    big = fill_small_holes(s.true_alpha, max_ratio=0.5)
    ny0, ny1, nx0, nx1 = s.neck
    assert big[(ny0 + ny1) // 2, (nx0 + nx1) // 2] == 1.0


def test_specks_removed_main_subject_kept() -> None:
    s = make_shirt()
    out = remove_specks(s.raw_alpha, 0.01)
    assert out[30, 30] == 0.0
    assert out[300, 200] > 0.9
    full = refine_alpha(s.rgb, s.raw_alpha)
    assert full[30, 30] == 0.0


def test_strokes_change_alpha_only_near_stroke() -> None:
    a = np.ones((100, 100), dtype=np.float32)
    out, touched = apply_strokes(a, [Stroke("erase", 6.0, ((50.0, 50.0), (60.0, 50.0)))])
    assert out[50, 55] < 0.05
    assert out[50, 50] < 0.05
    changed = np.abs(out - a) > 1e-6
    ys, xs = np.nonzero(changed)
    assert ys.min() >= 50 - 7 and ys.max() <= 50 + 7 and xs.min() >= 50 - 7 and xs.max() <= 60 + 7
    assert out[10, 10] == 1.0 and touched.sum() == changed.sum()
    z = np.zeros((100, 100), dtype=np.float32)
    back, _ = apply_strokes(z, [Stroke("restore", 6.0, ((20.0, 20.0),))])
    assert back[20, 20] > 0.95 and back[80, 80] == 0.0


def test_shift_edge_directions() -> None:
    a = np.zeros((60, 60), dtype=np.float32)
    a[20:40, 20:40] = 1.0
    assert shift_edge(a, 2.0).sum() > a.sum() > shift_edge(a, -2.0).sum()
    assert np.array_equal(shift_edge(a, 0.0), a)


def test_guided_filter_snaps_blurry_matte_to_guide_edge() -> None:
    s = make_shirt()
    guide = s.rgb.astype(np.float32) / 255.0
    raw = s.raw_alpha
    q = np.clip(guided_filter(guide, raw, radius=6, eps=1e-3), 0, 1)
    err_raw = float(np.abs(raw - s.true_alpha).mean())
    err_gf = float(np.abs(q - s.true_alpha).mean())
    assert err_gf < err_raw


def test_fine_detail_not_erased() -> None:
    """A 2 px wide dark strap must survive the default smoothing."""
    rgb = np.full((200, 200, 3), 255, dtype=np.uint8)
    rgb[:, 98:100] = (10, 10, 10)
    rgb[60:140, 40:160] = (10, 10, 10)
    alpha = np.zeros((200, 200), dtype=np.float32)
    alpha[:, 98:100] = 1.0
    alpha[60:140, 40:160] = 1.0
    out = refine_alpha(rgb, alpha, smooth=0.5, fill_holes=True)
    assert out[10:50, 98:100].mean() > 0.5


def _client_settings() -> TestClient:
    from app.config import Settings
    from app.main import create_app

    return TestClient(
        create_app(
            Settings(max_request_bytes=2_000_000, max_dimension=1000, timeout_seconds=20.0), FakeMatter()
        )
    )


def _refine_body(**over: Any) -> dict[str, Any]:
    s = make_shirt()
    body: dict[str, Any] = {
        "image_b64": _b64(_png(s.rgb, "RGB")),
        "mask_b64": _b64(_png(np.rint(s.raw_alpha * 255).astype(np.uint8), "L")),
        "strokes": [],
        "background": "studio",
    }
    body.update(over)
    return body


def test_refine_endpoint_contract_and_idempotent_size() -> None:
    c = _client_settings()
    r = c.post("/v1/refine", json=_refine_body())
    assert r.status_code == 200, r.text
    b = r.json()
    for k in (
        "png_b64",
        "mask_b64",
        "white_jpg_b64",
        "shadow_png_b64",
        "stats",
        "model_id",
        "model_version",
        "latency_ms",
        "background_render_b64",
    ):
        assert k in b
    assert _decode_gray(b["mask_b64"]).shape == (H, W)
    assert base64.b64decode(b["background_render_b64"])[:3] == b"\xff\xd8\xff"
    # Feeding the refined mask back keeps the size and barely changes it.
    r2 = c.post("/v1/refine", json=_refine_body(mask_b64=b["mask_b64"]))
    assert r2.status_code == 200
    m1, m2 = _decode_gray(b["mask_b64"]), _decode_gray(r2.json()["mask_b64"])
    assert m1.shape == m2.shape
    assert float(np.abs(m1 - m2).mean()) < 0.01


def test_refine_strokes_erase_and_restore_via_api() -> None:
    c = _client_settings()
    base = c.post("/v1/refine", json=_refine_body()).json()
    stroke = {"mode": "erase", "radius": 0.05, "points": [[0.5, 0.7], [0.55, 0.7]]}
    edited = c.post("/v1/refine", json=_refine_body(strokes=[stroke])).json()
    a0, a1 = _decode_gray(base["mask_b64"]), _decode_gray(edited["mask_b64"])
    diff = np.abs(a0 - a1) > 0.2
    ys, xs = np.nonzero(diff)
    assert ys.size > 0
    assert abs(ys.mean() - 0.7 * (H - 1)) < 0.06 * H and abs(xs.mean() - 0.525 * (W - 1)) < 0.08 * W
    assert diff.sum() < 0.05 * a0.size
    restore = {"mode": "restore", "radius": 0.05, "points": [[0.5, 0.7]]}
    s2 = c.post("/v1/refine", json=_refine_body(strokes=[stroke, restore])).json()
    a2 = _decode_gray(s2["mask_b64"])
    assert a2[int(0.7 * (H - 1)), int(0.5 * (W - 1))] > 0.9  # restore applied after erase


def test_refine_without_mask_uses_model() -> None:
    c = _client_settings()
    body = _refine_body()
    del body["mask_b64"]
    r = c.post("/v1/refine?quality=high", json=body)
    assert r.status_code == 200, r.text
    assert r.json()["model_id"] == "u2netp"  # only installed model in the fake


def test_refine_validation_errors_are_422_and_do_not_echo_input() -> None:
    c = _client_settings()
    img = _b64(_png(make_shirt().rgb, "RGB"))
    bad_cases: list[dict[str, Any]] = [
        _refine_body(strokes=[{"mode": "paint", "radius": 0.05, "points": [[0.1, 0.1]]}]),
        _refine_body(strokes=[{"mode": "erase", "radius": 0.5, "points": [[0.1, 0.1]]}]),
        _refine_body(strokes=[{"mode": "erase", "radius": 0.05, "points": []}]),
        _refine_body(strokes=[{"mode": "erase", "radius": 0.05, "points": [[0.1, 0.1]] * 2001}]),
        _refine_body(strokes=[{"mode": "erase", "radius": 0.05, "points": [[0.1, 0.1]]}] * 201),
        _refine_body(smooth=1.5),
        _refine_body(edge_shift_px=4),
        _refine_body(background="neon"),
        _refine_body(image_b64="!!!notbase64!!!"),
        _refine_body(mask_b64=_b64(_png(np.zeros((10, 10), dtype=np.uint8), "L"))),
        _refine_body(mask_b64=_b64(_png(np.zeros((H, W, 3), dtype=np.uint8), "RGB"))),
        {"image_b64": img, "unexpected": 1},
    ]
    for body in bad_cases:
        r = c.post("/v1/refine", json=body)
        assert r.status_code == 422, (r.status_code, r.text[:200])
        assert img[:40] not in r.text
    assert c.post("/v1/refine", content=b"{not json").status_code == 422
    assert c.post("/v1/refine", content=json.dumps({"image_b64": "A" * 5_000_000}).encode()).status_code in (
        413,
        422,
    )


def test_cutout_new_query_params_validated_and_response_unchanged() -> None:
    c = _client_settings()
    png = _png(make_shirt().rgb, "RGB")
    for q in ("smooth=2", "edge_shift_px=9", "quality=ultra"):
        assert c.post(f"/v1/cutout?{q}", content=png).status_code == 422
    r = c.post("/v1/cutout?smooth=0.8&edge_shift_px=-1&fill_holes=false&quality=fast", content=png)
    assert r.status_code == 200
    assert "background_render_b64" not in r.json()
