// Measures how well Spec Assistant finds and uses the right section.
//
//   SPEC_URL=... APP_PASSWORD=... npm run eval              (search only, no Claude cost)
//   SPEC_URL=... APP_PASSWORD=... npm run eval -- --answers  (also asks Claude, a few cents)
//
// Eval terms:
// - hit@k: share of questions where an expected section is in the top k
//   search results. If search misses, Claude never sees the right text.
// - MRR (mean reciprocal rank): 1 if the right section is ranked first,
//   1/2 if second, and so on, averaged. Higher means it ranks near the top.
// - Out-of-scope questions have no answer in the spec; the right behavior is
//   to say "Not found in the spec."
import { readFileSync, writeFileSync } from "node:fs";

interface Question {
  q: string;
  expect: string[]; // sections that answer it; [] means out of scope
  note?: string;
}

const url = process.env.SPEC_URL?.replace(/\/$/, "");
const password = process.env.APP_PASSWORD;
const withAnswers = process.argv.includes("--answers");
if (!url || !password) {
  console.error("Set SPEC_URL and APP_PASSWORD first.");
  process.exit(1);
}
const auth = "Basic " + Buffer.from("me:" + password).toString("base64");
const KS = [1, 3, 6, 10];

// "701.4" is matched by 701.4, 701.4.2, or a split part like 701.4#2.
export const matches = (section: string, expected: string) =>
  section === expected || section.startsWith(expected + ".");

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url + path, {
    ...init,
    headers: { Authorization: auth, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

const questions = JSON.parse(readFileSync("eval/questions.json", "utf8")) as Question[];
const inScope = questions.filter((x) => x.expect.length);
const outScope = questions.filter((x) => !x.expect.length);
const rows: Record<string, unknown>[] = [];
const hits = Object.fromEntries(KS.map((k) => [k, 0]));
let rrSum = 0;
let answeredRight = 0;
let refusedRight = 0;

for (const item of questions) {
  const results = await api<{ section: string; id: string }[]>(
    `/api/search?k=10&q=${encodeURIComponent(item.q)}`,
  );
  const rank = results.findIndex((r) => item.expect.some((e) => matches(r.section, e))) + 1;
  if (item.expect.length) {
    for (const k of KS) if (rank > 0 && rank <= k) hits[k]!++;
    if (rank > 0) rrSum += 1 / rank;
  }
  const row: Record<string, unknown> = { q: item.q, expect: item.expect, rank, top3: results.slice(0, 3).map((r) => r.id) };

  if (withAnswers) {
    const a = await api<{ found: boolean; sources: { section: string }[] }>("/api/ask", {
      method: "POST",
      body: JSON.stringify({ question: item.q }),
    });
    const citedRight = a.sources.some((s) => item.expect.some((e) => matches(s.section, e)));
    const ok = item.expect.length ? a.found && citedRight : !a.found;
    if (ok && item.expect.length) answeredRight++;
    if (ok && !item.expect.length) refusedRight++;
    Object.assign(row, { found: a.found, cited: a.sources.map((s) => s.section), ok });
  }
  rows.push(row);
  const mark = item.expect.length ? (rank ? `rank ${rank}` : "MISS") : "out of scope";
  console.log(`${mark.padEnd(13)} ${item.q}${row.ok === false ? "  <- answer wrong" : ""}`);
}

const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "n/a");
console.log("\n| metric | value |\n|---|---|");
for (const k of KS) console.log(`| hit@${k} | ${pct(hits[k]!, inScope.length)} |`);
console.log(`| MRR | ${inScope.length ? (rrSum / inScope.length).toFixed(2) : "n/a"} |`);
if (withAnswers) {
  console.log(`| answered and cited correctly | ${pct(answeredRight, inScope.length)} (${answeredRight}/${inScope.length}) |`);
  console.log(`| said "not found" when it should | ${pct(refusedRight, outScope.length)} (${refusedRight}/${outScope.length}) |`);
}
writeFileSync("eval/results.json", JSON.stringify(rows, null, 2));
console.log("\nPer-question details in eval/results.json");
