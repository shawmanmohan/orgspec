import type { AppContext } from '../context.js';
import { zenEndsAt } from '../zen.js';

/** Server-rendered dashboard building blocks. Nothing loads from the internet. */

export const esc = (v: unknown): string =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Views a persona can list in its manifest, in the order the designs show them. */
export const VIEWS: Record<string, { href: string; label: string }> = {
  'my-work': { href: '/work', label: 'My work' },
  'review-queue': { href: '/reviews', label: 'Review queue' },
  programs: { href: '/programs', label: 'Programs' },
  team: { href: '/team', label: 'Team & 1:1s' },
  'my-agents': { href: '/agents', label: 'My agents' },
  'task-inbox': { href: '/inbox', label: 'Task inbox' },
  'slack-summarizer': { href: '/slack', label: 'Slack summarizer' },
  'my-evidence': { href: '/evidence', label: 'My evidence' },
  decisions: { href: '/decisions', label: 'Decisions' },
};

export const DEFAULT_VIEWS = ['my-work', 'my-agents', 'task-inbox', 'slack-summarizer', 'my-evidence', 'decisions'];

export const ADMIN_NAV: [string, string][] = [
  ['/admin/sources', 'Sources & compile'],
  ['/admin/bundles', 'Bundle review'],
  ['/admin/waivers', 'Waivers'],
  ['/admin/personas', 'Personas'],
  ['/admin/sync', 'Sync'],
];

/** The persona's nav entries; unknown view ids in a manifest are ignored. */
export function personaNav(ctx: AppContext): { href: string; label: string }[] {
  const views = ctx.persona()?.spec.views ?? [];
  const ids = views.filter((v) => VIEWS[v]).length ? views.filter((v) => VIEWS[v]) : DEFAULT_VIEWS;
  return ids.map((v) => VIEWS[v] as { href: string; label: string });
}

