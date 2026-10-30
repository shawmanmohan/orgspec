import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { mySessions } from '../work.js';
import {
  activeZen,
  endZen,
  extendZen,
  type FocusItem,
  heldItems,
  rankFocus,
  setFocusDone,
  startZen,
  suggestFocus,
  waitingOnMe,
  zenConfig,
} from '../zen.js';
import { button, card, esc, heading, layout, pill } from './ui.js';

const SUGGEST_TTL_MS = 10 * 60_000;
const hhmm = (iso: string) => new Date(iso).toTimeString().slice(0, 5);

/** Suggestions are cached for ten minutes so the reasons job doesn't run on every page view. */
async function cachedSuggestions(ctx: AppContext, refresh = false): Promise<FocusItem[]> {
  const db = ctx.db();
  const row = db.prepare("select value from kv where key = 'zen:suggest'").get() as { value: string } | undefined;
  const cached = row ? (JSON.parse(row.value) as { at: number; items: FocusItem[] }) : undefined;
  if (!refresh && cached && Date.now() - cached.at < SUGGEST_TTL_MS) return cached.items;
  const items = await suggestFocus(ctx);
  db.prepare("insert or replace into kv (key, value) values ('zen:suggest', ?)").run(
    JSON.stringify({ at: Date.now(), items }),
  );
  return items;
}

