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

What the 2025 SCDOT spec looks like after PyMuPDF extraction:

    Division 200                                   Section 201   <- page header
    DIVISION 200
    EARTHWORK
    Section 201 — Clearing and Grubbing
    201.1   Description
    1   Clear, grub, remove, and dispose of vegetation, obstructions, and
        debris within designated limits.
    201.3.1   General
    1   Perform clearing and grubbing work before ...
    2   Perform clearing and grubbing work by removing ...
                          200-1                                  <- page footer

Paragraphs inside a subsection are numbered (1, 2, 3) at the left margin.
Long headings wrap onto a second line.
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass, field, asdict

DIVISION_RE = re.compile(r"^DIVISION\s+(\d{3})\s*$")
# "Section 201 — Clearing and Grubbing" (the dash is what separates a real
# heading from a cross-reference like "Section 305 and thoroughly compact").
SECTION_RE = re.compile(r"^Section\s+(\d{3})\s*[—–-]+\s*(\S.*)$")
# The all-caps two-line form ("SECTION 201" / "CLEARING AND GRUBBING") that
# the table of contents uses.
SECTION_CAPS_RE = re.compile(r"^SECTION\s+(\d{3})\s*$")
# No period after the number: "203.2.1.8. When the item" is a cross-reference.
SUBSECTION_RE = re.compile(r"^(\d{3}(?:\.\d{1,3}){1,5})\s+(\S.{0,150})$")
# Numbered paragraphs: "2   When a unit of government ...". At least two
# spaces, so a wrapped line like "18 ft. Clear and grub" doesn't count.
PARA_RE = re.compile(r"^(\d{1,2})\s{2,}(\S.*)$")
LONE_NUMBER_RE = re.compile(r"^\d{1,2}$")
BULLET_RE = re.compile(r"^(•|[-–]\s|\(?[a-z0-9]{1,2}[.)]\s)")
# Printed page numbers in the footer, like "700-12".
PAGE_LABEL_RE = re.compile(r"^(\d{3}-\d{1,3})$")
# Running header on every body page.
HEADER_RE = re.compile(r"^Division\s+\d{3}\s+Section\s+\d{3}$")
ROMAN_RE = re.compile(r"^[ivxlc]{1,6}$", re.IGNORECASE)
DOT_LEADER_RE = re.compile(r"\s*(?:\.{4,}|(?:\. ){4,})\s*")
# A table-of-contents or index line: dot leaders, then a printed page number.
TOC_LINE_RE = re.compile(r"(?:\.{3,}|(?:\. ){3,})\s*\d{3}-\d{1,3}$")
# A heading that ends like this continues on the next line.
CONNECTOR_END_RE = re.compile(
    r"(\b(and|or|of|for|the|by|to|in|on|with|before|after|from|at|a|an|over)|,|&)$",
    re.IGNORECASE,
)

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
    section_title: str  # "Portland Cement Concrete"
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


