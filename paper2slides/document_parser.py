"""Read text and DOCX inputs without converting them to PDF."""

import hashlib
import json
import re
import shutil
from pathlib import Path
from urllib.parse import unquote, urlparse
from xml.sax.saxutils import escape

from .file_formats import TEXT_FORMATS


def parse_native_document(file_path, output_dir=None):
    """Write markdown and MinerU-compatible blocks for the downstream stages.

    Each source gets its own directory, including its extension, so notes.md
    and notes.docx can be processed together without overwriting one another.
    """
    source = Path(file_path).resolve()
    if not source.is_file():
        raise FileNotFoundError(f"Document does not exist: {source}")
    root = Path(output_dir) if output_dir else source.parent / "parsed_output"
    destination = root / f"{source.name}.parsed" / "native"
    destination.mkdir(parents=True, exist_ok=True)
    if source.suffix.lower() in TEXT_FORMATS:
        markdown, blocks = _read_text(source, destination)
    elif source.suffix.lower() == ".docx":
        markdown, blocks = _read_docx(source, destination)
    else:
        raise ValueError(f"Unsupported native document format: {source.suffix}")
    if not blocks:
        raise ValueError(f"Document is empty: {source.name}")
    (destination / f"{source.stem}.md").write_text(markdown, encoding="utf-8")
    (destination / f"{source.stem}_content_list.json").write_text(
        json.dumps(blocks, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return blocks


def _read_text(source, destination):
    # UTF-8 BOM is common in notes exported from Windows editors.
    try:
        markdown = source.read_text(encoding="utf-8-sig")
    except UnicodeDecodeError as exc:
        raise ValueError(
            f"Cannot read {source.name}: save the document as UTF-8"
        ) from exc
    if not markdown.strip():
        return markdown, []

    images_blocks = []

    def copy_image(match):
        target = match.group(2)
        parsed = urlparse(target.strip("<>"))
        if parsed.scheme or parsed.netloc:
            return match.group(0)
        image = source.parent / unquote(parsed.path)
        if not image.is_file():
            return match.group(0)
        name = (
            hashlib.sha256(str(image.resolve()).encode()).hexdigest()[:16]
            + image.suffix
        )
        images = destination / "images"
        images.mkdir(exist_ok=True)
        shutil.copy2(image, images / name)
        images_blocks.append(
            {"type": "image", "img_path": str((images / name).resolve()), "page_idx": 0}
        )
        return f"![{match.group(1)}](images/{name})"

    if source.suffix.lower() != ".txt":
        markdown = re.sub(r"!\[([^\]]*)\]\((<[^>]+>|[^\s)]+)\)", copy_image, markdown)
    blocks = [{"type": "text", "text": markdown, "page_idx": 0}]
    return markdown, blocks + images_blocks


def _read_docx(source, destination):
    from docx import Document
    from docx.oxml.ns import qn
    from docx.table import Table

    try:
        document = Document(source)
    except Exception as exc:
        raise ValueError(f"Cannot read Word document {source.name}: {exc}") from exc
    sections = []
    blocks = []
    for element in document.iter_inner_content():
        if isinstance(element, Table):
            rows = []
            for row in element.rows:
                cells = "".join(
                    f"<td>{escape(cell.text).replace(chr(10), '<br/>')}</td>"
                    for cell in row.cells
                )
                rows.append(f"<tr>{cells}</tr>")
            table = "<table>\n" + "\n".join(rows) + "\n</table>"
            sections.append(table)
            blocks.append({"type": "table", "table_body": table, "page_idx": 0})
            continue
        text = element.text.strip()
        if text:
            style = element.style.name if element.style else ""
            heading = re.fullmatch(r"Heading ([1-6])", style)
            if heading:
                text = "#" * int(heading.group(1)) + " " + text
            elif style == "Title":
                text = "# " + text
            sections.append(text)
            blocks.append({"type": "text", "text": text, "page_idx": 0})
        for blip in element._p.iter(qn("a:blip")):
            relationship = blip.get(qn("r:embed"))
            if not relationship:
                continue
            image = document.part.related_parts[relationship]
            image_name = (
                hashlib.sha256(image.blob).hexdigest()[:16]
                + Path(str(image.partname)).suffix
            )
            images = destination / "images"
            images.mkdir(exist_ok=True)
            image_path = images / image_name
            image_path.write_bytes(image.blob)
            sections.append(f"![](images/{image_name})")
            blocks.append(
                {"type": "image", "img_path": str(image_path.resolve()), "page_idx": 0}
            )
    return "\n\n".join(sections) + "\n", blocks
