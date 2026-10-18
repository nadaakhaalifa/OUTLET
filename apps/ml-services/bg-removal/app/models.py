"""Model sessions: allow-listed names only, loaded lazily, never downloaded at runtime."""

from __future__ import annotations

import importlib.metadata
import threading
from pathlib import Path
from typing import Any, Protocol

import numpy as np
from numpy.typing import NDArray
from PIL import Image

from .config import ALLOWED_MODELS

_MODEL_FILES: dict[str, str] = {
    "u2netp": "u2netp.onnx",
    "u2net": "u2net.onnx",
    "isnet-general-use": "isnet-general-use.onnx",
    "birefnet-general-lite": "BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx",
}


class Matter(Protocol):
    """Produces a float32 alpha matte (0..1, same size as the image)."""

    def matte(self, model: str, image: Image.Image) -> NDArray[np.float32]: ...

    def version(self, model: str) -> str: ...

    def available(self) -> list[str]: ...


class UnknownModelError(ValueError):
    """The requested model is not on the allow-list."""


class RembgMatter:
    def __init__(self, models_dir: str) -> None:
        self._dir = Path(models_dir)
        self._sessions: dict[str, Any] = {}
        self._lock = threading.Lock()

    def available(self) -> list[str]:
        return [m for m in ALLOWED_MODELS if (self._dir / _MODEL_FILES[m]).is_file()]

    def version(self, model: str) -> str:
        try:
            rembg_v = importlib.metadata.version("rembg")
        except importlib.metadata.PackageNotFoundError:
            rembg_v = "unknown"
        return f"rembg-{rembg_v}+{model}"

    def _session(self, model: str) -> Any:  # noqa: ANN401
        if model not in ALLOWED_MODELS:
            raise UnknownModelError(model)
        with self._lock:
            s = self._sessions.get(model)
            if s is None:
                if not (self._dir / _MODEL_FILES[model]).is_file():
                    raise FileNotFoundError(f"model {model} is not installed in the image")
                from rembg import new_session  # imported late: heavy, and absent in unit tests

                s = new_session(model, providers=["CPUExecutionProvider"])
                self._sessions[model] = s
            return s

    def matte(self, model: str, image: Image.Image) -> NDArray[np.float32]:
        from rembg import remove

        out = remove(image, session=self._session(model), only_mask=True, post_process_mask=False)
        gray = np.asarray(out.convert("L"), dtype=np.float32)
        arr: NDArray[np.float32] = (gray / np.float32(255.0)).astype(np.float32)
        return arr
