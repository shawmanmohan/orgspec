import { DEFAULT_SYNC } from '@orgspec/core';
import { DEFAULT_OPERATIONS } from '@orgspec/integrations';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { adminCheck, adminPublish, adminRollback, bundleVersions } from '../admin.js';
import {
  bundleUsable,
  lastReview,
  lastRun,
  newWaiverPr,
  personaDiagnostics,
  personaHistory,
  personaTemplate,
  personaYaml,
  renewWaiverPr,
  revokeWaiverPr,
  savePersonaPr,
  saveSyncPr,
  sourcesStatus,
  startCompile,
  syncStat,
} from '../admin-ops.js';
import type { AppContext } from '../context.js';
import { Scheduler } from '../scheduler.js';
import { syncJobs } from '../sync.js';
import { ago, button, card, day, esc, heading, layout, pill, table } from './ui.js';

const STEPS: [string, string][] = [
  ['fetch', 'Fetch pinned versions'],
  ['extract', 'Normalise, label as data and extract rules'],
  ['ground', 'Ground quotes'],
  ['merge', 'Merge layers, tighten-only check'],
  ['budget', 'Budget per agent'],
  ['render', 'Render bundles'],
  ['evals', 'Run evals'],
];

const SOURCE_LABELS: Record<string, [string, string]> = {
  'jira.active': ['Jira · active tickets', 'status, gate fields'],
  'jira.programs': ['Jira · program tickets', 'scope, links, history'],
  'confluence.sources': ['Confluence · constitution sources', 'page versions'],
  'confluence.reviews': ['Confluence · PRDs in review', 'versions, comments'],
  'slack.dms': ['Slack · DMs for the task inbox', 'as each person, on their own machine'],
  'github.prs': ['GitHub · branches, PRs', "each person's gh account"],
  'ci.runs': ['CI · runs on your branches', 'and Jira gate fields'],
  'hr.directory': ['HR directory', 'reporting lines'],
  'config.pull': ['orgspec-config', 'personas, bundles, waivers'],
};

