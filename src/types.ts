export interface Env {
  DB: D1Database;
  VECTORS: VectorizeIndex;
  AI: Ai;
  ANTHROPIC_API_KEY: string;
  APP_PASSWORD: string;
  TOP_K?: string;
}

// One chunk as stored in D1 (same fields ingest/extract.py writes).
export interface Chunk {
  id: string;
  section: string;
  title: string;
  section_no: string;
  section_title: string;
  division: string;
  division_title: string;
  path: string;
  page_start: number;
  page_end: number;
  page_label: string;
  edition: string;
  text: string;
}

export interface Retrieved extends Chunk {
  score: number;
  // Which searches found it: "ref" (section number in the question),
  // "vector" (meaning), "keyword" (exact words).
  via: string[];
}
