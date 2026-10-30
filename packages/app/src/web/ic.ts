import { openTerminal } from '@orgspec/claude';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { addMyAgendaItem, addMyContext, myEvidence } from '../evidence.js';
import { createPacket, listPackets } from '../packet.js';
import { findChange, lastVerification, renderVerificationMd, type Verdict, verifyChange } from '../verify.js';
import { cleanLogs, myIssues, mySessions, specState, specSummary, ticketDetail } from '../work.js';
import { ago, button, card, day, esc, freshness, heading, layout, pill, table, when } from './ui.js';

const VERDICT_PILL: Record<Verdict, '' | 'ok' | 'warn' | 'bad'> = {
  met: 'ok',
  partial: 'warn',
  'not-met': 'bad',
  unclear: '',
};

/** "Check against the spec · advisory": the last verifier run for this ticket's change, and a button to run it. */
function verifierCard(ctx: AppContext, key: string, changeId?: string): string {
  if (!changeId)
    return card(
      'Check against the spec · advisory',
      '<p class="small muted" style="margin:0">No change folder with scenarios for this ticket on this machine, so there is nothing to check.</p>',
    );
  const v = lastVerification(ctx, changeId);
  const run = button(v ? 'Run again' : 'Run verifier', 'POST', `/api/tickets/${key}/verify`, {}, { ghost: true });
  const intro =
    '<p class="small muted" style="margin:0">Runs on this machine before you open or update the PR: an agent reads the branch diff and judges each scenario in the spec. The result goes into the PR description. Only the deterministic trace in the CI check can block a merge.</p>';
  if (!v) return card('Check against the spec · advisory', `${intro}<div class="row">${run}</div>`);
  return card(
    'Check against the spec · advisory',
    `${intro}<p style="margin:0">${esc(v.summary)} <span class="small muted">· ${esc(ago(v.ranAt))} against <code>${esc(v.base)}</code></span></p>
${table(
  ['Scenario', 'Verdict', 'Evidence'],
  v.scenarios.map((s) => [
    `<code>${esc(s.id)}</code>`,
    pill(s.verdict, VERDICT_PILL[s.verdict]),
    `${esc(s.evidence)}${s.files.length ? `<br><span class="small muted">${s.files.map(esc).join(', ')}</span>` : ''}`,
  ]),
)}
<details><summary class="small">Markdown for the PR description</summary><pre style="white-space:pre-wrap;font-size:12px">${esc(renderVerificationMd(v))}</pre></details>
<div class="row">${run}</div>`,
  );
}

const STATE_LABEL = {
  'needs-input': ['Needs input', 'warn'],
  working: ['Working', 'info'],
  ready: ['Ready for review', 'ok'],
  idle: ['Idle', ''],
  stopped: ['Stopped', ''],
} as const;

