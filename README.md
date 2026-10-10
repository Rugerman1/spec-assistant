# Spec Assistant

Ask plain-English questions about the **SCDOT Standard Specifications for Highway Construction (2025 edition)** and get answers that cite the exact subsection, with the quoted spec text one click away. If the spec doesn't answer the question, it says "Not found in the spec." instead of guessing.

It's a retrieval-augmented generation (RAG) app: it searches the spec first, then Claude answers using only the passages it found.

> Study aid, not engineering authority. Always check the cited section.

## How it works

```
PDF ──► ingest/extract.py ──► data/chunks.jsonl ──► scripts/load.mjs ──► Worker /api/admin/load
        (PyMuPDF: text,        (one chunk per                          ├─ D1: chunk text + FTS5 keyword index
         strip headers,         numbered subsection,                   └─ Vectorize: bge-base embeddings
         chunk by section)      with its breadcrumb)

Question ──► Worker /api/ask
              1. Retrieve: section numbers named in the question
                           + vector search (meaning) + keyword search (exact terms)
                           merged with Reciprocal Rank Fusion, top 6 chunks
              2. Answer:   Claude Sonnet 5.5 reads the chunks as search_result blocks
                           with citations on, so every claim links to the paragraph it came from
              3. Show:     answer with [n] footnotes, sources with the quoted text and full section
```

**Key ideas, in plain terms**

- **Chunking by structure.** The spec is numbered (701, 701.2, 701.2.4). Each chunk is one numbered subsection, so a citation is always a real section number. Long subsections are split on paragraph breaks with a little overlap. Each chunk carries a breadcrumb ("Section 701 Portland Cement Concrete > 701.2 Materials > 701.2.4 Water") because a subsection titled "Water" means nothing on its own.
- **Hybrid retrieval.** Vector search finds passages with similar meaning even when the words differ. Keyword search catches exact spec language like "Class 4000" or "AASHTO M 85" that vector search can blur. Both rankings vote, and sections named in the question ("what does 105.2 say") go straight to the top.
- **Grounded answers.** Claude only sees the retrieved passages, is told to answer only from them, and the API's citation feature ties each sentence to the exact paragraph it used. An answer with no citations counts as "not found".
- **Evals.** `npm run eval` scores search (hit@k and MRR on questions with known answers) and, with `--answers`, whether Claude cited the right section and correctly refused out-of-scope questions.

## Stack

| Part | Tool |
|---|---|
| PDF extraction and chunking | Python, PyMuPDF |
| API and web page | Cloudflare Workers (TypeScript) |
| Embeddings | Workers AI, `@cf/baai/bge-base-en-v1.5` (768 dimensions) |
| Vector search | Cloudflare Vectorize |
| Chunk store and keyword search | Cloudflare D1 (SQLite FTS5, BM25) |
| Answers with citations | Claude Sonnet 5.5 via the Anthropic API |
| Tests | Python `unittest`, Vitest |

## Set it up (Windows)

You need Node.js 20+, Python 3.11+, a free Cloudflare account, and an Anthropic API key.

1. **Install**
   ```
   cd "C:\Users\tyler\Claude Projects\spec-assistant"
   npm install
   python -m pip install -r ingest\requirements.txt
   ```
2. **Get the spec.** Download the [2025 Standard Specifications PDF](https://www.scdot.org/content/dam/scdot-legacy/business/pdf/2025_SCDOT_Standard_Specifications.pdf) from [scdot.org](https://www.scdot.org/business/standard-specifications.html) and save it as `data\2025_SCDOT_Standard_Specifications.pdf`. (It's free and public. The PDF stays out of git.)
3. **Chunk it.**
   ```
   npm run extract
   ```
   This writes `data\chunks.jsonl` and prints a report: page count, chunk count, chunk sizes, and a few samples. Skim the samples; each should start at a real subsection number.
4. **Create the Cloudflare pieces.**
   ```
   npx wrangler login
   npx wrangler d1 create spec-assistant
   ```
   Paste the `database_id` it prints into `wrangler.toml`, then:
   ```
   npx wrangler d1 migrations apply spec-assistant --remote
   npx wrangler vectorize create spec-assistant --dimensions=768 --metric=cosine
   ```
5. **Add secrets and deploy.**
   ```
   npx wrangler secret put ANTHROPIC_API_KEY
   npx wrangler secret put APP_PASSWORD
   npm run deploy
   ```
   `APP_PASSWORD` is what you'll type to open the site (any username works). It keeps strangers from spending your API credit.
6. **Load the chunks** into the deployed app (use the URL `deploy` printed):
   ```
   set SPEC_URL=https://spec-assistant.<your-subdomain>.workers.dev
   set APP_PASSWORD=<same password>
   npm run load
   ```
7. **Open the URL**, log in, and ask something. On iPhone, Share > Add to Home Screen makes it feel like an app.
8. **Measure it.**
   ```
   npm run eval
   npm run eval -- --answers
   ```
   The first is search only. The second also asks Claude every question (a few cents total).

## Cost

- The spec PDF is free. Cloudflare's free tier covers D1, Vectorize, and the embedding calls for one person.
- Each question sends about 6 short passages to Claude Sonnet 5.5: roughly 3,000 input tokens and a few hundred output tokens, under a cent per question.

## Project layout

```
ingest/extract.py      PDF -> data/chunks.jsonl
ingest/chunk.py        cleaning, section parsing, chunking (unit tested)
src/index.ts           routes: /, /api/ask, /api/search, /api/chunk/:id, /api/stats, /api/admin/load
src/retrieve.ts        embeddings, vector + keyword search, rank fusion
src/answer.ts          Claude call with search_result blocks and citations
src/load.ts            writes chunks to D1 and Vectorize
src/ui/page.ts         the question page
scripts/load.mjs       uploads chunks to the deployed Worker
eval/questions.json    questions with known answer sections, plus out-of-scope ones
eval/run-eval.ts       hit@k, MRR, citation accuracy, refusal accuracy
```

## Tests

```
npm test
npm run typecheck
python -m unittest discover -s ingest\tests
```

The unit tests use made-up sample text shaped like the spec, not real SCDOT text.

## Known limits

- Tables come through as flattened rows of text, so table-heavy answers (gradations, mix designs) are weaker. Better table extraction is the next improvement.
- Only the 2025 Standard Specifications are indexed. Supplemental specifications and special provisions can change a section, so the app may not reflect the latest requirement.
- Index only public documents. Paid standards (AASHTO, ASTM) are copyrighted and don't belong in the index.

The SCDOT specifications are published by SCDOT and are not included in this repository.
