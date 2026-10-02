"""
Batch and Parallel Document Parsing

This module provides functionality for processing multiple documents in parallel,
with progress reporting and error handling.
"""

import asyncio
import json
import logging
import os
import shutil
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass
import time

from tqdm import tqdm

from .parser import MineruParser, DoclingParser


@dataclass
class BatchProcessingResult:
    """Result of batch processing operation"""

    successful_files: List[str]
    failed_files: List[str]
    total_files: int
    processing_time: float
    errors: Dict[str, str]
    output_dir: str

    @property
    def success_rate(self) -> float:
        """Calculate success rate as percentage"""
        if self.total_files == 0:
            return 0.0
        return (len(self.successful_files) / self.total_files) * 100

    def summary(self) -> str:
        """Generate a summary of the batch processing results"""
        return (
            f"Batch Processing Summary:\n"
            f"  Total files: {self.total_files}\n"
            f"  Successful: {len(self.successful_files)} ({self.success_rate:.1f}%)\n"
            f"  Failed: {len(self.failed_files)}\n"
            f"  Processing time: {self.processing_time:.2f} seconds\n"
            f"  Output directory: {self.output_dir}"
        )


class BatchParser:
    """
    Batch document parser with parallel processing capabilities

    Supports processing multiple documents concurrently with progress tracking
    and comprehensive error handling.
    """

    def __init__(
        self,
        parser_type: Optional[str] = None,
        max_workers: int = 4,
        show_progress: bool = True,
        timeout_per_file: int = 300,
        skip_installation_check: bool = False,
        skip_parsing: Optional[bool] = None,
    ):
        """
        Initialize batch parser

        Args:
            parser_type: Type of parser to use ("mineru" or "docling");
                None resolves from the PARSER env var (default "mineru")
            max_workers: Maximum number of parallel workers
            show_progress: Whether to show progress bars
            timeout_per_file: Timeout in seconds for each file
            skip_installation_check: Skip parser installation check (useful for testing)
            skip_parsing: Skip parsing and accept pre-parsed content (issue #29
                option 3); None resolves from the SKIP_PARSING env var
        """
        self.logger = logging.getLogger(__name__)
        if parser_type is None:
            parser_type = (os.getenv("PARSER") or "mineru").strip().lower() or "mineru"
        if parser_type not in ("mineru", "docling"):
            self.logger.warning(
                f"Unknown PARSER={parser_type!r}, falling back to 'mineru'"
            )
            parser_type = "mineru"
        self.parser_type = parser_type
        self.max_workers = max_workers
        self.show_progress = show_progress
        self.timeout_per_file = timeout_per_file

        # Initialize parser
        if parser_type == "mineru":
            self.parser = MineruParser()
        elif parser_type == "docling":
            self.parser = DoclingParser()
        else:
            raise ValueError(f"Unsupported parser type: {parser_type}")

        # Issue #29 options 2/3: deadline-orchestration fallback and skip mode
        if skip_parsing is None:
            skip_parsing = (os.getenv("SKIP_PARSING", "") or "").strip().lower() in (
                "1",
                "true",
                "yes",
                "on",
            )
        self.skip_parsing = skip_parsing
        self.parse_fallback_enabled = (
            os.getenv("PARSE_FALLBACK_ENABLED", "true") or "true"
        ).strip().lower() in ("1", "true", "yes", "on")

        # Check parser installation (optional)
        if not skip_installation_check:
            if not self.parser.check_installation():
                self.logger.warning(
                    f"{parser_type.title()} parser installation check failed. "
                    f"This may be due to package conflicts. "
                    f"Use skip_installation_check=True to bypass this check."
                )
                # Don't raise an error, just warn - the parser might still work

    def get_supported_extensions(self) -> List[str]:
        """Get list of supported file extensions"""
        return list(
            self.parser.OFFICE_FORMATS
            | self.parser.IMAGE_FORMATS
            | self.parser.TEXT_FORMATS
            | {".pdf"}
        )

    def filter_supported_files(
        self, file_paths: List[str], recursive: bool = True
    ) -> List[str]:
        """
        Filter file paths to only include supported file types

        Args:
            file_paths: List of file paths or directories
            recursive: Whether to search directories recursively

        Returns:
            List of supported file paths
        """
        supported_extensions = set(self.get_supported_extensions())
        supported_files = []

        for path_str in file_paths:
            path = Path(path_str)

            if path.is_file():
                if path.suffix.lower() in supported_extensions:
                    supported_files.append(str(path))
                else:
                    self.logger.warning(f"Unsupported file type: {path}")

            elif path.is_dir():
                if recursive:
                    # Recursively find all files
                    for file_path in path.rglob("*"):
                        if (
                            file_path.is_file()
                            and file_path.suffix.lower() in supported_extensions
                        ):
                            supported_files.append(str(file_path))
                else:
                    # Only files in the directory (not subdirectories)
                    for file_path in path.glob("*"):
                        if (
                            file_path.is_file()
                            and file_path.suffix.lower() in supported_extensions
                        ):
                            supported_files.append(str(file_path))

            else:
                self.logger.warning(f"Path does not exist: {path}")

        return supported_files

    @staticmethod
    def _instantiate_parser(parser_type: str):
        """Instantiate a parser by type name ("mineru" or "docling")."""
        if parser_type == "mineru":
            return MineruParser()
        if parser_type == "docling":
            return DoclingParser()
        raise ValueError(f"Unsupported parser type: {parser_type}")

    @staticmethod
    def _copy_preparsed_file(file_path: str, output_dir: str) -> Tuple[bool, str, Optional[str]]:
        """Issue #29 Option 3 (SKIP_PARSING): accept pre-parsed content as-is.

        .md/.markdown/.txt files are copied verbatim into output_dir so the
        downstream markdown collection (`rglob("*.md")`) sees them. MinerU-style
        content-list JSON (.json) is flattened to markdown (text plus image/
        table/equation references mirroring what the mineru CLI emits) so a
        user-provided parse feeds slide generation identically to a real run.
        """
        src = Path(file_path)
        out_root = Path(output_dir)
        out_root.mkdir(parents=True, exist_ok=True)

        if src.suffix.lower() == ".json":
            with open(src, "r", encoding="utf-8") as f:
                content_list = json.load(f)
            if not isinstance(content_list, list):
                return False, file_path, (
                    "SKIP_PARSING JSON must be a MinerU content list (array), "
                    f"got {type(content_list).__name__}: {src}"
                )

            lines: List[str] = []
            for item in content_list:
                if not isinstance(item, dict):
                    lines.append(str(item))
                    continue
                item_type = str(item.get("type", "text"))
                if item_type == "text" or item.get("text"):
                    text = item.get("text")
                    if text:
                        lines.append(str(text))
                img_path = item.get("img_path") or item.get("image_path")
                if img_path:
                    lines.append(f"![image]({img_path})")
                for field in ("table_body", "equation", "html"):
                    if item.get(field):
                        lines.append(str(item[field]))

            dest = out_root / f"{src.stem}.md"
            with open(dest, "w", encoding="utf-8") as f:
                f.write("\n\n".join(lines) + "\n")
            return True, file_path, None

        if src.suffix.lower() not in (".md", ".markdown", ".txt"):
            return False, file_path, (
                f"SKIP_PARSING expects .md/.txt/MinerU content JSON, got {src}"
            )

        dest = out_root / src.name
        shutil.copy2(src, dest)
        return True, file_path, None

    def process_single_file(
        self, file_path: str, output_dir: str, parse_method: str = "auto", **kwargs
    ) -> Tuple[bool, str, Optional[str]]:
        """
        Process a single file

        Args:
            file_path: Path to the file to process
            output_dir: Output directory
            parse_method: Parsing method
            **kwargs: Additional parser arguments

        Returns:
            Tuple of (success, file_path, error_message)
        """
        try:
            start_time = time.time()

            # Issue #29 Option 3: accept pre-parsed content as-is
            if self.skip_parsing:
                return self._copy_preparsed_file(file_path, output_dir)

            # Create output directory if it doesn't exist
            Path(output_dir).mkdir(parents=True, exist_ok=True)

            # Parse the document
            content_list = self.parser.parse_document(
                file_path=file_path,
                output_dir=str(output_dir),
                method=parse_method,
                **kwargs,
            )

            processing_time = time.time() - start_time

            self.logger.info(
                f"Successfully processed {file_path} "
                f"({len(content_list)} content blocks, {processing_time:.2f}s)"
            )

            return True, file_path, None

        except Exception as e:
            error_msg = f"Failed to process {file_path}: {str(e)}"
            self.logger.error(error_msg)

            # Issue #29: one cross-parser retry for PDFs when the configured
            # parser failed or was terminated by PARSE_TIMEOUT_S
            if (
                self.parse_fallback_enabled
                and Path(file_path).suffix.lower() == ".pdf"
                and not self.skip_parsing
            ):
                alternate_type = "docling" if self.parser_type == "mineru" else "mineru"
                try:
                    alternate = self._instantiate_parser(alternate_type)
                    self.logger.warning(
                        f"Falling back to {alternate_type} parser for {file_path}"
                    )
                    alt_output_dir = str(Path(output_dir) / f"fallback_{alternate_type}")
                    content_list = alternate.parse_document(
                        file_path=file_path,
                        output_dir=alt_output_dir,
                        method=parse_method,
                        **kwargs,
                    )
                    alt_dir = Path(alt_output_dir)
                    markdown = sorted(alt_dir.rglob("*.md"))
                    if not markdown:
                        raise RuntimeError(
                            f"{alternate_type} fallback produced no markdown output"
                        )
                    alt_md = markdown[0]
                    dest_dir = Path(output_dir) / Path(file_path).stem
                    dest_dir.mkdir(parents=True, exist_ok=True)
                    dest = dest_dir / alt_md.name
                    shutil.copy2(alt_md, dest)
                    try:
                        images_src = alt_md.parent / "images"
                        if images_src.is_dir():
                            shutil.copytree(
                                images_src, dest_dir / "images", dirs_exist_ok=True
                            )
                    except Exception as copy_err:
                        self.logger.warning(
                            f"Could not copy fallback images: {copy_err}"
                        )
                    self.logger.info(
                        f"Recovered {file_path} via {alternate_type} fallback -> {dest}"
                    )
                    return True, file_path, None
                except Exception as fallback_error:
                    self.logger.error(
                        f"{alternate_type} fallback also failed: {fallback_error}"
                    )

            return False, file_path, error_msg

    def process_batch(
        self,
        file_paths: List[str],
        output_dir: str,
        parse_method: str = "auto",
        recursive: bool = True,
        **kwargs,
    ) -> BatchProcessingResult:
        """
        Process multiple files in parallel

        Args:
            file_paths: List of file paths or directories to process
            output_dir: Base output directory
            parse_method: Parsing method for all files
            recursive: Whether to search directories recursively
            **kwargs: Additional parser arguments

        Returns:
            BatchProcessingResult with processing statistics
        """
        start_time = time.time()

        # Filter to supported files
        supported_files = self.filter_supported_files(file_paths, recursive)

        if not supported_files:
            self.logger.warning("No supported files found to process")
            return BatchProcessingResult(
                successful_files=[],
                failed_files=[],
                total_files=0,
                processing_time=0.0,
                errors={},
                output_dir=output_dir,
            )

        self.logger.info(f"Found {len(supported_files)} files to process")

        # Create output directory
        output_path = Path(output_dir)
        output_path.mkdir(parents=True, exist_ok=True)

        # Process files in parallel
        successful_files = []
        failed_files = []
        errors = {}

        # Create progress bar if requested
        pbar = None
        if self.show_progress:
            pbar = tqdm(
                total=len(supported_files),
                desc=f"Processing files ({self.parser_type})",
                unit="file",
            )

        try:
            with ThreadPoolExecutor(max_workers=self.max_workers) as executor:
                # Submit all tasks
                future_to_file = {
                    executor.submit(
                        self.process_single_file,
                        file_path,
                        output_dir,
                        parse_method,
                        **kwargs,
                    ): file_path
                    for file_path in supported_files
                }

                # Process completed tasks
                for future in as_completed(
                    future_to_file, timeout=self.timeout_per_file
                ):
                    success, file_path, error_msg = future.result()

                    if success:
                        successful_files.append(file_path)
                    else:
                        failed_files.append(file_path)
                        errors[file_path] = error_msg

                    if pbar:
                        pbar.update(1)

        except Exception as e:
            self.logger.error(f"Batch processing failed: {str(e)}")
            # Mark remaining files as failed
            for future in future_to_file:
                if not future.done():
                    file_path = future_to_file[future]
                    failed_files.append(file_path)
                    errors[file_path] = f"Processing interrupted: {str(e)}"
                    if pbar:
                        pbar.update(1)

        finally:
            if pbar:
                pbar.close()

        processing_time = time.time() - start_time

        # Create result
        result = BatchProcessingResult(
            successful_files=successful_files,
            failed_files=failed_files,
            total_files=len(supported_files),
            processing_time=processing_time,
            errors=errors,
            output_dir=output_dir,
        )

        # Log summary
        self.logger.info(result.summary())

        return result

    async def process_batch_async(
        self,
        file_paths: List[str],
        output_dir: str,
        parse_method: str = "auto",
        recursive: bool = True,
        **kwargs,
    ) -> BatchProcessingResult:
        """
        Async version of batch processing

        Args:
            file_paths: List of file paths or directories to process
            output_dir: Base output directory
            parse_method: Parsing method for all files
            recursive: Whether to search directories recursively
            **kwargs: Additional parser arguments

        Returns:
            BatchProcessingResult with processing statistics
        """
        # Run the sync version in a thread pool
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(
            None,
            self.process_batch,
            file_paths,
            output_dir,
            parse_method,
            recursive,
            **kwargs,
        )


