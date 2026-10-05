// The Candidates page: the Models a Search returned, as numbered image tiles
// Connor picks from by replying with a number. Self-contained HTML, same
// look as the Review Page; thumbnails are hotlinked, since the page is
// private and short-lived.

export interface Candidate {
  site: "makerworld" | "printables";
  title: string;
  url: string;
  author?: string | null;
  license?: string | null;
  downloads?: number | null;
  likes?: number | null;
  thumbnail?: string | null;
}

const SITE = { makerworld: "MakerWorld", printables: "Printables" } as const;

const escape = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const count = (n: number | null | undefined) =>
  n == null ? "" : n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);

function tile(c: Candidate, i: number): string {
  const licence = (c.license ?? "").replace("Standard Digital File License", "Std");
  const nc = /NC/.test(licence) ? ' class="nc"' : "";
  const thumb = c.thumbnail
    ? `<img src="${escape(c.thumbnail)}" alt="" loading="lazy">`
    : '<div class="noimg"></div>';
  return `<div class="c"><a href="${escape(c.url)}">${thumb}</a><span class="n">${i + 1}</span><span class="site">${SITE[c.site]}</span><div class="b"><a class="t" href="${escape(c.url)}">${escape(c.title)}</a><div class="m">${c.author ? `<span>${escape(c.author)}</span>` : ""}<span class="r">↓ ${count(c.downloads)}</span><span>♥ ${count(c.likes)}</span><span${nc}>${escape(licence)}</span></div></div></div>`;
}

export function renderCandidatesPage(query: string, candidates: Candidate[]): string {
  const sites = [...new Set(candidates.map((c) => SITE[c.site]))].join(" + ");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(query)} · Candidates</title>
<link rel="preconnect" href="https://rsms.me/"><link rel="stylesheet" href="https://rsms.me/inter/inter.css">
<style>
:root{--bg:#0a0b0e;--panel:#121419;--line:rgba(255,255,255,.07);--text:#eceef3;--dim:#9aa1b1;--faint:#666d7c;--warn:#f2b84b;--accent:#8ab4ff}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--text)}
body{font:13.5px/1.5 Inter,system-ui,-apple-system,sans-serif;font-feature-settings:"tnum";-webkit-font-smoothing:antialiased;padding:20px 24px;max-width:1240px;margin:0 auto}
@supports (font-variation-settings:normal){body{font-family:InterVariable,Inter,system-ui,sans-serif}}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
header{display:flex;align-items:baseline;gap:14px;margin-bottom:14px}
h1{font-size:22px;margin:0;font-weight:600;letter-spacing:-.015em}
.muted{color:var(--dim)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px}
.c{position:relative;background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden}
.c img,.c .noimg{width:100%;aspect-ratio:4/3;object-fit:cover;display:block;background:#0b0d12}
.c .n{position:absolute;top:0;left:0;background:var(--bg);color:var(--text);font-size:20px;font-weight:600;padding:4px 12px;border-right:1px solid var(--line);border-bottom:1px solid var(--line);border-radius:0 0 8px 0}
.c .site{position:absolute;top:8px;right:8px;font-size:11px;color:var(--dim);background:rgba(10,11,14,.8);padding:2px 6px;border-radius:4px}
.c .b{padding:8px 10px}
.c .t{color:var(--text);display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.c .m{display:flex;gap:12px;color:var(--faint);font-size:12px;margin-top:3px;white-space:nowrap}.m span:first-child{overflow:hidden;text-overflow:ellipsis;min-width:0}
.c .m .nc{color:var(--warn)}.c .m .r{margin-left:auto}
p.next{color:var(--dim);margin-top:16px}p.next b{color:var(--warn);font-weight:500}
</style></head><body>
<header><h1>${escape(query)}</h1><span class="muted">${candidates.length} candidates · ${sites} · most downloaded first</span></header>
<div class="grid">${candidates.map(tile).join("")}</div>
<p class="next">Reply with a number to fetch it. MakerWorld needs your login for the file itself; Printables I can fetch. <b>NC</b> means no selling prints.</p>
</body></html>
`;
}