export function registerZenRoutes(app: FastifyInstance, ctx: AppContext) {
  const html = (reply: FastifyReply, title: string, body: string) =>
    reply.type('text/html').send(layout(ctx, '/zen', title, body));
  const base = () => `http://127.0.0.1:${(app.server.address() as { port?: number } | null)?.port ?? ''}`;

  // ---- API ----
  app.get('/api/zen', async () => ({ session: (await activeZen(ctx)) ?? null }));
  app.post(
    '/api/zen/start',
    async (
      req: FastifyRequest<{
        Body: { ids?: string[]; minutes?: number; freeze?: boolean; slackStatus?: boolean; autoReply?: boolean };
      }>,
    ) => {
      const b = req.body ?? {};
      let focus: FocusItem[] | undefined;
      if (b.ids?.length) {
        const pool = [...(await cachedSuggestions(ctx)), ...(await rankFocus(ctx))];
        focus = b.ids.flatMap((id) => pool.find((f) => f.id === id) ?? []).slice(0, 3);
      }
      return startZen(ctx, {
        ...(focus ? { focus } : {}),
        ...(b.minutes ? { minutes: Number(b.minutes) } : {}),
        ...(b.freeze !== undefined ? { freeze: b.freeze } : {}),
        ...(b.slackStatus !== undefined ? { slackStatus: b.slackStatus } : {}),
        ...(b.autoReply !== undefined ? { autoReply: b.autoReply } : {}),
      });
    },
  );
  app.post('/api/zen/extend', async (req: FastifyRequest<{ Body: { minutes?: number } }>) =>
    extendZen(ctx, Number(req.body?.minutes ?? 30)),
  );
  app.post('/api/zen/focus', async (req: FastifyRequest<{ Body: { id: string; done?: boolean } }>) =>
    setFocusDone(ctx, req.body.id, req.body.done ?? true),
  );
  app.post('/api/zen/end', async () => endZen(ctx, { baseUrl: base() }));
  app.post('/api/zen/suggest', async () => cachedSuggestions(ctx, true));

  // ---- Page ----
  app.get('/zen', async (_req, reply) => {
    const session = await activeZen(ctx);
    const cfg = zenConfig(ctx);
    if (!session) {
      const prefs = ctx.settings.zen;
      const suggested = await cachedSuggestions(ctx).catch(() => [] as FocusItem[]);
      const more = (await rankFocus(ctx).catch(() => [] as FocusItem[]))
        .filter((f) => !suggested.some((s) => s.id === f.id))
        .slice(0, 10);
      const lengths = [45, 60, 90, 120, 180].filter((m) => m <= cfg.maxMinutes);
      if (!lengths.includes(prefs.defaultMinutes) && prefs.defaultMinutes <= cfg.maxMinutes)
        lengths.push(prefs.defaultMinutes);
      const items = suggested
        .map(
          (f, n) =>
            `<label class="item row" style="flex-wrap:nowrap;align-items:flex-start"><input type="checkbox" class="focus" value="${esc(f.id)}" checked><span><b>${n + 1}. ${esc(f.title)}</b><br><span class="small muted">Why: ${esc(f.reason)} · ${esc(f.category.replace('-', ' '))}</span></span></label>`,
        )
        .join('');
      const body = `${heading('Start a zen session', 'Suggested from your ranked work and the org’s priority order. Keep, swap or drop each one.', button('Suggest again', 'POST', '/api/zen/suggest', undefined, { ghost: true }))}
<div class="cols"><div class="main">
<section class="card flush"><h2>Focus · up to 3</h2>${items || '<p class="muted" style="padding:14px 20px;margin:0">Nothing to suggest: no active tickets, waiting asks or reminders due today. Add one below.</p>'}</section>
${
  more.length
    ? card(
        'Swap in something else',
        `<label class="f">From your ranked list<select id="extra"><option value="">Choose…</option>${more.map((f) => `<option value="${esc(f.id)}">${esc(f.title)}</option>`).join('')}</select></label>`,
      )
    : ''
}
</div><div class="side"><section class="card focus"><h2>Session</h2>
<label class="f">Length<select id="minutes">${lengths
        .sort((a, b) => a - b)
        .map(
          (m) =>
            `<option value="${m}" ${m === Math.min(prefs.defaultMinutes, cfg.maxMinutes) ? 'selected' : ''}>${m} min${m === cfg.maxMinutes ? ' (org maximum)' : ''}</option>`,
        )
        .join('')}</select></label>
<label class="row"><input type="checkbox" id="slackStatus" ${prefs.slackStatus ? 'checked' : ''}> Slack status and Do Not Disturb</label>
<label class="row"><input type="checkbox" id="autoReply" ${prefs.autoReply ? 'checked' : ''}> Auto-reply to DMs</label>
<label class="row"><input type="checkbox" id="freeze"> Freeze my other agents (checkpoint now, resume after)</label>
<p class="small muted" style="margin:0">Always reach you: incidents and on-call pages${prefs.allowlist.length ? `, ${esc(prefs.allowlist.join(', '))}` : ''}. <a href="/settings#zen">Edit in Settings</a></p>
<button onclick="act(this,'POST','/api/zen/start',()=>({ids:[...document.querySelectorAll('.focus:checked')].map(e=>e.value).concat(val('extra')?[val('extra')]:[]),minutes:Number(val('minutes')),slackStatus:val('slackStatus'),autoReply:val('autoReply'),freeze:val('freeze')}),'/zen')">Start</button>
<p class="small muted" style="margin:0">Private to you. Sessions are never shown to managers or used as a metric.</p></section></div></div>`;
      return html(reply, 'Start a zen session', body);
    }

    const key = await ctx.key();
    const held = heldItems(ctx, session.id, key);
    const waiting = await waitingOnMe(ctx);
    const agents = await mySessions(ctx).catch(() => []);
    const focusTickets = session.focus.filter((f) => f.kind === 'ticket').map((f) => f.id.slice('ticket:'.length));
    const left = Math.max(0, Math.round((Date.parse(session.endsAt) - Date.now()) / 60_000));
    const done = session.focus.filter((f) => f.done).length;
    const focus = session.focus
      .map((f) => {
        const agent = f.kind === 'ticket' ? agents.find((a) => a.ticket === f.id.slice('ticket:'.length)) : undefined;
        return `<section class="card ${f.done ? '' : 'focus'}"><div class="row between"><span style="${f.done ? 'text-decoration:line-through' : ''}"><b>${f.url ? `<a href="${esc(f.url)}">${esc(f.title)}</a>` : esc(f.title)}</b></span>${f.done ? pill('Done', 'ok') : agent ? pill(agent.state === 'needs-input' ? 'Agent needs input' : 'Agent working', agent.state === 'needs-input' ? 'warn' : 'info') : ''}</div>
<p class="small muted" style="margin:0">${esc(f.reason)}</p>
<div class="row">${button(f.done ? 'Not done' : 'Mark done', 'POST', '/api/zen/focus', { id: f.id, done: !f.done }, { ghost: true })}${agent ? `<a class="btn ghost" href="/agents">Attach</a>` : ''}</div></section>`;
      })
      .join('');
    const others = agents.filter((a) => !a.ticket || !focusTickets.includes(a.ticket));
    const presence = session.presence
      ? session.presence.set
        ? `Status “Focusing until ${esc(hhmm(session.endsAt))}” and Do Not Disturb are on. Your previous status comes back when you end.`
        : `Couldn’t set your Slack status: ${esc(session.presence.error ?? 'unknown error')}`
      : 'Slack status is off for this session.';
    const body = `${heading(
      `Zen until ${hhmm(session.endsAt)}`,
      `${done} of ${session.focus.length} done · ${left} min left`,
      `${button('Add 30 min', 'POST', '/api/zen/extend', { minutes: 30 }, { ghost: true })}${button('End session', 'POST', '/api/zen/end', undefined, { next: '/' })}`,
    )}
${focus}
${waiting.map((w) => `<p class="note warn" style="margin:0">Waiting on you for over ${cfg.blockerHours} h: ${esc(w.from || 'someone')}, ${esc(w.title)}. <a href="/inbox">Open</a></p>`).join('')}
<div class="grid">
${card('Held for your digest', `<p class="small" style="margin:0">${held.length ? `${held.length} item(s). They arrive together when you finish.` : 'Nothing held yet.'}</p>`)}
${card('Slack', `<p class="small" style="margin:0">${presence}${session.options.autoReply ? ' Auto-reply is on.' : ''}</p>`)}
${card('Other agents', `<p class="small" style="margin:0">${session.frozen.length ? `${session.frozen.length} frozen; they resume from their checkpoints when you end.` : others.length ? `${others.length} keep running; their questions wait until you end.` : 'None running.'}</p>`)}
</div>
<p class="small muted" style="margin:0">Only you see this session. It is never shown to managers or used as a metric.</p>`;
    return html(reply, 'Zen', body);
  });
}