const CSS = `
:root{--bg:#f7f7f5;--fg:#16181d;--muted:#5b606b;--card:#fff;--line:#e2e3e0;--soft:#fafaf8;--accent:#2350d8;--accent-soft:#e5ebfb;--bad:#b42318;--bad-soft:#fbe3e1;--warn:#8a4500;--warn-soft:#fbebd9;--ok:#165c39;--ok-soft:#e3f1e9;--head:#16181d;--head-fg:#f4f4f2;--head-muted:#c9cbd1;--head-on:#2a2e37;--admin:#2b2147;--admin-on:#3c2f66;--admin-accent:#5b3fc4}
@media (prefers-color-scheme:dark){:root{--bg:#141517;--fg:#ececea;--muted:#9a9ea6;--card:#1d1f23;--line:#30333a;--soft:#22252a;--accent:#7b9bff;--accent-soft:#1f2a4a;--bad:#ef6b5f;--bad-soft:#3a1d1b;--warn:#e0a84a;--warn-soft:#3a2a12;--ok:#5fbf8a;--ok-soft:#163223;--head:#0d0e10;--head-on:#262a32;--admin:#1d1730;--admin-on:#2f2552;--admin-accent:#9a86f0}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;font:15px/1.5 "IBM Plex Sans",system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--fg)}
a{color:var(--accent)}a:hover{text-decoration:underline}
code,.mono{font-family:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
header.top{display:flex;flex-wrap:wrap;align-items:center;gap:14px;padding:10px 24px;background:var(--head);color:var(--head-fg)}
header.top.admin{background:var(--admin)}
header.top .brand{color:#fff;font-weight:600;text-decoration:none;font-size:16px}
header.top nav{display:flex;flex-wrap:wrap;gap:4px;font-size:14px}
header.top nav a{padding:6px 12px;border-radius:6px;color:var(--head-muted);text-decoration:none}
header.top nav a.on{background:var(--head-on);color:#fff}header.top.admin nav a.on{background:var(--admin-on)}
header.top .chip{padding:3px 12px;border:1px solid #4a4f59;border-radius:999px;color:var(--head-fg);text-decoration:none;font-size:13px}
header.top.admin .chip{background:#4b3b80;border-color:#4b3b80;font-weight:600}
header.top .right{margin-left:auto;display:flex;align-items:center;gap:14px;font-size:14px}
header.top .right a{color:var(--head-muted)}
.badge{display:inline-block;min-width:18px;padding:0 6px;border-radius:999px;background:var(--bad);color:#fff;font-size:12px;text-align:center}
main{max-width:1280px;margin:0 auto;padding:28px 24px 64px;display:flex;flex-direction:column;gap:18px}
h1{font-size:26px;line-height:1.2;margin:0;font-weight:600}h2{font-size:16px;margin:0;font-weight:600}h3{font-size:14px;margin:0;font-weight:600}
.sub{color:var(--muted);font-size:14px;margin:0}.muted{color:var(--muted)}.small{font-size:13px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 20px;display:flex;flex-direction:column;gap:10px}
.card.flush{padding:0;gap:0}.card.flush>h2{padding:14px 20px;border-bottom:1px solid var(--line)}
.card.focus{border:2px solid var(--accent)}.card.focus.admin{border-color:var(--admin-accent)}
.cols{display:flex;flex-wrap:wrap;gap:22px;align-items:flex-start}.cols>.main{flex:999 1 620px;min-width:0;display:flex;flex-direction:column;gap:16px}.cols>.side{flex:1 1 340px;min-width:0;display:flex;flex-direction:column;gap:16px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.between{justify-content:space-between}
.tw{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:14px}th{color:var(--muted);font-weight:500;text-align:left;background:var(--soft)}
td,th{padding:11px 16px;border-top:1px solid var(--line);vertical-align:top}thead th{border-top:0}
.pill{display:inline-block;padding:2px 10px;border-radius:999px;font-size:13px;font-weight:500;background:var(--soft);color:var(--muted);white-space:nowrap}
.pill.ok{background:var(--ok-soft);color:var(--ok)}.pill.warn{background:var(--warn-soft);color:var(--warn)}.pill.bad{background:var(--bad-soft);color:var(--bad)}.pill.info{background:var(--accent-soft);color:var(--accent)}
.bad{color:var(--bad)}.warn{color:var(--warn)}.ok{color:var(--ok)}
.note{padding:12px 14px;border-radius:8px;background:var(--soft);font-size:14px}.note.warn{background:var(--warn-soft)}.note.bad{background:var(--bad-soft)}.note.info{background:var(--accent-soft)}
blockquote{margin:0;padding:6px 12px;border-left:3px solid var(--line);color:var(--muted);font-size:14px}
button,.btn{font:inherit;font-size:14px;min-height:36px;padding:6px 14px;border-radius:8px;border:0;background:var(--accent);color:#fff;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:6px}
button.ghost,.btn.ghost{background:var(--card);color:var(--fg);border:1px solid var(--line)}button.danger{background:var(--card);color:var(--bad);border:1px solid var(--bad)}
button:disabled{background:var(--line);color:var(--muted);cursor:not-allowed}
.admin button:not(.ghost):not(.danger),.admin .btn:not(.ghost){background:var(--admin-accent)}
.admin button:disabled,button:disabled{background:var(--line);color:var(--muted)}
input,select,textarea{font:inherit;font-size:14px;background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:7px 10px;min-height:38px}
textarea{min-height:0}input[type=checkbox]{min-height:0;width:16px;height:16px;padding:0;margin:0 6px 0 0;flex:none}label.f{display:flex;flex-direction:column;gap:6px;font-size:14px;font-weight:500}
.tabs{display:flex;flex-wrap:wrap;gap:8px}.tabs a{padding:5px 14px;border-radius:999px;border:1px solid var(--line);background:var(--card);color:var(--fg);text-decoration:none;font-size:14px}.tabs a.on{background:var(--fg);color:var(--bg);border-color:var(--fg)}
ul.clean{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:4px}ol.steps{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px;font-size:14px}
.item{padding:14px 20px;border-top:1px solid var(--line);display:flex;flex-direction:column;gap:6px}.item:first-of-type{border-top:0}
.k{font-size:12px;font-weight:600;letter-spacing:.03em;color:var(--muted);text-transform:uppercase}
@media (max-width:640px){main{padding:18px 16px 48px}header.top{padding:10px 16px}td,th{padding:8px 10px}}
`;

const JS = `
async function api(method, path, body){
  const r = await fetch(path, body === undefined ? {method} : {method, headers:{'content-type':'application/json'}, body: JSON.stringify(body)});
  const t = await r.text(); let j; try { j = JSON.parse(t) } catch { j = {message: t} }
  if(!r.ok){ alert(j.message || r.statusText); throw new Error(j.message) }
  return j;
}
async function act(btn, method, path, body, next){
  btn.disabled = true;
  try { const j = await api(method, path, typeof body === 'function' ? body() : body); if (next) location.href = typeof next === 'function' ? next(j) : next; else location.reload() }
  finally { btn.disabled = false }
}
function val(id){ const e = document.getElementById(id); return e ? (e.type === 'checkbox' ? e.checked : e.value) : undefined }
function form(id){ const o = {}; document.querySelectorAll('#'+id+' [name]').forEach(e => { o[e.name] = e.type === 'checkbox' ? e.checked : e.value }); return o }
`;

export interface LayoutOptions {
  /** Admin mode header and nav. */
  admin?: boolean;
  /** Highlighted nav href when it differs from the request path. */
  active?: string;
}

