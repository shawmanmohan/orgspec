import { pendingActions } from '@orgspec/gateway';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { type DecisionRecord, listDecisions, newDecision, searchDecisions } from '../decisions.js';
import {
  type InboxTask,
  listInbox,
  planJira,
  renameGroup,
  sendToJira,
  syncDmInbox,
  updateInboxTask,
} from '../inbox.js';
import { slackName } from '../oneonone.js';
import { proposeChange } from '../prs.js';
import { computeReminders } from '../reminder-rules.js';
import { completeReminder, listReminders, snoozeReminder } from '../reminders.js';
import {
  createSummaryTasks,
  getSummary,
  listSummaries,
  markDecision,
  postSummary,
  remindQuestion,
  type StoredSummary,
  type SummaryWindow,
  summarizeSlack,
} from '../slack.js';
import { localWorkspaces } from '../work.js';
import { ago, button, card, day, esc, freshness, heading, layout, pill } from './ui.js';

const KIND_LABEL: Record<string, [string, '' | 'ok' | 'warn' | 'bad' | 'info']> = {
  request: ['Request', 'info'],
  saved: ['Saved message', ''],
  commitment: ['My commitment', 'warn'],
  question: ['Question for you', 'info'],
  fyi: ['No action', ''],
};

export function registerSharedRoutes(app: FastifyInstance, ctx: AppContext) {
  const html = (reply: FastifyReply, path: string, title: string, body: string) =>
    reply.type('text/html').send(layout(ctx, path, title, body));
  const slackWorkspace = () => {
    const team = ctx.config()?.integrations.constants.slackWorkspace;
    return team ? `https://${team}.slack.com` : undefined;
  };
  const slackLink = (conversation: string, ts: string) => {
    const base = slackWorkspace();
    return base ? `${base}/archives/${conversation}/p${ts.replace('.', '')}` : undefined;
  };

  // ---- Reminders (where Slack reminder links land) ----
  app.post('/api/reminders/compute', async () => computeReminders(ctx));
  app.post(
    '/api/reminders/:id/snooze-for',
    async (req: FastifyRequest<{ Params: { id: string }; Body: { days: number } }>) => {
      snoozeReminder(ctx, req.params.id, new Date(Date.now() + (req.body.days ?? 1) * 86_400_000).toISOString());
      return { ok: true };
    },
  );
  app.post(
    '/api/reminders/:id/handoff',
    async (req: FastifyRequest<{ Params: { id: string }; Body: { to: string } }>) => {
      const r = listReminders(ctx).find((x) => x.id === req.params.id);
      if (!r) throw Object.assign(new Error('No such reminder'), { statusCode: 404 });
      // Asking someone else to take it is a message, so it waits for approval like any other.
      const a = pendingActions(ctx.db()).create({
        server: 'slack',
        tool: 'chat_post_message',
        args: { channel: req.body.to, text: `Could you take this over? ${r.title}` },
        summary: `Hand off to ${req.body.to}: ${r.title}`,
      });
      completeReminder(ctx, r.id);
      return { action: a.id };
    },
  );
  app.get('/reminders', async (_req, reply) => {
    const list = listReminders(ctx);
    const body = `${heading('Reminders', `Delivered as ${ctx.settings.reminders.mode === 'digest' ? `a daily digest at ${esc(ctx.settings.reminders.digestAt)}` : 'Slack DMs as they happen'}, to yourself. Change this in <a href="/settings">Settings</a>.`, button('Check now', 'POST', '/api/reminders/compute', undefined, { ghost: true }))}
<section class="card flush">${list.length ? list.map((r) => `<div class="item"><div class="row between"><b>${esc(r.title)}</b>${pill(r.kind.replace(/-/g, ' '))}</div><span class="small muted">due ${esc(day(r.dueAt))}${r.snoozedUntil ? ` · snoozed until ${esc(day(r.snoozedUntil))}` : ''}${r.deliveredAt ? ` · delivered ${esc(ago(r.deliveredAt))}` : ''}</span><div class="row">${r.url ? `<a class="btn" href="${esc(r.url)}">Open</a>` : ''}${button('Done', 'POST', `/api/reminders/${r.id}/done`, undefined, { ghost: true })}${button('Snooze 1 day', 'POST', `/api/reminders/${r.id}/snooze-for`, { days: 1 }, { ghost: true })}${button('Snooze 1 week', 'POST', `/api/reminders/${r.id}/snooze-for`, { days: 7 }, { ghost: true })}<button class="ghost" onclick="const t=prompt('Hand off to (Slack user ID)');if(t)act(this,'POST','/api/reminders/${r.id}/handoff',{to:t})">Hand off</button></div></div>`).join('') : '<p class="muted" style="padding:14px 20px;margin:0">Nothing waiting on you.</p>'}</section>`;
    return html(reply, '/reminders', 'Reminders', body);
  });

  // ---- Task inbox ----
  app.post('/api/inbox/sync', async () => syncDmInbox(ctx));
  app.post(
    '/api/inbox/:id',
    async (req: FastifyRequest<{ Params: { id: string }; Body: { state?: InboxTask['state']; pinned?: boolean } }>) => {
      updateInboxTask(ctx, req.params.id, req.body);
      return { ok: true };
    },
  );
  app.post('/api/inbox/groups/rename', async (req: FastifyRequest<{ Body: { key: string; name: string } }>) => {
    renameGroup(ctx, req.body.key, req.body.name);
    return { ok: true };
  });
  app.post(
    '/api/inbox/jira/plan',
    async (
      req: FastifyRequest<{
        Body: { ids: string[]; project: string; shape: 'epic' | 'story-subtasks' | 'separate'; epic?: string };
      }>,
    ) =>
      planJira(ctx, req.body.ids, {
        project: req.body.project,
        shape: req.body.shape,
        ...(req.body.epic ? { epic: req.body.epic } : {}),
      }),
  );
  app.post(
    '/api/inbox/jira/create',
    async (
      req: FastifyRequest<{
        Body: {
          ids: string[];
          project: string;
          shape: 'epic' | 'story-subtasks' | 'separate';
          epic?: string;
          replyInSlack?: boolean;
        };
      }>,
    ) => {
      const b = req.body;
      const plan = await planJira(ctx, b.ids, {
        project: b.project,
        shape: b.shape,
        ...(b.epic ? { epic: b.epic } : {}),
      });
      return sendToJira(ctx, plan, { replyInSlack: Boolean(b.replyInSlack) });
    },
  );

  app.get(
    '/inbox',
    async (
      req: FastifyRequest<{ Querystring: { tab?: string; send?: string; project?: string; shape?: string } }>,
      reply,
    ) => {
      const enabled = ctx.settings.dmInbox.enabled;
      const all = enabled ? await listInbox(ctx, true) : [];
      const open = all.filter((t) => t.state === 'open' || t.state === 'snoozed');
      const actionable = open.filter((t) => t.kind !== 'fyi');
      const tab = req.query.tab ?? 'next';
      const shown =
        tab === 'done'
          ? all.filter((t) => t.state === 'done')
          : tab === 'fyi'
            ? open.filter((t) => t.kind === 'fyi')
            : actionable;
      const taskHtml = (t: InboxTask) => {
        const [label, kind] = KIND_LABEL[t.kind] ?? ['Request', 'info'];
        const link = slackLink(t.conversation, t.ts);
        return `<div class="item"><div class="row between"><b>${t.pinned ? '📌 ' : ''}${esc(t.title)}</b><span class="row">${pill(label, kind)}${t.sources.length > 1 ? pill(`${t.sources.length} sources`) : ''}</span></div>
<span class="small muted">${esc(slackName(ctx, t.from))}${t.excerpt ? ` · “${esc(t.excerpt.slice(0, 160))}”` : ''}</span>
${t.why && tab === 'next' ? `<span class="small"><b>Why ${t.priority <= 2 ? 'first' : 'here'}:</b> ${esc(t.why)}</span>` : ''}
${t.repliedAt && t.state !== 'done' ? `<span class="small note info">You replied in Slack — mark this done?</span>` : ''}
<div class="row">${t.state === 'done' ? button('Reopen', 'POST', `/api/inbox/${t.id}`, { state: 'open' }, { ghost: true }) : `${button('Mark done', 'POST', `/api/inbox/${t.id}`, { state: 'done' })}${button(t.pinned ? 'Unpin' : 'Pin', 'POST', `/api/inbox/${t.id}`, { pinned: !t.pinned }, { ghost: true })}${button('Dismiss', 'POST', `/api/inbox/${t.id}`, { state: 'dismissed' }, { ghost: true })}`}${link ? `<a class="btn ghost" href="${esc(link)}">Open in Slack</a>` : ''}${t.jira ? pill(t.jira, 'info') : ''}<label class="small row"><input type="checkbox" class="pick" value="${esc(t.id)}"> select</label></div></div>`;
      };
      let main = '';
      if (!enabled) main = '<p class="note">The task inbox is off. Turn it on in Settings.</p>';
      else if (tab === 'group') {
        const groups = new Map<string, InboxTask[]>();
        for (const t of actionable)
          groups.set(t.group || 'Ungrouped', [...(groups.get(t.group || 'Ungrouped') ?? []), t]);
        main = [...groups]
          .map(
            ([g, ts]) =>
              `<section class="card flush"><div class="row between" style="padding:14px 20px;border-bottom:1px solid var(--line)"><h2>${esc(g)} · ${ts.length} task${ts.length === 1 ? '' : 's'}</h2><span class="row"><button class="ghost" onclick="const n=prompt('Group name', ${esc(JSON.stringify(g))});if(n)act(this,'POST','/api/inbox/groups/rename',{key:${esc(JSON.stringify(g))},name:n})">Rename</button><a class="btn ghost" href="/inbox?tab=group&send=${encodeURIComponent(ts.map((t) => t.id).join(','))}">Send group to Jira</a></span></div>${ts.map(taskHtml).join('')}</section>`,
          )
          .join('');
      } else
        main = `<section class="card flush">${shown.map(taskHtml).join('') || '<p class="muted" style="padding:14px 20px;margin:0">Nothing here.</p>'}</section>`;

      let side = card(
        'Send tasks to Jira',
        `<p class="sub">Select tasks, or use Send group to Jira. Nothing is created until you press Create.</p><a class="btn ghost" href="#" onclick="const ids=[...document.querySelectorAll('.pick:checked')].map(e=>e.value);if(!ids.length){alert('Select tasks first');return false}location.href='/inbox?tab=${esc(tab)}&send='+ids.join(',');return false">Preview selected</a>`,
      );
      if (req.query.send) {
        const ids = req.query.send.split(',').filter(Boolean);
        const projects = ctx.settings.jira.projects.length ? ctx.settings.jira.projects : ['PROJ'];
        const project = req.query.project ?? projects[0] ?? 'PROJ';
        const shape = (req.query.shape as 'epic' | 'story-subtasks' | 'separate' | undefined) ?? 'epic';
        const plan = await planJira(ctx, ids, { project, shape }).catch((e: Error) => ({ error: e.message }) as const);
        const fresh = 'items' in plan ? plan.items.filter((i) => !i.duplicateOf) : [];
        side = `<section class="card focus"><h2>Send ${ids.length} task${ids.length === 1 ? '' : 's'} to Jira</h2>
<label class="f">Project<select id="jp" onchange="location.href='/inbox?tab=${esc(tab)}&send=${esc(req.query.send)}&shape=${esc(shape)}&project='+this.value">${projects.map((p) => `<option ${p === project ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select></label>
<label class="f">Create as<select id="js" onchange="location.href='/inbox?tab=${esc(tab)}&send=${esc(req.query.send)}&project=${esc(project)}&shape='+this.value">${[
          ['epic', 'One epic with stories'],
          ['story-subtasks', 'One story with sub-tasks'],
          ['separate', 'Separate issues'],
        ]
          .map(([v, l]) => `<option value="${v}" ${v === shape ? 'selected' : ''}>${l}</option>`)
          .join('')}</select></label>
${shape !== 'separate' && fresh.length > 1 ? `<label class="f">${shape === 'epic' ? 'Epic' : 'Story'} title<input id="je" placeholder="Follow-ups from Slack"></label>` : ''}
${
  'items' in plan
    ? `<div><span class="k">Preview</span><ul class="clean">${plan.items.map((i) => `<li>${i.duplicateOf ? `${pill(`Already covered: ${i.duplicateOf}`, 'info')} ` : ''}${esc(i.summary)}</li>`).join('')}</ul></div>`
    : `<p class="note bad">${esc(plan.error)}</p>`
}
<label class="row small"><input type="checkbox" id="jr"> Reply in each Slack thread with the Jira link after creating</label>
<button onclick="act(this,'POST','/api/inbox/jira/create',()=>({ids:${esc(JSON.stringify(ids))},project:${esc(JSON.stringify(project))},shape:${esc(JSON.stringify(shape))},epic:val('je')||undefined,replyInSlack:val('jr')}),'/inbox?tab=done')">Create ${shape !== 'separate' && fresh.length > 1 ? `1 ${shape === 'epic' ? 'epic' : 'story'}, ` : ''}${fresh.length} issue${fresh.length === 1 ? '' : 's'}${'items' in plan && plan.items.length - fresh.length ? ` · link ${plan.items.length - fresh.length}` : ''}</button>
<p class="small muted" style="margin:0">Issues are created as you, and each links back to its Slack messages.</p></section>`;
      }
      const counts = {
        next: actionable.length,
        fyi: open.filter((t) => t.kind === 'fyi').length,
        done: all.filter((t) => t.state === 'done').length,
      };
      const body = `${heading('Task inbox', 'Private to you and stored only on this machine. Built from your Slack DMs and saved messages; never shown to managers or agents.', button('Check Slack now', 'POST', '/api/inbox/sync', undefined, { ghost: true }))}
${freshness(ctx, 'From Slack', ['slack.dms'])}
<div class="tabs">${[
        ['next', `Do next · ${counts.next}`],
        ['group', 'By group'],
        ['fyi', `No action detected · ${counts.fyi}`],
        ['done', `Done · ${counts.done}`],
      ]
        .map(([k, l]) => `<a href="/inbox?tab=${k}" class="${k === tab ? 'on' : ''}">${esc(l)}</a>`)
        .join('')}</div>
<div class="cols"><div class="main">${main}</div><div class="side">${side}</div></div>`;
      return html(reply, '/inbox', 'Task inbox', body);
    },
  );

  // ---- Slack summarizer ----
  app.post(
    '/api/slack/summarize',
    async (req: FastifyRequest<{ Body: { channels?: string; links?: string; window?: SummaryWindow } }>) => {
      const split = (v?: string) => (v ?? '').split(/[\s,]+/).filter(Boolean);
      return summarizeSlack(ctx, {
        channels: split(req.body.channels),
        links: split(req.body.links),
        window: req.body.window ?? '7d',
      });
    },
  );
  app.post(
    '/api/slack/:id/decision/:i',
    async (
      req: FastifyRequest<{
        Params: { id: string; i: string };
        Body: { state: 'confirmed' | 'rejected'; repo?: string };
      }>,
    ) => {
      const s = await markDecision(ctx, req.params.id, Number(req.params.i), req.body.state);
      if (req.body.state !== 'confirmed') return { ok: true };
      const d = s.decisions[Number(req.params.i)];
      const target = localWorkspaces(ctx).find((w) => w.slug === req.body.repo) ?? localWorkspaces(ctx)[0];
      if (!d || !target)
        throw Object.assign(new Error('No local repository to record the decision in'), { statusCode: 400 });
      const conflict = s.decisionConflicts[Number(req.params.i)];
      const file = newDecision(target.ws, {
        title: d.text.length > 80 ? `${d.text.slice(0, 77)}…` : d.text,
        decision: `${d.text}${d.by ? ` Agreed by ${d.by}${d.date ? `, ${d.date}` : ''}.` : ''}`,
        context: `Recorded from a Slack summary of ${s.channels.map((c) => `#${c}`).join(', ')}.`,
        sources: s.links.length ? s.links : s.channels.map((c) => `#${c}`),
        ...(d.by ? { owner: d.by.split(/,| and /)[0]?.trim() ?? d.by } : {}),
        ...(conflict ? { supersedes: conflict.adrId } : {}),
      });
      const files = [file];
      if (conflict) {
        const old = listDecisions(target.ws, target.slug).find((x) => x.adrId === conflict.adrId);
        if (old) files.push(`${target.ws.repoRoot}/${old.file}`);
      }
      const url = await proposeChange(ctx, target.ws.repoRoot, {
        branch: `adr/${file.split('/').pop()?.replace(/\.md$/, '')}`,
        files,
        message: `Record decision: ${d.text.slice(0, 60)}`,
        title: `Decision: ${d.text.slice(0, 80)}`,
        body: `Recorded from a confirmed Slack summary.${conflict ? ` Supersedes ${conflict.adrId} (${conflict.title}) by link.` : ''}`,
      });
      return { url };
    },
  );
  app.post(
    '/api/slack/:id/tasks',
    async (req: FastifyRequest<{ Params: { id: string }; Body: { project: string } }>) => ({
      created: await createSummaryTasks(ctx, req.params.id, req.body.project),
    }),
  );
  app.post('/api/slack/:id/post', async (req: FastifyRequest<{ Params: { id: string } }>) => ({
    ts: await postSummary(ctx, req.params.id),
  }));
  app.post('/api/slack/:id/remind/:i', async (req: FastifyRequest<{ Params: { id: string; i: string } }>) => ({
    id: remindQuestion(ctx, await getSummary(ctx, req.params.id), Number(req.params.i)) ?? null,
  }));

  app.get('/slack', async (req: FastifyRequest<{ Querystring: { id?: string } }>, reply) => {
    const history = await listSummaries(ctx);
    const s: StoredSummary | undefined = req.query.id
      ? await getSummary(ctx, req.query.id).catch(() => undefined)
      : history[0];
    const repos = localWorkspaces(ctx);
    const projects = ctx.settings.jira.projects.length ? ctx.settings.jira.projects : ['PROJ'];
    const form = `<section class="card focus" id="sf"><h2>Summarize Slack</h2><p class="sub">Runs as you, so it reads only what you can already read.</p>
<label class="f">Channels (up to 5)<input name="channels" placeholder="payments-eng, C01ABCDEF"></label>
<label class="f">Time window<select name="window"><option value="24h">Last 24 hours</option><option value="7d" selected>Last 7 days</option><option value="30d">Last 30 days</option></select></label>
<label class="f">Thread or message links (up to 20)<textarea name="links" rows="3" placeholder="https://acme.slack.com/archives/C01/p1729…"></textarea></label>
<p class="small muted" style="margin:0">Tailored for ${esc(ctx.persona()?.metadata.name ?? 'you')}: action items for you come first.</p>
<button onclick="act(this,'POST','/api/slack/summarize',()=>form('sf'),j=>'/slack?id='+j.id)">Summarize</button>
<p class="small muted" style="margin:0">Kept 30 days, visible only to you. Nothing reaches shared memory or an agent until you confirm it.</p></section>`;
    const hist = history.length
      ? card(
          'Earlier summaries',
          `<ul class="clean">${history.map((h) => `<li><a href="/slack?id=${esc(h.id)}">${esc(h.channels.map((c) => `#${c}`).join(', ') || `${h.links.length} threads`)}</a> <span class="small muted">· ${esc(ago(h.createdAt))}</span></li>`).join('')}</ul>`,
        )
      : '';
    const result = s
      ? `<section class="card"><div class="row between"><h2>${esc([s.channels.length ? `${s.channels.length} channel${s.channels.length === 1 ? '' : 's'}` : '', s.links.length ? `${s.links.length} thread${s.links.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(', '))} · ${esc(s.window)}</h2><span class="small muted">${s.messages} messages read · ${esc(day(s.range.from))}–${esc(day(s.range.to))}</span></div></section>
${card(
  'Tasks',
  s.tasks.length
    ? `<ul class="clean">${s.tasks.map((t, i) => `<li>${esc(t.text)} · <span class="muted">${esc(t.owner || 'owner not stated')}${t.due ? ` · due ${esc(t.due)}` : ' · no due date'}</span> ${s.tasksExisting[i] ? pill(`Exists: ${s.tasksExisting[i]}`, 'info') : ''}</li>`).join('')}</ul>`
    : '<p class="muted" style="margin:0">No tasks.</p>',
)}
${card('Summary', s.summary.map((x) => `<p style="margin:0"><b>${esc(x.topic)}.</b> ${esc(x.text)} <span class="small muted">${x.messages} messages</span></p>`).join('') || '<p class="muted" style="margin:0">Nothing to summarise.</p>')}
${card(
  'Decisions · candidates until someone confirms',
  s.decisions.length
    ? s.decisions
        .map((d, i) => {
          const st = s.decisionState[i];
          const conflict = s.decisionConflicts[i];
          return `<div class="item" style="padding:10px 0"><span>${esc(d.text)}${d.by ? ` <span class="muted">Agreed by ${esc(d.by)}${d.date ? `, ${esc(d.date)}` : ''}.</span>` : ''}</span>
${conflict ? `<span class="small note warn">Conflicts with ${esc(conflict.adrId)} “${esc(conflict.title)}”. Saving supersedes it by link and opens a PR for review.</span>` : ''}
${st ? pill(st === 'confirmed' ? 'Saved as ADR · PR opened' : 'Not a decision', st === 'confirmed' ? 'ok' : '') : `<div class="row">${repos.length > 1 ? `<select id="dr${i}">${repos.map((r) => `<option>${esc(r.slug)}</option>`).join('')}</select>` : ''}${button('Confirm and save as ADR', 'POST', `/api/slack/${s.id}/decision/${i}`, { js: `{state:'confirmed',repo:val('dr${i}')}` }, { disabled: !repos.length })}${button('Not a decision', 'POST', `/api/slack/${s.id}/decision/${i}`, { state: 'rejected' }, { ghost: true })}</div>`}</div>`;
        })
        .join('')
    : '<p class="muted" style="margin:0">No decisions.</p>',
)}
${card('Open questions', s.questions.length ? `<ul class="clean">${s.questions.map((q, i) => `<li>${esc(q.text)}${q.askedOf ? ` <span class="muted">Asked of: ${esc(q.askedOf)}</span>` : ''} ${button('Set reminder', 'POST', `/api/slack/${s.id}/remind/${i}`, undefined, { ghost: true })}</li>`).join('')}</ul>` : '<p class="muted" style="margin:0">None.</p>')}
${card('Next steps', `${s.nextSteps.length ? `<ol class="clean">${s.nextSteps.map((n) => `<li>${esc(n)}</li>`).join('')}</ol>` : ''}<div class="row"><select id="tp">${projects.map((p) => `<option>${esc(p)}</option>`).join('')}</select>${button(`Create ${s.tasks.filter((_, i) => !s.tasksExisting[i]).length} Jira tasks`, 'POST', `/api/slack/${s.id}/tasks`, { js: "{project:val('tp')}" })}${button('Post summary to thread', 'POST', `/api/slack/${s.id}/post`, undefined, { ghost: true })}</div><p class="small muted" style="margin:0">Each action runs only after you click it, as you.</p>`)}`
      : '<p class="muted">Run a summary to see tasks, decisions and open questions.</p>';
    return html(
      reply,
      '/slack',
      'Slack summarizer',
      `${heading('Slack summarizer')}<div class="cols"><div class="side">${form}${hist}</div><div class="main">${result}</div></div>`,
    );
  });

  // ---- Decisions ----
  app.post(
    '/api/decisions/record',
    async (
      req: FastifyRequest<{
        Body: {
          repo: string;
          title: string;
          decision: string;
          context?: string;
          scope?: string;
          review?: string;
          sources?: string;
          supersedes?: string;
        };
      }>,
    ) => {
      const b = req.body;
      const target = localWorkspaces(ctx).find((w) => w.slug === b.repo) ?? localWorkspaces(ctx)[0];
      if (!target)
        throw Object.assign(new Error('No local repository with orgspec/ to record in'), { statusCode: 400 });
      if (!b.title?.trim()) throw Object.assign(new Error('Title is required'), { statusCode: 400 });
      const scope = (b.scope ?? '').split(/[\s,]+/).filter(Boolean);
      const file = newDecision(target.ws, {
        title: b.title.trim(),
        decision: b.decision,
        ...(b.context ? { context: b.context } : {}),
        paths: scope.filter((x) => x.includes('/') || x.includes('*')),
        capabilities: scope.filter((x) => !x.includes('/') && !x.includes('*')),
        ...(b.review ? { review: b.review } : {}),
        sources: (b.sources ?? '').split(/[\s,]+/).filter(Boolean),
        ...(b.supersedes ? { supersedes: b.supersedes.toUpperCase() } : {}),
        ...(ctx.settings.identity.email ? { owner: ctx.settings.identity.email } : {}),
      });
      const files = [file];
      if (b.supersedes) {
        const old = listDecisions(target.ws, target.slug).find((x) => x.adrId === b.supersedes?.toUpperCase());
        if (old) files.push(`${target.ws.repoRoot}/${old.file}`);
      }
      const url = await proposeChange(ctx, target.ws.repoRoot, {
        branch: `adr/${file.split('/').pop()?.replace(/\.md$/, '')}`,
        files,
        message: `Record decision: ${b.title.slice(0, 60)}`,
        title: `Decision: ${b.title.slice(0, 80)}`,
        body: `${b.decision}\n\nLands as a Markdown file in orgspec/decisions/ and takes effect when this PR merges.`,
      });
      return { url };
    },
  );

  app.get(
    '/decisions',
    async (
      req: FastifyRequest<{ Querystring: { q?: string; status?: string; scope?: string; id?: string } }>,
      reply,
    ) => {
      const all: DecisionRecord[] = localWorkspaces(ctx).flatMap((w) => listDecisions(w.ws, w.slug));
      const q = req.query.q ?? '';
      const statusAll = req.query.status === 'all';
      const hits = q ? new Set(searchDecisions(ctx.db(), q, 50).map((h) => h.adrId)) : undefined;
      const scopes = [...new Set(all.flatMap((d) => d.scopeCapabilities))].sort();
      const list = all
        .filter((d) =>
          statusAll
            ? true
            : !['superseded', 'rejected', 'deprecated'].includes(d.status.toLowerCase()) && !d.supersededBy,
        )
        .filter((d) => !hits || hits.has(d.adrId) || d.title.toLowerCase().includes(q.toLowerCase()))
        .filter((d) => !req.query.scope || d.scopeCapabilities.includes(req.query.scope))
        .sort((a, b) => b.adrId.localeCompare(a.adrId));
      const sel = list.find((d) => d.adrId === req.query.id) ?? list[0];
      const today = new Date().toISOString().slice(0, 10);
      const statusPill = (d: DecisionRecord) =>
        d.supersededBy
          ? pill(`Superseded once ${d.supersededBy} merges`)
          : d.status === 'accepted' &&
              d.review &&
              d.review <= new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10)
            ? pill(`Accepted · review due ${d.review < today ? 'now' : day(d.review)}`, 'warn')
            : pill(
                d.status[0]?.toUpperCase() + d.status.slice(1),
                d.status === 'accepted' ? 'ok' : d.status === 'proposed' ? 'info' : '',
              );
      const qs = (o: Record<string, string>) =>
        new URLSearchParams({
          ...(q ? { q } : {}),
          ...(req.query.status ? { status: req.query.status } : {}),
          ...(req.query.scope ? { scope: req.query.scope } : {}),
          ...o,
        }).toString();
      const listHtml = list
        .map(
          (d) =>
            `<a class="item" href="/decisions?${esc(qs({ id: d.adrId }))}" style="color:var(--fg);text-decoration:none;${sel?.adrId === d.adrId ? 'background:var(--accent-soft)' : ''}"><span class="row small"><span class="mono">${esc(d.adrId)}</span>${statusPill(d)}</span><b style="${d.supersededBy ? 'text-decoration:line-through' : ''}">${esc(d.title)}</b><span class="small muted">${esc([d.scopeCapabilities.join(', '), d.supersedes ? `supersedes ${d.supersedes}` : '', d.repo].filter(Boolean).join(' · '))}</span></a>`,
        )
        .join('');
      const sec = (name: string) =>
        sel?.sections[name] ??
        sel?.sections[
          Object.keys(sel.sections).find((k) => k.toLowerCase().startsWith(name.toLowerCase().slice(0, 6))) ?? ''
        ];
      const detail = sel
        ? `<article class="card"><div class="row between"><div><span class="mono small muted">${esc(sel.adrId)} · ${esc(sel.status)}${sel.date ? ` ${esc(day(sel.date))}` : ''}${sel.owner ? ` by ${esc(sel.owner)}` : ''}</span><h2 style="font-size:22px">${esc(sel.title)}</h2></div><span class="small mono muted">${esc(sel.repo)}:${esc(sel.file)}</span></div>
${['Decision', 'Context', 'Options considered', 'Consequences'].map((h) => (sec(h) ? `<div><span class="k">${esc(h)}</span><p style="margin:4px 0 0;white-space:pre-wrap">${esc(sec(h))}</p></div>` : '')).join('')}
<div class="grid"><div><span class="k">Owner</span><br>${esc(sel.owner ?? '—')}</div><div><span class="k">Review date</span><br>${esc(sel.review ? day(sel.review) : '—')}</div><div><span class="k">Scope</span><br><span class="mono">${esc([...sel.scopeCapabilities, ...sel.scopePaths].join(' · ') || '—')}</span></div></div>
${sel.sources.length ? `<div><span class="k">Sources</span><ul class="clean">${sel.sources.map((x) => `<li>${/^https?:/.test(x) ? `<a href="${esc(x)}">${esc(x)}</a>` : esc(x)}</li>`).join('')}</ul></div>` : ''}
${sel.supersedes ? `<p class="note warn">Supersedes <a href="/decisions?${esc(qs({ id: sel.supersedes, status: 'all' }))}">${esc(sel.supersedes)}</a> by link. ${esc(sel.supersedes)} stays in history and is marked superseded when this merges.</p>` : ''}</article>`
        : '<p class="muted">No decision records found in your local repositories.</p>';
      const repos = localWorkspaces(ctx);
      const record = `<section class="card focus" id="record"><h2>Record a decision</h2><div class="grid" id="rf">
<label class="f">Title<input name="title" placeholder="One line: what was decided"></label>
<label class="f">Where it lives<select name="repo">${repos.map((r) => `<option>${esc(r.slug)}</option>`).join('') || '<option value="">no local repository</option>'}</select></label>
<label class="f">Decision<textarea name="decision" rows="3"></textarea></label>
<label class="f">Context and options considered<textarea name="context" rows="3"></textarea></label>
<label class="f">Scope: capabilities or paths<input name="scope" class="mono"></label>
<label class="f">Review date<input name="review" type="date"></label>
<label class="f">Sources (Slack, Jira, Confluence links)<input name="sources"></label>
<label class="f">Supersedes<input name="supersedes" placeholder="ADR id, if any"></label></div>
<div class="row">${button('Open PR with this decision', 'POST', '/api/decisions/record', { js: "form('rf')" }, { disabled: !repos.length })}<span class="small muted">Lands as a Markdown file in orgspec/decisions/ and takes effect when the PR merges.</span></div></section>`;
      const body = `${heading('Decisions', 'Decision records from your repositories. Agents check these before proposing a change.', '<a class="btn" href="#record">Record a decision</a>')}
<form class="row" style="align-items:flex-end"><label class="f" style="flex:1 1 300px">Search<input name="q" value="${esc(q)}"></label><label class="f">Status<select name="status"><option value="">Accepted and proposed</option><option value="all" ${statusAll ? 'selected' : ''}>All, including superseded</option></select></label><label class="f">Scope<select name="scope"><option value="">Any capability</option>${scopes.map((x) => `<option ${x === req.query.scope ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></label><button>Apply</button></form>
<div class="cols"><div class="side"><section class="card flush">${listHtml || '<p class="muted" style="padding:14px 20px;margin:0">No matches.</p>'}</section></div><div class="main">${detail}</div></div>${record}`;
      return html(reply, '/decisions', 'Decisions', body);
    },
  );
}
