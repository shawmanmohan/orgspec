import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import {
  draftStatus,
  lastNudge,
  nudgeDraft,
  nudgeTarget,
  type Program,
  program,
  programs,
  recipientClock,
  renderStatus,
  sendNudge,
  shareStatus,
  statusHistory,
  WEIGHTS_VERSION,
} from '../programs.js';
import { ago, band, button, card, day, esc, freshness, heading, layout } from './ui.js';

const statusPill = (p: Program) => band(p.status);

export function registerPmRoutes(app: FastifyInstance, ctx: AppContext) {
  const html = (reply: FastifyReply, path: string, title: string, body: string) =>
    reply.type('text/html').send(layout(ctx, path, title, body, { active: '/programs' }));
  const need = (key: string) => {
    const p = program(ctx, key);
    if (!p) throw Object.assign(new Error(`No program ${key} in the cache; run Refresh`), { statusCode: 404 });
    return p;
  };

  // ---- APIs ----
  app.get('/api/programs', async () => programs(ctx));
  app.post(
    '/api/programs/:key/nudge',
    async (
      req: FastifyRequest<{ Params: { key: string }; Body: { ticket: string; via: 'slack' | 'jira'; text: string } }>,
    ) => {
      const p = need(req.params.key);
      const t = await nudgeTarget(ctx, p, req.body.ticket);
      if (!t)
        throw Object.assign(
          new Error('No one to nudge: the ticket has no assignee and its team has no lead in people.yaml'),
          { statusCode: 400 },
        );
      await sendNudge(ctx, {
        ticket: req.body.ticket,
        to: t.to,
        ...(t.slackId ? { slackId: t.slackId } : {}),
        via: req.body.via,
        text: req.body.text,
      });
      return { ok: true };
    },
  );
  app.post('/api/programs/:key/status/draft', async (req: FastifyRequest<{ Params: { key: string } }>) => {
    const p = need(req.params.key);
    const d = await draftStatus(ctx, p);
    ctx
      .db()
      .prepare('insert or replace into kv (key, value) values (?, ?)')
      .run(`status:draft:${p.key}`, JSON.stringify({ ...d, text: renderStatus(p, d) }));
    return d;
  });
  app.post(
    '/api/programs/:key/status/share',
    async (
      req: FastifyRequest<{
        Params: { key: string };
        Body: { text: string; slackChannel?: string; confluencePageId?: string; epicComment?: boolean };
      }>,
    ) => {
      const p = need(req.params.key);
      const b = req.body;
      return shareStatus(ctx, p, b.text, {
        ...(b.slackChannel ? { slackChannel: b.slackChannel } : {}),
        ...(b.confluencePageId ? { confluencePageId: b.confluencePageId } : {}),
        ...(b.epicComment ? { epicComment: true } : {}),
      });
    },
  );

  // ---- Programs ----
  app.get('/programs', async (req: FastifyRequest<{ Querystring: { filter?: string } }>, reply) => {
    const all = programs(ctx);
    const f = req.query.filter ?? 'all';
    const shown = f === 'all' ? all : all.filter((p) => p.status === f);
    const count = (s: string) => all.filter((p) => p.status === s).length;
    const body = `${heading('Programs', `Scores recomputed every 15 min from Jira and GitHub changes · weights v${WEIGHTS_VERSION}`)}
${freshness(ctx, 'From Jira and GitHub', ['jira.programs'])}
<div class="tabs">${[
      ['all', `All · ${all.length}`],
      ['off track', `Off track · ${count('off track')}`],
      ['at risk', `At risk · ${count('at risk')}`],
      ['on track', `On track · ${count('on track')}`],
    ]
      .map(
        ([k, l]) =>
          `<a href="/programs?filter=${encodeURIComponent(k ?? '')}" class="${k === f ? 'on' : ''}">${esc(l)}</a>`,
      )
      .join('')}</div>
<section class="card flush"><div class="tw"><table><thead><tr><th>Program</th><th>Status</th><th>Risk score</th><th>Top driver</th><th>Target</th><th>Chance of hitting target</th></tr></thead><tbody>
${
  shown
    .map(
      (p) =>
        `<tr><td><a href="/programs/${esc(p.key)}" style="font-weight:600">${esc(p.title)}</a><br><span class="small muted">${esc(p.key)} · ${esc(p.teams.join(', '))}</span></td><td>${statusPill(p)}</td><td><b style="font-size:18px">${p.score}</b> <span class="muted small">/ 100</span></td><td>${esc(p.drivers[0]?.text ?? 'No driver above threshold')}</td><td>${esc(p.target ? day(p.target) : '—')}</td><td>${p.chance !== undefined ? `${Math.round(p.chance * 100)}%` : '—'}</td></tr>`,
    )
    .join('') ||
  '<tr><td colspan="6" class="muted">No programs in the cache. Set your program JQL in Settings or with orgspec settings jira --program-jql, then Refresh.</td></tr>'
}</tbody></table></div></section>
<p class="sub">Scores are about the work, never about people. Under 40 is on track, 40–70 at risk, over 70 off track.</p>`;
    return html(reply, '/programs', 'Programs', body);
  });

  app.get(
    '/programs/:key',
    async (req: FastifyRequest<{ Params: { key: string }; Querystring: { nudge?: string } }>, reply) => {
      const p = need(req.params.key);
      const attention = p.tickets.filter((t) => p.drivers.some((d) => d.tickets.includes(t.key)) && !t.done);
      const nudgeKey = req.query.nudge ?? attention[0]?.key;
      const target = nudgeKey ? await nudgeTarget(ctx, p, nudgeKey) : undefined;
      const clock = recipientClock(target?.timezone);
      const last = nudgeKey ? lastNudge(ctx, nudgeKey) : undefined;
      const recent = last && Date.now() - Date.parse(last) < 86_400_000;
      const summary = `${p.done} of ${p.stories} stories done.${p.drivers[0] ? ` ${p.drivers[0].text}.` : ''}${p.chance !== undefined && p.target ? ` At current throughput there is a ${Math.round(p.chance * 100)}% chance of finishing by ${day(p.target)}.` : ''}`;
      const nudge =
        nudgeKey && target
          ? `<section class="card focus"><h2>Nudge about ${esc(nudgeKey)}</h2><p style="margin:0">To <b>${esc(target.name)}</b> · ${esc(target.why)}</p>
<label class="f">Send as<select id="via"><option value="slack" ${target.slackId ? '' : 'disabled'}>Slack DM${target.slackId ? '' : ' (no Slack ID in people.yaml)'}</option><option value="jira" ${target.slackId ? '' : 'selected'}>Jira comment</option></select></label>
<label class="f">Message (draft, edit freely)<textarea id="msg" rows="6">${esc(nudgeDraft(p, nudgeKey, target))}</textarea></label>
${clock.local ? `<p class="note ${clock.quiet ? 'warn' : ''}" style="margin:0">It's ${esc(clock.local)} for ${esc(target.name.split(' ')[0])}${clock.quiet ? '; quiet hours. Slack holds notifications until their morning.' : '; outside quiet hours.'}</p>` : ''}
<p class="small muted" style="margin:0">${recent ? `Nudged ${esc(ago(last))}; wait 24 hours.` : 'No nudge on this ticket in the last 24 hours.'} It is logged on ${esc(nudgeKey)} so the team sees it.</p>
${button('Send as you', 'POST', `/api/programs/${p.key}/nudge`, { js: `{ticket:${JSON.stringify(nudgeKey)},via:val('via'),text:val('msg')}` }, { disabled: Boolean(recent) })}</section>`
          : nudgeKey
            ? card(
                `Nudge about ${nudgeKey}`,
                '<p class="muted" style="margin:0">No one to nudge: the ticket has no assignee and its team has no lead in people.yaml (teamLeads).</p>',
              )
            : '';
      const body = `<p class="small"><a href="/programs">Programs</a> / ${esc(p.key)}</p>
${heading(p.title, `${p.target ? `Target ${esc(day(p.target))} · ` : ''}${esc(p.teams.join(', '))} · ${p.stories} stories, ${p.done} done`, `${statusPill(p)} <b>${p.score}</b> <a class="btn" href="/programs/${esc(p.key)}/status">Share status update</a>`)}
${freshness(ctx, 'From Jira and GitHub · score recomputed every 15 min', ['jira.programs'])}
<div class="cols"><div class="main">
${card('Summary', `<p style="margin:0">${esc(summary)}</p>`)}
${card(
  `Why ${p.score}: top drivers`,
  p.drivers.length
    ? p.drivers
        .map(
          (d) =>
            `<div class="row" style="align-items:flex-start"><span class="pill ${d.points >= 20 ? 'bad' : 'warn'}">+${d.points}</span><span><b>${esc(d.category)}</b><br>${esc(d.text)}</span></div>`,
        )
        .join('') +
        `<p class="small muted" style="margin:0">The rest of the score is 0 when no other driver crosses its threshold.</p>`
    : '<p class="muted" style="margin:0">No driver above threshold.</p>',
)}
<section class="card flush"><h2>Tickets that need attention</h2>${
        attention
          .map(
            (t) =>
              `<div class="item"><div class="row between"><span><span class="mono">${esc(t.key)}</span> ${esc(t.summary)}</span><a class="btn ghost" href="/programs/${esc(p.key)}?nudge=${esc(t.key)}">Nudge</a></div><span class="small muted">${esc([t.assignee ?? 'unassigned', t.status, `${ago(t.updated)}`].join(' · '))}${t.blocks.length ? ` · blocks ${esc(t.blocks.join(', '))}` : ''}${t.blockedBy.length ? ` · blocked by ${esc(t.blockedBy.join(', '))}` : ''}</span></div>`,
          )
          .join('') || '<p class="muted" style="padding:14px 20px;margin:0">None.</p>'
      }</section>
</div><div class="side">${nudge}</div></div>`;
      return html(reply, `/programs/${p.key}`, `Program: ${p.title}`, body);
    },
  );

  app.get('/programs/:key/status', async (req: FastifyRequest<{ Params: { key: string } }>, reply) => {
    const p = need(req.params.key);
    const raw = (
      ctx.db().prepare('select value from kv where key = ?').get(`status:draft:${p.key}`) as
        | { value?: string }
        | undefined
    )?.value;
    const draft = raw ? (JSON.parse(raw) as { text: string; at: string }) : undefined;
    const history = statusHistory(ctx, p.key);
    const body = `<p class="small"><a href="/programs">Programs</a> / <a href="/programs/${esc(p.key)}">${esc(p.key)}</a> / Status update</p>
${heading(`Status update: ${p.title}`, draft ? `Drafted from Jira, PRs, CI and the risk score at ${esc(new Date(draft.at).toLocaleString())}. Every claim links to its source; edit anything before sharing.` : 'Draft an update from Jira, PRs, CI and the risk score.', button(draft ? 'Draft again' : 'Draft update', 'POST', `/api/programs/${p.key}/status/draft`, undefined, { ghost: Boolean(draft) }))}
<div class="cols"><div class="main">
${card('Draft', `<textarea id="txt" rows="16" style="width:100%;font-family:inherit">${esc(draft?.text ?? '')}</textarea>`)}
${card('Earlier updates', history.length ? `<ul class="clean">${history.map((h) => `<li>${esc(day(h.at))} · ${esc(h.status)} (${h.score}) · posted to ${esc(h.sharedTo.join(' and ') || 'nowhere')}</li>`).join('')}</ul>` : '<p class="muted" style="margin:0">None yet.</p>')}
</div><div class="side"><section class="card focus"><h2>Share to</h2>
<label class="row"><input type="checkbox" id="toSlack" checked> Slack channel <input id="chan" placeholder="#program-leads" style="flex:1"></label>
<label class="row"><input type="checkbox" id="toConf"> Confluence program page, as a new dated section <input id="page" placeholder="page ID" style="width:120px"></label>
<label class="row"><input type="checkbox" id="toEpic"> Comment on epic ${esc(p.key)}</label>
<p class="small muted" style="margin:0">Posted as you. Mentions are added only for the people you name in the text.</p>
${button('Share', 'POST', `/api/programs/${p.key}/status/share`, { js: "{text:val('txt'),slackChannel:val('toSlack')?val('chan'):undefined,confluencePageId:val('toConf')?val('page'):undefined,epicComment:val('toEpic')}" }, { disabled: !draft })}
<a class="btn ghost" href="/programs/${esc(p.key)}">Back to program</a></section></div></div>`;
    return html(reply, `/programs/${p.key}/status`, 'Share status update', body);
  });
}