def _squash(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


def _norm(line: str) -> str:
    return re.sub(r"\d+", "#", _squash(line))


def clean_pages(pages: list[str]) -> list[Line]:
    """Split pages into lines, keep each line's page, and drop running
    headers/footers (lines that repeat on many pages), table-of-contents
    pages, and printed page numbers."""
    split = [[l.rstrip() for l in p.splitlines()] for p in pages]
    counts: Counter[str] = Counter()
    for lines in split:
        # Count each distinct (digit-normalized) line once per page.
        counts.update({_norm(l) for l in lines if l.strip()})
    threshold = max(3, int(len(pages) * 0.3))
    repeating = {k for k, v in counts.items() if v >= threshold}

    out: list[Line] = []
    for i, lines in enumerate(split, start=1):
        if sum(1 for l in lines if TOC_LINE_RE.search(l.strip())) >= 5 or any(
            "TABLE OF CONTENTS" in l for l in lines
        ):
            continue  # a table-of-contents or index page
        label = ""
        for l in lines:
            m = PAGE_LABEL_RE.match(l.strip())
            if m:
                label = m.group(1)
        for l in lines:
            s = l.strip()
            if not s:
                continue
            if PAGE_LABEL_RE.match(s) or HEADER_RE.match(_squash(s)):
                continue
            if not label and ROMAN_RE.match(s):
                continue  # front-matter page numbers
            if _norm(s) in repeating and not SECTION_RE.match(s):
                continue
            if TOC_LINE_RE.search(s):
                continue
            # Table rows like "Slump ........ 7 in. to 9 in." keep their value.
            s = DOT_LEADER_RE.sub(": ", s)
            out.append(Line(s, i, label))
    return out


def _num_key(num: str) -> tuple[int, ...]:
    return tuple(int(x) for x in num.split("."))


def _is_heading_line(s: str) -> bool:
    return bool(
        PARA_RE.match(s)
        or SUBSECTION_RE.match(s)
        or SECTION_RE.match(s)
        or SECTION_CAPS_RE.match(s)
        or DIVISION_RE.match(s)
        or PAGE_LABEL_RE.match(s)
    )


STOPWORDS = {
    "a", "an", "and", "or", "of", "for", "the", "to", "in", "on", "with", "by",
    "from", "at", "over", "through", "thru", "as", "is", "are", "if", "when",
    "unless", "where", "per", "under", "until", "shall", "will", "may",
}


def _title_start(rest: str) -> bool:
    """A heading starts with a capital, a digit ("15-Lamp Arrow Panel") or a
    short lowercase word that isn't a connector ("pH Factor"); a wrapped
    cross-reference ("701.2.4 and the...") starts with a connector."""
    first = rest[:1]
    if first.isupper() or first.isdigit() or first == "(":
        return True
    word = re.match(r"[a-z]+", rest)
    return bool(word) and word.group(0) not in STOPWORDS and len(rest.split()) <= 6


CONNECTOR_START_RE = re.compile(
    r"^(and|or|of|for|the|to|in|on|with|by|from|at|over)\s+(.+)$", re.IGNORECASE
)


def _title_continues(title: str, nxt: str) -> bool:
    """'105.4 Coordination of Plans, Specifications, and Special' followed by
    'Provisions': the heading wrapped. Body paragraphs are numbered, so an
    unnumbered Title Case fragment right after a heading is the rest of it."""
    if not nxt or len(nxt) > 80 or _is_heading_line(nxt):
        return False
    nxt = _squash(nxt)
    m = CONNECTOR_START_RE.match(nxt)
    body = m.group(2) if m else nxt
    if not (body[:1].isupper() or body[:1] == "("):
        return False
    if re.search(r"[.;:]$", nxt) and not nxt.endswith("etc."):
        return False
    if CONNECTOR_END_RE.search(title.rstrip()):
        return True
    words = [w for w in re.findall(r"[A-Za-z][\w'/-]*", body) if w.lower() not in STOPWORDS]
    return bool(words) and sum(w[:1].isupper() for w in words) / len(words) >= 0.6


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
        s = _squash(lines[i].text)
        nxt = lines[i + 1].text if i + 1 < len(lines) else ""

        m = DIVISION_RE.match(s)
        if m:
            division, division_title = m.group(1), _squash(nxt).title()
            i += 2
            continue

        m = SECTION_RE.match(s)
        caps = SECTION_CAPS_RE.match(s)
        if m or caps:
            if m:
                section_no, section_title = m.group(1), m.group(2).strip()
                i += 1
            else:
                section_no, section_title = caps.group(1), _squash(nxt)
                i += 2
            while i < len(lines) and _title_continues(section_title, lines[i].text):
                section_title += " " + _squash(lines[i].text)
                i += 1
            current = Unit(section_no, section_title, division, division_title,
                           section_no, section_title)
            units.append(current)
            stack, last_key = [], (int(section_no),)
            continue

        m = SUBSECTION_RE.match(s)
        if m and section_no and m.group(1).split(".")[0] == section_no:
            num, rest = m.group(1), m.group(2).strip()
            key = _num_key(num)
            prev = _squash(lines[i - 1].text) if i else ""
            # A real heading moves forward in numbering, starts with a capital
            # letter, and doesn't continue a cross-reference. This filters out
            # wrapped sentences like "...as directed in Subsection / 105.2 of".
            looks_like_heading = (
                key > last_key
                and len(key) - len(last_key) <= 1
                and _title_start(rest)
                and not re.search(r"\b(Subsections?|Sections?|and|or|in|of|to|through|thru)$", prev)
            )
            if looks_like_heading:
                title, body = _split_heading(rest)
                heading_line = lines[i]
                i += 1
                while not body and i < len(lines) and _title_continues(title, lines[i].text):
                    title += " " + _squash(lines[i].text)
                    i += 1
                while stack and not num.startswith(stack[-1][0] + "."):
                    stack.pop()
                current = Unit(num, title, division, division_title,
                               section_no, section_title, parents=list(stack))
                if body:
                    current.lines.append(Line(body, heading_line.page, heading_line.label))
                units.append(current)
                stack.append((num, title))
                last_key = key
                continue

        if current is not None:
            current.lines.append(lines[i])
        i += 1
    return units


def _split_heading(rest: str) -> tuple[str, str]:
    """'Water. Use water that ...' -> ('Water', 'Use water that ...').
    Headings normally sit alone on their line; this catches the rare one
    that runs straight into its text."""
    m = re.match(r"^([^.:]{1,80})[.:]\s+(.{25,})$", rest)
    if m and m.group(1)[:1].isupper():
        return m.group(1).strip(), m.group(2).strip()
    return rest.rstrip(".:"), ""


def _join(lines: list[Line]) -> str:
    """Rejoin PDF lines into paragraphs. A numbered paragraph ("2   When
    ...") or a bullet starts a new one; the number itself is dropped."""
    paras: list[str] = []
    pending_number = False
    for ln in lines:
        raw = ln.text
        if LONE_NUMBER_RE.match(raw):
            pending_number = True  # the number landed on its own line
            continue
        m = PARA_RE.match(raw)
        t = _squash(m.group(2) if m else raw)
        if m or pending_number or BULLET_RE.match(t) or not paras:
            paras.append(t)
        elif paras[-1].endswith("-") and t[:1].islower():
            paras[-1] = paras[-1][:-1] + t  # undo a hyphenated line break
        else:
            paras[-1] = paras[-1] + " " + t
        pending_number = False
    return "\n".join(paras)


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
            cur = _tail_sentences(cur) + "\n" + p  # carry a little context over
        else:
            cur = f"{cur}\n{p}" if cur else p
    if cur:
        parts.append(cur)
    return parts


def _tail_sentences(text: str) -> str:
    """The last OVERLAP_CHARS or so of a chunk, starting at a sentence."""
    tail = text[-OVERLAP_CHARS:]
    cut = tail.find(". ")
    return tail[cut + 2 :] if 0 <= cut < len(tail) - 20 else tail.split(" ", 1)[-1]


def build_chunks(units: list[Unit]) -> list[Chunk]:
    chunks: list[Chunk] = []
    for u in units:
        body = _join(u.lines).strip()
        if len(body) < MIN_BODY_CHARS:
            continue  # heading-only units: their title still appears in children's paths
        crumbs = [f"Section {u.section_no} {u.section_title}"]
        crumbs += [f"{n} {t}" for n, t in u.parents]
        if u.section != u.section_no:
            crumbs.append(f"{u.section} {u.title}")
        path = " > ".join(crumbs)
        parts = _split_long(body)
        for n, part in enumerate(parts, start=1):
            cid = u.section if len(parts) == 1 else f"{u.section}#{n}"
            chunks.append(Chunk(
                id=cid, section=u.section, title=u.title,
                section_no=u.section_no, section_title=u.section_title,
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
