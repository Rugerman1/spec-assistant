import Anthropic from "@anthropic-ai/sdk";
import type { Retrieved } from "./types";

// Sonnet writes the answers: it's the model the plan called for, and the
// answer step is where judgment matters (reading spec language carefully and
// refusing when the passages don't cover the question).
export const ANSWER_MODEL = "claude-sonnet-5-5";
export const NOT_FOUND = "Not found in the spec.";

export const SYSTEM = `You answer questions about the SCDOT Standard Specifications for Highway Construction (2025 edition) for a civil engineering student.

You are given search results. Each one is a numbered subsection of the spec; its title is the section path.

Rules:
- Answer only from the search results. Do not use outside knowledge of SCDOT, AASHTO, ASTM, or general practice to fill gaps.
- Cite every factual sentence. Quote numbers, limits, and units exactly as the spec states them.
- If the search results do not contain the answer, reply with exactly "${NOT_FOUND}" followed by one sentence naming the closest related subsection if one was retrieved. Do not guess.
- If the results only partly answer the question, answer that part and say plainly what the retrieved sections do not cover.
- Be concise: lead with the direct answer, then any conditions or exceptions. No preamble.`;

export interface AnswerPart {
  text: string;
  cites: number[]; // source numbers, 1-based
}

export interface Source {
  n: number;
  id: string;
  section: string;
  title: string;
  path: string;
  page_label: string;
  page_start: number;
  quotes: string[]; // exact text Claude cited
  text: string; // the full chunk, for the expandable view
}

export interface Answer {
  found: boolean;
  parts: AnswerPart[];
  sources: Source[];
  retrieved: { id: string; path: string; via: string[] }[];
  model: string;
}

// Each chunk becomes a search_result block. Its paragraphs become separate
// text blocks, so a citation points at the exact paragraph Claude used.
export function toSearchResults(chunks: Retrieved[]): Anthropic.Beta.BetaSearchResultBlockParam[] {
  return chunks.map((c) => ({
    type: "search_result",
    source: c.id,
    title: c.path + (c.page_label ? ` (page ${c.page_label})` : ""),
    content: c.text
      .split("\n")
      .filter((p) => p.trim())
      .map((p) => ({ type: "text" as const, text: p })),
    citations: { enabled: true },
  }));
}

export async function answerQuestion(
  client: Anthropic,
  question: string,
  chunks: Retrieved[],
): Promise<Answer> {
  const retrieved = chunks.map((c) => ({ id: c.id, path: c.path, via: c.via }));
  if (!chunks.length) {
    return { found: false, parts: [{ text: NOT_FOUND, cites: [] }], sources: [], retrieved, model: ANSWER_MODEL };
  }

  const response = await client.beta.messages.create({
    model: ANSWER_MODEL,
    max_tokens: 4000,
    // If a safety classifier declines the request, the API retries it on a
    // fallback model instead of returning nothing.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium" },
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: [...toSearchResults(chunks), { type: "text", text: `Question: ${question}` }],
      },
    ],
  });

  if (response.stop_reason === "refusal") {
    return {
      found: false,
      parts: [{ text: "The model declined to answer this question.", cites: [] }],
      sources: [],
      retrieved,
      model: response.model,
    };
  }
  return parseResponse(response.content, chunks, retrieved, response.model);
}

// Turn Claude's text blocks + citations into numbered footnotes.
export function parseResponse(
  content: Anthropic.Beta.BetaContentBlock[],
  chunks: Retrieved[],
  retrieved: Answer["retrieved"],
  model: string,
): Answer {
  const byId = new Map(chunks.map((c) => [c.id, c]));
  const sources: Source[] = [];
  const numberFor = (id: string): number | null => {
    let s = sources.find((x) => x.id === id);
    if (!s) {
      const c = byId.get(id);
      if (!c) return null;
      s = {
        n: sources.length + 1,
        id: c.id,
        section: c.section,
        title: c.title,
        path: c.path,
        page_label: c.page_label,
        page_start: c.page_start,
        quotes: [],
        text: c.text,
      };
      sources.push(s);
    }
    return s.n;
  };

  const parts: AnswerPart[] = [];
  for (const block of content) {
    if (block.type !== "text") continue; // skip thinking / fallback markers
    const cites: number[] = [];
    for (const cit of block.citations ?? []) {
      if (cit.type !== "search_result_location") continue;
      const n = numberFor(cit.source);
      if (n === null) continue;
      if (!cites.includes(n)) cites.push(n);
      const src = sources[n - 1]!;
      const quote = cit.cited_text.trim();
      if (quote && !src.quotes.includes(quote)) src.quotes.push(quote);
    }
    parts.push({ text: block.text, cites });
  }

  const full = parts.map((p) => p.text).join("").trim();
  const found = !full.startsWith(NOT_FOUND) && sources.length > 0;
  return { found, parts, sources, retrieved, model };
}
