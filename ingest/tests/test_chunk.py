"""Run with: python -m unittest discover -s ingest/tests

The sample text below is made up to look like the spec's layout (page
header, DIVISION line, "Section 901 — Title", numbered paragraphs, printed
page numbers). It is not real SCDOT text."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import chunk  # noqa: E402

HEADER = "Division 900                                        Section 901"

TOC = "\n".join([
    "TABLE OF CONTENTS",
    "SECTION 901",
    "SAMPLE MATERIALS",
    "901.1  Description ........................ 900-1",
    "901.2  Materials .......................... 900-1",
    "901.2.1  Water ............................ 900-1",
    "901.2.2  Aggregate ........................ 900-2",
    "901.3  Measurement ........................ 900-3",
    "i",
])

PAGE1 = "\n".join([
    HEADER,
    "                    DIVISION 900",
    "                 SAMPLE DIVISION",
    "       Section 901 — Sample Materials for Testing the",
    "                 Chunker",
    "   901.1   Description",
    "1   This section covers the sample materials used to test the chunker. It",
    "    continues on a second line that wraps mid-sentence.",
    "   901.2   Materials",
    "   901.2.1   Water",
    "1   Use water that is clean and free of oil, acid, and organic matter. Test",
    "    the water as directed in Subsection",
    "    901.3 of these sample specifications when requested by the RCE.",
    "2   Water from  wells  is  acceptable  if it is tested every 30 days.",
    "                       900-1",
])

PAGE2 = "\n".join([
    HEADER,
    "   901.2.2   Aggregate for Use in Portland Cement",
    "   Concrete",
    "1   Use coarse aggregate meeting the gradation in the table below.",
    "    Sieve Size   Percent Passing",
    "    1 inch       100",
    "    3/4 inch     90-100",
    "                       900-2",
])

PAGE3 = "\n".join([
    HEADER,
    "   901.3   Measurement",
    "1   The quantity is measured by the cubic yard of material placed and ac-",
    "    cepted.",
    "                       900-3",
])


class ChunkTests(unittest.TestCase):
    def setUp(self):
        self.chunks = chunk.chunk_pages([TOC, PAGE1, PAGE2, PAGE3])
        self.by_id = {c["id"]: c for c in self.chunks}

    def test_sections_found_in_order(self):
        self.assertEqual([c["id"] for c in self.chunks], ["901.1", "901.2.1", "901.2.2", "901.3"])

    def test_toc_and_headers_dropped(self):
        all_text = " ".join(c["text"] for c in self.chunks)
        self.assertNotIn("....", all_text)
        self.assertNotIn("Division 900", all_text)
        self.assertNotIn("900-1", all_text)

    def test_wrapped_reference_is_not_a_heading(self):
        # "901.3 of these sample..." starts a line but is part of 901.2.1.
        self.assertIn("Subsection 901.3 of these sample specifications", self.by_id["901.2.1"]["text"])
        self.assertIn("measured by the cubic yard", self.by_id["901.3"]["text"])

    def test_path_and_metadata(self):
        c = self.by_id["901.2.1"]
        self.assertEqual(
            c["path"],
            "Section 901 Sample Materials for Testing the Chunker > 901.2 Materials > 901.2.1 Water",
        )
        self.assertEqual(c["section_title"], "Sample Materials for Testing the Chunker")
        self.assertEqual(c["division"], "900")
        self.assertEqual(c["division_title"], "Sample Division")
        self.assertEqual(c["page_label"], "900-1")

    def test_wrapped_subsection_heading(self):
        c = self.by_id["901.2.2"]
        self.assertEqual(c["title"], "Aggregate for Use in Portland Cement Concrete")
        self.assertTrue(c["text"].startswith("Use coarse aggregate"))
        self.assertIn("3/4 inch", c["text"])

    def test_numbered_paragraphs_become_paragraphs(self):
        text = self.by_id["901.2.1"]["text"]
        paras = text.split("\n")
        self.assertEqual(len(paras), 2)
        self.assertTrue(paras[0].startswith("Use water"))
        self.assertTrue(paras[1].startswith("Water from wells is acceptable"))
        self.assertNotIn("  ", text)  # justified-text gaps collapsed

    def test_wrapped_lines_rejoined(self):
        self.assertIn("It continues on a second line", self.by_id["901.1"]["text"])
        self.assertIn("placed and accepted", self.by_id["901.3"]["text"])

    def test_long_units_split_with_overlap(self):
        long_para = " ".join(["The contractor shall do a sample thing."] * 150)
        pages = [PAGE1.replace("2   Water from  wells", "2   " + long_para + " Water from wells")]
        chunks = chunk.chunk_pages(pages)
        parts = [c for c in chunks if c["section"] == "901.2.1"]
        self.assertGreater(len(parts), 1)
        self.assertEqual(parts[0]["id"], "901.2.1#1")
        self.assertTrue(all(len(p["text"]) <= chunk.MAX_CHARS for p in parts))


if __name__ == "__main__":
    unittest.main()
