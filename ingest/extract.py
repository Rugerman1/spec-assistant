"""Extract and chunk the SCDOT Standard Specifications PDF.

Usage (from the repo root):
    python ingest/extract.py data/2025_SCDOT_Standard_Specifications.pdf

Writes data/chunks.jsonl (one chunk per line) and prints a short report so
you can eyeball whether the chunking looks right before loading anything.
"""

from __future__ import annotations

import json
import statistics
import sys
from collections import Counter
from pathlib import Path

import pymupdf

from chunk import chunk_pages

EDITION = "2025"


def read_pages(pdf_path: Path) -> list[str]:
    with pymupdf.open(pdf_path) as doc:
        # sort=True reads blocks top-to-bottom, left-to-right, which keeps
        # two-column pages and table rows in reading order.
        return [page.get_text("text", sort=True) for page in doc]


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    pdf = Path(sys.argv[1])
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("data/chunks.jsonl")

    pages = read_pages(pdf)
    chunks = chunk_pages(pages)
    for c in chunks:
        c["edition"] = EDITION

    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8") as f:
        for c in chunks:
            f.write(json.dumps(c, ensure_ascii=False) + "\n")

    sizes = [len(c["text"]) for c in chunks]
    sections = Counter(c["section_no"] for c in chunks)
    print(f"{len(pages)} pages -> {len(chunks)} chunks in {len(sections)} sections -> {out}")
    if sizes:
        print(f"chunk size (chars): median {statistics.median(sizes):.0f}, "
              f"min {min(sizes)}, max {max(sizes)}")
    print("sample:")
    for c in chunks[:: max(1, len(chunks) // 5)][:5]:
        print(f"  [{c['id']}] {c['path']} (p. {c['page_label'] or c['page_start']})")
        print("   ", c["text"][:160].replace("\n", " "), "...")


if __name__ == "__main__":
    main()
