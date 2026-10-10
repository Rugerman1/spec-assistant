-- One row per chunk (one numbered subsection, or part of a long one).
CREATE TABLE chunks (
  id             TEXT PRIMARY KEY,   -- "701.2.4" or "701.2.4#2"
  section        TEXT NOT NULL,      -- "701.2.4"
  title          TEXT NOT NULL,
  section_no     TEXT NOT NULL,      -- "701"
  section_title  TEXT NOT NULL,
  division       TEXT NOT NULL,
  division_title TEXT NOT NULL,
  path           TEXT NOT NULL,      -- breadcrumb shown with citations
  page_start     INTEGER NOT NULL,
  page_end       INTEGER NOT NULL,
  page_label     TEXT NOT NULL,      -- printed page like "700-12"
  edition        TEXT NOT NULL,
  text           TEXT NOT NULL
);
CREATE INDEX chunks_section ON chunks(section);

-- Keyword search. Catches exact terms (ASTM numbers, "slump", "Class 4000")
-- that meaning-based vector search can miss.
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  id UNINDEXED, path, text,
  tokenize = 'porter unicode61'
);

-- Questions asked, for spotting gaps and growing the eval set.
CREATE TABLE questions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  asked_at   TEXT NOT NULL DEFAULT (datetime('now')),
  question   TEXT NOT NULL,
  found      INTEGER NOT NULL,
  cited      TEXT NOT NULL           -- JSON array of chunk ids
);
