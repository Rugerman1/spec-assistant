// Checks the keyword half of retrieval on your own machine, with no
// Cloudflare account and no API cost:
//
//   npm run eval:local
//
// It loads data/chunks.jsonl into an in-memory SQLite database (the same
// tables as migrations/0001_init.sql) and runs the real retrieve() code from
// src/retrieve.ts against eval/questions.json. Vector search needs Workers AI
// and Vectorize, so here it returns nothing: the numbers below are a floor
// for the deployed app, which adds meaning-based search on top.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { Chunk, Env } from "../src/types";
import { retrieve } from "../src/retrieve";

interface Question {
  q: string;
  expect: string[];
}

const KS = [1, 3, 6, 10];
const matches = (section: string, expected: string) =>
  section === expected || section.startsWith(expected + ".");

// Just enough of Cloudflare's D1 API for src/retrieve.ts and src/load.ts.
function fakeD1(db: DatabaseSync): Env["DB"] {
  const prepare = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => prepare(sql, a),
    all: async () => ({ results: db.prepare(sql).all(...(args as never[])) }),
    first: async () => db.prepare(sql).get(...(args as never[])) ?? null,
    run: async () => db.prepare(sql).run(...(args as never[])),
  });
  return { prepare, batch: async (stmts: { run: () => unknown }[]) => Promise.all(stmts.map((s) => s.run())) } as unknown as Env["DB"];
}

const db = new DatabaseSync(":memory:");
db.exec(readFileSync("migrations/0001_init.sql", "utf8"));
const chunks = readFileSync("data/chunks.jsonl", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Chunk);
const insert = db.prepare(
  `INSERT INTO chunks (id, section, title, section_no, section_title, division, division_title,
   path, page_start, page_end, page_label, edition, text) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
);
const insertFts = db.prepare(`INSERT INTO chunks_fts (id, path, text) VALUES (?,?,?)`);
for (const c of chunks) {
  insert.run(c.id, c.section, c.title, c.section_no, c.section_title, c.division, c.division_title,
    c.path, c.page_start, c.page_end, c.page_label, c.edition, c.text);
  insertFts.run(c.id, c.path, c.text);
}

const env = {
  DB: fakeD1(db),
  VECTORS: { query: async () => ({ matches: [] }) },
  AI: { run: async () => ({ data: [[]] }) },
} as unknown as Env;

const questions = JSON.parse(readFileSync("eval/questions.json", "utf8")) as Question[];
const inScope = questions.filter((x) => x.expect.length);
const hits = Object.fromEntries(KS.map((k) => [k, 0]));
let rrSum = 0;
console.log(`${chunks.length} chunks loaded. Keyword + section-number search only (no vectors).\n`);
for (const item of inScope) {
  const results = await retrieve(env, item.q, 10);
  const rank = results.findIndex((r) => item.expect.some((e) => matches(r.section, e))) + 1;
  for (const k of KS) if (rank > 0 && rank <= k) hits[k]!++;
  if (rank > 0) rrSum += 1 / rank;
  const top = results.slice(0, 3).map((r) => r.id).join(", ");
  console.log(`${(rank ? `rank ${rank}` : "MISS").padEnd(8)} ${item.q}\n         expected ${item.expect.join(" or ")} | top 3: ${top}`);
}
const pct = (n: number) => `${Math.round((100 * n) / inScope.length)}%`;
console.log("\n| metric | keyword only |\n|---|---|");
for (const k of KS) console.log(`| hit@${k} | ${pct(hits[k]!)} |`);
console.log(`| MRR | ${(rrSum / inScope.length).toFixed(2)} |`);
