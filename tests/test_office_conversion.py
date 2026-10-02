"""Legacy Office conversion: platform discovery and concurrent-safe profiles."""

from pathlib import Path
from types import SimpleNamespace

import pytest
from helpers import load_parser_module


@pytest.mark.parametrize("system", ["Linux", "Windows", "Darwin"])
def test_legacy_office_conversion_uses_isolated_profile(tmp_path, monkeypatch, system):
    module = load_parser_module(f"office_{system}_under_test")
    monkeypatch.setattr(module.platform, "system", lambda: system)
    monkeypatch.setattr(
        module.subprocess, "CREATE_NO_WINDOW", 0x08000000, raising=False
    )
    source = tmp_path / "report.doc"
    source.write_bytes(b"legacy Word document")
    calls = []

    def convert(command, **kwargs):
        calls.append((command, kwargs))
        if system == "Darwin" and command[0] in {"libreoffice", "soffice"}:
            raise FileNotFoundError(command[0])
        output = Path(command[command.index("--outdir") + 1])
        (output / "report.pdf").write_bytes(b"%PDF-1.4\n" + b"x" * 200)
        return SimpleNamespace(returncode=0, stderr="")

    monkeypatch.setattr(module.subprocess, "run", convert)
    result = module.Parser.convert_office_to_pdf(source, str(tmp_path / "output"))
    assert result.is_file()
    command, kwargs = calls[-1]
    profile = next(arg for arg in command if arg.startswith("-env:UserInstallation="))
    assert profile.startswith("-env:UserInstallation=file:")
    assert "profile" in profile
    assert kwargs["timeout"] == 60
    if system == "Windows":
        assert kwargs["creationflags"] == module.subprocess.CREATE_NO_WINDOW
    if system == "Darwin":
        assert command[0] == "/Applications/LibreOffice.app/Contents/MacOS/soffice"


def test_zero_exit_without_pdf_retries_next_command(tmp_path, monkeypatch):
    module = load_parser_module("office_retry_under_test")
    monkeypatch.setattr(module.platform, "system", lambda: "Linux")
    source = tmp_path / "report.doc"
    source.touch()
    commands = []

    def convert(command, **kwargs):
        commands.append(command[0])
        if command[0] == "soffice":
            output = Path(command[command.index("--outdir") + 1])
            (output / "report.pdf").write_bytes(b"%PDF-1.4\n" + b"x" * 200)
        return SimpleNamespace(returncode=0, stderr="")

    monkeypatch.setattr(module.subprocess, "run", convert)
    assert module.Parser.convert_office_to_pdf(
        source, str(tmp_path / "output")
    ).is_file()
    assert commands == ["libreoffice", "soffice"]


def test_missing_office_reports_filename_and_install_instructions(
    tmp_path, monkeypatch
):
    module = load_parser_module("office_missing_under_test")
    monkeypatch.setattr(module.platform, "system", lambda: "Linux")
    source = tmp_path / "report.doc"
    source.touch()

    def missing(*args, **kwargs):
        raise FileNotFoundError("No converter installed")

    monkeypatch.setattr(module.subprocess, "run", missing)
    with pytest.raises(RuntimeError, match="report.doc") as raised:
        module.Parser.convert_office_to_pdf(source, str(tmp_path / "output"))
    assert "ensure LibreOffice is installed" in str(raised.value)
