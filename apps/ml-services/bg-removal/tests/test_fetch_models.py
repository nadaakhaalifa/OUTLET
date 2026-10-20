import importlib.util
from pathlib import Path
from types import ModuleType

import pytest


def _load() -> ModuleType:
    path = Path(__file__).resolve().parent.parent / "scripts" / "fetch_models.py"
    spec = importlib.util.spec_from_file_location("fetch_models", path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


fm = _load()


@pytest.mark.parametrize(
    "url",
    ["file:///etc/passwd", "http://github.com/x", "https://evil.example/x", "https://github.com:8443/x"],
)
def test_refuses_non_allow_listed_targets(url: str) -> None:
    with pytest.raises(SystemExit):
        fm._https_target(url)


def test_accepts_allow_listed_https() -> None:
    assert fm._https_target("https://github.com/a/b?c=1") == ("github.com", "/a/b?c=1")
