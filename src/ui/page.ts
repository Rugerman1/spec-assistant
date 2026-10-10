// The question page: one HTML file with a little JavaScript, no build step.
export const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Spec Assistant</title>
<style>
  :root { --bg:#f6f5f2; --card:#fff; --ink:#1d1d1b; --muted:#6b6a65; --line:#e3e1dc;
          --accent:#f56600; --soft:#fff1e6; --warn:#9a3b3b; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#161614; --card:#20201e; --ink:#eeede9; --muted:#a3a19a; --line:#34332f; --soft:#3a2614; }
  }
  * { box-sizing:border-box; }
  body { margin:0; font:15px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; background:var(--bg); color:var(--ink); }
  .wrap { max-width:820px; margin:0 auto; padding:20px 16px 48px; }
  h1 { font-size:22px; margin:0; } h1 span { color:var(--accent); }
  .sub { color:var(--muted); font-size:13px; margin:2px 0 16px; }
  form { display:flex; gap:8px; }
  textarea { flex:1; font:inherit; padding:10px 12px; border-radius:10px; border:1px solid var(--line); background:var(--card); color:var(--ink); resize:vertical; min-height:46px; }
  button { font:inherit; border:0; border-radius:10px; padding:0 18px; background:var(--accent); color:#fff; font-weight:600; cursor:pointer; }
  button:disabled { opacity:.6; cursor:wait; }
  .examples { display:flex; flex-wrap:wrap; gap:6px; margin:10px 0 18px; }
  .examples a { font-size:13px; padding:4px 10px; border:1px solid var(--line); border-radius:999px; color:var(--ink); text-decoration:none; background:var(--card); cursor:pointer; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px 18px; margin-top:12px; }
  .answer { white-space:pre-wrap; }
  .answer.nf { color:var(--warn); }
  sup a { color:var(--accent); text-decoration:none; font-weight:700; padding:0 1px; cursor:pointer; }
  h2 { font-size:14px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); margin:20px 0 6px; }
  details { border:1px solid var(--line); border-radius:10px; padding:10px 12px; margin:8px 0; background:var(--card); }
  details.flash { outline:2px solid var(--accent); }
  summary { cursor:pointer; } summary b { color:var(--accent); }
  .path { color:var(--muted); font-size:13px; }
  blockquote { margin:8px 0; padding:6px 10px; border-left:3px solid var(--accent); background:var(--soft); border-radius:0 6px 6px 0; }
  .full { white-space:pre-wrap; font-size:14px; color:var(--muted); margin-top:8px; }
  .also { font-size:13px; color:var(--muted); }
  .note { font-size:12px; color:var(--muted); margin-top:28px; }
  .err { color:var(--warn); }
  @media (max-width:520px) { form { flex-direction:column; } button { padding:12px; } }
</style>
</head>
<body>
<div class="wrap">
  <h1>Spec <span>Assistant</span></h1>
  <div class="sub" id="stats">SCDOT Standard Specifications for Highway Construction, 2025 edition</div>
  <form id="f">
    <textarea id="q" rows="2" maxlength="500" placeholder="Ask about the SCDOT specs, e.g. What slump is allowed for Class 4000 concrete?"></textarea>
    <button id="go">Ask</button>
  </form>
  <div class="examples" id="ex"></div>
  <div id="out"></div>
  <p class="note">Answers come only from the spec text shown under Sources. This is a study aid, not engineering authority: check the cited section before relying on it.</p>
</div>
<script>
const EXAMPLES = [
  "What is the maximum slump for Class 4000 concrete?",
  "When can the contractor work at night?",
  "How is asphalt pavement measured for payment?",
  "What does Section 105 cover?",
];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const q = document.getElementById("q"), out = document.getElementById("out"), go = document.getElementById("go");

document.getElementById("ex").innerHTML = EXAMPLES.map((e) => "<a>" + esc(e) + "</a>").join("");
document.getElementById("ex").onclick = (e) => { if (e.target.tagName === "A") { q.value = e.target.textContent; ask(); } };
document.getElementById("f").onsubmit = (e) => { e.preventDefault(); ask(); };
q.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(); } };

fetch("/api/stats").then((r) => r.json()).then((s) => {
  if (s && s.chunks) document.getElementById("stats").textContent =
    "SCDOT Standard Specifications for Highway Construction, 2025 edition · " + s.sections + " sections, " + s.chunks + " passages indexed";
}).catch(() => {});

async function ask() {
  const question = q.value.trim();
  if (!question) return;
  go.disabled = true; go.textContent = "Searching…";
  out.innerHTML = '<div class="card path">Finding the relevant sections and reading them…</div>';
  try {
    const r = await fetch("/api/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question }) });
    const a = await r.json();
    if (!r.ok) throw new Error(a.error || r.statusText);
    render(a);
  } catch (e) {
    out.innerHTML = '<div class="card err">Something went wrong: ' + esc(e.message) + "</div>";
  } finally {
    go.disabled = false; go.textContent = "Ask";
  }
}

function render(a) {
  const body = a.parts.map((p) => esc(p.text) + p.cites.map((n) =>
    '<sup><a data-n="' + n + '">[' + n + "]</a></sup>").join("")).join("");
  let html = '<div class="card"><div class="answer' + (a.found ? "" : " nf") + '">' + body + "</div></div>";
  if (a.sources.length) {
    html += "<h2>Sources</h2>" + a.sources.map((s) =>
      '<details id="src' + s.n + '"><summary><b>[' + s.n + "]</b> " + esc(s.section) + " " + esc(s.title) +
      (s.page_label ? ' <span class="path">· page ' + esc(s.page_label) + "</span>" : "") + "</summary>" +
      '<div class="path">' + esc(s.path) + "</div>" +
      s.quotes.map((t) => "<blockquote>" + esc(t) + "</blockquote>").join("") +
      '<div class="full">' + esc(s.text) + "</div></details>").join("");
  }
  const cited = new Set(a.sources.map((s) => s.id));
  const also = a.retrieved.filter((r) => !cited.has(r.id));
  if (also.length) html += '<p class="also">Also searched: ' + also.map((r) => esc(r.path)).join(" · ") + "</p>";
  out.innerHTML = html;
}

out.onclick = (e) => {
  const n = e.target.dataset && e.target.dataset.n;
  if (!n) return;
  const d = document.getElementById("src" + n);
  d.open = true; d.scrollIntoView({ behavior: "smooth", block: "center" });
  d.classList.add("flash"); setTimeout(() => d.classList.remove("flash"), 1200);
};
</script>
</body>
</html>`;
