from __future__ import annotations

import io

import numpy as np
import pytest
from fastapi.testclient import TestClient
from numpy.typing import NDArray
from PIL import Image

from app.config import Settings
from app.main import create_app


class FakeMatter:
    """Alpha = a centred rectangle covering 30 percent of the frame. No model, no network."""

    def __init__(self) -> None:
        self.calls: list[str] = []

    def matte(self, model: str, image: Image.Image) -> NDArray[np.float32]:
        self.calls.append(model)
        w, h = image.size
        a = np.zeros((h, w), dtype=np.float32)
        a[h // 5 : 4 * h // 5, w // 4 : 3 * w // 4] = 1.0
        return a

    def version(self, model: str) -> str:
        return f"fake+{model}"

    def available(self) -> list[str]:
        return ["u2netp"]


def png_bytes(w: int = 120, h: int = 160, color: tuple[int, int, int] = (200, 30, 30)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), color).save(buf, format="PNG")
    return buf.getvalue()


@pytest.fixture()
def matter() -> FakeMatter:
    return FakeMatter()


@pytest.fixture()
def client(matter: FakeMatter) -> TestClient:
    settings = Settings(max_request_bytes=200_000, max_dimension=400, timeout_seconds=5.0, max_concurrency=2)
    return TestClient(create_app(settings, matter))
