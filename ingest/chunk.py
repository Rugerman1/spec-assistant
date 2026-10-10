"""Turn the text of a spec PDF into section-sized chunks.

RAG terms used here:
- A *chunk* is one piece of the document that gets searched and handed to
  Claude. Good chunks follow the document's own structure, so every chunk
  here is one numbered subsection (like 701.2.4), split further only when a
  subsection is too long.
- A *contextual header* is the breadcrumb ("Section 701 Portland Cement
  Concrete > 701.2 Materials > 701.2.4 Water") stored with each chunk. It
  helps search, because a short subsection like "Water" means nothing on its
  own.

This file only works on plain text, so it can be unit tested without a PDF.
extract.py does the PDF part.
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass, field, asdict

# Headings in the SCDOT spec look like:
#   DIVISION 700
#   STRUCTURES
#   SECTION 701
#   PORTLAND CEMENT CONCRETE
#   701.1 Description
#   701.2.4 Water
DIVISION_RE = re.compile(r"^DIVISION\s+(\d{3})\s*$")
SECTION_RE = re.compile(r"^SECTION\s+(\d{3})\s*$")
SUBSECTION_RE = re.compile(r"^(\d{3}(?:\.\d{1,3}){1,5})\.?\s+(\S.{0,150})$")
# Printed page numbers in the footer, like "700-12".
PAGE_LABEL_RE = re.compile(r"^(\d{3}-\d{1,3})$")
ROMAN_RE = re.compile(r"^[ivxlc]{1,6}$", re.IGNORECASE)
DOT_LEADER_RE = re.compile(r"\.{5,}|(?:\. ){4,}")

# About 500 tokens. Long enough to hold a full requirement with its
# conditions, short enough that the retrieved set stays focused.
MAX_CHARS = 2200
OVERLAP_CHARS = 250
MIN_BODY_CHARS = 40


@dataclass
class Line:
    text: str
    page: int  # 1-based PDF page
    label: str  # printed page label like "700-12", or "" if unknown


@dataclass
class Unit:
    section: str  # "701.2.4"
    title: str  # "Water"
    division: str  # "700"
    division_title: str
    section_no: str  # "701"
    section_title: str  # "PORTLAND CEMENT CONCRETE"
    parents: list[tuple[str, str]] = field(default_factory=list)
    lines: list[Line] = field(default_factory=list)


@dataclass
class Chunk:
    id: str
    section: str
    title: str
    section_no: str
    section_title: str
    division: str
    division_title: str
    path: str
    page_start: int
    page_end: int
    page_label: str
    text: str


def _norm(line: str) -> str:
    return re.sub(r"\d+", "#", line.strip())


def clean_pages(pages: list[str]) -> list[Line]:
    """Split pages into lines, keep each line's page, and drop running
    headers/footers (lines that repeat on many pages) and table-of-contents
    lines with dot leaders."""
    split = [[l.rstrip() for l in p.splitlines()] for p in pages]
    counts: Counter[str] = Counter()
    for lines in split:
        # Count each distinct (digit-normalized) line once per page.
        counts.update({_norm(l) for l in lines if l.strip()})
    threshold = max(3, int(len(pages) * 0.3))
    repeating = {k for k, v in counts.items() if v >= threshold}

    out: list[Line] = []
    for i, lines in enumerate(split, start=1):
        if sum(1 for l in lines if DOT_LEADER_RE.search(l)) >= 5:
            continue  # a table-of-contents page
        label = ""
        for l in lines:
            m = PAGE_LABEL_RE.match(l.strip())
            if m:
                label = m.group(1)
        for l in lines:
            s = l.strip()
            if not s:
                continue
            if PAGE_LABEL_RE.match(s) or ROMAN_RE.match(s):
                continue
            if _norm(s) in repeating and not SECTION_RE.match(s):
                continue
            if DOT_LEADER_RE.search(s):
                continue
            out.append(Line(s, i, label))
    return out


def _num_key(num: str) -> tuple[int, ...]:
    return tuple(int(x) for x in num.split("."))


def parse_units(lines: list[Line]) -> list[Unit]:
    """Walk the lines and group them under the subsection they belong to."""
    units: list[Unit] = []
    division = division_title = ""
    section_no = section_title = ""
    current: Unit | None = None
    last_key: tuple[int, ...] = ()
    stack: list[tuple[str, str]] = []  # open ancestors (number, title)
    i = 0
    while i < len(lines):
        s = lines[i].text
        nxt = lines[i + 1].text if i + 1 < len(lines) else ""

        m = DIVISION_RE.match(s)
        if m:
            division, division_title = m.group(1), nxt.title()
            i += 2
            continue

        m = SECTION_RE.match(s)
        if m:
            section_no, section_title = m.group(1), nxt
            current = Unit(section_no, section_title, division, division_title,
                           section_no, section_title)
            units.append(current)
            stack, last_key = [], (int(section_no),)
            i += 2
            continue

        m = SUBSECTION_RE.match(s)
        if m and section_no and m.group(1).split(".")[0] == section_no:
            num, rest = m.group(1), m.group(2).strip()
            key = _num_key(num)
            prev = lines[i - 1].text if i else ""
            # A real heading moves forward in numbering, starts with a capital
            # letter, and doesn't continue a cross-reference. This filters out
            # wrapped sentences like "...as directed in Subsection / 105.2 of".
            looks_like_heading = (
                key > last_key
                and len(key) - len(last_key) <= 1
                and rest[:1].isupper()
                and not re.search(r"\b(Subsections?|Sections?|and|or|in|of|to)$", prev)
            )
            if looks_like_heading:
                title, body = _split_heading(rest)
                while stack and not num.startswith(stack[-1][0] + "."):
                    stack.pop()
                current = Unit(num, title, division, division_title,
                               section_no, section_title, parents=list(stack))
                if body:
                    current.lines.append(Line(body, lines[i].page, lines[i].label))
                units.append(current)
                stack.append((num, title))
                last_key = key
                i += 1
                continue

        if current is not None:
            current.lines.append(lines[i])
        i += 1
    return units


def _split_heading(rest: str) -> tuple[str, str]:
    """'Water. Use water that ...' -> ('Water', 'Use water that ...').
    Most headings sit alone on their line; deep ones may run into text."""
    m = re.match(r"^([^.:]{1,80})[.:]\s+(.+)$", rest)
    if m and m.group(1)[:1].isupper():
        return m.group(1).strip(), m.group(2).strip()
    return rest.rstrip(".:"), ""


def _join(lines: list[Line]) -> str:
    """Rejoin PDF lines into paragraphs. A line that ends a sentence, or a
    next line that starts a list item, starts a new paragraph."""
    out: list[str] = []
    for ln in lines:
        t = ln.text
        if out and not re.search(r"[.:;]$", out[-1]) and not re.match(r"^(\(?[A-Za-z0-9]{1,3}[.)]|•|-)\s", t):
            # Mid-sentence wrap; also undo hyphenated line breaks.
            if out[-1].endswith("-") and t[:1].islower():
                out[-1] = out[-1][:-1] + t
            else:
                out[-1] = out[-1] + " " + t
        else:
            out.append(t)
    return "\n".join(out)


def _split_long(text: str) -> list[str]:
    if len(text) <= MAX_CHARS:
        return [text]
    paras = text.split("\n")
    parts: list[str] = []
    cur = ""
    for p in paras:
        while len(p) > MAX_CHARS:  # one giant paragraph: hard split on a sentence
            cut = p.rfind(". ", 0, MAX_CHARS)
            cut = cut + 1 if cut > MAX_CHARS // 2 else MAX_CHARS
            if cur:
                parts.append(cur)
                cur = ""
            parts.append(p[:cut].strip())
            p = p[cut:].strip()
        if cur and len(cur) + len(p) + 1 > MAX_CHARS:
            parts.append(cur)
            cur = cur[-OVERLAP_CHARS:].split(" ", 1)[-1] + "\n" + p  # carry a little context over
        else:
            cur = f"{cur}\n{p}" if cur else p
    if cur:
        parts.append(cur)
    return parts


def build_chunks(units: list[Unit]) -> list[Chunk]:
    chunks: list[Chunk] = []
    for u in units:
        body = _join(u.lines).strip()
        if len(body) < MIN_BODY_CHARS:
            continue  # heading-only units: their title still appears in children's paths
        crumbs = [f"Section {u.section_no} {u.section_title.title()}"]
        crumbs += [f"{n} {t}" for n, t in u.parents]
        if u.section != u.section_no:
            crumbs.append(f"{u.section} {u.title}")
        path = " > ".join(crumbs)
        parts = _split_long(body)
        for n, part in enumerate(parts, start=1):
            cid = u.section if len(parts) == 1 else f"{u.section}#{n}"
            chunks.append(Chunk(
                id=cid, section=u.section, title=u.title if u.section != u.section_no else u.section_title.title(),
                section_no=u.section_no, section_title=u.section_title.title(),
                division=u.division, division_title=u.division_title,
                path=path, page_start=u.lines[0].page, page_end=u.lines[-1].page,
                page_label=u.lines[0].label, text=part,
            ))
    return _dedupe_ids(chunks)


def _dedupe_ids(chunks: list[Chunk]) -> list[Chunk]:
    """Rare duplicate numbers (a typo in the PDF) would overwrite each other
    in the index, so give repeats a suffix."""
    seen: Counter[str] = Counter()
    for c in chunks:
        seen[c.id] += 1
        if seen[c.id] > 1:
            c.id = f"{c.id}~{seen[c.id]}"
    return chunks


def chunk_pages(pages: list[str]) -> list[dict]:
    return [asdict(c) for c in build_chunks(parse_units(clean_pages(pages)))]
