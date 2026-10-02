"""Issue #29: hard proofs against the real vendored modules.

Run with: PYTHONPATH=$PWD .venv-test/bin/python tests/test_issue29_e2e.py

Scenarios (mirroring the issue report):
  A. Config dataclass resolves PARSE_TIMEOUT_S/PARSE_FALLBACK_ENABLED via
     lightrag get_env_value (the real RAGAnythingConfig fields).
  B. A hung mineru subprocess (sleeps forever) is killed at PARSE_TIMEOUT_S
     and surfaces as MineruExecutionError; fallback then recovers via docling.
     The fake binaries live in tests/fake_bin so no real parser is needed.
"""

import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))
sys.path.insert(0, str(PROJECT_ROOT / "paper2slides"))

FAKE_BIN = Path(__file__).parent / "fake_bin"
# The runner itself has lightrag installed; subprocesses must use the same env.
py = sys.executable


def _make_pdf(base: Path, stem: str) -> Path:
    pdf = base / f"{stem}.pdf"
    pdf.write_bytes(b"%PDF-1.4 fake pdf for issue29 hang test")
    return pdf


def env_set(key: str, value: str):
    os.environ[key] = value


def env_del(key: str):
    os.environ.pop(key, None)


def scenario_a():
    """RAGAnythingConfig resolves the new parsing knobs from env.

    Field defaults bake env values at import time (same as every other vendored
    config field), so this scenario runs fresh subprocesses: one with the env
    set, one without, proving both the override and the 1800 default.
    """
    code = (
        "import sys; sys.path.insert(0, {root!r}); sys.path.insert(0, {pkg!r})\n"
        "from paper2slides.raganything.config import RAGAnythingConfig\n"
        "c = RAGAnythingConfig()\n"
        "print(c.parse_timeout_s, int(c.parse_fallback_enabled))\n"
    ).format(root=str(PROJECT_ROOT), pkg=str(PROJECT_ROOT / "paper2slides"))

    with_env = subprocess.run(
        [py, "-c", code],
        env={**os.environ, "PARSE_TIMEOUT_S": "1234", "PARSE_FALLBACK_ENABLED": "false"},
        capture_output=True,
        text=True,
        cwd=str(PROJECT_ROOT),
    )
    assert with_env.returncode == 0, with_env.stderr[-500:]
    timeout_s, fallback = with_env.stdout.split()
    assert timeout_s == "1234" and fallback == "0", with_env.stdout

    without_env = subprocess.run(
        [py, "-c", code],
        env={k: v for k, v in os.environ.items() if k not in ("PARSE_TIMEOUT_S", "PARSE_FALLBACK_ENABLED")},
        capture_output=True,
        text=True,
        cwd=str(PROJECT_ROOT),
    )
    assert without_env.returncode == 0, without_env.stderr[-500:]
    timeout_s, fallback = without_env.stdout.split()
    assert timeout_s == "1800" and fallback == "1", without_env.stdout
    print("[A] OK  RAGAnythingConfig: env override + defaults (fresh processes)")


def scenario_b():
    """Hung mineru is deadline-killed; docling fallback recovers.
    The fallback docling markdown must be found by rglob like in real runs."""
    from paper2slides.raganything.parser import MineruExecutionError
    from paper2slides.raganything.batch_parser import BatchParser

    # Fallback docling "succeeds" immediately (real docling CLI layout:
    # --output DIR input.pdf -> DIR/<stem>/docling/<stem>.md).
    docling_dir = FAKE_BIN
    fake_docling = docling_dir / "docling"
    fake_docling.write_text(
        "#!/bin/sh\n"
        'out=""; next=0; input=""\n'
        'for a in "$@"; do\n'
        '  if [ "$next" = "1" ]; then out="$a"; next=0; continue; fi\n'
        '  case "$a" in\n'
        '    --output) next=1 ;;\n'
        '    --to|--json|--md) : ;;\n'
        '    *) input="$a" ;;\n'
        "  esac\n"
        "done\n"
        'base=$(basename "$input" .pdf)\n'
        'dir="$out/$base/docling"\n'
        'mkdir -p "$dir"\n'
        "printf '# Fake docling fallback output\\n' > \"$dir/$base.md\"\n",
        encoding="utf-8",
    )
    os.chmod(fake_docling, 0o755)
    env_set("PATH", f"{docling_dir}:{os.environ['PATH']}")
    env_set("PARSE_TIMEOUT_S", "2")
    env_set("PARSE_FALLBACK_ENABLED", "true")

    bp = BatchParser(parser_type="mineru", skip_installation_check=True)
    # Primary parser instance must use the fake hanging mineru
    bp.parser = __import__(
        "paper2slides.raganything.parser", fromlist=["MineruParser"]
    ).MineruParser()

    with tempfile.TemporaryDirectory() as tmp:
        pdf = _make_pdf(Path(tmp), "longpaper")
        out = Path(tmp) / "rag_output"
        start = time.monotonic()
        ok, fpath, err = bp.process_single_file(str(pdf), str(out))
        elapsed = time.monotonic() - start

        assert ok, f"fallback did not recover: {err}"
        assert elapsed < 30, f"hang not killed in time: {elapsed:.1f}s"
        md_files = list(out.rglob("*.md"))
        assert md_files, f"no markdown after fallback: {list(out.rglob('*'))}"
        recovered = md_files[0].read_text(encoding="utf-8")
        assert "Fake docling fallback output" in recovered
        # The hung mineru process must no longer be alive (deadline killed it)
        leftovers = subprocess.run(
            ["pgrep", "-f", "sleep 300"], capture_output=True, text=True
        )
        assert (
            leftovers.returncode != 0
        ), f"hung mineru 'sleep 300' still alive: {leftovers.stdout}"
        print(
            f"[B] OK  hung mineru killed at deadline ({elapsed:.1f}s), "
            f"docling fallback recovered markdown: {md_files[0].name}"
        )


if __name__ == "__main__":
    scenario_a()
    scenario_b()
    print("ALL ISSUE #29 E2E PROOFS PASSED")