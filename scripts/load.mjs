// Load data/chunks.jsonl into your deployed Spec Assistant.
//
//   set SPEC_URL=https://spec-assistant.<you>.workers.dev
//   set APP_PASSWORD=<the password you set with wrangler secret put>
//   npm run load
//
// Safe to re-run: chunks with the same id are replaced.
import { readFileSync } from "node:fs";

const url = process.env.SPEC_URL?.replace(/\/$/, "");
const password = process.env.APP_PASSWORD;
const file = process.argv[2] ?? "data/chunks.jsonl";
const BATCH = 50;

if (!url || !password) {
  console.error("Set SPEC_URL and APP_PASSWORD first (see README, step 6).");
  process.exit(1);
}

const chunks = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const auth = "Basic " + Buffer.from("me:" + password).toString("base64");
console.log(`Loading ${chunks.length} chunks from ${file} into ${url}`);

for (let i = 0; i < chunks.length; i += BATCH) {
  const batch = chunks.slice(i, i + BATCH);
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url + "/api/admin/load", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({ chunks: batch }),
    });
    if (res.ok) break;
    const msg = `${res.status} ${await res.text()}`;
    if (attempt >= 3 || res.status === 400 || res.status === 401) {
      console.error(`Batch starting at chunk ${i} failed: ${msg}`);
      process.exit(1);
    }
    console.warn(`Retrying batch at ${i} (${msg})`);
    await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
  process.stdout.write(`\r${Math.min(i + BATCH, chunks.length)}/${chunks.length}`);
}
console.log("\nDone. Vectorize can take a minute before new vectors show up in search.");
