"""Test helper that loads vendored parser/batch_parser modules in isolation.

parser.py loads via importlib straight from its file path (no package import,
no lightrag chain). batch_parser.py loads with a stubbed `.parser` sibling so
`from .parser import ...` resolves without pulling lightrag/mineru.
"""

import importlib
import importlib.util
import sys
import types
from unittest import mock
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
_RA = PROJECT_ROOT / "paper2slides" / "raganything"


def load_parser_module(module_name: str):
    """Load the vendored parser.py under the given virtual module name."""
    spec = importlib.util.spec_from_file_location(module_name, _RA / "parser.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


def load_batch_parser_module():
    """Load batch_parser.py with a stub `.parser` sibling module."""
    cached = sys.modules.get("_p2s_test_batch_parser")
    if cached is not None:
        return cached

    parser_mod = load_parser_module("_p2s_test_parser")

    stub_pkg = types.ModuleType("_p2s_test_bp_pkg")
    stub_pkg.__path__ = [str(_RA)]  # type: ignore[attr-defined]
    stub_pkg.parser = parser_mod  # type: ignore[attr-defined]
    sys.modules["_p2s_test_bp_pkg"] = stub_pkg

    spec = importlib.util.spec_from_file_location(
        "_p2s_test_bp_pkg.batch_parser", _RA / "batch_parser.py"
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    module.__package__ = "_p2s_test_bp_pkg"
    sys.modules["_p2s_test_bp_pkg.batch_parser"] = module
    spec.loader.exec_module(module)
    return module