import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, rmSync } from 'node:fs';
import { createServer, type Server as NetServer } from 'node:net';
import { readJsonFile, writeFileAtomic } from '@orgspec/core';
import { pendingActions } from '@orgspec/gateway';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { adminCheck, bundleVersions } from './admin.js';
import type { AppContext } from './context.js';
import { band, button, card, esc, page, table } from './dashboard.js';
import { searchDecisions } from './decisions.js';
import { preToolUse } from './hook.js';
import { listInbox, updateInboxTask } from './inbox.js';
import { listJobs } from './jobs.js';
import { createPacket, listPackets } from './packet.js';
import { completeReminder, deliverReminders, listReminders, snoozeReminder } from './reminders.js';
import { listFindings, reviewPrd, setFindingStatus } from './reviews.js';
import { executePending, scoreCachedIssues } from './risk.js';
import { Scheduler } from './scheduler.js';
import { syncJobs } from './sync.js';

export interface DaemonInfo {
  pid: number;
  port: number;
  token: string;
  startedAt: string;
}

export const readDaemonInfo = (ctx: AppContext): DaemonInfo | undefined =>
  readJsonFile<DaemonInfo | undefined>(ctx.paths.daemonInfo, undefined);

const COOKIE = 'orgspec_token';

/** True when the request carries this run's token (bearer header or the dashboard cookie). */
function authorized(req: FastifyRequest, token: string): boolean {
  const header = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  const cookie = /(?:^|;\s*)orgspec_token=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
  const given = header ?? cookie ?? '';
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface Daemon {
  app: FastifyInstance;
  scheduler: Scheduler;
  info: DaemonInfo;
  url: string;
  close(): Promise<void>;
}

/**
 * `orgspec daemon`: the local service. Binds 127.0.0.1 only; every request needs the per-start token,
 * which is written to daemon.json (0600) for the CLI and handed to the browser once via `/login`.
 */
export async function startDaemon(
  ctx: AppContext,
  o: { port?: number; scheduler?: boolean; socket?: boolean } = {},
): Promise<Daemon> {
  const token = randomBytes(24).toString('base64url');
  const app = Fastify({ logger: false, bodyLimit: 1_000_000 });
  const cfg = ctx.config();
  const scheduler = new Scheduler({
    db: ctx.db(),
    sync: cfg?.sync ?? { workingHours: { start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5] }, sources: {} },
    personal: ctx.settings.intervals,
    jobs: syncJobs(ctx),
  });
  const pending = pendingActions(ctx.db());

  app.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/login')) return;
    if (!authorized(req, token)) {
      reply.code(401).type('text/plain').send('Open the dashboard with: orgspec dashboard');
    }
  });
  app.setErrorHandler((err, _req, reply) => {
    reply.code((err as { statusCode?: number }).statusCode ?? 500).send({ message: (err as Error).message });
  });

  app.get('/login', async (req: FastifyRequest<{ Querystring: { token?: string } }>, reply: FastifyReply) => {
    const a = Buffer.from(req.query.token ?? '');
    const b = Buffer.from(token);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return reply.code(401).send('Invalid token');
    reply.header('set-cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`).redirect('/');
  });

  // ---- API ----
  app.get('/api/status', async () => ({
    packets: listPackets(ctx).length,
    pendingActions: pending.list('pending').length,
    reminders: listReminders(ctx).length,
    sync: scheduler.states(),
    persona: ctx.settings.persona ?? null,
  }));
  app.get('/api/packets', async () => listPackets(ctx));
  app.post(
    '/api/packets',
    async (
      req: FastifyRequest<{
        Body: { ticket: string; launch?: 'interactive' | 'background' | 'none'; repos?: string[] };
      }>,
    ) => {
      const { ticket, launch, repos } = req.body;
      const p = await createPacket(ctx, {
        ticket,
        launch: launch ?? ctx.settings.sendMode,
        ...(repos ? { repos } : {}),
      });
      return { folder: p.folder, warnings: p.warnings, claudeSession: p.claudeSession ?? null };
    },
  );
  app.get('/api/actions', async () => pending.list());
  app.post('/api/actions/:id/:decision', async (req: FastifyRequest<{ Params: { id: string; decision: string } }>) => {
    const { id, decision } = req.params;
    const a = pending.get(id);
    if (!a) throw Object.assign(new Error('No such action'), { statusCode: 404 });
    pending.decide(id, decision === 'approve');
    // Actions raised by OrgSpec itself (nudges) run on approval; gateway actions wait for Claude to call run_pending.
    if (decision === 'approve' && !a.persona) return executePending(ctx, id);
    return { ok: true };
  });
  app.get('/api/inbox', async () => listInbox(ctx));
  app.post(
    '/api/inbox/:id',
    async (
      req: FastifyRequest<{
        Params: { id: string };
        Body: { state?: 'open' | 'done' | 'snoozed' | 'dismissed'; pinned?: boolean };
      }>,
    ) => {
      updateInboxTask(ctx, req.params.id, req.body);
      return { ok: true };
    },
  );
  app.get('/api/reminders', async () => listReminders(ctx));
  app.post('/api/reminders/:id/done', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    completeReminder(ctx, req.params.id);
    return { ok: true };
  });
  app.post(
    '/api/reminders/:id/snooze',
    async (req: FastifyRequest<{ Params: { id: string }; Body: { hours?: number } }>) => {
      snoozeReminder(ctx, req.params.id, new Date(Date.now() + (req.body?.hours ?? 24) * 3_600_000).toISOString());
      return { ok: true };
    },
  );
  app.get('/api/findings', async () => listFindings(ctx));
  app.post(
    '/api/findings/:id',
    async (
      req: FastifyRequest<{ Params: { id: string }; Body: { status: 'open' | 'accepted' | 'dismissed' | 'resolved' } }>,
    ) => {
      setFindingStatus(ctx, req.params.id, req.body.status);
      return { ok: true };
    },
  );
  app.post('/api/reviews/prd', async (req: FastifyRequest<{ Body: { pageId: string } }>) =>
    reviewPrd(ctx, req.body.pageId),
  );
  app.get('/api/risk', async () => scoreCachedIssues(ctx).sort((a, b) => b.score - a.score));
  app.get('/api/jobs', async () => listJobs(ctx));
  app.get('/api/sync', async () => scheduler.states());
  app.post('/api/sync/:source/run', async (req: FastifyRequest<{ Params: { source: string } }>) => {
    await scheduler.runSource(req.params.source);
    return scheduler.state(req.params.source);
  });
  app.get('/api/decisions', async (req: FastifyRequest<{ Querystring: { q?: string } }>) =>
    searchDecisions(ctx.db(), req.query.q ?? '', 25),
  );
  app.get('/api/settings', async () => ctx.settings);
  app.get('/api/github/accounts', async () => ({
    accounts: await ctx.gh.accounts(),
    autoSwitch: ctx.settings.github.autoSwitch,
    orgAccounts: ctx.settings.github.orgAccounts,
  }));
  app.post('/api/github/switch', async (req: FastifyRequest<{ Body: { login: string; host?: string } }>) => {
    await ctx.gh.switch(req.body.login, req.body.host);
    return { ok: true };
  });
  app.post('/api/github/logout', async (req: FastifyRequest<{ Body: { login: string; host?: string } }>) => {
    await ctx.gh.logout(req.body.login, req.body.host);
    return { ok: true };
  });
  app.post('/api/github/setup-git', async (req: FastifyRequest<{ Body: { host?: string } }>) => {
    await ctx.gh.setupGit(req.body?.host);
    return { ok: true };
  });
  app.put(
    '/api/settings/github',
    async (req: FastifyRequest<{ Body: { autoSwitch?: boolean; orgAccounts?: Record<string, string> } }>) =>
      ctx.updateSettings((s) => ({ ...s, github: { ...s.github, ...req.body } })).github,
  );

  // ---- Pages ----
  const html = (reply: FastifyReply, path: string, title: string, body: string) =>
    reply.type('text/html').send(page(path, title, body));

  app.get('/', async (_req, reply) => {
    const packets = listPackets(ctx);
    const prs = ctx.db().prepare('select * from cache_github_prs order by updated_at desc limit 20').all() as Record<
      string,
      string
    >[];
    const ci = ctx.db().prepare('select * from cache_ci_runs order by source_updated_at desc limit 10').all() as Record<
      string,
      string
    >[];
    const issues = ctx
      .db()
      .prepare('select key, status, summary from cache_jira_issues order by source_updated_at desc limit 20')
      .all() as Record<string, string>[];
    const body = [
      card(
        'Start work on a ticket',
        `<input id="t" placeholder="PROJ-123"> <select id="m"><option value="interactive">Interactive</option><option value="background">Background</option><option value="none">Folder only</option></select> <button onclick="act(this,'POST','/api/packets',{ticket:document.getElementById('t').value,launch:document.getElementById('m').value})">Open packet</button>`,
      ),
      card(
        'Ticket folders',
        table(
          ['Ticket', 'Persona', 'Tier', 'Repos', 'State'],
          packets.map((p) => [
            esc(p.ticket),
            esc(p.persona),
            esc(p.tier),
            esc(p.repos.map((r) => r.slug).join(', ')),
            esc(p.state),
          ]),
        ),
      ),
      card(
        'Jira',
        table(
          ['Key', 'Status', 'Summary'],
          issues.map((i) => [esc(i.key), esc(i.status), esc(i.summary)]),
        ),
      ),
      card(
        'Pull requests',
        table(
          ['PR', 'State', 'Review'],
          prs.map((p) => [
            `<a href="${esc(p.url)}">${esc(p.repo)}#${esc(p.number)}</a> ${esc(p.title)}`,
            esc(p.state),
            esc(p.review_decision ?? ''),
          ]),
        ),
      ),
      card(
        'CI',
        table(
          ['Repo', 'Branch', 'Result'],
          ci.map((r) => [
            esc(r.repo),
            esc(r.branch),
            `<span class="${r.status === 'failed' ? 'bad' : r.status === 'passed' ? 'ok' : 'muted'}">${esc(r.status)}</span>`,
          ]),
        ),
      ),
      card(
        'Reminders',
        table(
          ['', 'Due'],
          listReminders(ctx).map((r) => [
            `${r.url ? `<a href="${esc(r.url)}">${esc(r.title)}</a>` : esc(r.title)}`,
            `${esc(r.dueAt.slice(0, 16))} ${button('Done', 'POST', `/api/reminders/${r.id}/done`)} ${button('Snooze', 'POST', `/api/reminders/${r.id}/snooze`, { hours: 24 }, true)}`,
          ]),
        ),
      ),
    ].join('');
    return html(reply, '/', 'My work', body);
  });

  app.get('/inbox', async (_req, reply) => {
    const tasks = ctx.settings.dmInbox.enabled ? await listInbox(ctx) : [];
    return html(
      reply,
      '/inbox',
      'Inbox',
      ctx.settings.dmInbox.enabled
        ? table(
            ['Task', 'From', 'Due', ''],
            tasks.map((t) => [
              `${t.pinned ? '📌 ' : ''}${esc(t.title)} <span class="pill">${esc(t.kind)}</span>`,
              esc(t.from),
              esc(t.due ?? ''),
              `${button('Done', 'POST', `/api/inbox/${t.id}`, { state: 'done' })} ${button(t.pinned ? 'Unpin' : 'Pin', 'POST', `/api/inbox/${t.id}`, { pinned: !t.pinned }, true)} ${button('Dismiss', 'POST', `/api/inbox/${t.id}`, { state: 'dismissed' }, true)}`,
            ]),
            'No open asks. Direct messages are triaged on your machine and stored encrypted.',
          )
        : '<p class="muted">The DM inbox is off. Turn it on in Settings.</p>',
    );
  });

  app.get('/reviews', async (_req, reply) => {
    const f = listFindings(ctx).filter((x) => x.verdict !== 'pass');
    return html(
      reply,
      '/reviews',
      'Reviews',
      card(
        'Review a PRD',
        `<input id="p" placeholder="Confluence page ID"> <button onclick="act(this,'POST','/api/reviews/prd',{pageId:document.getElementById('p').value})">Review</button>`,
      ) +
        table(
          ['Subject', 'Rule', 'Finding', ''],
          f.map((x) => [
            esc(x.subject),
            `<span class="pill ${x.verdict === 'fail' ? 'bad' : 'warn'}">${esc(x.rubricId)}</span>`,
            `<blockquote class="muted">${esc(x.quote)}</blockquote>${esc(x.finding)}<br><span class="muted">${esc(x.suggestion)}</span>`,
            `${button('Accept', 'POST', `/api/findings/${x.id}`, { status: 'accepted' })} ${button('Dismiss', 'POST', `/api/findings/${x.id}`, { status: 'dismissed' }, true)}`,
          ]),
          'No open findings.',
        ),
    );
  });

  app.get('/risk', async (_req, reply) => {
    const scores = scoreCachedIssues(ctx)
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);
    return html(
      reply,
      '/risk',
      'Delivery risk',
      table(
        ['Ticket', 'Score', 'Why'],
        scores.map((s) => [esc(s.key), `${band(s.band)} ${s.score}`, esc(s.drivers.map((d) => d.detail).join('; '))]),
        'No at-risk tickets in the cache.',
      ),
    );
  });

  app.get('/oneonone', async (_req, reply) => {
    const raw = (
      ctx.db().prepare("select value from kv where key = 'hr:reports'").get() as { value: string } | undefined
    )?.value;
    const reports = raw ? (JSON.parse(raw) as { name: string; email: string; title?: string }[]) : [];
    return html(
      reply,
      '/oneonone',
      '1:1s',
      table(
        ['Name', 'Title', 'Email'],
        reports.map((r) => [esc(r.name), esc(r.title ?? ''), esc(r.email)]),
        'No direct reports found in the HR directory.',
      ) +
        '<p class="muted">Briefs and private notes: <code>orgspec 1on1 brief &lt;email&gt;</code>. Shared agendas live on restricted Confluence pages.</p>',
    );
  });

  app.get('/decisions', async (req: FastifyRequest<{ Querystring: { q?: string } }>, reply) => {
    const q = req.query.q ?? '';
    const hits = q ? searchDecisions(ctx.db(), q, 25) : [];
    return html(
      reply,
      '/decisions',
      'Decisions',
      `<form><input name="q" value="${esc(q)}" placeholder="Search decision records"> <button>Search</button></form>${
        q
          ? table(
              ['ADR', 'Repo', 'Status', 'Match'],
              hits.map((h) => [`${esc(h.adrId)} ${esc(h.title)}`, esc(h.repo), esc(h.status), esc(h.snippet)]),
            )
          : ''
      }`,
    );
  });

  app.get('/actions', async (_req, reply) => {
    const list = pending.list();
    return html(
      reply,
      '/actions',
      'Approvals',
      table(
        ['Action', 'Ticket', 'State', ''],
        list.map((a) => [
          `<pre>${esc(a.summary)}</pre>`,
          esc(a.ticket ?? ''),
          esc(a.state),
          a.state === 'pending'
            ? `${button('Approve', 'POST', `/api/actions/${a.id}/approve`)} ${button('Reject', 'POST', `/api/actions/${a.id}/reject`, undefined, true)}`
            : '',
        ]),
        'No actions waiting.',
      ),
    );
  });

  app.get('/sync', async (_req, reply) =>
    html(
      reply,
      '/sync',
      'Sync',
      table(
        ['Source', 'Status', 'Last run', 'Next run', 'Message', ''],
        scheduler
          .states()
          .map((s) => [
            esc(s.source),
            `<span class="${s.status === 'error' ? 'bad' : s.status === 'ok' ? 'ok' : 'muted'}">${esc(s.status)}</span>${s.failures ? ` <span class="warn">backing off ×${s.failures}</span>` : ''}`,
            esc(s.lastRunAt?.slice(0, 19).replace('T', ' ') ?? 'never'),
            esc(
              !s.nextRunAt
                ? 'paused (off hours)'
                : Date.parse(s.nextRunAt) <= Date.now() + 1000
                  ? 'now'
                  : new Date(s.nextRunAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            ),
            esc(s.message ?? ''),
            button('Run now', 'POST', `/api/sync/${s.source}/run`, undefined, true),
          ]),
      ),
    ),
  );

  app.get('/settings', async (_req, reply) => {
    const accounts = await ctx.gh.accounts().catch(() => []);
    const s = ctx.settings;
    const body =
      card(
        'GitHub accounts (gh)',
        table(
          ['Host', 'Login', 'Active', 'Token', ''],
          accounts.map((a) => [
            esc(a.host),
            esc(a.login),
            a.active ? '<span class="ok">active</span>' : '',
            esc(a.tokenSource ?? ''),
            `${a.active ? '' : button('Switch', 'POST', '/api/github/switch', { login: a.login, host: a.host })} ${button('Log out', 'POST', '/api/github/logout', { login: a.login, host: a.host }, true)}`,
          ]),
          'gh has no accounts. Run: orgspec github login',
        ) +
          `<p>${button('Set up git credentials', 'POST', '/api/github/setup-git', {}, true)}</p>
<h2>Automatic switching</h2><label><input type="checkbox" id="as" ${s.github.autoSwitch ? 'checked' : ''}> Switch gh to the mapped account before working in a repo</label>
<h2>Organisation → account</h2><textarea id="oa" rows="5" style="width:100%">${esc(
            Object.entries(s.github.orgAccounts)
              .map(([k, v]) => `${k} = ${v}`)
              .join('\n'),
          )}</textarea>
<p><button onclick="const m={};document.getElementById('oa').value.split('\\n').forEach(l=>{const [k,v]=l.split('=').map(x=>x&&x.trim());if(k&&v)m[k]=v});act(this,'PUT','/api/settings/github',{autoSwitch:document.getElementById('as').checked,orgAccounts:m})">Save</button></p>`,
      ) +
      card(
        'Profile',
        `<pre>${esc(JSON.stringify({ persona: s.persona, identity: s.identity, workRoot: s.workRoot, terminal: s.terminal, sendMode: s.sendMode, quietHours: s.quietHours, reminders: s.reminders, intervals: s.intervals }, null, 2))}</pre><p class="muted">Change with <code>orgspec settings</code>.</p>`,
      );
    return html(reply, '/settings', 'Settings', body);
  });

  app.get('/admin', async (_req, reply) => {
    const diags = adminCheck(ctx);
    const personas = ctx.config()?.personas ?? [];
    const body =
      card(
        'Configuration check',
        diags.length
          ? `<ul>${diags.map((d) => `<li class="${d.severity === 'error' ? 'bad' : 'warn'}">${esc(d.message)}</li>`).join('')}</ul>`
          : '<p class="ok">orgspec-config is valid and every persona’s bundle verifies.</p>',
      ) +
      card(
        'Personas',
        table(
          ['Persona', 'Version', 'Bundle', 'Available'],
          personas.map((p) => [
            esc(p.metadata.name),
            esc(p.metadata.version),
            esc(p.spec.constitution.bundle),
            esc(ctx.configDir ? bundleVersions(ctx.configDir, p.metadata.id).join(', ') : ''),
          ]),
        ),
      ) +
      card(
        'Jobs',
        table(
          ['Job', 'Kind', 'State', 'Started'],
          listJobs(ctx, 20).map((j) => [
            esc(j.id),
            esc(j.kind),
            `<span class="${j.state === 'failed' ? 'bad' : ''}">${esc(j.state)}</span>${j.error ? ` <span class="muted">${esc(j.error)}</span>` : ''}`,
            esc(j.started_at?.slice(0, 19) ?? ''),
          ]),
        ),
      );
    return html(
      reply,
      '/admin',
      'Admin',
      `${body}<p class="muted">Compile, evaluate and publish with <code>orgspec admin compile</code>, <code>orgspec admin eval</code> and <code>orgspec admin publish</code>.</p>`,
    );
  });

  await app.listen({ host: '127.0.0.1', port: o.port ?? 0 });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const info: DaemonInfo = { pid: process.pid, port, token, startedAt: new Date().toISOString() };
  writeFileAtomic(ctx.paths.daemonInfo, JSON.stringify(info));
  chmodSync(ctx.paths.daemonInfo, 0o600);

  let sock: NetServer | undefined;
  if (o.socket !== false) sock = startHookSocket(ctx.paths.socket);
  let reminderTimer: NodeJS.Timeout | undefined;
  if (o.scheduler !== false) {
    scheduler.start();
    reminderTimer = setInterval(() => void deliverReminders(ctx).catch(() => undefined), 60_000);
    reminderTimer.unref();
  }

  return {
    app,
    scheduler,
    info,
    url: `http://127.0.0.1:${port}`,
    async close() {
      scheduler.stop();
      if (reminderTimer) clearInterval(reminderTimer);
      sock?.close();
      if (existsSync(ctx.paths.socket)) rmSync(ctx.paths.socket, { force: true });
      await app.close();
      rmSync(ctx.paths.daemonInfo, { force: true });
    },
  };
}

/**
 * Unix socket for the hook's thin-client mode (`ORGSPEC_HOOK_MODE=socket`): one JSON request per
 * connection, answered by the already-warm process.
 */
export function startHookSocket(path: string): NetServer {
  if (existsSync(path)) rmSync(path, { force: true });
  const server = createServer((conn) => {
    let buf = '';
    conn.on('data', (d) => {
      buf += d.toString();
      if (!buf.includes('\n')) return;
      let out = '';
      try {
        const res = preToolUse(JSON.parse(buf.trim()));
        out = res ? JSON.stringify(res) : '';
      } catch (e) {
        out = JSON.stringify({ error: (e as Error).message });
      }
      conn.end(`${out}\n`);
    });
  });
  server.on('error', (e) => {
    // The hook falls back to in-process evaluation, so a missing socket is not fatal.
    process.stderr.write(`OrgSpec hook socket unavailable (${path}): ${e.message}\n`);
  });
  server.listen(path, () => chmodSync(path, 0o600));
  return server;
}