export function layout(ctx: AppContext, path: string, title: string, body: string, o: LayoutOptions = {}): string {
  const active = o.active ?? path;
  const persona = ctx.persona();
  const pending = (
    ctx.db().prepare("select count(*) as n from pending_actions where state = 'pending'").get() as { n: number }
  ).n;
  const reminders = (
    ctx
      .db()
      .prepare('select count(*) as n from reminders where done = 0 and (snoozed_until is null or snoozed_until <= ?)')
      .get(new Date().toISOString()) as { n: number }
  ).n;
  const initials = (ctx.settings.identity.email ?? 'me')
    .split('@')[0]
    ?.split(/[._-]/)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('')
    .slice(0, 2);
  const nav = o.admin ? ADMIN_NAV.map(([href, label]) => ({ href, label })) : personaNav(ctx);
  const navHtml = nav
    .map(
      (n) =>
        `<a href="${n.href}" class="${active === n.href || active.startsWith(`${n.href}/`) ? 'on' : ''}">${esc(n.label)}</a>`,
    )
    .join('');
  const chip = o.admin
    ? '<span class="chip">Admin mode</span>'
    : `<a class="chip" href="/workspace">${esc(persona?.metadata.name ?? 'Choose workspace')} ▾</a>`;
  const zenEnds = o.admin ? undefined : zenEndsAt(ctx);
  const zenLink = o.admin
    ? ''
    : `<a class="chip" href="/zen"${zenEnds ? ' style="background:var(--accent);border-color:var(--accent);color:#fff"' : ''}>${zenEnds ? `Zen until ${esc(new Date(zenEnds).toTimeString().slice(0, 5))}` : 'Zen'}</a>`;
  const right = o.admin
    ? `<a href="/">Exit admin mode</a>`
    : `${zenLink}<a href="/reminders">Reminders${reminders ? ` <span class="badge" style="background:var(--warn)">${reminders}</span>` : ''}</a><a href="/actions">Approvals${pending ? ` <span class="badge">${pending}</span>` : ''}</a><a href="/settings">Settings</a>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · OrgSpec</title><style>${CSS}</style><script>${JS}</script></head><body class="${o.admin ? 'admin' : ''}">
<header class="top${o.admin ? ' admin' : ''}"><a class="brand" href="/">OrgSpec</a>${chip}<nav aria-label="Workspace">${navHtml}</nav>
<span class="right">${right}<span title="${esc(ctx.settings.identity.email ?? '')}" style="width:30px;height:30px;border-radius:50%;background:#3a3f4b;color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:600">${esc(initials)}</span></span></header>
<main>${body}</main></body></html>`;
}

/** A page heading with an optional subtitle and right-hand actions. */
export const heading = (title: string, sub?: string, actions?: string) =>
  `<div class="row between" style="align-items:flex-end"><div style="display:flex;flex-direction:column;gap:4px"><h1>${esc(title)}</h1>${sub ? `<p class="sub">${sub}</p>` : ''}</div>${actions ? `<div class="row">${actions}</div>` : ''}</div>`;

export const card = (title: string, inner: string, cls = '') =>
  `<section class="card ${cls}">${title ? `<h2>${esc(title)}</h2>` : ''}${inner}</section>`;

export const table = (head: string[], rows: string[][], empty = 'Nothing here.') =>
  rows.length
    ? `<div class="tw"><table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
    : `<p class="muted" style="padding:14px 20px;margin:0">${esc(empty)}</p>`;

export const pill = (text: string, kind: '' | 'ok' | 'warn' | 'bad' | 'info' = '') =>
  `<span class="pill ${kind}">${esc(text)}</span>`;

export const band = (b: string) =>
  pill(b, b === 'high' || b === 'off track' ? 'bad' : b === 'medium' || b === 'at risk' ? 'warn' : 'ok');

/** A button that calls the local API and reloads (or goes to `next`). `body` may be a JS expression string via {js}. */
export const button = (
  label: string,
  method: string,
  path: string,
  body?: unknown,
  o: { ghost?: boolean; danger?: boolean; next?: string; disabled?: boolean } = {},
) => {
  const b =
    body === undefined
      ? 'undefined'
      : typeof body === 'object' && body !== null && 'js' in (body as object)
        ? `()=>(${(body as { js: string }).js})`
        : esc(JSON.stringify(body));
  return `<button class="${o.danger ? 'danger' : o.ghost ? 'ghost' : ''}" ${o.disabled ? 'disabled' : ''} onclick='act(this, ${JSON.stringify(method)}, ${JSON.stringify(path)}, ${b}${o.next ? `, ${JSON.stringify(o.next)}` : ''})'>${esc(label)}</button>`;
};

export const ago = (iso?: string | null): string => {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${Math.max(s, 0)} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} days ago`;
};

export const when = (iso?: string) =>
  iso
    ? new Date(iso).toLocaleString([], {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';
export const day = (iso?: string) =>
  iso ? new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' }) : '';

/** "From Jira and GitHub · updated 2 min ago · Refresh now" line used on every data view. */
export const freshness = (ctx: AppContext, label: string, sources: string[]) => {
  const rows = sources.map(
    (s) =>
      ctx.db().prepare('select last_success_at from sync_state where source = ?').get(s) as
        | { last_success_at?: string }
        | undefined,
  );
  const latest = rows
    .map((r) => r?.last_success_at)
    .filter(Boolean)
    .sort()
    .at(-1);
  return `<p class="sub row">${esc(label)} · updated ${esc(ago(latest))} ${sources
    .map((s) => button('Refresh now', 'POST', `/api/sync/${s}/run`, undefined, { ghost: true }))
    .slice(0, 1)
    .join('')}</p>`;
};
