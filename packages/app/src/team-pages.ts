import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from './context.js';
import { button, card, esc, page } from './dashboard.js';
import {
  addAction,
  addAgendaItem,
  CADENCES,
  type Cadence,
  completeAction,
  findReport,
  latestBrief,
  listActions,
  prepareBrief,
  privateNotes,
  type RosterEntry,
  roster,
  savePrivateNote,
  scheduleOneOnOne,
  sharedPage,
  suggestSlots,
} from './oneonone.js';

const when = (iso?: string) =>
  iso
    ? new Date(iso).toLocaleString([], {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';
const day = (iso?: string) => (iso ? new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' }) : '');

function briefStatus(r: RosterEntry): string {
  if (!r.nextOneOnOne) return '<span class="muted">After scheduling</span>';
  if (r.briefAt && Date.now() - Date.parse(r.briefAt) < 7 * 86_400_000) return '<span class="ok">Ready</span>';
  return '<span class="muted">Not built yet</span>';
}

const TEAM_CSS = `<style>
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}@media (max-width:760px){.grid2{grid-template-columns:1fr}}
.note{border-left:3px solid var(--accent);padding:8px 12px;background:var(--card);border-radius:4px;margin:0 0 14px}
.src{font-size:12px;color:var(--accent);margin-left:6px}.ctx{color:var(--muted);font-style:italic}
.who{font-weight:600}.sub{color:var(--muted);font-size:13px}.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
textarea.wide,input.wide{width:100%}
ul.clean{margin:0;padding-left:18px}ul.clean li{margin:4px 0}
</style>`;

/** "Team & 1:1s" and the 1:1 prep page for engineering managers. */
export function registerTeamRoutes(app: FastifyInstance, ctx: AppContext): void {
  const html = (reply: FastifyReply, path: string, title: string, body: string) =>
    reply.type('text/html').send(page(path, title, TEAM_CSS + body));
  const report = (email: string) => findReport(ctx, decodeURIComponent(email));

  // ---- API ----
  app.get('/api/team', async () => roster(ctx));
  app.post('/api/team/:email/brief', async (req: FastifyRequest<{ Params: { email: string } }>) =>
    prepareBrief(ctx, await report(req.params.email)),
  );
  app.post(
    '/api/team/:email/agenda',
    async (req: FastifyRequest<{ Params: { email: string }; Body: { item: string } }>) => ({
      version: await addAgendaItem(ctx, await report(req.params.email), req.body.item),
    }),
  );
  app.post(
    '/api/team/:email/notes',
    async (req: FastifyRequest<{ Params: { email: string }; Body: { text: string } }>) => {
      const r = await report(req.params.email);
      return { id: await savePrivateNote(ctx, r.email, req.body.text) };
    },
  );
  app.post(
    '/api/team/:email/actions',
    async (
      req: FastifyRequest<{ Params: { email: string }; Body: { text: string; owner?: 'manager' | 'report' } }>,
    ) => ({
      id: await addAction(ctx, await report(req.params.email), req.body.text, req.body.owner ?? 'manager'),
    }),
  );
  app.post('/api/team/actions/:id/done', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    completeAction(ctx, req.params.id);
    return { ok: true };
  });
  app.get(
    '/api/team/:email/slots',
    async (req: FastifyRequest<{ Params: { email: string }; Querystring: { cadence?: Cadence } }>) =>
      suggestSlots(ctx, await report(req.params.email), req.query.cadence ?? 'weekly'),
  );
  app.post(
    '/api/team/:email/schedule',
    async (
      req: FastifyRequest<{
        Params: { email: string };
        Body: { cadence: Cadence; start: string; end: string; createPage?: boolean };
      }>,
    ) => {
      const b = req.body;
      return scheduleOneOnOne(ctx, await report(req.params.email), {
        cadence: b.cadence,
        slot: { start: b.start, end: b.end },
        createPage: b.createPage ?? true,
      });
    },
  );

  // ---- Team & 1:1s ----
  app.get('/team', async (req: FastifyRequest<{ Querystring: { schedule?: string; cadence?: Cadence } }>, reply) => {
    let people: RosterEntry[] = [];
    let error = '';
    try {
      people = await roster(ctx);
    } catch (e) {
      error = (e as Error).message;
    }
    const rows = people.map((r) => {
      const href = `/team/${encodeURIComponent(r.email)}`;
      const action = !r.nextOneOnOne
        ? `<a href="/team?schedule=${encodeURIComponent(r.email)}">Schedule</a>`
        : r.briefAt && Date.now() - Date.parse(r.briefAt) < 7 * 86_400_000
          ? `<a href="${href}">Open brief</a>`
          : `<a href="${href}">Prepare</a>`;
      return [
        `<div class="who"><a href="${href}">${esc(r.name)}</a></div><div class="sub">${esc([r.title, r.team].filter(Boolean).join(' · '))}</div>`,
        r.cadence ? esc(CADENCES[r.cadence].label.split(',')[0]) : '<span class="muted">Not set</span>',
        r.nextOneOnOne ? esc(when(r.nextOneOnOne.start)) : '<span class="muted">Not scheduled</span>',
        String(r.openActions),
        briefStatus(r),
        action,
      ];
    });
    const synced = (
      ctx.db().prepare("select last_success_at from sync_state where source = 'hr.directory'").get() as
        | { last_success_at?: string }
        | undefined
    )?.last_success_at;
    let schedule = '';
    if (req.query.schedule) {
      const target = people.find((p) => p.email === req.query.schedule);
      if (target) {
        const cadence: Cadence = req.query.cadence ?? 'weekly';
        const slots = await suggestSlots(ctx, target, cadence).catch((e: Error) => {
          error = `Free/busy lookup failed: ${e.message}`;
          return [];
        });
        schedule = card(
          `Schedule 1:1 with ${target.name.split(' ')[0]}`,
          `<div class="row">Cadence ${Object.entries(CADENCES)
            .map(
              ([k, c]) =>
                `<a class="pill" ${k === cadence ? 'style="border-color:var(--accent)"' : ''} href="/team?schedule=${encodeURIComponent(target.email)}&cadence=${k}">${esc(c.label)}</a>`,
            )
            .join(' ')}</div>
<h2>Free in both calendars</h2>
${
  slots.length
    ? `<ul class="clean">${slots
        .map(
          (s) =>
            `<li>${esc(new Date(s.start).toLocaleString([], { weekday: 'long', hour: '2-digit', minute: '2-digit' }))}–${esc(new Date(s.end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))} from ${esc(day(s.start))} ${button('Create recurring event', 'POST', `/api/team/${encodeURIComponent(target.email)}/schedule`, { cadence, start: s.start, end: s.end, createPage: true })}</li>`,
        )
        .join('')}</ul>`
    : '<p class="muted">No common free time in the next two weeks.</p>'
}
<p class="sub">Also creates a restricted Confluence page for your shared agenda and notes. The event is sent from your calendar only after you approve it under Approvals. ${esc(target.name.split(' ')[0])} is told what the 1:1 evidence includes before the first brief.</p>`,
        );
      }
    }
    const body = `
<p class="sub">${people.length} direct report${people.length === 1 ? '' : 's'} from the HR directory${synced ? `, synced ${esc(when(synced))}` : ''}. ${button('Refresh now', 'POST', '/api/sync/hr.directory/run', undefined, true)}</p>
${error ? `<p class="bad">${esc(error)}</p>` : ''}
${schedule}
<div class="card"><table><thead><tr>${['Person', 'Cadence', 'Next 1:1', 'Open actions', 'Prep brief', 'Action'].map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>
${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('') || '<tr><td colspan="6" class="muted">No direct reports in the HR directory.</td></tr>'}
</tbody></table></div>
<p class="sub">You can only add people the HR directory lists as your reports; anything else goes to HR as a manager-change request. When someone moves, your access to their briefs ends that day.</p>`;
    return html(reply, '/team', 'Team and 1:1s', body);
  });

  // ---- 1:1 prep ----
  app.get('/team/:email', async (req: FastifyRequest<{ Params: { email: string } }>, reply) => {
    const r = await report(req.params.email);
    const enc = encodeURIComponent(r.email);
    const [brief, shared, notes, actions] = await Promise.all([
      latestBrief(ctx, r.email),
      sharedPage(ctx, r).catch(() => undefined),
      privateNotes(ctx, r.email),
      listActions(ctx, r.email),
    ]);
    const src = (s: string) => `<span class="src">${esc(s)}</span>`;
    const first = r.name.split(' ')[0];
    const header = `<p><a href="/team">Team and 1:1s</a> / ${esc(r.name)}</p>
<h2 style="font-size:17px;margin:4px 0">1:1 with ${esc(r.name)}${r.nextOneOnOne ? ` · ${esc(when(r.nextOneOnOne.start))}` : ''}</h2>
<p class="sub">${brief ? `Brief built ${esc(day(brief.createdAt))} from Jira, GitHub and your shared page, since ${esc(day(brief.since))}${brief.dropped ? ` · ${brief.dropped} unsourced item(s) left out` : ''}` : 'No brief yet.'} ${button(brief ? 'Rebuild brief' : 'Prepare brief', 'POST', `/api/team/${enc}/brief`, undefined, Boolean(brief))}</p>
<p class="note">A preparation aid, not an evaluation. No scores or rankings, and it never feeds pay or promotion decisions. ${esc(first)} sees the same evidence and can add context on your shared page.</p>`;

    const left = brief
      ? [
          card(
            'From last time',
            actions.length
              ? `<ul class="clean">${actions.map((a) => `<li>${a.owner === 'manager' ? 'You' : esc(first)}: ${esc(a.text)}</li>`).join('')}</ul>`
              : '<p class="muted">No open actions.</p>',
          ),
          card(
            'Work since the last 1:1',
            `<p>${esc(brief.workSince)}</p>${shared?.context.length ? `<p class="ctx">${esc(first)}'s context: ${esc(shared.context.join(' '))}</p>` : ''}`,
          ),
          `<div class="grid2">${card('Strengths', brief.strengths.length ? `<ul class="clean">${brief.strengths.map((s) => `<li>${esc(s.text)}${src(s.source)}</li>`).join('')}</ul>` : '<p class="muted">No evidence in these sources.</p>')}${card('Growth areas', brief.growth.length ? `<ul class="clean">${brief.growth.map((s) => `<li>${esc(s.text)}${src(s.source)}</li>`).join('')}</ul>` : '<p class="muted">No evidence in these sources.</p>')}</div>`,
          card(
            'Progress against goals',
            brief.goals.length
              ? `<ul class="clean">${brief.goals.map((g) => `<li><b>${esc(g.goal)}:</b> ${esc(g.progress)}</li>`).join('')}</ul>`
              : '<p class="muted">No goals on the shared page yet.</p>',
          ),
          brief.feedback
            ? card(
                'Suggested feedback · draft, adapt it in your own words',
                `<p class="sub">Situation, behaviour, impact</p><p>${esc(brief.feedback.situation)} ${esc(brief.feedback.behaviour)} ${esc(brief.feedback.impact)} ${esc(brief.feedback.ask)}</p>`,
              )
            : '',
          card(
            'Questions to ask',
            brief.questions.length
              ? `<ul class="clean">${brief.questions.map((q) => `<li>${esc(q)}</li>`).join('')}</ul>`
              : '<p class="muted">None.</p>',
          ),
        ].join('')
      : card(
          'Brief',
          `<p class="muted">Build a brief to see work since the last 1:1, sourced strengths and growth areas, goal progress and questions.</p>`,
        );

    const right = [
      card(
        'Shared agenda',
        `<p class="sub">${shared ? 'On your restricted Confluence page' : 'A restricted Confluence page is created on the first item'}</p>${shared?.agenda.length ? `<ul class="clean">${shared.agenda.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>` : '<p class="muted">Nothing yet.</p>'}
<div class="row"><input id="ag" class="wide" placeholder="Add agenda item"><button onclick="act(this,'POST','/api/team/${enc}/agenda',{item:document.getElementById('ag').value})">Add</button></div>`,
      ),
      card(
        'Private notes',
        `<p class="sub">Only you, stored encrypted on this machine</p>${notes.length ? `<ul class="clean">${notes.map((n) => `<li><span class="sub">${esc(day(n.updatedAt))}</span> ${esc(n.text)}</li>`).join('')}</ul>` : ''}
<textarea id="pn" class="wide" rows="3" placeholder="Private notes"></textarea><p><button onclick="act(this,'POST','/api/team/${enc}/notes',{text:document.getElementById('pn').value})">Save note</button></p>`,
      ),
      card(
        'Agreed actions',
        `<p class="sub">Added during the 1:1; each gets a reminder and opens the next brief.</p>${actions.length ? `<ul class="clean">${actions.map((a) => `<li>${a.owner === 'manager' ? 'You' : esc(first)}: ${esc(a.text)} ${button('Done', 'POST', `/api/team/actions/${a.id}/done`, undefined, true)}</li>`).join('')}</ul>` : ''}
<div class="row"><input id="aa" class="wide" placeholder="Add action"><select id="ao"><option value="manager">Me</option><option value="report">${esc(first)}</option></select><button onclick="act(this,'POST','/api/team/${enc}/actions',{text:document.getElementById('aa').value,owner:document.getElementById('ao').value})">Add</button></div>`,
      ),
      '<p class="sub">Your views of this brief are logged. Kept per HR policy.</p>',
    ].join('');
    return html(
      reply,
      '/team',
      `1:1 prep with ${r.name}`,
      `${header}<div class="grid2" style="grid-template-columns:1.4fr 1fr">${`<div>${left}</div><div>${right}</div>`}</div>`,
    );
  });
}
