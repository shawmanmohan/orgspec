import { join, relative } from 'node:path';
import { listChangeIds, loadChange } from '@orgspec/spec-engine';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { addApproval, artifactHashes, loadRoles, readApprovals } from '../approvals.js';
import {
  type Breakdown,
  createBreakdown,
  draftBreakdown,
  getBreakdown,
  planBreakdown,
  saveBreakdown,
} from '../breakdown.js';
import type { AppContext } from '../context.js';
import { listDecisions } from '../decisions.js';
import {
  decideFinding,
  decidePrd,
  postFindings,
  prdDecision,
  prdFindings,
  prdQueue,
  prdReview,
  processHealth,
  reviewPrdFull,
} from '../prd.js';
import { prdSla } from '../reminder-rules.js';
import { listReminders } from '../reminders.js';
import { localWorkspaces } from '../work.js';
import { ago, button, card, day, esc, freshness, heading, layout, pill, table } from './ui.js';

interface ApprovalItem {
  repo: string;
  repoRoot: string;
  changeId: string;
  artifact: string;
  role: string;
  hash: string;
  stale?: { at: string; previous: string };
}

/** Artifacts waiting for your approval in your local repos, and approvals of yours that went stale. */
function approvalQueue(ctx: AppContext): ApprovalItem[] {
  const me = ctx.settings.identity.githubLogin?.toLowerCase();
  if (!me) return [];
  const roles = loadRoles(ctx.configDir);
  const myRoles = Object.entries(roles.roles)
    .filter(([, members]) => members.some((m) => m.toLowerCase() === me))
    .map(([r]) => r);
  const rules = ctx.bundle().bundle?.rules ?? [];
  const out: ApprovalItem[] = [];
  for (const { slug, ws } of localWorkspaces(ctx)) {
    for (const id of listChangeIds(ws)) {
      const change = loadChange(ws, id);
      const tier = change.meta?.tier;
      const hashes = artifactHashes(change);
      const entries = readApprovals(change.dir).entries;
      for (const r of rules) {
        if (r.check?.kind !== 'approval' || (tier && !r.appliesTo.tiers.includes(tier))) continue;
        const check = r.check;
        const role = check.role ?? '';
        if (role && !myRoles.includes(role)) continue;
        const hash = hashes[check.artifact];
        if (!hash) continue;
        const mine = entries.find((e) => e.artifact === check.artifact && e.approver.toLowerCase() === me);
        if (mine?.sha256 === hash) continue;
        out.push({
          repo: slug,
          repoRoot: ws.repoRoot,
          changeId: id,
          artifact: check.artifact,
          role,
          hash,
          ...(mine ? { stale: { at: mine.at, previous: mine.sha256 } } : {}),
        });
      }
    }
  }
  return out;
}

