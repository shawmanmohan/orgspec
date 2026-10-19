import { join } from 'node:path';
import {
  type AppContext,
  addAgendaItem,
  addApproval,
  addWaiver,
  adminCheck,
  adminCompile,
  adminEval,
  adminPublish,
  adminRollback,
  bundleVersions,
  cleanupPacket,
  completeReminder,
  createPacket,
  doctor,
  executePending,
  indexDecisions,
  installService,
  listDecisions,
  listFindings,
  listInbox,
  listPackets,
  listReminders,
  loadPeople,
  loadRoles,
  newDecision,
  planTasks,
  prepareBrief,
  privateNotes,
  readDaemonInfo,
  renderManagedSettings,
  reviewDesign,
  reviewPrd,
  rolesDirectory,
  roster,
  runCheck,
  runGateway,
  Scheduler,
  savePrivateNote,
  scoreCachedIssues,
  searchDecisions,
  setup,
  snoozeReminder,
  startDaemon,
  summarizeSlack,
  syncDmInbox,
  syncJobs,
  updateInboxTask,
} from '@orgspec/app';
import { GATEWAY_CONFIG, interactiveCommand, openTerminal } from '@orgspec/claude';
import { describeDiff, diffRules, loadBundle } from '@orgspec/constitution';
import { DEFAULT_SYNC, isDuration } from '@orgspec/core';
import { authorizeServer, pendingActions, waitForAuthCode } from '@orgspec/gateway';
import { remoteOwner } from '@orgspec/integrations';
import { type Diagnostic, error, loadChange, type Workspace } from '@orgspec/spec-engine';
import { type Command, Option } from 'commander';
import type { IO } from './run.js';

export interface CommandHelpers {
  io: IO;
  opts: () => { json: boolean; cwd: string };
  workspace: () => Workspace;
  emit: (payload: Record<string, unknown>, human: () => string, diagnostics?: readonly Diagnostic[]) => void;
  context: () => AppContext;
  /** Long-running commands (daemon, gateway) keep the process alive. */
  keepAlive: (close: () => Promise<void>, o?: { untilStdinEnds?: boolean }) => Promise<void>;
  setExit: (code: number) => void;
}

const openBrowser = async (ctx: AppContext, url: string) => {
  await ctx.runner(process.platform === 'darwin' ? 'open' : 'xdg-open', [url]);
};

const list = (v: string, prev: string[] = []) => [...prev, v];
const fromDiags = (lines: readonly { name: string; ok: boolean; detail: string; fix?: string }[]) =>
  lines
    .filter((c) => !c.ok)
    .map((c) =>
      error(
        `doctor_${c.name.toLowerCase().replace(/\W+/g, '_')}`,
        `${c.name}: ${c.detail}`,
        c.fix ? { fix: c.fix } : {},
      ),
    );

