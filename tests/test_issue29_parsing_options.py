"""Issue #29 tests: parser timeout engine + BatchParser env/skip behavior."""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
from helpers import load_parser_module, load_batch_parser_module

batch_parser = load_batch_parser_module()


class GetParseTimeoutTests(unittest.TestCase):
    """_get_parse_timeout_s env parsing (issue #29 option 2)."""

    def setUp(self):
        self._orig = os.environ.pop("PARSE_TIMEOUT_S", None)

    def tearDown(self):
        if self._orig is None:
            os.environ.pop("PARSE_TIMEOUT_S", None)
        else:
            os.environ["PARSE_TIMEOUT_S"] = self._orig

    def test_default_1800(self):
        parser_mod = load_parser_module("_p2s_t_default")
        self.assertEqual(parser_mod._get_parse_timeout_s(), 1800)

    def test_env_value_respected(self):
        os.environ["PARSE_TIMEOUT_S"] = "300"
        parser_mod = load_parser_module("_p2s_t_env")
        self.assertEqual(parser_mod._get_parse_timeout_s(), 300)

    def test_zero_disables(self):
        os.environ["PARSE_TIMEOUT_S"] = "0"
        parser_mod = load_parser_module("_p2s_t_zero")
        self.assertEqual(parser_mod._get_parse_timeout_s(), 0)

    def test_invalid_falls_back_to_default(self):
        os.environ["PARSE_TIMEOUT_S"] = "garbage"
        parser_mod = load_parser_module("_p2s_t_bad")
        self.assertEqual(parser_mod._get_parse_timeout_s(), 1800)


class BatchParserEnvTests(unittest.TestCase):
    """BatchParser env resolution: PARSER / SKIP_PARSING / fallback flag."""

    def setUp(self):
        self._saved = {
            k: os.environ.pop(k, None)
            for k in ("PARSER", "SKIP_PARSING", "PARSE_FALLBACK_ENABLED")
        }

    def tearDown(self):
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def _make(self, env=None, parser_type=None, skip_parsing=None):
        for k, v in (env or {}).items():
            os.environ[k] = v
        return batch_parser.BatchParser(
            parser_type=parser_type,
            skip_installation_check=True,
            skip_parsing=skip_parsing,
        )

    def test_default_parser_is_mineru(self):
        self.assertEqual(self._make({"PARSER": ""}).parser_type, "mineru")

    def test_env_selects_docling(self):
        bp = self._make({"PARSER": "docling"})
        self.assertEqual(bp.parser_type, "docling")

    def test_invalid_env_falls_back_to_mineru(self):
        self.assertEqual(self._make({"PARSER": "pdfplumber"}).parser_type, "mineru")

    def test_explicit_parser_wins_over_env(self):
        os.environ["PARSER"] = "docling"
        self.assertEqual(self._make(parser_type="mineru").parser_type, "mineru")

    def test_skip_parsing_param_wins_over_env(self):
        os.environ["SKIP_PARSING"] = "true"
        self.assertFalse(self._make(skip_parsing=False).skip_parsing)
        self.assertTrue(self._make(skip_parsing=True).skip_parsing)

    def test_skip_parsing_env_true(self):
        self.assertTrue(self._make({"SKIP_PARSING": "true"}).skip_parsing)

    def test_skip_parsing_default_false(self):
        self.assertFalse(self._make({}).skip_parsing)

    def test_fallback_enabled_by_default(self):
        self.assertTrue(self._make({}).parse_fallback_enabled)

    def test_fallback_env_false(self):
        self.assertFalse(
            self._make({"PARSE_FALLBACK_ENABLED": "false"}).parse_fallback_enabled
        )