export function registerIcRoutes(app: FastifyInstance, ctx: AppContext) {
  const html = (reply: FastifyReply, path: string, title: string, body: string, active?: string) =>
    reply.type('text/html').send(layout(ctx, path, title, body, active ? { active } : {}));

  // ---- APIs ----
  app.get('/api/work', async () => myIssues(ctx));
  app.post('/api/tickets/:key/verify', async (req: FastifyRequest<{ Params: { key: string } }>) => {
    const found = findChange(ctx, req.params.key);
    if (!found)
      throw Object.assign(new Error(`No change folder for ${req.params.key} on this machine`), { statusCode: 404 });
    return verifyChange(ctx, found.ws, found.changeId);
  });
  app.get('/api/agents', async () => mySessions(ctx));
  app.get('/api/agents/:id/logs', async (req: FastifyRequest<{ Params: { id: string } }>) => ({
    lines: cleanLogs(await ctx.sessions.logs(req.params.id), 40),
  }));
  app.post('/api/agents/:id/:verb', async (req: FastifyRequest<{ Params: { id: string; verb: string } }>) => {
    const { id, verb } = req.params;
    const s = ctx.sessions;
    if (verb === 'stop') await s.stop(id);
    else if (verb === 'restart') await s.respawn(id);
    else if (verb === 'remove') await s.remove(id);
    else if (verb === 'attach')
      openTerminal({
        app: ctx.settings.terminal,
        cwd: ctx.workRoot,
        command: s.attachCommand(id),
        scriptDir: ctx.paths.packets,
        name: `attach-${id}`,
      });
    else throw Object.assign(new Error(`Unknown action ${verb}`), { statusCode: 400 });
    return { ok: true };
  });
  app.post(
    '/api/tickets/:key/send',
    async (
      req: FastifyRequest<{
        Params: { key: string };
        Body: { launch?: 'background' | 'interactive'; repos?: string[] };
      }>,
    ) => {
      const p = await createPacket(ctx, {
        ticket: req.params.key,
        launch: req.body?.launch ?? ctx.settings.sendMode,
        ...(req.body?.repos?.length ? { repos: req.body.repos } : {}),
      });
      return { folder: p.folder, warnings: p.warnings, claudeSession: p.claudeSession ?? null };
    },
  );
  app.get('/api/evidence', async () => myEvidence(ctx));
  app.post(
    '/api/evidence/context',
    async (req: FastifyRequest<{ Body: { text: string; about?: string; correction?: boolean } }>) => ({
      version: await addMyContext(ctx, req.body.text, {
        ...(req.body.about ? { about: req.body.about } : {}),
        ...(req.body.correction ? { correction: true } : {}),
      }),
    }),
  );
  app.post('/api/evidence/agenda', async (req: FastifyRequest<{ Body: { item: string } }>) => ({
    version: await addMyAgendaItem(ctx, req.body.item),
  }));

  // ---- My work ----
  app.get('/work', async (req: FastifyRequest<{ Querystring: { sort?: string } }>, reply) => {
    const rules = ctx.bundle().bundle?.rules ?? [];
    const issues = myIssues(ctx);
    const sort = req.query.sort ?? 'priority';
    const prio = (p?: string) => ['highest', 'high', 'medium', 'low', 'lowest'].indexOf((p ?? 'medium').toLowerCase());
    issues.sort((a, b) =>
      sort === 'status'
        ? a.status.localeCompare(b.status)
        : sort === 'updated'
          ? b.updated.localeCompare(a.updated)
          : prio(a.priority) - prio(b.priority),
    );
    const sessions = await mySessions(ctx);
    const prs = ctx.db().prepare('select repo, number, branch, url, state from cache_github_prs').all() as {
      repo: string;
      number: number;
      branch: string;
      url: string;
      state: string;
    }[];
    const runs = ctx.db().prepare('select branch, status from cache_ci_runs order by source_updated_at desc').all() as {
      branch: string;
      status: string;
    }[];
    const packets = listPackets(ctx);
    const rows = issues.map((i) => {
      const spec = specState(ctx, i.key, i.type, rules);
      const tier = spec.tier ?? (spec.label.startsWith('Not needed') ? 'low' : 'medium');
      const pr = prs.find((p) => p.branch.toLowerCase().startsWith(i.key.toLowerCase()));
      const ci = pr ? runs.find((r) => r.branch === pr.branch) : undefined;
      const packet = packets.find((p) => p.ticket === i.key);
      const session = sessions.find((s) => s.ticket === i.key);
      const sendable = spec.label === 'Approved' || spec.label.startsWith('Not needed');
      const action =
        session?.state === 'needs-input'
          ? button('Connect to agent', 'POST', `/api/agents/${session.id}/attach`)
          : session?.state === 'stopped'
            ? `<a class="btn ghost" href="/agents">Resume</a>`
            : pr
              ? `<a class="btn ghost" href="${esc(pr.url)}">Open PR</a>`
              : sendable
                ? `<a class="btn" href="/ticket/${esc(i.key)}">Send to agent</a>`
                : `<span class="small muted">Waiting for spec approval</span>`;
      return [
        `<a href="/ticket/${esc(i.key)}" class="mono">${esc(i.key)}</a><br><span class="small muted">${esc([i.type, i.priority].filter(Boolean).join(' · '))}</span><br>${esc(i.summary)}`,
        esc(i.status),
        pill(tier[0]?.toUpperCase() + tier.slice(1), tier === 'high' ? 'bad' : tier === 'medium' ? 'warn' : ''),
        pill(spec.label, spec.kind),
        pr
          ? `<a href="${esc(pr.url)}">#${pr.number}</a> ${esc(pr.state)}${ci ? `<br><span class="small ${ci.status === 'failed' ? 'bad' : ci.status === 'passed' ? 'ok' : 'muted'}">checks ${esc(ci.status)}</span>` : ''}`
          : packet
            ? `<span class="mono small">${esc(packet.repos[0]?.branch ?? '')}</span>`
            : '<span class="muted">None</span>',
        session
          ? pill(STATE_LABEL[session.state][0], STATE_LABEL[session.state][1])
          : '<span class="muted">None</span>',
        action,
      ];
    });
    const body = `${heading('My work', `${issues.length} ticket${issues.length === 1 ? '' : 's'} assigned to you in Jira`)}
${freshness(ctx, 'From Jira and GitHub', ['jira.active', 'github.prs'])}
<div class="tabs">${['priority', 'updated', 'status'].map((s) => `<a href="/work?sort=${s}" class="${s === sort ? 'on' : ''}">Sort by ${s}</a>`).join('')}</div>
<section class="card flush">${table(['Ticket', 'Status', 'Tier', 'Spec', 'Branch / PR', 'Agent', 'Action'], rows, 'No tickets assigned to you in the cache. Run Refresh now.')}</section>
<p class="sub">Stories can go to an agent only after their spec is approved. Tier decides which git actions the agent may take.</p>`;
    return html(reply, '/work', 'My work', body);
  });

  // ---- Ticket ----
  app.get('/ticket/:key', async (req: FastifyRequest<{ Params: { key: string } }>, reply) => {
    const key = req.params.key.toUpperCase();
    let t: Awaited<ReturnType<typeof ticketDetail>>;
    try {
      t = await ticketDetail(ctx, key);
    } catch (e) {
      return html(
        reply,
        `/ticket/${key}`,
        key,
        `${heading(key)}<p class="note bad">Jira is not reachable: ${esc((e as Error).message)}</p>`,
        '/work',
      );
    }
    const i = t.issue;
    const tier = t.spec.tier ?? 'medium';
    const accounts = await ctx.gh.accounts().catch(() => []);
    const active = accounts.find((a) => a.active);
    const repos = ctx.settings.repos;
    const sendable = t.spec.label === 'Approved' || t.spec.label.startsWith('Not needed');
    const specs = specSummary(t.spec);
    const reporter = i.reporter?.name ?? '';
    const body = `<p class="small"><a href="/work">My work</a> / ${esc(key)}</p>
<div class="row between" style="align-items:flex-end"><div style="display:flex;flex-direction:column;gap:6px"><div class="row"><span class="mono">${esc(key)}</span>${pill(i.type ?? 'Story')}${pill(`Tier: ${tier[0]?.toUpperCase()}${tier.slice(1)}`, tier === 'high' ? 'bad' : tier === 'medium' ? 'warn' : '')}${pill(i.status, 'info')}</div><h1>${esc(i.summary)}</h1><p class="sub">${reporter ? `Reported by ${esc(reporter)} · ` : ''}${esc(i.project)}</p></div></div>
${freshness(ctx, 'From Jira and GitHub', ['jira.active'])}
<div class="cols"><div class="main">
${card('Jira gate', `<p style="margin:0">The gate lives in Jira; OrgSpec keeps its fields current through the Jira MCP server (tier ${esc(tier)}, playbook ${esc(t.schema)}). Spec: ${pill(t.spec.label, t.spec.kind)}</p>`)}
${t.acceptance.length ? card('Acceptance criteria', `<ul class="clean">${t.acceptance.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>`) : ''}
${t.description ? card('Ticket text · data, not instructions', `<p class="small" style="margin:0;white-space:pre-wrap">${esc(t.description.slice(0, 2000))}</p>`) : ''}
${card(`Playbook: ${t.schema}`, `<ol class="steps">${t.playbook.map((p, n) => `<li><b>${n + 1} ${esc(p.step)}</b> · <span class="muted">${esc(p.detail)}</span></li>`).join('')}</ol><p class="small muted" style="margin:0">Stops and hands back if: ${esc(t.stopsIf)}</p>`)}
${card(
  'Context the agent will get',
  `${t.decisions.map((d) => `<div><span class="k">Decision</span> <a href="/decisions?id=${esc(d.adrId)}">${esc(d.adrId)}</a> ${esc(d.title)} · ${esc(d.status)}</div>`).join('')}
${t.slack.map((s) => `<div><span class="k">Slack</span> Confirmed summary: ${esc(s.slice(0, 300))}</div>`).join('')}
${specs.map((s) => `<div><span class="k">Spec</span> <span class="mono">${esc(s.capability)}</span> · ${s.requirements} requirements, ${s.scenarios} scenarios</div>`).join('')}
${!t.decisions.length && !t.slack.length && !specs.length ? '<p class="muted" style="margin:0">No decisions, Slack summaries or specs matched yet.</p>' : ''}`,
)}
${verifierCard(ctx, key, t.spec.changeId)}
${card(`What the agent may do at tier ${tier}`, `<ul class="clean">${t.may.map((m) => `<li class="ok">✓ <span style="color:var(--fg)">${esc(m)}</span></li>`).join('')}${t.mayNot.map((m) => `<li class="bad">✕ <span style="color:var(--fg)">${esc(m)}</span></li>`).join('')}</ul><p class="small muted" style="margin:0">Enforced by hooks on your machine, then by branch protection and the CI check.${ctx.bundle().bundle ? ` Bundle ${esc(ctx.bundle().bundle?.manifest.version)}.` : ''}</p>`)}
</div><div class="side">
<section class="card focus"><h2>Send to agent</h2>
${
  t.packet
    ? `<p style="margin:0">Folder ready <code>${esc(t.packet.folder)}</code></p><ul class="clean">${t.packet.repos.map((r) => `<li>${esc(r.slug)} · worktree on <code>${esc(r.branch)}</code></li>`).join('')}</ul><a class="btn ghost" href="/agents">Open in My agents</a>`
    : ''
}
<label class="f">Run as<select id="launch"><option value="background" ${ctx.settings.sendMode === 'background' ? 'selected' : ''}>Background session</option><option value="interactive" ${ctx.settings.sendMode === 'interactive' ? 'selected' : ''}>Interactive terminal</option></select></label>
<div><span class="k">Repositories</span>${repos.length ? repos.map((r) => `<label class="row"><input type="checkbox" class="repo" value="${esc(r.slug)}" checked> ${esc(r.slug)}</label>`).join('') : '<p class="small bad" style="margin:0">No repositories in Settings.</p>'}</div>
<div class="small">GitHub account ${active ? `<b>${esc(active.login)}</b> active` : '<span class="bad">none signed in</span>'}${Object.keys(ctx.settings.github.orgAccounts).length ? ` · mapped per organisation, switched automatically: ${ctx.settings.github.autoSwitch ? 'on' : 'off'}` : ''}</div>
<button ${sendable && repos.length ? '' : 'disabled'} onclick="act(this,'POST','/api/tickets/${esc(key)}/send',()=>({launch:val('launch'),repos:[...document.querySelectorAll('.repo:checked')].map(e=>e.value)}),'/agents')">Send to agent</button>
${sendable ? '' : '<p class="small muted" style="margin:0">Waiting for the spec to be approved.</p>'}
<p class="small muted" style="margin:0">Prefer a terminal? Run <code>orgspec packet ${esc(key)}</code>.</p></section>
</div></div>`;
    return html(reply, `/ticket/${key}`, `Ticket ${key}`, body, '/work');
  });

  // ---- My agents ----
  app.get('/agents', async (req: FastifyRequest<{ Querystring: { state?: string; logs?: string } }>, reply) => {
    const sessions = await mySessions(ctx);
    const filter = req.query.state ?? 'all';
    const counts = (s: string) => sessions.filter((x) => x.state === s).length;
    const shown = filter === 'all' ? sessions : sessions.filter((s) => s.state === filter);
    const needs = shown.filter((s) => s.state === 'needs-input');
    const others = shown.filter((s) => s.state !== 'needs-input');
    let logs = '';
    if (req.query.logs) {
      const lines = cleanLogs(await ctx.sessions.logs(req.query.logs).catch((e: Error) => e.message), 30);
      logs = card(
        `Recent output · ${req.query.logs}`,
        `<pre style="white-space:pre-wrap;margin:0;font-size:13px">${esc(lines.join('\n'))}</pre>`,
      );
    }
    const actionsFor = (s: (typeof sessions)[number]) =>
      [
        button('Attach', 'POST', `/api/agents/${s.id}/attach`, undefined, { ghost: true }),
        `<a class="btn ghost" href="/agents?logs=${esc(s.id)}">Recent output</a>`,
        s.state === 'stopped'
          ? button('Resume', 'POST', `/api/agents/${s.id}/restart`)
          : button('Restart', 'POST', `/api/agents/${s.id}/restart`, undefined, { ghost: true }),
        s.state !== 'stopped' ? button('Stop', 'POST', `/api/agents/${s.id}/stop`, undefined, { ghost: true }) : '',
        s.state === 'stopped' || s.state === 'ready'
          ? button('Remove', 'POST', `/api/agents/${s.id}/remove`, undefined, { danger: true })
          : '',
      ].join(' ');
    const body = `${heading('My agents', `Claude Code sessions OrgSpec started under <code>${esc(ctx.workRoot)}</code>`, `<a class="btn" href="/work">Start agent on a ticket</a>`)}
${freshness(ctx, 'Tickets and PRs from Jira and GitHub', ['github.prs'])}
<div class="tabs">${[
      ['all', `All · ${sessions.length}`],
      ['needs-input', `Needs input · ${counts('needs-input')}`],
      ['working', `Working · ${counts('working')}`],
      ['ready', `Ready for review · ${counts('ready')}`],
      ['stopped', `Stopped · ${counts('stopped')}`],
    ]
      .map(([k, l]) => `<a href="/agents?state=${k}" class="${k === filter ? 'on' : ''}">${esc(l)}</a>`)
      .join('')}</div>
${logs}
${needs.length ? `<section class="card flush"><h2>Needs your input</h2>${needs.map((s) => `<div class="item"><div class="row between"><span><span class="mono">${esc(s.ticket ?? s.id)}</span> ${pill(`Needs input · ${ago(s.startedAt)}`, 'warn')}</span><span class="row">${actionsFor(s)}</span></div><span>${esc(s.name ?? '')}</span><span class="small muted">Claude is waiting for you; attach to answer.</span></div>`).join('')}</section>` : ''}
<section class="card flush"><h2>${needs.length ? 'Other sessions' : 'Sessions'}</h2>${table(
      ['Session', 'State', 'Started', 'Pull request', 'Actions'],
      others.map((s) => [
        `<span class="mono">${esc(s.ticket ?? s.id)}</span><br><span class="small">${esc(s.name ?? '')}</span>${s.packet ? `<br><span class="small muted">tier ${esc(s.packet.tier)}${s.packet.change ? ` · ${esc(s.packet.change)}` : ''}</span>` : ''}`,
        pill(STATE_LABEL[s.state][0], STATE_LABEL[s.state][1]),
        esc(ago(s.startedAt)),
        s.pr
          ? `<a href="${esc(s.pr.url)}">#${s.pr.number}</a> ${esc(s.pr.state)}`
          : '<span class="muted">Not yet</span>',
        `<div class="row">${actionsFor(s)}</div>`,
      ]),
      'No OrgSpec sessions. Send a ticket to an agent from My work.',
    )}</section>