def main():
    """Command-line interface for batch parsing"""
    import argparse

    parser = argparse.ArgumentParser(description="Batch document parsing")
    parser.add_argument("paths", nargs="+", help="File paths or directories to process")
    parser.add_argument("--output", "-o", required=True, help="Output directory")
    parser.add_argument(
        "--parser",
        choices=["auto", "mineru", "docling"],
        default="auto",
        help="Parser to use ('auto' = PARSER env var, default 'mineru')",
    )
    parser.add_argument(
        "--skip-parsing",
        action="store_true",
        help="Skip parsing: inputs must be pre-parsed .md/.txt/MinerU content JSON",
    )
    parser.add_argument(
        "--method",
        choices=["auto", "txt", "ocr"],
        default="auto",
        help="Parsing method",
    )
    parser.add_argument(
        "--workers", type=int, default=4, help="Number of parallel workers"
    )
    parser.add_argument(
        "--no-progress", action="store_true", help="Disable progress bar"
    )
    parser.add_argument(
        "--recursive",
        action="store_true",
        default=True,
        help="Search directories recursively",
    )
    parser.add_argument(
        "--timeout", type=int, default=300, help="Timeout per file (seconds)"
    )

    args = parser.parse_args()

    # Configure logging
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    )

    try:
        # Create batch parser
        batch_parser = BatchParser(
            parser_type=None if args.parser == "auto" else args.parser,
            max_workers=args.workers,
            show_progress=not args.no_progress,
            timeout_per_file=args.timeout,
            skip_parsing=args.skip_parsing,
        )

        # Process files
        result = batch_parser.process_batch(
            file_paths=args.paths,
            output_dir=args.output,
            parse_method=args.method,
            recursive=args.recursive,
        )

        # Print summary
        print("\n" + result.summary())

        # Exit with error code if any files failed
        if result.failed_files:
            return 1

        return 0

    except Exception as e:
        print(f"Error: {str(e)}")
        return 1


if __name__ == "__main__":
    exit(main())