export function registerEmRoutes(app: FastifyInstance, ctx: AppContext) {
  const html = (reply: FastifyReply, path: string, title: string, body: string, active = '/reviews') =>
    reply.type('text/html').send(layout(ctx, path, title, body, { active }));

  // ---- APIs ----
  app.post('/api/prd/:id/review', async (req: FastifyRequest<{ Params: { id: string } }>) =>
    reviewPrdFull(ctx, req.params.id),
  );
  app.post(
    '/api/prd/finding/:fid',
    async (
      req: FastifyRequest<{
        Params: { fid: string };
        Body: { decision: 'accepted' | 'rejected' | 'edited'; text?: string };
      }>,
    ) => {
      decideFinding(ctx, req.params.fid, req.body.decision, req.body.text);
      return { ok: true };
    },
  );
  app.post('/api/prd/:id/post', async (req: FastifyRequest<{ Params: { id: string } }>) => ({
    posted: await postFindings(ctx, req.params.id),
  }));
  app.post(
    '/api/prd/:id/decide',
    async (
      req: FastifyRequest<{ Params: { id: string }; Body: { decision: 'approved' | 'returned'; notes?: string } }>,
    ) => decidePrd(ctx, req.params.id, req.body.decision, req.body.notes),
  );
  app.post('/api/prd/:id/breakdown', async (req: FastifyRequest<{ Params: { id: string } }>) =>
    draftBreakdown(ctx, req.params.id),
  );
  app.put(
    '/api/prd/:id/breakdown',
    async (req: FastifyRequest<{ Params: { id: string }; Body: { epics: Breakdown['epics'] } }>) => {
      const b = getBreakdown(ctx, req.params.id);
      if (!b) throw Object.assign(new Error('No draft'), { statusCode: 404 });
      saveBreakdown(ctx, { ...b, epics: req.body.epics });
      return { ok: true };
    },
  );
  app.post(
    '/api/prd/:id/breakdown/create',
    async (req: FastifyRequest<{ Params: { id: string }; Body: { project: string } }>) => ({
      created: await createBreakdown(ctx, req.params.id, req.body.project),
    }),
  );
  app.post(
    '/api/approvals/approve',
    async (req: FastifyRequest<{ Body: { repo: string; changeId: string; artifact: string; role?: string } }>) => {
      const b = req.body;
      const target = localWorkspaces(ctx).find((w) => w.slug === b.repo);
      if (!target) throw Object.assign(new Error('Unknown repository'), { statusCode: 404 });
      const login = (await ctx.gh.activeAccount())?.login ?? ctx.settings.identity.githubLogin;
      if (!login) throw new Error('gh is not signed in');
      const change = loadChange(target.ws, b.changeId);
      const author = (
        await ctx.git
          .logForFile(target.ws.repoRoot, relative(target.ws.repoRoot, join(change.dir, b.artifact)))
          .catch(() => [])
      ).at(-1);
      if (
        author &&
        (author.name.toLowerCase() === login.toLowerCase() ||
          author.email.toLowerCase().startsWith(`${login.toLowerCase()}@`))
      )
        throw Object.assign(new Error("You can't approve your own artifacts"), { statusCode: 403 });
      const e = addApproval(change, { artifact: b.artifact, approver: login, ...(b.role ? { role: b.role } : {}) });
      // The approval only counts once it is committed by the approver, so commit it as you now.
      await ctx.git.call(target.ws.repoRoot, ['add', relative(target.ws.repoRoot, join(change.dir, 'approvals.yaml'))]);
      await ctx.git.call(target.ws.repoRoot, [
        'commit',
        '-m',
        `Approve ${b.changeId} ${b.artifact} (${e.sha256.slice(0, 15)})`,
      ]);
      return { approval: e, note: 'Committed as you; push the branch to share it.' };
    },
  );
  app.get(
    '/api/approvals/diff',
    async (
      req: FastifyRequest<{ Querystring: { repo: string; changeId: string; artifact: string; since: string } }>,
    ) => {
      const target = localWorkspaces(ctx).find((w) => w.slug === req.query.repo);
      if (!target) throw Object.assign(new Error('Unknown repository'), { statusCode: 404 });
      const change = loadChange(target.ws, req.query.changeId);
      const file = relative(target.ws.repoRoot, join(change.dir, req.query.artifact));
      const diff = await ctx.git
        .call(target.ws.repoRoot, [
          'log',
          '-p',
          `--since=${req.query.since}`,
          '--format=--- %h %an %ad %s',
          '--date=short',
          '--',
          file,
        ])
        .catch(() => '');
      return { diff: diff || 'No commits since your approval; the content differs only in uncommitted edits.' };
    },
  );

  // ---- Review queue ----
  app.get('/reviews', async (req: FastifyRequest<{ Querystring: { tab?: string; diff?: string } }>, reply) => {
    const tab = req.query.tab ?? 'prds';
    const sla = prdSla(ctx);
    const prds = prdQueue(ctx).filter((p) => !p.decision || p.decision.version !== p.version);
    const approvals = approvalQueue(ctx);
    const pending = approvals.filter((a) => !a.stale);
    const stale = approvals.filter((a) => a.stale);
    const soon = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
    const decisionsDue = localWorkspaces(ctx)
      .flatMap((w) => listDecisions(w.ws, w.slug))
      .filter((d) => d.review && d.review <= soon && d.status === 'accepted');
    const health = processHealth(ctx);
    const prdHtml = prds
      .map(
        (p) =>
          `<div class="item"><div class="row between"><a href="/reviews/prd/${esc(p.pageId)}" style="font-weight:600">${esc(p.title)}</a>${p.running ? pill('Reviewer running', 'info') : pill(`Waiting ${p.waitingDays} day${p.waitingDays === 1 ? '' : 's'} · SLA ${sla}`, p.waitingDays >= sla ? 'bad' : p.waitingDays >= sla - 1 ? 'warn' : '')}</div>
<span class="small muted">${esc([p.epic ? `Epic ${p.epic}` : '', p.author ? `by ${p.author}` : '', `Confluence v${p.version}`].filter(Boolean).join(' · '))}</span>
<span class="row">${p.review ? `${p.blockers ? pill(`${p.blockers} blocker${p.blockers === 1 ? '' : 's'}`, 'bad') : ''}${pill(`${p.gaps} gap${p.gaps === 1 ? '' : 's'}`, p.gaps ? 'warn' : 'ok')}${pill(p.notConsulted ? `${p.dependencies} dependencies, ${p.notConsulted} not consulted` : 'All dependencies consulted', p.notConsulted ? 'warn' : 'ok')}` : pill('Not reviewed yet')}<a class="btn ghost" href="/reviews/prd/${esc(p.pageId)}">Open review</a></span></div>`,
      )
      .join('');
    const approvalHtml = (list: ApprovalItem[]) =>
      list
        .map((a) => {
          const q = new URLSearchParams({
            repo: a.repo,
            changeId: a.changeId,
            artifact: a.artifact,
            since: a.stale?.at ?? '',
          }).toString();
          return `<div class="item"><div class="row between"><span><span class="mono">${esc(a.changeId)}</span> · ${esc(a.artifact)}${a.role ? ` · as ${esc(a.role)}` : ''}</span>${a.stale ? pill(`Changed since you approved it on ${day(a.stale.at)}`, 'warn') : pill('New', 'info')}</div><span class="small muted mono">now ${esc(a.hash.slice(7, 11))}…${esc(a.hash.slice(-2))} · ${esc(a.repo)}</span><div class="row">${a.stale ? `<a class="btn ghost" href="/reviews?tab=${esc(tab)}&diff=${encodeURIComponent(q)}">View diff</a>` : ''}${button('Approve this version', 'POST', '/api/approvals/approve', { repo: a.repo, changeId: a.changeId, artifact: a.artifact, role: a.role || undefined })}</div></div>`;
        })
        .join('');
    let diffHtml = '';
    if (req.query.diff) {
      const p = new URLSearchParams(req.query.diff);
      const r = await app.inject({
        method: 'GET',
        url: `/api/approvals/diff?${p.toString()}`,
        headers: req.headers as Record<string, string>,
      });
      diffHtml = card(
        'Changes since your approval',
        `<pre style="white-space:pre-wrap;margin:0;font-size:12px;max-height:420px;overflow:auto">${esc((JSON.parse(r.body) as { diff?: string; message?: string }).diff ?? r.body)}</pre>`,
      );
    }
    const main =
      tab === 'prds'
        ? `<section class="card flush">${prdHtml || '<p class="muted" style="padding:14px 20px;margin:0">No PRDs waiting. PRDs labelled for review in Confluence appear here.</p>'}</section>`
        : tab === 'approvals'
          ? `${diffHtml}<section class="card flush"><h2>Waiting for your approval</h2>${approvalHtml(pending) || '<p class="muted" style="padding:14px 20px;margin:0">Nothing waiting.</p>'}</section><section class="card flush"><h2>Stale approvals</h2>${approvalHtml(stale) || '<p class="muted" style="padding:14px 20px;margin:0">None.</p>'}</section><p class="sub">An approval covers this exact content. Any later edit makes it stale. You can't approve your own artifacts.</p>`
          : `<section class="card flush">${table(
              ['Decision', 'Owner', 'Review'],
              decisionsDue.map((d) => [
                `<a href="/decisions?id=${esc(d.adrId)}">${esc(d.adrId)}</a> ${esc(d.title)}`,
                esc(d.owner ?? ''),
                esc(day(d.review)),
              ]),
              'No decision reviews due in the next two weeks.',
            )}</section>`;
    const coming = listReminders(ctx)
      .filter((r) => ['decision-review', 'waiver-expiring', 'stale-approval', 'prd-review-wait'].includes(r.kind))
      .slice(0, 6);
    const body = `${heading('Review queue')}
${freshness(ctx, 'From Confluence and Jira', ['confluence.reviews'])}
<div class="tabs">${[
      ['prds', `PRDs · ${prds.length}`],
      ['approvals', `Designs · ${pending.length}`],
      ['decisions', `Decisions due · ${decisionsDue.length}`],
      ['approvals', `Stale approvals · ${stale.length}`],
    ]
      .map(
        ([k, l], i) =>
          `<a href="/reviews?tab=${k}" class="${k === tab && (i !== 3 || tab !== 'approvals') ? 'on' : ''}">${esc(l)}</a>`,
      )
      .join('')}</div>
<div class="cols"><div class="main">${main}</div><div class="side">
${card(
  `Process health${ctx.settings.repos[0] ? '' : ''}`,
  health.length
    ? `<span class="k">Rubric items with low acceptance</span>${table(
        ['Rule', 'Accepted'],
        health
          .slice(0, 6)
          .map((h) => [
            `<span class="mono">${esc(h.rubricId)}</span>`,
            `<span class="${h.rate < 0.7 ? 'bad' : ''}">${Math.round(h.rate * 100)}% of ${h.total}</span>`,
          ]),
      )}<p class="small muted" style="margin:0">Below 70% is flagged to the process owner for tuning.</p>`
    : '<p class="muted" style="margin:0">No decided findings yet.</p>',
)}
${card('Coming up', coming.length ? `<ul class="clean">${coming.map((r) => `<li>${r.url ? `<a href="${esc(r.url)}">${esc(r.title)}</a>` : esc(r.title)}</li>`).join('')}</ul>` : '<p class="muted" style="margin:0">Nothing due soon.</p>')}
</div></div>`;
    return html(reply, '/reviews', 'Review queue', body);
  });

  // ---- PRD review ----
  app.get('/reviews/prd/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const id = req.params.id;
    const r = prdReview(ctx, id);
    const d = prdDecision(ctx, id);
    const findings = prdFindings(ctx, id);
    const cached = ctx.db().prepare('select title, version from cache_confluence_pages where page_id = ?').get(id) as
      | { title?: string; version?: number }
      | undefined;
    const current = await ctx
      .workplace()
      .confluence.get(id)
      .then((p) => p.version)
      .catch(() => cached?.version);
    const title = r?.title ?? cached?.title ?? id;
    const blockers = r?.feasibility.filter((f) => f.kind === 'blocker') ?? [];
    const counts = {
      accepted: findings.filter((f) => f.status === 'accepted').length,
      rejected: findings.filter((f) => f.status === 'dismissed').length,
      open: findings.filter((f) => f.status === 'open').length,
    };
    const newer = r && current && current !== r.version;
    const findingHtml = findings
      .map((f) => {
        const major = f.severity === 'blocking';
        const conf = f.confidence >= 0.8 ? 'high' : f.confidence >= 0.5 ? 'medium' : 'low';
        const state =
          f.status === 'accepted'
            ? f.edited
              ? `<p class="note info small" style="margin:0"><b>Your edit (posted as your comment):</b> ${esc(f.edited)}</p>`
              : pill('Accepted', 'ok')
            : f.status === 'dismissed'
              ? `<p class="small muted" style="margin:0">Rejected by you${f.edited ? `: ${esc(f.edited)}` : '.'}</p>`
              : '';
        return `<div class="item"><div class="row between"><span class="row">${pill(major ? 'Major' : 'Minor', major ? 'bad' : 'warn')}<span class="mono">${esc(f.rubricId)}</span><span class="small muted">confidence ${conf}</span></span></div>
<b>${esc(f.finding)}</b>${f.quote ? `<blockquote>“${esc(f.quote)}”</blockquote>` : f.absent ? '<span class="small muted">Not in the PRD.</span>' : ''}
${f.suggestion ? `<span class="small"><b>Question for the author:</b> ${esc(f.suggestion)}</span>` : ''}${state}
${f.status === 'open' ? `<div class="row">${button('Accept', 'POST', `/api/prd/finding/${f.id}`, { decision: 'accepted' })}<button class="ghost" onclick="const t=prompt('Your wording (posted as your comment)', ${esc(JSON.stringify(f.suggestion || f.finding))});if(t)act(this,'POST','/api/prd/finding/${f.id}',{decision:'edited',text:t})">Edit</button><button class="ghost" onclick="const t=prompt('Why reject it? (helps tune the rubric)');if(t!==null)act(this,'POST','/api/prd/finding/${f.id}',{decision:'rejected',text:t})">Reject</button></div>` : ''}</div>`;
      })
      .join('');
    const body = `<p class="small"><a href="/reviews">Review queue</a> / ${esc(r?.epic ?? id)}</p>
${heading(title, r ? `PRD${r.author ? ` by ${esc(r.author)}` : ''} · Confluence v${r.version} · reviewed against PRD rubric ${esc(r.rubricVersion ?? '')} · ${esc(ago(r.reviewedAt))}` : 'Not reviewed yet', button(r ? 'Review again' : 'Run the reviewer', 'POST', `/api/prd/${id}/review`, undefined, { ghost: Boolean(r) }))}
${newer ? `<p class="note warn">Confluence has v${current}; this review is of v${r?.version}. Review again before deciding.</p>` : r ? `<p class="sub">Confluence checked · no newer version</p>` : ''}
${
  r
    ? `<div class="tabs"><a class="on">Completeness · ${Math.round(r.completeness)}/100</a><a href="#deps">Dependencies · ${r.dependencies.length}</a><a href="#feas">Feasibility · ${blockers.length} blocker${blockers.length === 1 ? '' : 's'}</a><a href="/reviews/prd/${esc(id)}/breakdown">Task breakdown</a></div>
<div class="cols"><div class="main">
<section class="card flush"><h2>Findings</h2>${findingHtml || '<p class="muted" style="padding:14px 20px;margin:0">No concerns.</p>'}${r.dropped ? `<p class="small muted" style="padding:10px 20px;margin:0">${r.dropped} item(s) without a quote from the PRD were left out.</p>` : ''}</section>
<section class="card flush" id="deps"><h2>Dependencies</h2>${table(
        ['Touches', 'Owner', 'Consulted'],
        r.dependencies.map((x) => [
          esc(x.touches),
          esc(x.owner),
          x.consulted
            ? `<span class="ok">Yes</span>${x.note ? ` · ${esc(x.note)}` : ''}`
            : `<span class="bad">Not consulted</span>${x.note ? ` · ${esc(x.note)}` : ''}`,
        ]),
        'No dependencies found.',
      )}</section>
<section class="card" id="feas"><h2>Feasibility</h2>${r.feasibility.map((f) => `<div class="row" style="align-items:flex-start">${pill(f.kind.toUpperCase(), f.kind === 'blocker' ? 'bad' : f.kind === 'spike' ? 'warn' : '')}<span>${esc(f.text)}${f.adr ? ` <a href="/decisions?id=${esc(f.adr)}">${esc(f.adr)}</a>` : ''}</span></div>`).join('') || '<p class="muted" style="margin:0">No feasibility concerns.</p>'}</section>
</div><div class="side"><section class="card focus"><h2>Your decision</h2>
<div class="row">${pill(`${counts.accepted} accepted`, 'ok')}${pill(`${counts.rejected} rejected`)}${pill(`${counts.open} to decide`, counts.open ? 'warn' : '')}</div>
${d ? `<p class="note ${d.decision === 'approved' ? 'info' : 'warn'}">${d.decision === 'approved' ? 'Approved' : 'Returned'} v${d.version} by ${esc(d.by)} · ${esc(day(d.at))}${d.version !== current ? ' · a newer version needs a fresh look' : ''}</p>` : ''}
<label class="f">Notes to the author<textarea id="notes" rows="3"></textarea></label>
${button(`Post ${counts.accepted} finding${counts.accepted === 1 ? '' : 's'} to Confluence`, 'POST', `/api/prd/${id}/post`, undefined, { ghost: true, disabled: !counts.accepted })}
${button('Return to author', 'POST', `/api/prd/${id}/decide`, { js: "{decision:'returned',notes:val('notes')}" }, { ghost: true })}
${button('Approve', 'POST', `/api/prd/${id}/decide`, { js: "{decision:'approved',notes:val('notes')}" }, { disabled: blockers.length > 0 || Boolean(newer) })}
<p class="small muted" style="margin:0">${blockers.length ? 'Approve is off while blockers are open. ' : ''}Approval applies to v${r.version} only; a new version needs a fresh look. Comments are posted as you.</p></section></div></div>`
    : '<p class="muted">Run the reviewer to see rubric findings, dependencies and feasibility.</p>'
}`;
    return html(reply, `/reviews/prd/${id}`, `PRD review · ${title}`, body);
  });

  // ---- Task breakdown ----
  app.get(
    '/reviews/prd/:id/breakdown',
    async (req: FastifyRequest<{ Params: { id: string }; Querystring: { project?: string } }>, reply) => {
      const id = req.params.id;
      const r = prdReview(ctx, id);
      const d = prdDecision(ctx, id);
      const b = getBreakdown(ctx, id);
      const projects = ctx.settings.jira.projects.length ? ctx.settings.jira.projects : ['PROJ'];
      const project = req.query.project ?? (r?.epic ? r.epic.split('-')[0] : undefined) ?? projects[0] ?? 'PROJ';
      const plan = b ? await planBreakdown(ctx, b, project).catch(() => []) : [];
      const tierPill = (t: string) =>
        pill(t[0]?.toUpperCase() + t.slice(1), t === 'high' ? 'bad' : t === 'medium' ? 'warn' : '');
      const epics =
        b?.epics
          .map(
            (e, ei) =>
              `<section class="card flush"><div class="row between" style="padding:14px 20px;border-bottom:1px solid var(--line)"><h2>${pill(`EPIC ${ei + 1}`, 'info')} <input class="ep" data-e="${ei}" value="${esc(e.title)}" style="min-width:340px"></h2><span class="small muted">${esc(e.team || '')} team</span></div>
${table(
  ['Order', 'Story', 'Size', 'Suggested tier', 'After'],
  e.stories.map((s) => {
    const p = plan.find((x) => x.order === s.order);
    return [
      `<span class="mono">${esc(s.order)}</span>`,
      `<input class="st" data-e="${ei}" data-o="${esc(s.order)}" value="${esc(s.title)}" style="width:100%">${p?.duplicateOf ? `<br>${pill(`Exists: ${p.duplicateOf}`, 'info')}` : ''}${b.created?.[s.order] ? `<br>${pill(`Created ${b.created[s.order]}`, 'ok')}` : ''}`,
      esc(s.size),
      tierPill(s.tier),
      esc(
        [s.after.join(', ') || 'None', s.team && s.team !== e.team ? `${s.team} team` : ''].filter(Boolean).join(' · '),
      ),
    ];
  }),
)}</section>`,
          )
          .join('') ?? '';
      const cross = plan.filter((p) => p.crossTeam);
      const dups = plan.filter((p) => p.duplicateOf);
      const total = (b?.epics.length ?? 0) + plan.filter((p) => !p.duplicateOf).length;
      const body = `<p class="small"><a href="/reviews">Review queue</a> / <a href="/reviews/prd/${esc(id)}">${esc(r?.epic ?? id)}</a> / Task breakdown</p>
${heading(r?.title ?? id, d?.decision === 'approved' ? `${pill(`PRD approved by ${d.by.split('@')[0]} · v${d.version} · ${day(d.at)}`, 'ok')} Draft breakdown from the task planner; edit before anything reaches Jira.` : 'Approve the PRD before breaking it down.', d?.decision === 'approved' ? button(b ? 'Regenerate draft' : 'Draft breakdown', 'POST', `/api/prd/${id}/breakdown`, undefined, { ghost: Boolean(b) }) : '')}
<div class="cols"><div class="main">${epics || '<p class="muted">No draft yet.</p>'}${b ? `<div>${button('Save edits', 'PUT', `/api/prd/${id}/breakdown`, { js: `{epics:${JSON.stringify(b.epics)}.map((e,ei)=>({...e,title:document.querySelector('.ep[data-e="'+ei+'"]').value,stories:e.stories.map(s=>({...s,title:document.querySelector('.st[data-e="'+ei+'"][data-o="'+s.order+'"]').value}))}))}` }, { ghost: true })}</div>` : ''}</div>
<div class="side">${
        b
          ? `<section class="card focus"><h2>Create in Jira</h2><label class="f">Project<select onchange="location.href='/reviews/prd/${esc(id)}/breakdown?project='+this.value">${[...new Set([project, ...projects])].map((p) => `<option ${p === project ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select></label>
<ul class="clean"><li>${b.epics.length} epic${b.epics.length === 1 ? '' : 's'}, ${plan.length} stor${plan.length === 1 ? 'y' : 'ies'}${r?.epic ? `, linked to ${esc(r.epic)}` : ''}</li><li>Dependencies as "is blocked by" links</li><li>Tier set as suggested; owners confirm it</li></ul>
${cross.map((c) => `<p class="note warn" style="margin:0">Story ${esc(c.order)} belongs to the ${esc(c.crossTeam)} team. It is created in ${esc(c.project)} and its lead is asked to accept it.</p>`).join('')}
<p class="note" style="margin:0">${dups.length ? `${dups.length} already exist and will be linked: ${dups.map((x) => esc(x.duplicateOf)).join(', ')}.` : `No duplicates found in ${esc([...new Set(plan.map((p) => p.project))].join(', ') || project)}.`}</p>
${button(`Create ${total} issue${total === 1 ? '' : 's'}`, 'POST', `/api/prd/${id}/breakdown/create`, { project })}
<p class="small muted" style="margin:0">Created as you, after this click. Each issue links to the PRD and this breakdown.</p></section>`
          : ''
      }</div></div>`;
      return html(reply, `/reviews/prd/${id}/breakdown`, 'Task breakdown', body);
    },
  );
}
