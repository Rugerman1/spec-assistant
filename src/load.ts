import type { Chunk, Env } from "./types";
import { embed, embedText } from "./retrieve";

// Store a batch of chunks: text in D1 (plus the keyword index) and
// embeddings in Vectorize. Re-loading the same ids replaces them, so running
// the loader twice is safe.
export async function loadChunks(env: Env, chunks: Chunk[]): Promise<number> {
  if (!chunks.length) return 0;
  const vectors = await embed(env, chunks.map(embedText));

  const stmts = chunks.flatMap((c) => [
    env.DB.prepare(
      `INSERT OR REPLACE INTO chunks
       (id, section, title, section_no, section_title, division, division_title,
        path, page_start, page_end, page_label, edition, text)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
    ).bind(
      c.id, c.section, c.title, c.section_no, c.section_title, c.division, c.division_title,
      c.path, c.page_start, c.page_end, c.page_label, c.edition, c.text,
    ),
    env.DB.prepare(`DELETE FROM chunks_fts WHERE id = ?1`).bind(c.id),
    env.DB.prepare(`INSERT INTO chunks_fts (id, path, text) VALUES (?1, ?2, ?3)`).bind(c.id, c.path, c.text),
  ]);
  await env.DB.batch(stmts);

  await env.VECTORS.upsert(
    chunks.map((c, i) => ({
      id: c.id,
      values: vectors[i]!,
      metadata: { section: c.section, division: c.division },
    })),
  );
  return chunks.length;
}

const STRING_FIELDS = [
  "id", "section", "title", "section_no", "section_title", "division",
  "division_title", "path", "page_label", "edition", "text",
] as const;

export function isChunk(x: unknown): x is Chunk {
  if (!x || typeof x !== "object") return false;
  const c = x as Record<string, unknown>;
  return (
    STRING_FIELDS.every((f) => typeof c[f] === "string") &&
    (c.id as string).length > 0 &&
    (c.id as string).length <= 64 && // Vectorize id limit
    Number.isInteger(c.page_start) &&
    Number.isInteger(c.page_end)
  );
}