class SkipParsingTests(unittest.TestCase):
    """SKIP_PARSING accept pre-parsed content (issue #29 option 3)."""

    def test_md_copied_verbatim(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "input.md"
            src.write_text("# Title\n\nContent paragraph", encoding="utf-8")
            out = Path(tmp) / "out"
            ok, _, err = batch_parser.BatchParser._copy_preparsed_file(str(src), str(out))
            self.assertTrue(ok, err)
            self.assertEqual(
                (out / "input.md").read_text(encoding="utf-8"),
                "# Title\n\nContent paragraph",
            )

    def test_mineru_json_becomes_markdown(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "input.json"
            src.write_text(
                json.dumps(
                    [
                        {"type": "text", "text": "Intro paragraph"},
                        {"type": "image", "img_path": "images/fig1.jpg"},
                        {"type": "table", "table_body": "<table><tr><td>1</td></tr></table>"},
                        {"type": "equation", "text": "E = mc^2"},
                    ]
                ),
                encoding="utf-8",
            )
            out = Path(tmp) / "out"
            ok, _, err = batch_parser.BatchParser._copy_preparsed_file(str(src), str(out))
            self.assertTrue(ok, err)
            md = (out / "input.md").read_text(encoding="utf-8")
            self.assertIn("Intro paragraph", md)
            self.assertIn("![image](images/fig1.jpg)", md)
            self.assertIn("<table>", md)
            self.assertIn("E = mc^2", md)

    def test_unsupported_extension_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "input.pdf"
            src.write_bytes(b"%PDF-1.4 fake")
            out = Path(tmp) / "out"
            ok, _, err = batch_parser.BatchParser._copy_preparsed_file(str(src), str(out))
            self.assertFalse(ok)
            self.assertIn("SKIP_PARSING expects", str(err))

    def test_non_list_json_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "input.json"
            src.write_text('{"title": 1}', encoding="utf-8")
            out = Path(tmp) / "out"
            ok, _, err = batch_parser.BatchParser._copy_preparsed_file(str(src), str(out))
            self.assertFalse(ok)
            self.assertIn("must be a MinerU content list (array)", str(err))

    def test_process_single_file_skip_bypasses_parser(self):
        bp = batch_parser.BatchParser(
            skip_installation_check=True, skip_parsing=True
        )
        bp.parser = mock.MagicMock()
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "ready.md"
            src.write_text("hello", encoding="utf-8")
            ok, _, err = bp.process_single_file(str(src), str(Path(tmp) / "out"))
            self.assertTrue(ok, err)
            self.assertEqual(bp.parser.parse_document.call_count, 0)


class BatchParserFallbackTests(unittest.TestCase):
    """Cross-parser fallback for PDF failures (issue #29 option 2)."""

    def _make_bp(self, parser_type="mineru"):
        bp = batch_parser.BatchParser(
            parser_type=parser_type, skip_installation_check=True
        )
        bp.parser = mock.MagicMock()
        return bp

    def test_fallback_on_primary_failure(self):
        bp = self._make_bp("mineru")
        bp.parser.parse_document.side_effect = RuntimeError("mineru exploded")
        alt = mock.MagicMock()
        alt_md = Path("/tmp/alt/fallback_docling/doc.md")
        alt_md.parent.mkdir(parents=True, exist_ok=True)
        alt_md.write_text("# recovered", encoding="utf-8")
        alt.parse_document.return_value = []
        with mock.patch.object(
            batch_parser.BatchParser, "_instantiate_parser", return_value=alt
        ) as mk, mock.patch.object(
            batch_parser.Path, "rglob", return_value=iter([alt_md])
        ):
            with tempfile.TemporaryDirectory() as tmp:
                pdf = Path(tmp) / "doc.pdf"
                pdf.write_bytes(b"%PDF-1.4 fake")
                ok, _, err = bp.process_single_file(str(pdf), str(Path(tmp) / "out"))
                self.assertTrue(ok, err)
                mk.assert_called_once_with("docling")
                self.assertEqual(alt.parse_document.call_count, 1)

    def test_no_fallback_when_disabled(self):
        bp = self._make_bp("mineru")
        bp.parse_fallback_enabled = False
        bp.parser.parse_document.side_effect = RuntimeError("boom")
        with tempfile.TemporaryDirectory() as tmp:
            pdf = Path(tmp) / "doc.pdf"
            pdf.write_bytes(b"%PDF-1.4 fake")
            ok, _, err = bp.process_single_file(str(pdf), str(Path(tmp) / "out"))
            self.assertFalse(ok)
            self.assertIn("boom", err)

    def test_no_fallback_for_non_pdf(self):
        bp = self._make_bp("docling")
        bp.parser.parse_document.side_effect = RuntimeError("docling died")
        with tempfile.TemporaryDirectory() as tmp:
            txt = Path(tmp) / "doc.txt"
            txt.write_text("text", encoding="utf-8")
            ok, _, err = bp.process_single_file(str(txt), str(Path(tmp) / "out"))
            self.assertFalse(ok)
            self.assertIn("docling died", err)


if __name__ == "__main__":
    unittest.main()