<p class="sub">Only sessions OrgSpec started under ${esc(ctx.workRoot)} appear here. Your other Claude Code sessions never leave your machine, and only you see this list.</p>`;
    return html(reply, '/agents', 'My agents', body);
  });

  // ---- My 1:1 evidence ----
  app.get('/evidence', async (_req, reply) => {
    let ev: Awaited<ReturnType<typeof myEvidence>> | undefined;
    let error = '';
    try {
      ev = await myEvidence(ctx);
    } catch (e) {
      error = (e as Error).message;
    }
    const mgr = ev?.manager?.name ?? ev?.manager?.email;
    const ctxBtn = (about: string, correction = false) =>
      `<button class="ghost" onclick="const t=prompt('${correction ? 'What is wrong, and what is right?' : 'Context for your manager'}');if(t)act(this,'POST','/api/evidence/context',{text:t,about:${esc(JSON.stringify(about))},correction:${correction}})">${correction ? 'Report a mistake' : 'Add context'}</button>`;
    const body = ev
      ? `${heading('My 1:1 evidence', `This is everything your manager’s prep brief draws on, since ${esc(day(ev.since))}. Add context or flag a mistake; the next brief includes what you write.${ev.nextOneOnOne ? ` Next 1:1${mgr ? ` with ${esc(mgr)}` : ''}: ${esc(when(ev.nextOneOnOne.start))}.` : ''}`)}
