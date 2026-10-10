import type { Chunk, Env, Retrieved } from "./types";

// RAG terms:
// - An *embedding* is a list of 768 numbers that captures what a piece of
//   text means. Texts with similar meaning get nearby embeddings.
// - *Vector search* finds the chunks whose embeddings sit closest to the
//   question's embedding (Cloudflare Vectorize does this).
// - *Keyword search* (SQLite FTS5 with BM25 ranking) finds exact words, which
//   matters for spec language like "Class 4000" or "AASHTO M 85".
// - *Hybrid retrieval* runs both and merges the rankings with Reciprocal Rank
//   Fusion (RRF): each list votes 1/(60 + rank) for its results.

export const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";
// bge models retrieve better when the *question* (not the passages) carries
// this instruction.
const QUERY_INSTRUCTION = "Represent this sentence for searching relevant passages: ";
const CANDIDATES = 20;
// bge reads at most 512 tokens; about 1,800 characters stays under that.
const MAX_EMBED_CHARS = 1800;

export function embedText(c: Pick<Chunk, "path" | "text">): string {
  return `${c.path}\n${c.text}`.slice(0, MAX_EMBED_CHARS);
}

export async function embed(env: Env, texts: string[]): Promise<number[][]> {
  const out = (await env.AI.run(EMBED_MODEL, { text: texts })) as { data: number[][] };
  return out.data;
}

// "What does 701.2.4 say" or "Section 105 ..." -> ["701.2.4"] / ["105"].
// A bare 3-digit number only counts after the word Section/Subsection, so
// "100 degrees" or "a 3/4 inch sieve" don't trigger it.
export function sectionRefs(question: string): string[] {
  const refs = new Set<string>();
  for (const m of question.matchAll(/\b(\d{3}(?:\.\d{1,3}){1,5})\b/g)) refs.add(m[1]!);
  for (const m of question.matchAll(/\b(?:sub)?sections?\s+(\d{3})\b/gi)) refs.add(m[1]!);
  return [...refs];
}

const STOPWORDS = new Set(
  ("the and for are what does how when where which who why can must should " +
    "shall will with from that this there their about into than then them " +
    "does is was were been being have has had any all per not use used spec " +
    "specs specification specifications scdot section subsection").split(" "),
);

// Turn a question into an FTS5 query: meaningful words OR'd together, each
// quoted so punctuation in the question can't break the query syntax.
export function ftsQuery(question: string): string | null {
  const words = (question.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (w) => (w.length >= 3 || /\d/.test(w)) && !STOPWORDS.has(w),
  );
  const unique = [...new Set(words)].slice(0, 16);
  return unique.length ? unique.map((w) => `"${w}"`).join(" OR ") : null;
}

export function rrf(lists: string[][], k = 60): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1)));
  }
  return scores;
}

export async function retrieve(env: Env, question: string, topK: number): Promise<Retrieved[]> {
  const refs = sectionRefs(question);
  const fts = ftsQuery(question);

  const [refIds, vectorIds, keywordIds] = await Promise.all([
    refLookup(env, refs),
    embed(env, [QUERY_INSTRUCTION + question]).then(([v]) =>
      env.VECTORS.query(v!, { topK: CANDIDATES }).then((r) => r.matches.map((m) => m.id)),
    ),
    fts
      ? env.DB.prepare(
          `SELECT id FROM chunks_fts WHERE chunks_fts MATCH ?1
           ORDER BY bm25(chunks_fts, 0.0, 2.0, 1.0) LIMIT ${CANDIDATES}`,
        )
          .bind(fts)
          .all<{ id: string }>()
          .then((r) => r.results.map((x) => x.id))
      : Promise.resolve([] as string[]),
  ]);

  const fused = rrf([vectorIds, keywordIds]);
  const ranked = [...fused.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  // Sections the question names outright go first.
  const ids = [...new Set([...refIds, ...ranked])].slice(0, topK);
  if (!ids.length) return [];

  const rows = await getChunks(env, ids);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    if (!row) return [];
    const via = [
      refIds.includes(id) && "ref",
      vectorIds.includes(id) && "vector",
      keywordIds.includes(id) && "keyword",
    ].filter(Boolean) as string[];
    return [{ ...row, score: fused.get(id) ?? 1, via }];
  });
}

async function refLookup(env: Env, refs: string[]): Promise<string[]> {
  if (!refs.length) return [];
  const ids: string[] = [];
  for (const ref of refs.slice(0, 3)) {
    // The section itself, then its first few children.
    const { results } = await env.DB.prepare(
      `SELECT id FROM chunks WHERE section = ?1 OR section LIKE ?1 || '.%'
       ORDER BY length(section), id LIMIT 3`,
    )
      .bind(ref)
      .all<{ id: string }>();
    ids.push(...results.map((r) => r.id));
  }
  return ids;
}

export async function getChunks(env: Env, ids: string[]): Promise<Chunk[]> {
  if (!ids.length) return [];
  const marks = ids.map((_, i) => `?${i + 1}`).join(",");
  const { results } = await env.DB.prepare(`SELECT * FROM chunks WHERE id IN (${marks})`)
    .bind(...ids)
    .all<Chunk>();
  return results;
}
