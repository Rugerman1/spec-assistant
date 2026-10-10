import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "./types";
import { getChunks, retrieve } from "./retrieve";
import { answerQuestion } from "./answer";
import { isChunk, loadChunks } from "./load";
import { PAGE } from "./ui/page";

const MAX_QUESTION_CHARS = 500;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (!authorized(req, env)) {
      return new Response("Password required", {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="Spec Assistant"' },
      });
    }
    try {
      return await route(req, env);
    } catch (e) {
      console.error(e);
      return json({ error: (e as Error).message }, 500);
    }
  },
};

// Every answer costs a little API money, so the whole app sits behind a
// password. Your browser shows its own login box; any username works.
function authorized(req: Request, env: Env): boolean {
  if (!env.APP_PASSWORD) return false;
  const header = req.headers.get("Authorization") ?? "";
  if (!header.startsWith("Basic ")) return false;
  const decoded = atob(header.slice(6));
  return decoded.slice(decoded.indexOf(":") + 1) === env.APP_PASSWORD;
}

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const { pathname: path } = url;
  const topK = Number(env.TOP_K ?? 6);

  if (req.method === "GET" && path === "/") {
    return new Response(PAGE, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  if (req.method === "POST" && path === "/api/ask") {
    const body = (await req.json()) as { question?: unknown };
    const question = typeof body.question === "string" ? body.question.trim() : "";
    if (!question) return json({ error: "Ask a question" }, 400);
    if (question.length > MAX_QUESTION_CHARS) return json({ error: "Question is too long" }, 400);

    const chunks = await retrieve(env, question, topK);
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const answer = await answerQuestion(client, question, chunks);
    await env.DB.prepare(`INSERT INTO questions (question, found, cited) VALUES (?1, ?2, ?3)`)
      .bind(question, answer.found ? 1 : 0, JSON.stringify(answer.sources.map((s) => s.id)))
      .run();
    return json(answer);
  }

  // Retrieval only, no Claude call. The eval uses this to score search.
  if (req.method === "GET" && path === "/api/search") {
    const q = url.searchParams.get("q")?.trim() ?? "";
    if (!q) return json({ error: "Missing q" }, 400);
    const k = Math.min(20, Number(url.searchParams.get("k") ?? topK));
    const chunks = await retrieve(env, q, k);
    return json(chunks.map(({ text, ...rest }) => ({ ...rest, preview: text.slice(0, 200) })));
  }

  const m = path.match(/^\/api\/chunk\/(.+)$/);
  if (req.method === "GET" && m) {
    const [chunk] = await getChunks(env, [decodeURIComponent(m[1]!)]);
    return chunk ? json(chunk) : json({ error: "Not found" }, 404);
  }

  if (req.method === "GET" && path === "/api/stats") {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS chunks, COUNT(DISTINCT section_no) AS sections,
              (SELECT COUNT(*) FROM questions) AS questions FROM chunks`,
    ).first();
    return json(row);
  }

  // Used by scripts/load.mjs to fill the index from data/chunks.jsonl.
  if (req.method === "POST" && path === "/api/admin/load") {
    const body = (await req.json()) as { chunks?: unknown[] };
    const chunks = Array.isArray(body.chunks) ? body.chunks : [];
    if (!chunks.length || chunks.length > 100 || !chunks.every(isChunk)) {
      return json({ error: "Send 1-100 chunks in the format ingest/extract.py writes" }, 400);
    }
    return json({ loaded: await loadChunks(env, chunks) });
  }

  return json({ error: "Not found" }, 404);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
