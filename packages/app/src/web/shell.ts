import { claudeVersion, MIN_CLAUDE_VERSION } from '@orgspec/claude';
import { DEFAULT_SYNC, openJson } from '@orgspec/core';
import { pendingActions } from '@orgspec/gateway';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { executePending } from '../risk.js';
import { zenEndsAt } from '../zen.js';
import { button, card, esc, heading, layout, personaNav, pill, table } from './ui.js';

interface ConnectionStatus {
  server: string;
  ok: boolean;
  detail: string;
  transport: string;
}

/** Each MCP server probed once a minute at most. */
function connections(ctx: AppContext) {
  let cache: { at: number; list: ConnectionStatus[] } | undefined;
  return async (force = false): Promise<ConnectionStatus[]> => {
    if (!force && cache && Date.now() - cache.at < 60_000) return cache.list;
    const servers = ctx.config()?.integrations.servers ?? {};
    const list = await Promise.all(
      Object.entries(servers).map(async ([server, cfg]) => {
        try {
          const tools = await Promise.race([
            ctx.pool().tools(server),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timed out')), 8000)),
          ]);
          return { server, ok: true, detail: `${tools.length} tools`, transport: cfg.transport };
        } catch (e) {
          return { server, ok: false, detail: (e as Error).message, transport: cfg.transport };
        }
      }),
    );
    cache = { at: Date.now(), list };
    return list;
  };
}