export function registerAdminRoutes(app: FastifyInstance, ctx: AppContext) {
  const html = (reply: FastifyReply, path: string, title: string, body: string) =>
    reply.type('text/html').send(layout(ctx, path, title, body, { admin: true }));

  // ---- APIs ----
  app.post('/api/admin/compile', async (req: FastifyRequest<{ Body: { changedOnly?: boolean } }>) =>
    startCompile(ctx, { changedOnly: Boolean(req.body?.changedOnly) }),
  );
  app.get('/api/admin/compile', async () => ({ run: lastRun(ctx) ?? null, review: lastReview(ctx) ?? null }));
  app.post('/api/admin/publish', async () => {
    const r = lastReview(ctx);
    if (!r || r.blocking.length)
      throw Object.assign(new Error('Nothing publishable: fix the blocking checks first'), { statusCode: 409 });
    return {
      url: await adminPublish(
        ctx,
        r.candidates.map((c) => ({ persona: c.persona, version: c.version })),
      ),
    };
  });
  app.post('/api/admin/rollback', async (req: FastifyRequest<{ Body: { persona: string; version: string } }>) => ({
    url: await adminRollback(ctx, req.body.persona, req.body.version),
  }));
  app.post(
    '/api/admin/waivers',
    async (
      req: FastifyRequest<{ Body: { rule: string; scope: string; reason: string; expires: string; approver: string } }>,
    ) => {
      const b = req.body;
      const scope: Record<string, unknown> = {};
      for (const part of b.scope
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)) {
        const [k = '', ...rest] = part.split(':');
        const v = rest.join(':').trim();
        if (k.trim() === 'paths') scope.paths = v.split(/\s+/);
        else if (['team', 'repo', 'change'].includes(k.trim())) scope[k.trim()] = v;
      }
      return {
        url: await newWaiverPr(ctx, {
          rule: b.rule,
          reason: b.reason,
          approver: b.approver,
          expires: b.expires,
          scope,
        }),
      };
    },
  );
  app.post(
    '/api/admin/waivers/:id/renew',
    async (req: FastifyRequest<{ Params: { id: string }; Body: { expires: string } }>) => ({
      url: await renewWaiverPr(ctx, req.params.id, req.body.expires),
    }),
  );
  app.post('/api/admin/waivers/:id/revoke', async (req: FastifyRequest<{ Params: { id: string } }>) => ({
    url: await revokeWaiverPr(ctx, req.params.id),
  }));
  app.post(
    '/api/admin/personas/:id',
    async (req: FastifyRequest<{ Params: { id: string }; Body: { yaml: string; create?: boolean } }>) => ({
      url: await savePersonaPr(ctx, req.params.id, req.body.yaml, { create: Boolean(req.body.create) }),
    }),
  );
  app.post(
    '/api/admin/sync/:source',
    async (
      req: FastifyRequest<{
        Params: { source: string };
        Body: { every: string; offHours: 'slow' | 'pause' | 'same'; personal: boolean };
      }>,
    ) => ({
      url: await saveSyncPr(ctx, req.params.source, req.body),
    }),
  );

  app.get('/admin', async (_req, reply) => reply.redirect('/admin/sources'));

  // ---- Sources & compile ----
  app.get('/admin/sources', async (req: FastifyRequest<{ Querystring: { live?: string } }>, reply) => {
    const rows = await sourcesStatus(ctx, { live: req.query.live === '1' });
    const changed = rows.filter((r) => r.status === 'changed').length;
    const run = lastRun(ctx);
    const unreadable = rows.filter((r) => r.status === 'unreadable');
    const stepState = (s: string) => {
      if (!run) return 'todo';
      const done = run.steps.map((x) => x.step);
      if (run.state === 'done') return 'done';
      if (done.includes(s)) return done[done.length - 1] === s && run.state === 'running' ? 'now' : 'done';
      return 'todo';
    };
    const body = `<div class="cols"><div class="main">
${heading('Sources and compile', 'Confluence pages the constitution is compiled from. Edits there never take effect until a bundle is reviewed and published.', `<a class="btn ghost" href="/admin/sources?live=1">Check versions now</a>${button('Compile all', 'POST', '/api/admin/compile', { changedOnly: false }, { ghost: true })}${button(`Compile ${changed} changed`, 'POST', '/api/admin/compile', { changedOnly: true }, { disabled: !changed })}`)}
<section class="card flush">${table(
      ['Source page', 'Feeds', 'Compiled · current', 'Status', 'Owner'],
      rows.map((r) => [
        `<b>${esc(r.title)}</b><br><span class="small muted">${esc(r.space)} space · ${esc(r.pageId)}</span>`,
        esc(r.feeds.join(', ')),
        `<span class="mono">${r.compiled !== undefined ? `v${r.compiled}` : '—'} · ${r.current !== undefined ? `v${r.current}` : '—'}</span>`,
        r.status === 'up to date'
          ? pill('Up to date', 'ok')
          : r.status === 'changed'
            ? pill(run?.state === 'running' ? 'Changed · compiling' : 'Changed', 'warn')
            : r.status === 'unreadable'
              ? pill("Can't read · access", 'bad')
              : pill('Not compiled'),
        esc(r.owners.join(', ')),
      ]),
      'No sources in the constitution overlays.',
    )}</section>
${unreadable.map((u) => `<p class="sub">Your Confluence account can't read “${esc(u.title)}” (${esc(u.error?.slice(0, 120) ?? '')}). Compiles run with your access; the last good snapshot stays in use until access returns.</p>`).join('')}
</div><div class="side"><section class="card focus admin"><h2>${run ? `Compile ${esc(run.id)}` : 'No compile yet'}</h2>
${run ? `<p class="sub">Started ${esc(ago(run.startedAt))} on this machine${run.changedOnly ? ' · changed pages only' : ''} · ${esc(run.state)}</p>` : ''}
<ol class="steps">${STEPS.map(([k, l]) => {
      const st = stepState(k);
      const detail = run?.steps.filter((x) => x.step === k).at(-1)?.detail;
      return `<li class="${st === 'todo' ? 'muted' : ''}" style="${st === 'now' ? 'font-weight:600' : ''}">${st === 'done' ? '<span class="ok">✓</span>' : st === 'now' ? '◌' : '○'} ${esc(l)}${detail ? `<br><span class="small muted">${esc(detail)}</span>` : ''}</li>`;
    }).join('')}</ol>
${run?.error ? `<p class="note bad">${esc(run.error)}</p>` : ''}
<a class="btn ghost" href="/admin/bundles">Review when ready</a>${run?.state === 'running' ? '<script>setTimeout(()=>location.reload(),3000)</script>' : ''}</section></div></div>`;
    return html(reply, '/admin/sources', 'Admin: sources and compile', body);
  });

  // ---- Bundle review ----
  app.get('/admin/bundles', async (_req, reply) => {
    const r = lastReview(ctx);
    const run = lastRun(ctx);
    const cfg = ctx.config();
    const loosen = r?.blocking.filter((d) => d.code === 'layer_loosens_rule') ?? [];
    const owners = [...new Set((cfg?.overlays ?? []).flatMap((o) => o.metadata.owners))];
    const rollback = (cfg?.personas ?? []).map((p) => {
      const versions = ctx.configDir ? bundleVersions(ctx.configDir, p.metadata.id) : [];
      const live = ctx.bundle(p).bundle?.manifest.version;
      // Only versions at or before the live one: a candidate is published with the button above, not "pointed back" to.
      const older = live ? versions.filter((v) => v.localeCompare(live, undefined, { numeric: true }) <= 0) : versions;
      return `<div><b>${esc(p.metadata.name)}</b>${older
        .slice(0, 4)
        .map(
          (v) =>
            `<div class="row small">${esc(v)} ${v === live ? pill('live', 'ok') : button('Point back', 'POST', '/api/admin/rollback', { persona: p.metadata.id, version: v }, { ghost: true })}</div>`,
        )
        .join('')}</div>`;
    });
    const kindPill = (k: string) =>
      pill(
        k === 'added' ? 'Added' : k === 'changed' ? 'Changed' : 'Removed',
        k === 'added' ? 'ok' : k === 'changed' ? 'warn' : 'bad',
      );
    const enfPill = (e: string) =>
      pill(
        e === 'hook'
          ? 'Enforced by hook'
          : e === 'ci'
            ? 'Enforced in CI'
            : e === 'review'
              ? 'Review rubric'
              : 'Advisory',
        e === 'hook' || e === 'ci' ? 'info' : '',
      );
    const body = r
      ? `${heading(`Review ${esc(r.runId)}`, `Candidates: ${r.candidates.map((c) => `${esc(c.persona)} ${esc(c.version)}`).join(', ') || 'none written'} · ${esc(ago(r.at))}`)}
${loosen.length ? `<div class="note bad"><b>Publish blocked: a layer loosens a base rule</b><br>${loosen.map((d) => esc(d.message)).join('<br>')}<br><span class="small">Raise the overlay to match, or file a time-limited waiver.</span> <a class="btn ghost" href="/admin/waivers">Draft waiver</a></div>` : r.blocking.length ? `<div class="note bad"><b>Publish blocked</b><br>${r.blocking.map((d) => esc(d.message)).join('<br>')}</div>` : ''}
<div class="cols"><div class="main">
${card(
  'Checks',
  `<div class="grid">${[
    [r.blocking.filter((d) => d.code.startsWith('config') || d.code.includes('invalid')).length === 0, 'Schema valid'],
    [
      loosen.length === 0,
      loosen.length
        ? `Tighten-only: ${loosen.length} conflict${loosen.length === 1 ? '' : 's'}`
        : 'Tighten-only: no conflicts',
    ],
    [
      r.blocking.every((d) => d.code !== 'budget_exceeded'),
      `Budget: ${r.candidates.map((c) => `${c.persona} ${c.rules}/${c.maxRules} rules, ${(c.tokens / 1000).toFixed(1)}k tokens`).join('; ') || 'n/a'}`,
    ],
    [
      r.dropped.length === 0,
      r.dropped.length
        ? `${r.dropped.length} quote${r.dropped.length === 1 ? '' : 's'} not found, rules dropped`
        : 'Every rule quotes its source',
    ],
  ]
    .map(
      ([ok, t]) =>
        `<span class="${ok ? '' : 'bad'}">${ok ? '<span class="ok">✓</span>' : '✕'} ${esc(String(t))}</span>`,
    )
    .join(
      '',
    )}</div>${r.warnings.length ? `<details><summary class="small">${r.warnings.length} warning(s)</summary><ul class="clean small">${r.warnings.map((w) => `<li>${esc(w.message)}</li>`).join('')}</ul></details>` : ''}`,
)}
<section class="card flush"><h2>What changes for teams</h2>${
          r.changes
            .map(
              (c) =>
                `<div class="item"><span class="row small">${kindPill(c.kind)}<span class="mono">${esc(c.rule.id)}</span>${enfPill(c.rule.enforcement)}<span class="muted">${esc(c.persona)}${c.fields ? ` · ${esc(c.fields.join(', '))}` : ''}</span></span><span>${esc(c.rule.statement)}</span><blockquote>“${esc(c.rule.source.quote)}” · page ${esc(c.rule.source.pageId)} v${c.rule.source.version}</blockquote></div>`,
            )
            .join('') || '<p class="muted" style="padding:14px 20px;margin:0">No rule changes.</p>'
        }</section>
<section class="card flush"><h2>Evals on the golden set</h2>${table(
          ['Persona', 'Current', 'Candidate', 'Failures'],
          r.evals.map((e) => [
            esc(e.persona),
            `${e.current.passed} passed, ${e.current.failed} failed`,
            `<span class="${e.candidate.failed > e.current.failed ? 'bad' : 'ok'}">${e.candidate.passed} passed, ${e.candidate.failed} failed</span>`,
            esc(e.failures.map((f) => `${f.name}: got ${f.got}`).join('; ') || '—'),
          ]),
          'No golden cases in orgspec-config/evals.',
        )}</section>
${r.dropped.length ? card('Dropped candidates', `<ul class="clean small">${r.dropped.map((d) => `<li><span class="mono">${esc(d.id ?? '?')}</span> (${esc(d.overlay)}, page ${esc(d.pageId)}): ${esc(d.reason)}</li>`).join('')}</ul>`) : ''}
</div><div class="side"><section class="card focus admin"><h2>Publish</h2>
<ul class="clean small"><li>Opens one PR in orgspec-config</li><li>Adds ${r.candidates.map((c) => `compiled/${esc(c.persona)}/${esc(c.version)}`).join(', ') || 'no bundles'}</li><li>Bumps bundle and hash in ${r.candidates.length} persona file${r.candidates.length === 1 ? '' : 's'}</li><li>Running sessions keep their version</li></ul>
<div class="small"><span class="muted">Approver</span><br>${esc(owners.join(', ') || 'process owners')}</div>
${button('Open publish PR', 'POST', '/api/admin/publish', undefined, { disabled: r.blocking.length > 0 || !r.candidates.length })}
${r.blocking.length ? '<p class="small muted" style="margin:0">Blocked until the checks above pass.</p>' : ''}
<div style="border-top:1px solid var(--line);padding-top:10px;display:flex;flex-direction:column;gap:8px"><b>Roll back</b>${rollback.join('')}</div></section></div></div>`
      : `${heading('Bundle review')}<p class="note">${run?.state === 'running' ? 'A compile is running; this page fills in when it finishes.' : 'No compile run yet. Start one from Sources & compile.'}</p>${card(
          'Configuration check',
          `${
            adminCheck(ctx)
              .map(
                (d) =>
                  `<p class="small ${d.severity === 'error' ? 'bad' : 'warn'}" style="margin:0">${esc(d.message)}</p>`,
              )
              .join('') ||
            '<p class="ok" style="margin:0">orgspec-config is valid and every persona’s bundle verifies.</p>'
          }`,
        )}`;
    return html(reply, '/admin/bundles', 'Admin: bundle review', body);
  });

  // ---- Waivers ----
  app.get('/admin/waivers', async (req: FastifyRequest<{ Querystring: { tab?: string } }>, reply) => {
    const waivers = ctx.config()?.waivers ?? [];
    const today = new Date().toISOString().slice(0, 10);
    const in30 = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const tab = req.query.tab ?? 'active';
    const active = waivers.filter((w) => w.expires >= today);
    const expiring = active.filter((w) => w.expires <= in30);
    const expired = waivers.filter((w) => w.expires < today);
    const shown = tab === 'expiring' ? expiring : tab === 'expired' ? expired : active;
    const rules = [
      ...new Set(
        (ctx.config()?.personas ?? [])
          .flatMap((p) => ctx.bundle(p).bundle?.rules ?? [])
          .filter((r) => r.enforcement === 'ci' || r.enforcement === 'hook')
          .map((r) => `${r.id}|${r.severity}`),
      ),
    ];
    const counts = new Map<string, number>();
    for (const w of waivers) counts.set(w.rule, (counts.get(w.rule) ?? 0) + 1);
    const days = (d: string) => Math.ceil((Date.parse(d) - Date.now()) / 86_400_000);
    const owners = [...new Set((ctx.config()?.overlays ?? []).flatMap((o) => o.metadata.owners))];
    const body = `<div class="cols"><div class="main">
${heading('Waivers', 'Time-limited exceptions to a rule, read by CI and the hooks. A waiver stops applying on its expiry date with no action needed.')}
<div class="tabs">${[
      ['active', `Active · ${active.length}`],
      ['expiring', `Expiring in 30 days · ${expiring.length}`],
      ['expired', `Expired · ${expired.length}`],
    ]
      .map(([k, l]) => `<a href="/admin/waivers?tab=${k}" class="${k === tab ? 'on' : ''}">${esc(l)}</a>`)
      .join('')}</div>
<section class="card flush">${table(
      ['Waiver', 'Rule', 'Scope', 'Approved by', 'Expires', ''],
      shown.map((w) => [
        `<span class="mono">${esc(w.id)}</span><br><span class="small muted">${esc(w.reason)}</span>`,
        `<span class="mono small">${esc(w.rule)}</span>`,
        esc(
          Object.entries(w.scope)
            .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(' ') : v}`)
            .join(' · ') || 'everywhere',
        ),
        esc(w.approver),
        w.expires < today
          ? pill(`Expired ${day(w.expires)}`)
          : w.expires <= in30
            ? pill(`${day(w.expires)} · ${days(w.expires)} days`, 'warn')
            : esc(day(w.expires)),
        w.expires < today
          ? ''
          : `<div class="row"><button class="ghost" onclick="const d=prompt('New expiry (YYYY-MM-DD, 90 days at most)');if(d)act(this,'POST','/api/admin/waivers/${esc(w.id)}/renew',{expires:d})">Renew</button>${button('Revoke', 'POST', `/api/admin/waivers/${w.id}/revoke`, undefined, { danger: true })}</div>`,
      ]),
      'None.',
    )}</section>
<p class="sub">Waiver counts per rule feed process health: a rule that keeps needing waivers is a candidate for change in the source page.${[
      ...counts,
    ]
      .filter(([, n]) => n > 1)
      .map(([r, n]) => ` <span class="mono">${esc(r)}</span> ×${n}.`)
      .join('')}</p>
</div><div class="side"><section class="card focus admin" id="nw"><h2>New waiver</h2>
<label class="f">Rule<select name="rule">${rules
      .map((r) => {
        const [id, sev] = r.split('|');
        return `<option value="${esc(id)}">${esc(id)} · ${esc(sev)}</option>`;
      })
      .join('')}</select></label>
<label class="f">Scope<input name="scope" placeholder="team: payments, repo: acme/web, paths: src/vendor/**"></label>
<label class="f">Reason<textarea name="reason" rows="3"></textarea></label>
<label class="f">Expires (90 days at most)<input name="expires" type="date" max="${new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10)}"></label>
<label class="f">Approver<input name="approver" placeholder="${esc(owners[0] ?? 'rule owner')}"></label>
<div class="small"><span class="muted">Rule owner</span><br>${esc(owners.join(', ') || 'process owners')}</div>
${button('Open PR in orgspec-config', 'POST', '/api/admin/waivers', { js: "form('nw')" })}
<p class="small muted" style="margin:0">The waiver applies only after the approver merges the PR.</p></section></div></div>`;
    return html(reply, '/admin/waivers', 'Admin: waivers', body);
  });

  // ---- Personas ----
  app.get('/admin/personas', async (req: FastifyRequest<{ Querystring: { id?: string; add?: string } }>, reply) => {
    const cfg = ctx.config();
    const personas = cfg?.personas ?? [];
    const diags = personaDiagnostics(ctx);
    const sel = personas.find((p) => p.metadata.id === req.query.id) ?? personas[0];
    const rows = personas.map((p) => {
      const b = ctx.bundle(p).bundle;
      const usable = bundleUsable(ctx, p.metadata.id);
      const tools = p.spec.mcp.reduce((n, g) => n + g.tools.length, 0);
      const confirm = p.spec.mcp.reduce((n, g) => n + g.confirm.length, 0);
      const bad = diags.get(p.metadata.id);
      return [
        `<a href="/admin/personas?id=${esc(p.metadata.id)}" style="font-weight:600">${esc(p.metadata.name)}</a><br><span class="mono small muted">${esc(p.metadata.id)} ${esc(p.metadata.version)}</span>`,
        esc(p.spec.eligibility.teams.join(', ') || 'everyone'),
        usable.ok && b
          ? `<span class="mono small">${esc(b.manifest.version)} · ${esc(b.manifest.sha256.slice(7, 11))}…${esc(b.manifest.sha256.slice(-2))}</span>`
          : `<span class="bad">${esc(usable.message ?? 'No bundle compiled')}</span>`,
        String(p.spec.agents.length || 'built-in'),
        `${tools}${confirm ? ` · ${confirm} need confirmation` : ''}`,
        bad ? `<span class="bad">${bad.length} schema error${bad.length === 1 ? '' : 's'}</span>` : pill('Valid', 'ok'),
      ];
    });
    for (const [id, msgs] of diags)
      if (!personas.some((p) => p.metadata.id === id))
        rows.push([
          `<b>${esc(id)}</b>`,
          '',
          '',
          '',
          '',
          `<span class="bad" title="${esc(msgs.join('; '))}">${msgs.length} schema error${msgs.length === 1 ? '' : 's'}</span>`,
        ]);
    const history = sel ? await personaHistory(ctx, sel.metadata.id) : [];
    const editorId = req.query.add ? 'new' : (sel?.metadata.id ?? '');
    const yaml = req.query.add ? personaTemplate() : sel ? personaYaml(ctx, sel.metadata.id) : '';
    const detail = sel
      ? `<section class="card focus admin"><div class="row between"><h2>${esc(sel.metadata.name)} · ${esc(sel.metadata.version)}</h2><a href="#edit">Edit manifest (opens a PR)</a></div>
<div class="grid">
<div><span class="k">Agents</span>${(sel.spec.agents.length ? sel.spec.agents : [{ id: 'built-in agents', model: '', skills: [] as string[] }]).map((a) => `<div class="row between note"><span>${esc(a.id)}${a.skills.length ? `<br><span class="small muted">${esc(a.skills.join(', '))}</span>` : ''}</span><span class="mono">${esc(a.model)}</span></div>`).join('')}<p class="small muted" style="margin:0">Each runs as a Claude CLI session; agent files are written into each job and ticket folder.</p></div>
<div><span class="k">Upstream tools through the gateway</span>${table(
          ['Tool', ''],
          sel.spec.mcp.flatMap((g) =>
            g.tools.map((t) => [
              `<span class="mono small">${esc(g.server)}__${esc(t)}</span>`,
              g.confirm.some((c) => c === t || (c.endsWith('*') && t.startsWith(c.slice(0, -1))))
                ? '<span class="warn">confirm</span>'
                : '<span class="muted">read</span>',
            ]),
          ),
          'No upstream tools.',
        )}<p class="small muted" style="margin:0">The effective list is this one intersected with each person's own access in each system. GitHub is not behind the gateway: each machine reads it with that person's gh account.</p></div>
<div><span class="k">Views and reminders</span><p style="margin:4px 0">${esc(sel.spec.views.join(', ') || 'default views')}</p><p style="margin:4px 0">${esc(sel.spec.reminders.join(', ') || 'no reminders')}</p><span class="k">Change history</span>${history.map((h) => `<p class="small" style="margin:2px 0">${esc(h.date)} · ${esc(h.subject)}</p>`).join('') || '<p class="small muted" style="margin:0">No commits yet.</p>'}</div>
</div></section>`
      : '';
    const editor = `<section class="card" id="edit"><h2>${req.query.add ? 'Add persona' : `Edit ${esc(editorId)}`}</h2><textarea id="py" rows="18" class="mono" style="width:100%">${esc(yaml)}</textarea>
<div class="row">${button('Validate and open PR', 'POST', `/api/admin/personas/${encodeURIComponent(editorId)}`, { js: `{yaml:val('py'),create:${Boolean(req.query.add)}}` })}<span class="small muted">A persona is a view: it can narrow what people can do, never widen it. Merging the PR is what publishes.</span></div></section>`;
    const body = `${heading('Personas', 'Each persona is a versioned manifest in orgspec-config. A persona is a view: it can narrow what people can do, never widen it.', '<a class="btn ghost" href="/admin/personas?add=1#edit">Add persona</a>')}
<section class="card flush">${table(['Persona', 'Who can select it', 'Bundle', 'Agents', 'Upstream tools', 'Manifest'], rows, 'No personas.')}</section>${detail}${editor}`;
    return html(reply, '/admin/personas', 'Admin: personas', body);
  });

  // ---- Sync ----
  app.get('/admin/sync', async (req: FastifyRequest<{ Querystring: { source?: string } }>, reply) => {
    const cfg = ctx.config();
    const sched = new Scheduler({
      db: ctx.db(),
      sync: cfg?.sync ?? { workingHours: { start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5] }, sources: {} },
      personal: {},
      jobs: syncJobs(ctx),
    });
    const states = sched.states();
    const ops = { ...DEFAULT_OPERATIONS, ...(cfg?.integrations.operations ?? {}) };
    const through = (src: string) => {
      const prefix = src.split('.')[0] ?? '';
      if (prefix === 'github') return 'gh CLI';
      if (prefix === 'config') return 'git';
      const op = Object.entries(ops).find(([k]) => k.startsWith(`${prefix}.`))?.[1]?.tool;
      return `${op ? op.split('__')[0] : prefix} MCP`;
    };
    const sel = req.query.source ?? 'jira.active';
    const selCfg = cfg?.sync.sources[sel] ?? DEFAULT_SYNC[sel];
    const stat = syncStat(ctx, sel);
    const opt = (v: string, cur: string, label = v) =>
      `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(label)}</option>`;
    const body = `<div class="cols"><div class="main">
${heading('Sync and refresh', 'Default intervals every machine uses, from sync.yaml. Each machine fetches only its own person’s items; status below is for this machine.')}
<section class="card flush">${table(
      ['Source', 'Through', 'Every', 'Last run here', 'Status here', ''],
      states.map((s) => {
        const c = cfg?.sync.sources[s.source] ?? DEFAULT_SYNC[s.source];
        const label = SOURCE_LABELS[s.source] ?? [s.source, ''];
        const eff = s.effectiveIntervalMs && c ? Math.round(s.effectiveIntervalMs / 60_000) : undefined;
        return [
          `<b>${esc(label[0])}</b><br><span class="small muted">${esc(label[1])}</span>`,
          esc(through(s.source)),
          `${esc(c?.every ?? '—')}${s.failures && eff ? ` <span class="warn">(now ${eff} min)</span>` : ''}`,
          esc(ago(s.lastRunAt)),
          s.status === 'error'
            ? pill(s.failures ? 'Failing · backing off' : 'Error', 'bad')
            : s.status === 'ok'
              ? pill('Healthy', 'ok')
              : pill(s.status),
          `<a class="btn ghost" href="/admin/sync?source=${esc(s.source)}">Edit</a>`,
        ];
      }),
    )}</section>
<p class="sub">A failing source doubles its interval up to four times its maximum and returns to normal after a clean run. Slack summaries and calendar slots run on demand.</p>
</div><div class="side"><section class="card focus admin" id="se"><h2>${esc(SOURCE_LABELS[sel]?.[0] ?? sel)}</h2>
${
  selCfg
    ? `<label class="f">Fetch every<select name="every">${[...new Set([selCfg.min, '1m', '2m', '5m', '10m', '15m', '30m', '60m', '24h', selCfg.every])].map((v) => opt(v, selCfg.every, v === selCfg.every ? `${v} (current)` : v)).join('')}</select></label>
<span class="small muted">Allowed range ${esc(selCfg.min)} to ${esc(selCfg.max)}, from sync.yaml</span>
<label class="f">Outside working hours<select name="offHours">${opt('slow', selCfg.offHours, `Slow to every ${selCfg.offHoursEvery}`)}${opt('pause', selCfg.offHours, 'Pause')}${opt('same', selCfg.offHours, 'Same as working hours')}</select></label>
<label class="row"><input type="checkbox" name="personal" ${selCfg.personal ? 'checked' : ''}> Let people set a faster interval for their own views, within the range</label>
<p class="note small" style="margin:0">This machine, today: ${stat ? `${stat.runs} runs, slowest ${(stat.slowestMs / 1000).toFixed(1)} s` : 'no runs recorded yet'}. OrgSpec has no central view of other machines; watch the MCP server’s own rate-limit dashboard for org-wide load.</p>
${button('Open PR to sync.yaml', 'POST', `/api/admin/sync/${sel}`, { js: "form('se')" })}
<p class="small muted" style="margin:0">After the PR merges, every machine picks up the new interval on its next config pull, within 15 minutes.</p>`
    : '<p class="muted">Unknown source.</p>'
}</section></div></div>`;
    return html(reply, '/admin/sync', 'Admin: sync and refresh', body);
  });
}
