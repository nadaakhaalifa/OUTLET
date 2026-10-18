from __future__ import annotations

import base64

from fastapi.testclient import TestClient

from tests.conftest import FakeMatter, png_bytes


def test_healthz(client: TestClient) -> None:
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json() == {"status": "ok", "models_available": ["u2netp"], "default_model": "u2netp"}


def test_cutout_happy_path(client: TestClient, matter: FakeMatter) -> None:
    r = client.post("/v1/cutout?model=u2net&shadow=true", content=png_bytes(), headers={"content-type": "application/octet-stream"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert base64.b64decode(body["png_b64"])[:4] == b"\x89PNG"
    assert base64.b64decode(body["white_jpg_b64"])[:3] == b"\xff\xd8\xff"
    assert body["model_id"] == "u2net" and matter.calls == ["u2net"]
    assert 0.29 < body["stats"]["coverage"] < 0.31
    assert set(body) == {"png_b64", "mask_b64", "white_jpg_b64", "shadow_png_b64", "stats", "model_id", "model_version", "latency_ms"}


def test_rejects_unknown_and_non_commercial_models(client: TestClient) -> None:
    for m in ("bria-rmbg-2.0", "rmbg-1.4", "../etc/passwd"):
        r = client.post(f"/v1/cutout?model={m}", content=png_bytes())
        assert r.status_code == 422


def test_rejects_big_bodies_bad_types_and_big_dimensions(client: TestClient) -> None:
    assert client.post("/v1/cutout", content=b"\x00" * 300_000).status_code == 413
    assert client.post("/v1/cutout", content=b"not an image").status_code == 422
    assert client.post("/v1/cutout", content=b"").status_code == 422
    assert client.post("/v1/cutout", content=png_bytes(500, 100)).status_code == 422
