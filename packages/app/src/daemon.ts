import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, rmSync } from 'node:fs';
import { createServer, type Server as NetServer } from 'node:net';
import { readJsonFile, writeFileAtomic } from '@orgspec/core';
import { pendingActions } from '@orgspec/gateway';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { AppContext } from './context.js';
import { searchDecisions } from './decisions.js';
import { preToolUse } from './hook.js';
import { listInbox } from './inbox.js';
import { listJobs } from './jobs.js';
import { createPacket, listPackets } from './packet.js';
import { computeReminders } from './reminder-rules.js';
import { completeReminder, deliverReminders, listReminders, snoozeReminder } from './reminders.js';
import { listFindings, reviewPrd, setFindingStatus } from './reviews.js';
import { executePending, scoreCachedIssues } from './risk.js';
import { Scheduler } from './scheduler.js';
import { syncJobs } from './sync.js';
import { registerTeamRoutes } from './team-pages.js';
import { registerEmRoutes } from './web/em.js';
import { registerIcRoutes } from './web/ic.js';
import { registerPmRoutes } from './web/pm.js';
import { registerSharedRoutes } from './web/shared.js';
import { registerShellRoutes } from './web/shell.js';

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
  const started = new Date().toISOString();
  registerShellRoutes(app, ctx, { started });
  registerIcRoutes(app, ctx);
  registerSharedRoutes(app, ctx);
  registerEmRoutes(app, ctx);
  registerPmRoutes(app, ctx);
  registerTeamRoutes(app, ctx);

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
    reminderTimer = setInterval(() => {
      void computeReminders(ctx)
        .catch(() => undefined)
        .then(() => deliverReminders(ctx, new Date(), { baseUrl: `http://127.0.0.1:${port}` }))
        .catch(() => undefined);
    }, 60_000);
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