export function registerShellRoutes(app: FastifyInstance, ctx: AppContext, deps: { started: string }) {
  const html = (reply: FastifyReply, path: string, title: string, body: string) =>
    reply.type('text/html').send(layout(ctx, path, title, body));
  const conns = connections(ctx);
  let claudeInfo: { at: number; v: Awaited<ReturnType<typeof claudeVersion>> } | undefined;
  const claude = async () => {
    if (!claudeInfo || Date.now() - claudeInfo.at > 300_000)
      claudeInfo = { at: Date.now(), v: await claudeVersion(ctx.runner) };
    return claudeInfo.v;
  };

  app.get('/', async (_req, reply) => {
    if (!ctx.persona()) return reply.redirect('/workspace');
    // During a zen session the dashboard opens on the focus view.
    if (zenEndsAt(ctx)) return reply.redirect('/zen');
    return reply.redirect(personaNav(ctx)[0]?.href ?? '/work');
  });

  // ---- Choose your workspace ----
  app.post('/api/persona', async (req: FastifyRequest<{ Body: { id: string } }>) => {
    const eligible = JSON.parse(
      (ctx.db().prepare("select value from kv where key = 'personas:eligible'").get() as { value?: string } | undefined)
        ?.value ?? 'null',
    ) as string[] | null;
    const p = ctx.persona(req.body.id);
    if (!p) throw Object.assign(new Error('Unknown persona'), { statusCode: 404 });
    if (eligible && !eligible.includes(p.metadata.id) && p.spec.eligibility.teams.length) {
      throw Object.assign(new Error(`You are not in ${p.spec.eligibility.teams.join(', ')}`), { statusCode: 403 });
    }
    ctx.updateSettings((s) => ({ ...s, persona: p.metadata.id }));
    return { ok: true };
  });

  app.get('/workspace', async (_req, reply) => {
    const cfg = ctx.config();
    const eligible = JSON.parse(
      (ctx.db().prepare("select value from kv where key = 'personas:eligible'").get() as { value?: string } | undefined)
        ?.value ?? 'null',
    ) as string[] | null;
    const [cv, cs] = await Promise.all([claude(), conns()]);
    const cards = (cfg?.personas ?? []).map((p) => {
      const current = p.metadata.id === ctx.settings.persona;
      const allowed = !p.spec.eligibility.teams.length || !eligible || eligible.includes(p.metadata.id);
      const bundle = ctx.bundle(p).bundle;
      const agents = p.spec.agents.map((a) => a.id).join(', ') || 'built-in agents';
      const views = (p.spec.views.length ? p.spec.views : ['my-work', 'my-agents', 'task-inbox'])
        .map((v) => v.replace(/-/g, ' '))
        .join(', ');
      return `<section class="card ${current ? 'focus' : ''}"><div class="row between"><h2>${esc(p.metadata.name)}</h2>${current ? pill('Current', 'ok') : allowed ? pill('Available', 'info') : pill('Not available')}</div>
<p class="small muted" style="margin:0">Agents: ${esc(agents)}<br>Views: ${esc(views)}</p>
<p class="small mono muted" style="margin:0">${bundle ? `bundle ${esc(bundle.manifest.version)} · ${esc(bundle.manifest.sha256.slice(7, 11))}…${esc(bundle.manifest.sha256.slice(-2))}` : 'bundle not verified'}</p>
${allowed ? button(current ? 'Open' : 'Switch to this workspace', 'POST', '/api/persona', { id: p.metadata.id }, { next: '/' }) : `<p class="small" style="margin:0">Needs membership of ${esc(p.spec.eligibility.teams.join(', '))}. Ask a process owner in orgspec-config.</p>`}</section>`;
    });
    const slack = cs.find((c) => c.server === 'slack');
    const body = `${heading('Choose your workspace', 'A workspace loads the agents, views and rules for one role. It never changes what you can see in Jira, Slack, Confluence or GitHub — that still comes from your own access.')}
<div class="grid">${cards.join('') || '<p class="muted">No personas in orgspec-config. Run orgspec setup.</p>'}</div>
${card(
  'Setup on this machine',
  `<ul class="clean"><li>${pill('Local service running', 'ok')} on this machine only · tickets in <code>${esc(ctx.workRoot)}</code></li>
<li>${pill(`Claude Code ${cv.version ?? '?'}`, cv.ok ? 'ok' : 'bad')} ${esc(cv.ok ? `at or above ${MIN_CLAUDE_VERSION}` : cv.message)}</li>
<li>${slack ? (slack.ok ? pill('Slack connected', 'ok') : `${pill('Slack not authorised', 'warn')} <code>orgspec connect slack</code> to use the summarizer and task inbox`) : pill('No Slack server configured')}</li>
<li>Process owner? <a href="/admin/sources">Open admin mode</a> to compile and publish constitution bundles.</li></ul>`,
)}`;
    return html(reply, '/workspace', 'Choose your workspace', body);
  });

  // ---- Approvals (pending actions) ----
  app.get('/actions', async (_req, reply) => {
    const p = pendingActions(ctx.db());
    const pending = p.list('pending');
    const recent = p
      .list()
      .filter((a) => a.state !== 'pending')
      .slice(0, 20);
    const body = `${heading('Approvals', 'Actions that write to Jira, Confluence, Slack or your calendar wait here until you approve them.')}
<section class="card flush"><h2>Waiting for you · ${pending.length}</h2>${table(
      ['Action', 'From', ''],
      pending.map((a) => [
        `<pre style="white-space:pre-wrap;margin:0;font-size:13px">${esc(a.summary)}</pre>`,
        esc(
          a.persona
            ? `Claude session${a.ticket ? ` · ${a.ticket}` : ''}`
            : a.ticket
              ? `OrgSpec · ${a.ticket}`
              : 'OrgSpec',
        ),
        `<div class="row">${button('Approve', 'POST', `/api/actions/${a.id}/approve`)} ${button('Reject', 'POST', `/api/actions/${a.id}/reject`, undefined, { ghost: true })}</div>`,
      ]),
      'Nothing waiting.',
    )}</section>
<section class="card flush"><h2>Recent</h2>${table(
      ['Action', 'State', 'Decided'],
      recent.map((a) => [
        esc(a.summary.split('\n')[0]),
        pill(a.state, a.state === 'done' ? 'ok' : a.state === 'failed' || a.state === 'rejected' ? 'bad' : ''),
        esc(a.decidedAt?.slice(0, 16).replace('T', ' ') ?? ''),
      ]),
      'No history yet.',
    )}</section>`;
    return html(reply, '/actions', 'Approvals', body);
  });

  // ---- Settings and privacy ----
  app.put('/api/settings', async (req: FastifyRequest<{ Body: Record<string, unknown> }>) => {
    const b = req.body;
    const s = ctx.updateSettings((x) => ({
      ...x,
      ...(typeof b.workRoot === 'string' && b.workRoot ? { workRoot: b.workRoot } : {}),
      ...(b.sendMode === 'background' || b.sendMode === 'interactive' ? { sendMode: b.sendMode } : {}),
      ...(b.terminal === 'Terminal' || b.terminal === 'iTerm2' || b.terminal === 'Ghostty'
        ? { terminal: b.terminal }
        : {}),
      ...(typeof b.quietStart === 'string' && typeof b.quietEnd === 'string'
        ? { quietHours: { start: b.quietStart, end: b.quietEnd } }
        : {}),
      ...(b.reminderMode === 'digest' || b.reminderMode === 'dm'
        ? {
            reminders: {
              mode: b.reminderMode,
              digestAt: typeof b.digestAt === 'string' ? b.digestAt : x.reminders.digestAt,
            },
          }
        : {}),
      ...(typeof b.dmInbox === 'boolean' ? { dmInbox: { ...x.dmInbox, enabled: b.dmInbox } } : {}),
      ...(Array.isArray(b.excluded) ? { dmInbox: { ...x.dmInbox, excluded: b.excluded.map(String) } } : {}),
    }));
    return s;
  });
  app.put(
    '/api/settings/zen',
    async (
      req: FastifyRequest<{
        Body: { defaultMinutes?: number; slackStatus?: boolean; autoReply?: boolean; allowlist?: string[] };
      }>,
    ) => {
      const b = req.body ?? {};
      const max = ctx.config()?.zen.maxMinutes ?? 120;
      return ctx.updateSettings((x) => ({
        ...x,
        zen: {
          ...x.zen,
          ...(typeof b.defaultMinutes === 'number' && Number.isFinite(b.defaultMinutes)
            ? { defaultMinutes: Math.min(Math.max(15, Math.round(b.defaultMinutes)), max) }
            : {}),
          ...(typeof b.slackStatus === 'boolean' ? { slackStatus: b.slackStatus } : {}),
          ...(typeof b.autoReply === 'boolean' ? { autoReply: b.autoReply } : {}),
          ...(Array.isArray(b.allowlist) ? { allowlist: b.allowlist.map(String).filter(Boolean) } : {}),
        },
      })).zen;
    },
  );
  app.put('/api/settings/interval', async (req: FastifyRequest<{ Body: { source: string; every: string } }>) => {
    const { source, every } = req.body;
    const cfg = ctx.config()?.sync.sources[source] ?? DEFAULT_SYNC[source];
    if (!cfg) throw Object.assign(new Error(`Unknown source ${source}`), { statusCode: 400 });
    if (every !== 'default' && !cfg.personal)
      throw Object.assign(new Error(`${source} uses the admin interval`), { statusCode: 400 });
    return ctx.updateSettings((x) => {
      const intervals = { ...x.intervals };
      if (every === 'default') delete intervals[source];
      else intervals[source] = every;
      return { ...x, intervals };
    }).intervals;
  });
  app.post('/api/connections/refresh', async () => conns(true));

  app.get('/api/me/export', async (_req, reply) => {
    const key = await ctx.key();
    const pdb = ctx.privateDb();
    const open = (rows: { payload: string }[]) => rows.map((r) => openJson<unknown>(key, r.payload));
    const data = {
      exportedAt: new Date().toISOString(),
      settings: ctx.settings,
      inbox: open(pdb.prepare('select payload from inbox_tasks').all() as { payload: string }[]),
      slackSummaries: open(pdb.prepare('select payload from summaries').all() as { payload: string }[]),
      privateNotes: open(pdb.prepare('select payload from notes').all() as { payload: string }[]),
      oneOnOneBriefs: open(pdb.prepare('select payload from briefs').all() as { payload: string }[]),
      agreedActions: open(pdb.prepare('select payload from oneonone_actions').all() as { payload: string }[]),
      reminders: ctx.db().prepare('select * from reminders').all(),
    };
    return reply
      .header('content-disposition', 'attachment; filename="orgspec-my-data.json"')
      .type('application/json')
      .send(JSON.stringify(data, null, 2));
  });
  app.post('/api/me/delete-inbox', async () => {
    const pdb = ctx.privateDb();
    pdb.exec('delete from inbox_tasks; delete from inbox_cursor; delete from summaries;');
    return { ok: true };
  });

  app.get('/settings', async (_req, reply) => {
    const s = ctx.settings;
    const [cv, cs, accounts] = await Promise.all([claude(), conns(), ctx.gh.accounts().catch(() => [])]);
    const sync = ctx.config()?.sync.sources ?? {};
    const src = (id: string) => sync[id] ?? DEFAULT_SYNC[id];
    const opt = (v: string, cur: string, label = v) =>
      `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(label)}</option>`;
    const intervalSelect = (id: string, label: string, choices: string[]) => {
      const cfg = src(id);
      if (!cfg) return '';
      const cur = s.intervals[id] ?? 'default';
      return `<label class="f">${esc(label)}<select onchange="api('PUT','/api/settings/interval',{source:'${id}',every:this.value})">${opt('default', cur, `${cfg.every} (default)`)}${choices.map((c) => opt(c, cur)).join('')}</select></label>`;
    };
    const orgRows = Object.entries(s.github.orgAccounts);
    const body = `${heading('Settings and privacy')}
<div class="cols"><div class="main">
${card(
  'Connections · all through MCP servers, except GitHub',
  `${table(
    ['Server', 'Status', ''],
    cs.map((c) => [
      `<b>${esc(c.server)}</b><br><span class="small muted">${esc(c.transport)}</span>`,
      c.ok
        ? `${pill('Connected', 'ok')} <span class="small muted">${esc(c.detail)} · every call goes through the gateway with your own access</span>`
        : `${pill('Not connected', 'warn')} <span class="small muted">${esc(c.detail.slice(0, 140))}</span>`,
      c.ok
        ? ''
        : c.transport === 'http'
          ? `<code>orgspec connect ${esc(c.server)}</code>`
          : '<span class="small muted">check the command in integrations.yaml</span>',
    ]),
    'No MCP servers configured in integrations.yaml.',
  )}<p class="small muted" style="margin:0">GitHub is not an MCP server: agents and background jobs use your gh accounts below. ${button('Check again', 'POST', '/api/connections/refresh', undefined, { ghost: true })}</p>`,
)}
${card(
  'This machine',
  `<div class="grid">
<div><span class="k">Local service</span><br>${pill('Running', 'ok')} <span class="small muted">since ${esc(new Date(deps.started).toLocaleTimeString())} · 127.0.0.1 only</span></div>
<div><span class="k">Claude Code</span><br>${pill(cv.version ?? 'missing', cv.ok ? 'ok' : 'bad')} <span class="small muted">${esc(cv.ok ? `supported (≥ ${MIN_CLAUDE_VERSION})` : cv.message)}</span></div>
<label class="f">Ticket folders<input id="wr" value="${esc(s.workRoot)}" onchange="api('PUT','/api/settings',{workRoot:this.value})"></label>
<label class="f">Send to agent opens<select onchange="api('PUT','/api/settings',{sendMode:this.value})">${opt('background', s.sendMode, 'Background session')}${opt('interactive', s.sendMode, 'Interactive terminal')}</select></label>
<label class="f">Terminal for Attach<select onchange="api('PUT','/api/settings',{terminal:this.value})">${['Terminal', 'iTerm2', 'Ghostty'].map((t) => opt(t, s.terminal)).join('')}</select></label>
</div>`,
)}
${card(
  'GitHub accounts on this machine',
  `<p class="sub">Agents clone, push and open PRs with the gh account that is active here. OrgSpec reads them from <code>gh auth status</code> and never sees your tokens.</p>
${table(
  ['Account', 'Host', 'Status', 'Scopes', ''],
  accounts.map((a) => [
    esc(a.login),
    esc(a.host),
    a.active ? pill('Active', 'ok') : a.state === 'success' ? pill('Signed in') : pill('Token invalid', 'bad'),
    `<span class="small">${esc(a.scopes ?? '')}</span>`,
    a.active
      ? '<span class="small muted">In use</span>'
      : `<div class="row">${button('Switch to', 'POST', '/api/github/switch', { login: a.login, host: a.host }, { ghost: true })}${button('Sign out', 'POST', '/api/github/logout', { login: a.login, host: a.host }, { danger: true })}</div>`,
  ]),
  'gh has no accounts. Run: orgspec github login',
)}
<h3>Which account each GitHub organisation uses</h3>
${table(
  ['Organisation', 'Account', ''],
  orgRows.map(([org, login]) => [
    esc(org),
    `<select onchange="const m=${esc(JSON.stringify(s.github.orgAccounts))};m['${esc(org)}']=this.value;api('PUT','/api/settings/github',{orgAccounts:m})">${accounts.map((a) => opt(a.login, login)).join('') || opt(login, login)}</select>`,
    button(
      'Remove',
      'PUT',
      '/api/settings/github',
      { orgAccounts: Object.fromEntries(orgRows.filter(([o]) => o !== org)) },
      { ghost: true },
    ),
  ]),
  'No organisations mapped yet.',
)}
<div class="row"><input id="neworg" placeholder="github.com/acme-payments"><select id="newacct">${accounts.map((a) => `<option>${esc(a.login)}</option>`).join('')}</select>${button('Add organisation', 'PUT', '/api/settings/github', { js: `{orgAccounts:Object.assign(${JSON.stringify(s.github.orgAccounts)},{[val('neworg')]:val('newacct')})}` }, { ghost: true })}</div>
<label class="row"><input type="checkbox" ${s.github.autoSwitch ? 'checked' : ''} onchange="api('PUT','/api/settings/github',{autoSwitch:this.checked})"> Switch account automatically when an agent starts</label>
<p class="small muted" style="margin:0">Switching changes the active account for every terminal on this machine, not only OrgSpec. ${button('Let git use these credentials', 'POST', '/api/github/setup-git', {}, { ghost: true })} Add an account with <code>orgspec github login</code>; it opens a terminal so you sign in to GitHub directly.</p>`,
)}
</div><div class="side">
${card(
  'Refresh',
  `<p class="sub">How often OrgSpec fetches your data through MCP servers, and with gh for GitHub. Admins set the allowed range.</p>
${intervalSelect('slack.dms', 'Task inbox checks Slack every', ['2m', '15m', '30m'])}
${intervalSelect('jira.active', 'My work refreshes every', ['1m', '5m', '10m'])}
${intervalSelect('github.prs', 'Pull requests refresh every', ['1m', '5m', '10m'])}`,
)}
${card(
  'Task inbox',
  `<label class="row"><input type="checkbox" ${s.dmInbox.enabled ? 'checked' : ''} onchange="api('PUT','/api/settings',{dmInbox:this.checked})"> Turn DMs and saved messages into tasks</label>
<p class="small muted" style="margin:0">Read with your Slack authorisation. Only you see the tasks.</p>
<span class="k">Excluded conversations</span>
${s.dmInbox.excluded.length ? `<ul class="clean">${s.dmInbox.excluded.map((c) => `<li class="row"><code>${esc(c)}</code> ${button('Remove', 'PUT', '/api/settings', { excluded: s.dmInbox.excluded.filter((x) => x !== c) }, { ghost: true })}</li>`).join('')}</ul>` : '<p class="small muted" style="margin:0">None.</p>'}
<div class="row"><input id="exc" placeholder="Conversation or user ID">${button('Add', 'PUT', '/api/settings', { js: `{excluded:${JSON.stringify(s.dmInbox.excluded)}.concat([val('exc')])}` }, { ghost: true })}</div>`,
)}
<section class="card" id="zen"><h2>Zen mode</h2>
<label class="f">Default length (org maximum ${ctx.config()?.zen.maxMinutes ?? 120} min)<input id="zm" type="number" min="15" step="15" value="${s.zen.defaultMinutes}"></label>
<label class="row"><input type="checkbox" id="zs" ${s.zen.slackStatus ? 'checked' : ''}> Set Slack status and Do Not Disturb</label>
<label class="row"><input type="checkbox" id="zr" ${s.zen.autoReply ? 'checked' : ''}> Auto-reply to DMs, once per conversation per session</label>
<label class="f">People who always reach you (work emails or Slack IDs, comma-separated)<input id="za" value="${esc(s.zen.allowlist.join(', '))}"></label>
${button('Save', 'PUT', '/api/settings/zen', { js: "{defaultMinutes:Number(val('zm')),slackStatus:val('zs'),autoReply:val('zr'),allowlist:val('za').split(',').map(x=>x.trim()).filter(Boolean)}" })}
<p class="small muted" style="margin:0">Incidents and on-call pages always break through. Sessions stay on this machine and are never a metric.</p></section>
${card(
  'Reminders and nudges',
  `<div class="row"><label class="f">Quiet hours from<input id="qs" type="time" value="${esc(s.quietHours.start)}"></label><label class="f">to<input id="qe" type="time" value="${esc(s.quietHours.end)}"></label></div>
<label class="f">Deliver reminders as<select id="rm">${opt('digest', s.reminders.mode, `Daily digest at ${s.reminders.digestAt}`)}${opt('dm', s.reminders.mode, 'Slack DM as they happen')}</select></label>
<label class="f">Digest time<input id="da" type="time" value="${esc(s.reminders.digestAt)}"></label>
${button('Save', 'PUT', '/api/settings', { js: "{quietStart:val('qs'),quietEnd:val('qe'),reminderMode:val('rm'),digestAt:val('da')}" })}
<p class="small muted" style="margin:0">${s.identity.timezone ? `Time zone: ${esc(s.identity.timezone)}.` : 'Time zone from this machine.'} Slack DMs are posted to yourself by your own OrgSpec through the Slack MCP server.</p>`,
)}
${card(
  'Data about you',
  `${table(
    ['What', 'Who can see it', 'Kept for'],
    [
      ['Task inbox and message excerpts', 'Only you', 'Until done + 14 days'],
      ['Slack summaries you run', 'Only you', '30 days'],
      [
        '1:1 evidence (tickets, PRs, allowlisted channels)',
        'Built separately on your machine and your manager’s, from the same sources',
        'HR policy',
      ],
      [
        '1:1 shared agenda and your context notes',
        'You and your manager, on a restricted Confluence page',
        'Confluence retention',
      ],
      ['Never collected', 'DMs for briefs, private channels, sentiment, commit or message counts, online hours', '—'],
    ].map((r) => r.map(esc)),
  )}
<p class="small muted" style="margin:0">Everything else stays on this machine, encrypted; OrgSpec has no server.</p>
<div class="row"><a class="btn ghost" href="/evidence">See my 1:1 evidence</a><a class="btn ghost" href="/api/me/export">Download my data</a>${button('Delete my inbox data', 'POST', '/api/me/delete-inbox', undefined, { danger: true })}</div>`,
)}
</div></div>`;
    return html(reply, '/settings', 'Settings and privacy', body);
  });

  app.post('/api/actions/:id/run', async (req: FastifyRequest<{ Params: { id: string } }>) =>
    executePending(ctx, req.params.id),
  );
}