export function registerAppCommands(program: Command, h: CommandHelpers): void {
  const { emit, context: ctx } = h;

  // ---------- setup & health ----------
  program
    .command('setup')
    .description('clone orgspec-config with gh, record your identity and pick a persona')
    .option('--config <owner/repo>', 'orgspec-config repository')
    .option('--config-dir <path>', 'existing local checkout of orgspec-config')
    .option('--persona <id>', 'persona to use')
    .option('--email <email>', 'your work email (for HR, Jira and 1:1s)')
    .action(async (o: { config?: string; configDir?: string; persona?: string; email?: string }) => {
      const r = await setup(ctx(), {
        ...(o.config ? { configRemote: o.config } : {}),
        ...(o.configDir ? { configDir: o.configDir } : {}),
        ...(o.persona ? { persona: o.persona } : {}),
        ...(o.email ? { email: o.email } : {}),
      });
      emit(r, () =>
        [
          `orgspec-config: ${r.configDir}`,
          `Persona: ${r.persona ?? 'not chosen'} (eligible: ${r.eligible.join(', ') || 'none'})`,
          ...r.notes,
        ].join('\n'),
      );
    });

  program
    .command('doctor')
    .description('check Node, Claude Code, gh, keychain, config, bundle, MCP servers and managed settings')
    .action(async () => {
      const checks = await doctor(ctx());
      const failed = fromDiags(checks);
      emit(
        { checks },
        () =>
          checks
            .map(
              (c) =>
                `${c.ok ? 'ok  ' : 'FAIL'}  ${c.name.padEnd(20)} ${c.detail}${!c.ok && c.fix ? `\n      fix: ${c.fix}` : ''}`,
            )
            .join('\n'),
        h.opts().json ? failed : [],
      );
      if (failed.length) h.setExit(1);
    });

  program
    .command('managed-settings')
    .description('print the Claude Code managed settings IT installs on every machine')
    .option('--bin <path>', 'path to the orgspec executable', 'orgspec')
    .action((o: { bin: string }) => {
      const s = renderManagedSettings({ orgspecBin: o.bin });
      h.io.out(`${JSON.stringify(s, null, 2)}\n`);
    });

  // ---------- Claude Code integration ----------
  program
    .command('hook')
    .description('Claude Code hook entry (pre-tool-use, checkpoint, restore, session-end)')
    .argument('<event>')
    .option('--reason <reason>')
    .action(async (event: string, o: { reason?: string }) => {
      const { runHook } = await import('@orgspec/app');
      await runHook(event, o.reason ? ['--reason', o.reason] : [], h.io);
    });

  program
    .command('gateway')
    .description('run the OrgSpec MCP gateway (started by Claude Code)')
    .option('--stdio', 'serve over stdin/stdout', true)
    .option('--session <id>')
    .action(async (o: { session?: string }) => {
      const gw = await runGateway(ctx(), { ...(o.session ? { session: o.session } : {}), cwd: h.opts().cwd });
      await h.keepAlive(() => gw.close(), { untilStdinEnds: true });
    });

  program
    .command('connect')
    .description('sign in to an MCP server (OAuth in your browser; tokens go to the keychain)')
    .argument('<server>')
    .action(async (server: string) => {
      const c = ctx();
      const cfg = c.config()?.integrations.servers[server];
      if (!cfg) throw new Error(`${server} is not in integrations.yaml`);
      const tools = await authorizeServer(
        c.keyStore,
        server,
        cfg,
        (u) => openBrowser(c, u.toString()),
        () => waitForAuthCode(),
      );
      emit({ server, tools }, () => `Connected to ${server} (${tools} tools).`);
    });

  // ---------- ticket packets ----------
  program
    .command('packet')
    .description('create a ticket folder with worktrees and start Claude Code in it')
    .argument('<jira>')
    .option('--repo <owner/name>', 'repository (repeatable; default: all configured)', list)
    .addOption(new Option('--launch <mode>', 'how to start Claude Code').choices(['interactive', 'background', 'none']))
    .option('--base <ref>', 'base ref for new branches')
    .option('--persona <id>')
    .action(
      async (
        jira: string,
        o: { repo?: string[]; launch?: 'interactive' | 'background' | 'none'; base?: string; persona?: string },
      ) => {
        const c = ctx();
        const p = await createPacket(c, {
          ticket: jira,
          launch: o.launch ?? c.settings.sendMode,
          ...(o.repo ? { repos: o.repo } : {}),
          ...(o.base ? { base: o.base } : {}),
          ...(o.persona ? { persona: o.persona } : {}),
        });
        emit(
          { folder: p.folder, session: p.session, warnings: p.warnings, claudeSession: p.claudeSession ?? null },
          () =>
            [
              `Ticket folder: ${p.folder}`,
              ...p.session.repos.map((r) => `  ${r.slug} → ${r.path} (${r.branch})`),
              ...p.warnings.map((w) => `warning: ${w}`),
              p.claudeSession
                ? `Background session ${p.claudeSession}`
                : p.terminalScript
                  ? 'Opened Claude Code in a new terminal.'
                  : '',
            ]
              .filter(Boolean)
              .join('\n'),
        );
      },
    );

  program
    .command('packets')
    .description('list ticket folders')
    .action(() => {
      const ps = listPackets(ctx());
      emit({ packets: ps }, () =>
        ps.length
          ? ps
              .map(
                (p) =>
                  `${p.ticket.padEnd(14)} ${p.state.padEnd(7)} ${p.persona.padEnd(12)} ${p.repos.map((r) => r.slug).join(', ')}`,
              )
              .join('\n')
          : 'No ticket folders.',
      );
    });

  program
    .command('resume')
    .description('reopen Claude Code in a ticket folder (it restores the last checkpoint)')
    .argument('<jira>')
    .action((jira: string) => {
      const c = ctx();
      const folder = join(c.workRoot, jira);
      const script = openTerminal({
        app: c.settings.terminal,
        cwd: folder,
        command: [
          ...interactiveCommand('orgspec-engineer', undefined, { mcpConfig: join(folder, GATEWAY_CONFIG) }),
          '--continue',
        ],
        scriptDir: c.paths.packets,
        name: `${jira}-resume`,
      });
      emit({ folder, script }, () => `Resumed ${jira} in a new terminal.`);
    });

  program
    .command('cleanup')
    .description('remove a ticket folder and its worktrees (keeps the action log)')
    .argument('<jira>')
    .option('--force', 'remove even with uncommitted changes')
    .action(async (jira: string, o: { force?: boolean }) => {
      const r = await cleanupPacket(ctx(), jira, o);
      emit(r, () => `Removed ${r.removed.length} path(s); log kept in ${r.kept}`);
    });

  const session = program.command('session').description('background Claude Code sessions');
  session.command('list').action(async () => {
    const c = ctx();
    const list = await c.sessions.list(c.workRoot);
    emit({ sessions: list }, () =>
      list.length
        ? list.map((s) => `${s.id}  ${s.status.padEnd(10)} ${s.name ?? ''} ${s.cwd ?? ''}`).join('\n')
        : 'No sessions.',
    );
  });
  for (const verb of ['logs', 'stop', 'respawn', 'rm'] as const) {
    session
      .command(verb)
      .argument('<id>')
      .action(async (id: string) => {
        const s = ctx().sessions;
        const out =
          verb === 'logs'
            ? await s.logs(id)
            : verb === 'stop'
              ? await s.stop(id)
              : verb === 'respawn'
                ? await s.respawn(id)
                : await s.remove(id);
        emit({ id, output: out }, () => out.trim() || `${verb} ${id}: done`);
      });
  }
  session
    .command('attach')
    .argument('<id>')
    .action((id: string) => {
      const c = ctx();
      openTerminal({
        app: c.settings.terminal,
        cwd: c.workRoot,
        command: c.sessions.attachCommand(id),
        scriptDir: c.paths.packets,
        name: `attach-${id}`,
      });
      emit({ id }, () => `Attached to ${id} in a new terminal.`);
    });

  // ---------- CI ----------
  program
    .command('check')
    .description('the CI gate: strict validation, trace, tier floor, approvals and compiled CI rules')
    .option('--base <ref>', 'ref the PR merges into', 'origin/main')
    .option('--config <dir>', 'orgspec-config checkout (default: your settings)')
    .option('--persona <id>', 'persona whose bundle CI enforces', 'engineer')
    .option('--change <id>', 'only this change (repeatable)', list)
    .option('--repo <owner/name>', 'repository slug, for waivers')
    .option('--author <login>', 'PR author, who cannot approve their own artifacts')
    .action(
      async (o: {
        base: string;
        config?: string;
        persona: string;
        change?: string[];
        repo?: string;
        author?: string;
      }) => {
        const c = ctx();
        const ws = h.workspace();
        const configDir = o.config ?? c.configDir;
        let bundle: ReturnType<typeof loadBundle>['bundle'];
        const diags: Diagnostic[] = [];
        let waivers = c.config()?.waivers ?? [];
        if (configDir) {
          const { loadOrgConfig } = await import('@orgspec/core');
          const cfg = loadOrgConfig(configDir);
          waivers = cfg.waivers;
          const p = cfg.personas.find((x) => x.metadata.id === o.persona);
          if (!p) diags.push(error('check_persona', `Persona ${o.persona} is not in ${configDir}`));
          else {
            const r = loadBundle(join(configDir, p.spec.constitution.bundle), p.spec.constitution.sha256);
            bundle = r.bundle;
            diags.push(...r.diagnostics);
          }
        }
        const remote = remoteOwner(await c.git.remoteUrl(ws.repoRoot).catch(() => ''));
        const repo = o.repo ?? (remote ? `${remote.owner}/${remote.repo}` : undefined);
        const directory = rolesDirectory(loadRoles(configDir), async (sha) =>
          repo ? c.gh.commitAuthor(repo, sha).catch(() => undefined) : undefined,
        );
        const report = await runCheck({
          ws,
          git: c.git,
          base: o.base,
          ...(bundle ? { bundle } : {}),
          waivers,
          directory,
          ...(o.author ? { author: o.author } : {}),
          ...(repo ? { repo } : {}),
          ...(o.change ? { changes: o.change } : {}),
        });
        const all = [...diags, ...report.diagnostics, ...report.changes.flatMap((x) => x.diagnostics)];
        emit(
          { report },
          () =>
            [
              `orgspec check against ${o.base}: ${report.diffPaths.length} changed file(s)${report.bundle ? `, constitution ${report.bundle.persona} ${report.bundle.version}` : ''}`,
              ...report.changes.map((x) => `  ${x.id} (tier ${x.tier ?? '?'}, needs ${x.requiredTier})`),
            ].join('\n'),
          all,
        );
      },
    );

  program
    .command('approve')
    .description('approve an artifact’s current content (commit approvals.yaml yourself)')
    .argument('<change>')
    .argument('<artifact>', 'for example design.md or specs/payments/retries/spec.md')
    .option('--role <role>')
    .option('--note <text>')
    .action(async (id: string, artifact: string, o: { role?: string; note?: string }) => {
      const c = ctx();
      const login = (await c.gh.activeAccount())?.login ?? c.settings.identity.githubLogin;
      if (!login) throw new Error('gh is not signed in; run orgspec github login');
      const e = addApproval(loadChange(h.workspace(), id), {
        artifact,
        approver: login,
        ...(o.role ? { role: o.role } : {}),
        ...(o.note ? { note: o.note } : {}),
      });
      emit(
        { approval: e },
        () =>
          `Approved ${artifact} (${e.sha256.slice(0, 15)}…) as ${login}. Commit approvals.yaml with your own account.`,
      );
    });

  // ---------- decisions ----------
  const decision = program.command('decision').description('decision records (ADRs)');
  decision
    .command('new')
    .argument('<title>')
    .option('--path <glob>', 'paths the decision covers (repeatable)', list)
    .option('--capability <id>', 'capabilities it covers (repeatable)', list)
    .option('--change <id>')
    .option('--decider <login>', 'repeatable', list)
    .action((title: string, o: { path?: string[]; capability?: string[]; change?: string; decider?: string[] }) => {
      const file = newDecision(h.workspace(), {
        title,
        ...(o.path ? { paths: o.path } : {}),
        ...(o.capability ? { capabilities: o.capability } : {}),
        ...(o.change ? { change: o.change } : {}),
        ...(o.decider ? { deciders: o.decider } : {}),
      });
      emit({ file }, () => `Created ${file}`);
    });
  decision
    .command('index')
    .description('index this repo’s decision records for search')
    .action(async () => {
      const c = ctx();
      const ws = h.workspace();
      const remote = remoteOwner(await c.git.remoteUrl(ws.repoRoot).catch(() => ''));
      const repo = remote ? `${remote.owner}/${remote.repo}` : ws.repoRoot;
      const n = indexDecisions(c.db(), repo, listDecisions(ws, repo));
      emit({ repo, indexed: n }, () => `Indexed ${n} decision record(s) for ${repo}.`);
    });
  decision
    .command('search')
    .argument('<query...>')
    .action((q: string[]) => {
      const hits = searchDecisions(ctx().db(), q.join(' '), 20);
      emit({ hits }, () =>
        hits.length
          ? hits.map((x) => `${x.adrId}  ${x.title}  [${x.status}] ${x.repo}:${x.file}\n    ${x.snippet}`).join('\n')
          : 'No matches.',
      );
    });

  // ---------- reviews ----------
  const review = program.command('review').description('rubric reviews run by claude -p');
  review
    .command('prd')
    .argument('<pageId>', 'Confluence page ID')
    .action(async (pageId: string) => {
      const r = await reviewPrd(ctx(), pageId);
      emit({ ...r }, () =>
        [
          `${r.title} v${r.version}: ${r.summary}`,
          ...r.findings
            .filter((f) => f.verdict !== 'pass')
            .map((f) => `  ${f.verdict.toUpperCase()} ${f.rubricId}: ${f.finding}\n    > ${f.quote}`),
          r.dropped.length ? `  (${r.dropped.length} ungrounded finding(s) dropped)` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      );
    });
  review
    .command('design')
    .argument('<change>')
    .action(async (id: string) => {
      const r = await reviewDesign(ctx(), h.workspace(), id);
      emit({ ...r }, () =>
        [
          `${id}: ${r.summary}`,
          ...r.findings
            .filter((f) => f.verdict !== 'pass')
            .map((f) => `  ${f.verdict.toUpperCase()} ${f.rubricId}: ${f.finding}`),
          'Wrote findings.md',
        ].join('\n'),
      );
    });
  program
    .command('plan')
    .description('break a reviewed design into tasks.md')
    .argument('<change>')
    .option('--force', 'replace an existing tasks.md')
    .action(async (id: string, o: { force?: boolean }) => {
      const r = await planTasks(ctx(), h.workspace(), id, o);
      emit(r, () => `Wrote ${r.count} task group(s) to ${r.file}`);
    });
  program
    .command('findings')
    .description('open review findings')
    .argument('[subject]')
    .action((subject?: string) => {
      const f = listFindings(ctx(), subject).filter((x) => x.verdict !== 'pass');
      emit({ findings: f }, () =>
        f.length
          ? f.map((x) => `${x.id}  ${x.subject}  ${x.rubricId}  ${x.status}\n    ${x.finding}`).join('\n')
          : 'No open findings.',
      );
    });

  // ---------- inbox, Slack, risk ----------
  const inbox = program.command('inbox').description('asks from your direct messages (stored encrypted)');
  inbox.command('list', { isDefault: true }).action(async () => {
    const t = await listInbox(ctx());
    emit({ tasks: t }, () =>
      t.length
        ? t
            .map((x) => `${x.id}  ${x.pinned ? '*' : ' '} ${x.title}  (${x.from}${x.due ? `, due ${x.due}` : ''})`)
            .join('\n')
        : 'Inbox is clear.',
    );
  });
  inbox.command('sync').action(async () => {
    const r = await syncDmInbox(ctx());
    emit(r, () => `${r.conversations} conversation(s), ${r.messages} new message(s), ${r.tasks} new task(s)`);
  });
  for (const state of ['done', 'dismissed', 'open'] as const) {
    inbox
      .command(state === 'open' ? 'reopen' : state === 'done' ? 'done' : 'dismiss')
      .argument('<id>')
      .action((id: string) => {
        updateInboxTask(ctx(), id, { state });
        emit({ id, state }, () => `${id}: ${state}`);
      });
  }
  program
    .command('summarize')
    .description('summarise a Slack channel or thread')
    .argument('<channel>')
    .option('--since <ts>', 'Slack timestamp to start from')
    .option('--thread <ts>')
    .action(async (channel: string, o: { since?: string; thread?: string }) => {
      const s = await summarizeSlack(ctx(), {
        channel,
        ...(o.since ? { since: o.since } : {}),
        ...(o.thread ? { thread: o.thread } : {}),
      });
      emit(s, () =>
        [
          s.summary,
          ...s.decisions.map((d) => `  decision: ${d.text}${d.by ? ` (${d.by})` : ''}`),
          ...s.questions.map((q) => `  question: ${q.text}`),
          ...s.followUps.map((f) => `  follow-up: ${f.text}${f.owner ? ` → ${f.owner}` : ''}`),
        ].join('\n'),
      );
    });
  program
    .command('risk')
    .description('delivery risk for cached tickets')
    .option('--program <epic>')
    .action((o: { program?: string }) => {
      const s = scoreCachedIssues(ctx(), o.program)
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score);
      emit({ scores: s }, () =>
        s.length
          ? s
              .map(
                (x) =>
                  `${x.key.padEnd(12)} ${x.band.padEnd(6)} ${String(x.score).padStart(3)}  ${x.drivers.map((d) => d.detail).join('; ')}`,
              )
              .join('\n')
          : 'No risky tickets in the cache (run orgspec sync jira.programs).',
      );
    });

  // ---------- 1:1s ----------
  const one = program.command('1on1').description('1:1 roster, briefs, shared agendas and private notes');
  const findReport = async (email: string) => {
    const r = (await roster(ctx())).find((x) => x.email === email);
    if (!r) throw new Error(`${email} is not one of your direct reports`);
    return r;
  };
  one.command('roster').action(async () => {
    const r = await roster(ctx());
    emit({ roster: r }, () =>
      r.length
        ? r.map((x) => `${x.name.padEnd(24)} ${x.email.padEnd(30)} ${x.pageId ? 'agenda page' : ''}`).join('\n')
        : 'No direct reports.',
    );
  });
  one
    .command('brief')
    .argument('<email>')
    .action(async (email: string) => {
      const b = await prepareBrief(ctx(), await findReport(email));
      emit(b, () =>
        [
          ...b.highlights.map((x) => `+ ${x.text} (${x.source})`),
          ...b.blockers.map((x) => `! ${x.text} (${x.source})`),
          ...b.talkingPoints.map((t) => `? ${t}`),
        ].join('\n'),
      );
    });
  one
    .command('agenda')
    .argument('<email>')
    .argument('<item...>')
    .action(async (email: string, item: string[]) => {
      const v = await addAgendaItem(ctx(), await findReport(email), item.join(' '));
      emit({ version: v }, () => `Added to the shared agenda (page version ${v}).`);
    });
  one
    .command('note')
    .argument('<email>')
    .argument('<text...>')
    .action(async (email: string, text: string[]) => {
      const id = await savePrivateNote(ctx(), email, text.join(' '));
      emit({ id }, () => 'Saved a private note (encrypted, this machine only).');
    });
  one
    .command('notes')
    .argument('<email>')
    .action(async (email: string) => {
      const n = await privateNotes(ctx(), email);
      emit({ notes: n }, () =>
        n.length ? n.map((x) => `${x.updatedAt.slice(0, 10)}  ${x.text}`).join('\n') : 'No notes.',
      );
    });

  // ---------- approvals of pending actions, reminders ----------
  const actions = program.command('actions').description('actions waiting for your approval');
  actions.command('list', { isDefault: true }).action(() => {
    const a = pendingActions(ctx().db()).list('pending');
    emit({ actions: a }, () =>
      a.length
        ? a.map((x) => `${x.id}  ${x.ticket ?? ''}\n${x.summary.replace(/^/gm, '    ')}`).join('\n')
        : 'Nothing waiting.',
    );
  });
  actions
    .command('approve')
    .argument('<id>')
    .action(async (id: string) => {
      const c = ctx();
      const p = pendingActions(c.db());
      const a = p.get(id);
      if (!a) throw new Error(`No action ${id}`);
      p.decide(id, true);
      if (!a.persona) {
        const r = await executePending(c, id);
        emit({ id, ...r }, () => (r.ok ? `Approved and ran ${id}.` : `Approved ${id}, but it failed: ${r.result}`));
      } else emit({ id }, () => `Approved ${id}. Claude Code will run it when it calls run_pending.`);
    });
  actions
    .command('reject')
    .argument('<id>')
    .action((id: string) => {
      pendingActions(ctx().db()).decide(id, false);
      emit({ id }, () => `Rejected ${id}.`);
    });

  const rem = program.command('reminders').description('your reminders');
  rem.command('list', { isDefault: true }).action(() => {
    const r = listReminders(ctx());
    emit({ reminders: r }, () =>
      r.length ? r.map((x) => `${x.id}  ${x.dueAt.slice(0, 16)}  ${x.title}`).join('\n') : 'No reminders.',
    );
  });
  rem
    .command('done')
    .argument('<id>')
    .action((id: string) => {
      completeReminder(ctx(), id);
      emit({ id }, () => `Done: ${id}`);
    });
  rem
    .command('snooze')
    .argument('<id>')
    .option('--hours <n>', 'hours', '24')
    .action((id: string, o: { hours: string }) => {
      snoozeReminder(ctx(), id, new Date(Date.now() + Number(o.hours) * 3_600_000).toISOString());
      emit({ id }, () => `Snoozed ${id} for ${o.hours}h.`);
    });

  // ---------- sync & local service ----------
  program
    .command('sync')
    .description('show sync status, or run one source now')
    .argument('[source]')
    .action(async (source?: string) => {
      const c = ctx();
      const s = new Scheduler({
        db: c.db(),
        sync: c.config()?.sync ?? {
          workingHours: { start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5] },
          sources: {},
        },
        personal: c.settings.intervals,
        jobs: syncJobs(c),
      });
      if (source) {
        if (!(source in syncJobs(c)))
          throw new Error(`Unknown source ${source}. Sources: ${Object.keys(DEFAULT_SYNC).join(', ')}`);
        await s.runSource(source);
      }
      const states = source ? [s.state(source)] : s.states();
      emit(
        { sources: states },
        () =>
          states
            .map(
              (x) =>
                `${x.source.padEnd(20)} ${x.status.padEnd(8)} ${x.lastRunAt?.slice(0, 19) ?? 'never'}  ${x.message ?? ''}`,
            )
            .join('\n'),
        states.filter((x) => x.status === 'error').map((x) => error('sync_failed', `${x.source}: ${x.message}`)),
      );
    });

  program
    .command('daemon')
    .description('run the local service (sync, reminders, dashboard, hook socket)')
    .option('--port <n>', 'port on 127.0.0.1 (default: any free port)')
    .action(async (o: { port?: string }) => {
      const d = await startDaemon(ctx(), o.port ? { port: Number(o.port) } : {});
      h.io.err(`OrgSpec daemon on ${d.url} (pid ${process.pid})\n`);
      await h.keepAlive(() => d.close());
    });

  program
    .command('dashboard')
    .description('open the dashboard in your browser')
    .action(async () => {
      const c = ctx();
      const info = readDaemonInfo(c);
      if (!info) throw new Error('The daemon is not running; start it with orgspec daemon or orgspec service install');
      const url = `http://127.0.0.1:${info.port}/login?token=${info.token}`;
      await openBrowser(c, url);
      emit({ url: `http://127.0.0.1:${info.port}` }, () => `Opened http://127.0.0.1:${info.port}`);
    });

  program
    .command('service')
    .description('start the daemon at login (launchd or systemd)')
    .argument('<action>', 'install')
    .action(async (action: string) => {
      if (action !== 'install') throw new Error('Only "install" is supported');
      const bin = process.execPath.endsWith('orgspec')
        ? [process.execPath]
        : [process.execPath, process.argv[1] ?? 'orgspec'];
      const file = await installService(ctx(), bin);
      emit({ file }, () => `Installed ${file}`);
    });

  // ---------- settings ----------
  const settings = program.command('settings').description('your local settings');
  settings.command('show', { isDefault: true }).action(() => {
    const s = ctx().settings;
    emit({ settings: s }, () => JSON.stringify(s, null, 2));
  });
  settings
    .command('persona')
    .argument('<id>')
    .action((id: string) => {
      const c = ctx();
      if (!c.persona(id)) throw new Error(`Persona ${id} is not in orgspec-config`);
      c.updateSettings((s) => ({ ...s, persona: id }));
      emit({ persona: id }, () => `Persona: ${id}`);
    });
  settings
    .command('identity')
    .option('--email <email>')
    .option('--github <login>')
    .option('--jira <accountId>')
    .option('--slack <userId>')
    .option('--timezone <tz>')
    .action((o: { email?: string; github?: string; jira?: string; slack?: string; timezone?: string }) => {
      const s = ctx().updateSettings((x) => ({
        ...x,
        identity: {
          ...x.identity,
          ...(o.email ? { email: o.email } : {}),
          ...(o.github ? { githubLogin: o.github } : {}),
          ...(o.jira ? { jiraAccountId: o.jira } : {}),
          ...(o.slack ? { slackUserId: o.slack } : {}),
          ...(o.timezone ? { timezone: o.timezone } : {}),
        },
      }));
      emit({ identity: s.identity }, () => JSON.stringify(s.identity, null, 2));
    });
  const repo = settings.command('repo').description('repositories you work in');
  repo
    .command('add')
    .argument('<owner/name>')
    .option('--path <dir>', 'existing local clone')
    .option('--host <host>', 'GitHub host', 'github.com')
    .action((slug: string, o: { path?: string; host: string }) => {
      const s = ctx().updateSettings((x) => ({
        ...x,
        repos: [...x.repos.filter((r) => r.slug !== slug), { slug, host: o.host, ...(o.path ? { path: o.path } : {}) }],
      }));
      emit({ repos: s.repos }, () => `Repos: ${s.repos.map((r) => r.slug).join(', ')}`);
    });
  repo
    .command('rm')
    .argument('<owner/name>')
    .action((slug: string) => {
      const s = ctx().updateSettings((x) => ({ ...x, repos: x.repos.filter((r) => r.slug !== slug) }));
      emit({ repos: s.repos }, () => `Repos: ${s.repos.map((r) => r.slug).join(', ') || 'none'}`);
    });
  settings
    .command('interval')
    .description('your own polling interval for a source the admin lets you tune')
    .argument('<source>')
    .argument('<duration>', 'for example 1m or 10m; "default" to reset')
    .action((source: string, duration: string) => {
      const c = ctx();
      const cfg = c.config()?.sync.sources[source] ?? DEFAULT_SYNC[source];
      if (!cfg) throw new Error(`Unknown source ${source}`);
      if (duration !== 'default') {
        if (!cfg.personal)
          throw new Error(`${source} uses the admin interval (${cfg.every}); it cannot be changed per person`);
        if (!isDuration(duration)) throw new Error('Use a duration such as 2m or 15m');
      }
      const s = c.updateSettings((x) => {
        const intervals = { ...x.intervals };
        if (duration === 'default') delete intervals[source];
        else intervals[source] = duration;
        return { ...x, intervals };
      });
      emit(
        { intervals: s.intervals },
        () => `${source}: ${s.intervals[source] ?? `${cfg.every} (default)`} (allowed ${cfg.min}–${cfg.max})`,
      );
    });
  settings
    .command('quiet-hours')
    .argument('<start>', 'HH:MM')
    .argument('<end>', 'HH:MM')
    .action((start: string, end: string) => {
      const s = ctx().updateSettings((x) => ({ ...x, quietHours: { start, end } }));
      emit({ quietHours: s.quietHours }, () => `Quiet hours ${start}–${end}`);
    });
  settings
    .command('terminal')
    .argument('<app>', 'Terminal, iTerm2 or Ghostty')
    .action((app: string) => {
      const s = ctx().updateSettings((x) => ({ ...x, terminal: app as typeof x.terminal }));
      emit({ terminal: s.terminal }, () => `Terminal: ${s.terminal}`);
    });
  settings
    .command('send-mode')
    .argument('<mode>', 'background or interactive')
    .action((mode: string) => {
      const s = ctx().updateSettings((x) => ({ ...x, sendMode: mode as typeof x.sendMode }));
      emit({ sendMode: s.sendMode }, () => `Packets start ${s.sendMode}`);
    });
  settings
    .command('dm-inbox')
    .argument('<on|off>')
    .option('--exclude <conversation>', 'conversation or user ID to skip (repeatable)', list)
    .action((v: string, o: { exclude?: string[] }) => {
      const s = ctx().updateSettings((x) => ({
        ...x,
        dmInbox: { enabled: v === 'on', excluded: o.exclude ?? x.dmInbox.excluded },
      }));
      emit({ dmInbox: s.dmInbox }, () => `DM inbox ${s.dmInbox.enabled ? 'on' : 'off'}`);
    });
  settings
    .command('reminders')
    .argument('<mode>', 'digest or dm')
    .option('--at <HH:MM>', 'digest time')
    .action((mode: string, o: { at?: string }) => {
      const s = ctx().updateSettings((x) => ({
        ...x,
        reminders: { mode: mode as 'digest' | 'dm', digestAt: o.at ?? x.reminders.digestAt },
      }));
      emit({ reminders: s.reminders }, () => `Reminders: ${s.reminders.mode} at ${s.reminders.digestAt}`);
    });
  settings
    .command('jira')
    .option('--project <key>', 'project to follow (repeatable)', list)
    .option('--program-jql <jql>')
    .option('--prd-label <label>')
    .action((o: { project?: string[]; programJql?: string; prdLabel?: string }) => {
      const s = ctx().updateSettings((x) => ({
        ...x,
        jira: {
          ...x.jira,
          ...(o.project ? { projects: o.project } : {}),
          ...(o.programJql ? { programJql: o.programJql } : {}),
          ...(o.prdLabel ? { prdLabel: o.prdLabel } : {}),
        },
      }));
      emit({ jira: s.jira }, () => JSON.stringify(s.jira, null, 2));
    });

  // ---------- GitHub accounts via gh ----------
  const github = program.command('github').description('GitHub accounts through gh');
  github.command('status', { isDefault: true }).action(async () => {
    const c = ctx();
    const accounts = await c.gh.accounts();
    emit({ accounts, autoSwitch: c.settings.github.autoSwitch, orgAccounts: c.settings.github.orgAccounts }, () =>
      [
        ...(accounts.length
          ? accounts.map(
              (a) =>
                `${a.active ? '*' : ' '} ${a.login.padEnd(20)} ${a.host.padEnd(16)} ${a.state} ${a.tokenSource ?? ''}`,
            )
          : ['gh has no accounts; run orgspec github login']),
        '',
        `Automatic switching: ${c.settings.github.autoSwitch ? 'on' : 'off'}`,
        ...Object.entries(c.settings.github.orgAccounts).map(([k, v]) => `  ${k} → ${v}`),
      ].join('\n'),
    );
  });
  github
    .command('switch')
    .argument('<login>')
    .option('--host <host>', 'GitHub host', 'github.com')
    .action(async (login: string, o: { host: string }) => {
      await ctx().gh.switch(login, o.host);
      emit({ login, host: o.host }, () => `gh now uses ${login} on ${o.host}`);
    });
  github
    .command('login')
    .option('--host <host>', 'GitHub host', 'github.com')
    .action((o: { host: string }) => {
      const c = ctx();
      openTerminal({
        app: c.settings.terminal,
        cwd: c.paths.home,
        command: c.gh.loginCommand(o.host),
        scriptDir: c.paths.packets,
        name: 'gh-login',
      });
      emit({ host: o.host }, () => 'Opened gh auth login in a new terminal; finish the browser sign-in there.');
    });
  github
    .command('logout')
    .argument('<login>')
    .option('--host <host>', 'GitHub host', 'github.com')
    .action(async (login: string, o: { host: string }) => {
      await ctx().gh.logout(login, o.host);
      emit({ login }, () => `Logged out ${login} from ${o.host}`);
    });
  github
    .command('setup-git')
    .option('--host <host>', 'GitHub host', 'github.com')
    .action(async (o: { host: string }) => {
      await ctx().gh.setupGit(o.host);
      emit({ host: o.host }, () => `git now uses gh for ${o.host} credentials`);
    });
  github
    .command('map')
    .description('use a gh account for an organisation')
    .argument('<org>', 'owner, or host/owner')
    .argument('<login>')
    .action((org: string, login: string) => {
      const key = org.includes('/') ? org : `github.com/${org}`;
      const s = ctx().updateSettings((x) => ({
        ...x,
        github: { ...x.github, orgAccounts: { ...x.github.orgAccounts, [key]: login } },
      }));
      emit({ orgAccounts: s.github.orgAccounts }, () => `${key} → ${login}`);
    });
  github
    .command('unmap')
    .argument('<org>')
    .action((org: string) => {
      const key = org.includes('/') ? org : `github.com/${org}`;
      const s = ctx().updateSettings((x) => {
        const orgAccounts = { ...x.github.orgAccounts };
        delete orgAccounts[key];
        delete orgAccounts[org];
        return { ...x, github: { ...x.github, orgAccounts } };
      });
      emit({ orgAccounts: s.github.orgAccounts }, () => `Removed ${key}`);
    });
  github
    .command('auto-switch')
    .argument('<on|off>')
    .action((v: string) => {
      const s = ctx().updateSettings((x) => ({ ...x, github: { ...x.github, autoSwitch: v === 'on' } }));
      emit({ autoSwitch: s.github.autoSwitch }, () => `Automatic switching ${s.github.autoSwitch ? 'on' : 'off'}`);
    });

  // ---------- admin ----------
  const admin = program.command('admin').description('constitution and org configuration (process owners)');
  admin.command('check').action(() => {
    const d = adminCheck(ctx());
    emit({}, () => (d.length ? '' : 'orgspec-config is valid.'), d);
  });
  admin.command('compile').action(async () => {
    const r = await adminCompile(ctx());
    const dropped = r.overlays.flatMap((o) => o.dropped);
    emit(
      {
        bundles: r.bundles.map((b) => ({
          persona: b.persona,
          version: b.version,
          dir: b.dir,
          sha256: b.manifest.sha256,
        })),
        diffs: r.diffs,
        dropped,
      },
      () =>
        [
          ...r.diffs.map((d) => `${d.persona}: ${d.from ?? 'none'} → ${d.to}\n${d.summary.replace(/^/gm, '  ')}`),
          dropped.length ? `${dropped.length} candidate rule(s) dropped (ungrounded or invalid)` : '',
          r.bundles.length ? 'Run orgspec admin eval, then orgspec admin publish.' : 'Nothing written.',
        ]
          .filter(Boolean)
          .join('\n'),
      r.diagnostics,
    );
  });
  admin
    .command('eval')
    .option('--bundle <persona=version>', 'evaluate a specific bundle (repeatable)', list)
    .action((o: { bundle?: string[] }) => {
      const versions = Object.fromEntries((o.bundle ?? []).map((v) => v.split('=') as [string, string]));
      const r = adminEval(ctx(), versions);
      emit(
        r,
        () =>
          [
            `${r.passed} passed, ${r.failed.length} failed`,
            ...r.failed.map((f) => `  ${f.name}: got ${f.got}, want ${f.want}`),
          ].join('\n'),
        r.failed.map((f) => error('eval_failed', `${f.name}: got ${f.got}, want ${f.want}`)),
      );
    });
  admin
    .command('diff')
    .argument('<persona>')
    .argument('[from]')
    .argument('[to]')
    .action((persona: string, from?: string, to?: string) => {
      const c = ctx();
      const dir = c.configDir;
      if (!dir) throw new Error('orgspec-config is not set up');
      const versions = bundleVersions(dir, persona);
      const b = to ?? versions[0];
      const a = from ?? versions[1];
      const load = (v?: string) => (v ? (loadBundle(join(dir, 'compiled', persona, v)).bundle?.rules ?? []) : []);
      const d = diffRules(load(a), load(b));
      emit(
        { from: a ?? null, to: b ?? null, diff: d },
        () => `${persona} ${a ?? 'none'} → ${b ?? 'none'}\n${describeDiff(d)}`,
      );
    });
  admin
    .command('publish')
    .description('open a PR on orgspec-config pinning personas to bundles')
    .argument('<pins...>', 'persona@version')
    .action(async (pins: string[]) => {
      const url = await adminPublish(
        ctx(),
        pins.map((p) => {
          const [persona = '', version = ''] = p.split('@');
          return { persona, version };
        }),
      );
      emit({ url }, () => `Opened ${url}`);
    });
  admin
    .command('rollback')
    .argument('<persona>')
    .option('--to <version>')
    .action(async (persona: string, o: { to?: string }) => {
      const url = await adminRollback(ctx(), persona, o.to);
      emit({ url }, () => `Opened ${url}`);
    });
  admin
    .command('waiver')
    .description('write a time-limited waiver (takes effect when merged)')
    .argument('<rule>')
    .requiredOption('--reason <text>')
    .requiredOption('--approver <login>')
    .requiredOption('--expires <yyyy-mm-dd>')
    .option('--team <team>')
    .option('--repo <owner/name>')
    .option('--change <id>')
    .option('--path <glob>', 'repeatable', list)
    .action(
      (
        ruleId: string,
        o: {
          reason: string;
          approver: string;
          expires: string;
          team?: string;
          repo?: string;
          change?: string;
          path?: string[];
        },
      ) => {
        const r = addWaiver(ctx(), {
          rule: ruleId,
          reason: o.reason,
          approver: o.approver,
          expires: o.expires,
          scope: {
            ...(o.team ? { team: o.team } : {}),
            ...(o.repo ? { repo: o.repo } : {}),
            ...(o.change ? { change: o.change } : {}),
            ...(o.path ? { paths: o.path } : {}),
          },
        });
        emit(r, () => `Wrote ${r.file}; open a PR on orgspec-config to apply it.`);
      },
    );
  admin.command('personas').action(() => {
    const c = ctx();
    const ps = c.config()?.personas ?? [];
    emit(
      {
        personas: ps.map((p) => ({
          id: p.metadata.id,
          name: p.metadata.name,
          version: p.metadata.version,
          bundle: p.spec.constitution.bundle,
          teams: p.spec.eligibility.teams,
        })),
      },
      () =>
        ps
          .map(
            (p) =>
              `${p.metadata.id.padEnd(16)} ${p.metadata.version.padEnd(8)} ${p.spec.constitution.bundle}  teams: ${p.spec.eligibility.teams.join(', ') || 'everyone'}`,
          )
          .join('\n') || 'No personas.',
    );
  });
  admin.command('people').action(() => {
    const p = loadPeople(ctx().configDir);
    emit(p, () => `${Object.keys(p.people).length} people mapped; 1:1 space ${p.oneOnOne.spaceId ?? 'not set'}`);
  });
}
