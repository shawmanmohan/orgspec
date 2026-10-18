/** Server-rendered dashboard pages. Data comes from the local API; nothing loads from the internet. */

export const esc = (v: unknown): string =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export const NAV: [string, string][] = [
  ['/', 'My work'],
  ['/inbox', 'Inbox'],
  ['/reviews', 'Reviews'],
  ['/risk', 'Risk'],
  ['/oneonone', '1:1s'],
  ['/decisions', 'Decisions'],
  ['/actions', 'Approvals'],
  ['/sync', 'Sync'],
  ['/settings', 'Settings'],
  ['/admin', 'Admin'],
];

const CSS = `
:root{--bg:#f7f7f5;--fg:#1d1d1b;--muted:#6b6b66;--card:#fff;--line:#e4e4df;--accent:#2f5bea;--bad:#c2372c;--warn:#b7791f;--ok:#2f855a}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ececea;--muted:#9a9a94;--card:#1f1f1d;--line:#2e2e2b;--accent:#7b9bff;--bad:#ef6b5f;--warn:#e0a84a;--ok:#5fbf8a}}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--fg)}
header{display:flex;gap:16px;align-items:center;padding:10px 20px;border-bottom:1px solid var(--line);background:var(--card);flex-wrap:wrap}
header b{margin-right:8px}header a{color:var(--muted);text-decoration:none}header a.on{color:var(--fg);font-weight:600}
main{max-width:1100px;margin:0 auto;padding:20px}h1{font-size:20px;margin:0 0 16px}h2{font-size:15px;margin:24px 0 8px}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px;margin-bottom:12px}
table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:500}
.pill{display:inline-block;padding:1px 8px;border-radius:99px;font-size:12px;border:1px solid var(--line)}
.bad{color:var(--bad)}.warn{color:var(--warn)}.ok{color:var(--ok)}.muted{color:var(--muted)}
button,input,select,textarea{font:inherit}button{background:var(--accent);color:#fff;border:0;border-radius:6px;padding:4px 10px;cursor:pointer}button.ghost{background:none;color:var(--accent);border:1px solid var(--line)}
input,select,textarea{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:4px 8px}
pre{white-space:pre-wrap;background:var(--bg);padding:8px;border-radius:6px}
@media (max-width:640px){main{padding:12px 16px}td,th{padding:4px}}
`;

const JS = `
async function api(method, path, body){
  const r = await fetch(path, {method, headers:{'content-type':'application/json'}, body: body ? JSON.stringify(body) : undefined});
  const t = await r.text(); let j; try { j = JSON.parse(t) } catch { j = {message: t} }
  if(!r.ok){ alert(j.message || r.statusText); throw new Error(j.message) }
  return j;
}
async function act(btn, method, path, body){ btn.disabled = true; try { await api(method, path, body); location.reload() } finally { btn.disabled = false } }
`;

export function page(path: string, title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OrgSpec ${esc(title)}</title><style>${CSS}</style><script>${JS}</script></head><body>
<header><b>OrgSpec</b>${NAV.map(([href, label]) => `<a href="${href}" class="${href === path ? 'on' : ''}">${label}</a>`).join('')}</header>
<main><h1>${esc(title)}</h1>${body}</main></body></html>`;
}

export const table = (head: string[], rows: string[][], empty = 'Nothing here.'): string =>
  rows.length
    ? `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`
    : `<p class="muted">${esc(empty)}</p>`;

export const card = (title: string, inner: string) =>
  `<div class="card"><h2 style="margin-top:0">${esc(title)}</h2>${inner}</div>`;

export const band = (b: string) =>
  `<span class="pill ${b === 'high' ? 'bad' : b === 'medium' ? 'warn' : 'ok'}">${esc(b)}</span>`;

export const button = (label: string, method: string, path: string, body?: unknown, ghost = false) =>
  `<button class="${ghost ? 'ghost' : ''}" onclick='act(this, ${JSON.stringify(method)}, ${JSON.stringify(path)}, ${body === undefined ? 'undefined' : esc(JSON.stringify(body))})'>${esc(label)}</button>`;