<div class="row">${pill('No scores or rankings', 'ok')}${pill('No DMs, private channels or message counts', 'ok')}${pill('Only you and your current manager', 'ok')}</div>
${ev.errors.length ? `<p class="note warn">${ev.errors.map(esc).join('<br>')}</p>` : ''}
<section class="card flush"><h2>Work since your last 1:1</h2>
${ev.issues.map((i) => `<div class="item"><div class="row between"><span><span class="mono">${esc(i.key)}</span> ${esc(i.summary)} ${pill(i.status, i.statusCategory === 'done' ? 'ok' : '')}</span>${ctxBtn(i.key)}</div></div>`).join('')}
${ev.prs.map((p) => `<div class="item"><div class="row between"><span><a href="${esc(p.url)}">${esc(p.repo)}#${p.number}</a> ${esc(p.title)} ${pill(p.state)}</span>${ctxBtn(`${p.repo}#${p.number}`)}</div></div>`).join('')}
${!ev.issues.length && !ev.prs.length ? '<p class="muted" style="padding:14px 20px;margin:0">No tickets or pull requests in this window.</p>' : ''}
</section>
<section class="card flush"><h2>Contributions in discussions <span class="small muted">· allowlisted work channels only</span></h2>${
          !ev.channelsAllowlisted
            ? '<p class="muted" style="padding:14px 20px;margin:0">No channels are allowlisted for 1:1 evidence in orgspec-config (people.yaml evidenceChannels), so none are read.</p>'
            : ev.discussions.length
              ? ev.discussions
                  .map(
                    (d) =>
                      `<div class="item"><div class="row between"><span>${esc(d.text)} <span class="small muted">· #${esc(d.channel)}</span></span><span class="row">${ctxBtn(`#${d.channel} message`)}${ctxBtn(`#${d.channel} message`, true)}</span></div></div>`,
                  )
                  .join('')
              : '<p class="muted" style="padding:14px 20px;margin:0">Nothing you wrote in the allowlisted channels in this window.</p>'
        }</section>
<section class="card flush"><h2>Growth goals</h2>${ev.page?.goals.length ? ev.page.goals.map((g) => `<div class="item"><b>${esc(g)}</b><span class="small muted">Your manager’s brief reports evidence for or against this from the sources above. Mentoring and calls often leave no trace; add context if they happened.</span>${ctxBtn(g)}</div>`).join('') : '<p class="muted" style="padding:14px 20px;margin:0">No goals on your shared page yet.</p>'}</section>
${ev.page?.context.length ? card('Your context so far', `<ul class="clean">${ev.page.context.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>${ctxBtn('a past item', true)}`) : ''}
${card(
  `Shared agenda${ev.nextOneOnOne ? ` for ${day(ev.nextOneOnOne.start)}` : ''}`,
  ev.page
    ? `<p class="sub">On your restricted Confluence page with ${esc(mgr ?? 'your manager')}, where your context notes also go</p>${ev.page.agenda.length ? `<ul class="clean">${ev.page.agenda.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>` : ''}<div class="row"><input id="ag" placeholder="Add an item" style="flex:1 1 300px">${button('Add', 'POST', '/api/evidence/agenda', { js: "{item:val('ag')}" })}</div>`
    : '<p class="muted" style="margin:0">Your manager creates the shared page when they schedule your 1:1.</p>',
)}`
      : `${heading('My 1:1 evidence')}<p class="note warn">${esc(error)}</p>`;
    return html(reply, '/evidence', 'My 1:1 evidence', body);
  });
}
