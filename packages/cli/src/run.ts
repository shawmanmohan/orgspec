import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AppContext } from '@orgspec/app';
import {
  applyStrict,
  archiveChange,
  changeStatus,
  type Diagnostic,
  findWorkspace,
  hasErrors,
  initWorkspace,
  listChangeIds,
  listSpecs,
  loadChange,
  newChange,
  OrgSpecError,
  parseSpec,
  rebaseChange,
  rel,
  TIERS,
  type Tier,
  taskProgress,
  traceChange,
  validateChange,
  validateSpec,
  type Workspace,
} from '@orgspec/spec-engine';
import { Command, CommanderError, Option } from 'commander';
import { registerAppCommands } from './commands.js';
import { formatDiagnostics, summary } from './format.js';

export interface IO {
  out(text: string): void;
  err(text: string): void;
  cwd: string;
}

export const VERSION = '0.1.0';

export interface RunDeps {
  /** Builds the app context (tests inject fakes for claude, gh and MCP). */
  context?: () => AppContext;
  /** Waits until a long-running command should stop; defaults to SIGINT/SIGTERM. */
  wait?: () => Promise<void>;
}

const waitForSignal = () =>
  new Promise<void>((resolve) => {
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
  });

export async function run(argv: readonly string[], io: IO, deps: RunDeps = {}): Promise<number> {
  let exitCode = 0;
  let ctx: AppContext | undefined;
  const context = (): AppContext => {
    if (!ctx) {
      if (deps.context) ctx = deps.context();
      else throw new Error('internal: context factory missing');
    }
    return ctx;
  };
  const program = new Command('orgspec')
    .description('Spec-driven development that follows your organisation’s constitution')
    .version(VERSION)
    .option('--json', 'print exactly one JSON document')
    .option('-C, --cwd <dir>', 'run as if started in <dir>')
    .exitOverride()
    .configureOutput({ writeOut: io.out, writeErr: io.err });

  const opts = () => {
    const o = program.opts<{ json?: boolean; cwd?: string }>();
    return { json: Boolean(o.json), cwd: o.cwd ? resolve(io.cwd, o.cwd) : io.cwd };
  };
  const workspace = (): Workspace => findWorkspace(opts().cwd);

  /** Prints one payload; in human mode `human` renders it. Sets exit 1 when diagnostics carry errors. */
  const emit = (payload: Record<string, unknown>, human: () => string, diagnostics: readonly Diagnostic[] = []) => {
    const failed = hasErrors(diagnostics);
    if (failed) exitCode = 1;
    if (opts().json) {
      io.out(`${JSON.stringify({ ok: !failed, ...payload, diagnostics }, null, 2)}\n`);
      return;
    }
    const body = human();
    if (body) io.out(`${body}\n`);
    if (diagnostics.length) io.out(`${formatDiagnostics(diagnostics)}\n\n${summary(diagnostics)}\n`);
  };

  program
    .command('init')
    .description('create orgspec/ in the current repository')
    .option('--team <name>', 'owning team', 'unassigned')
    .action((o: { team: string }) => {
      const { workspace: ws, created } = initWorkspace(opts().cwd, o.team);
      emit({ root: rel(ws, ws.root) || 'orgspec', created }, () =>
        created.length
          ? `Created:\n${created.map((c) => `  ${c}`).join('\n')}`
          : 'orgspec/ already exists; nothing to do.',
      );
    });

  program
    .command('new')
    .description('start a change for a Jira ticket')
    .argument('<jira>', 'Jira key, for example PROJ-123')
    .option('--slug <words>', 'short name added to the folder, for example "retry logic"')
    .option('--title <title>', 'title used in templates')
    .option('--schema <name>', 'workflow schema (feature, bugfix, spike, chore, api-change, migration)')
    .addOption(new Option('--tier <tier>', 'proposed risk tier').choices([...TIERS]).default('medium'))
    .action((jira: string, o: { slug?: string; title?: string; schema?: string; tier: Tier }) => {
      const ws = workspace();
      const created = newChange(ws, { jira, ...o });
      const status = changeStatus(loadChange(ws, created.id));
      emit(
        { change: { id: created.id, path: rel(ws, created.dir), files: created.files.map((f) => rel(ws, f)) }, status },
        () =>
          [
            `Created ${rel(ws, created.dir)}`,
            ...created.files.map((f) => `  ${rel(ws, f)}`),
            status?.next ? `Next: write ${status.next} (orgspec status ${created.id})` : '',
          ]
            .filter(Boolean)
            .join('\n'),
      );
    });

  program
    .command('list')
    .description('list active changes, or capabilities with --specs')
    .option('--specs', 'list capabilities instead of changes')
    .action((o: { specs?: boolean }) => {
      const ws = workspace();
      if (o.specs) {
        const specs = listSpecs(ws).map((s) => ({
          id: s.id,
          path: rel(ws, s.file),
          requirements: parseSpec(readFileSync(s.file, 'utf8'), rel(ws, s.file), s.id).requirements.length,
        }));
        emit({ specs }, () =>
          specs.length
            ? specs.map((s) => `${s.id.padEnd(40)} ${s.requirements} requirements`).join('\n')
            : 'No specs yet.',
        );
        return;
      }
      const changes = listChangeIds(ws).map((id) => {
        const change = loadChange(ws, id);
        const status = changeStatus(change);
        const tasksFile = join(change.dir, 'tasks.md');
        let tasks: { total: number; done: number } | undefined;
        try {
          tasks = taskProgress(readFileSync(tasksFile, 'utf8'));
        } catch {
          tasks = undefined;
        }
        return {
          id,
          schema: status?.schema,
          tier: status?.tier,
          planningComplete: status?.planningComplete ?? false,
          ...(tasks ? { tasks } : {}),
        };
      });
      emit({ changes }, () =>
        changes.length
          ? changes
              .map(
                (c) =>
                  `${c.id.padEnd(36)} ${(c.tier ?? '?').padEnd(7)} ${c.planningComplete ? 'planned ' : 'planning'} ${
                    c.tasks ? `${c.tasks.done}/${c.tasks.total} tasks` : ''
                  }`,
              )
              .join('\n')
          : 'No active changes.',
      );
    });

  program
    .command('status')
    .description('show which artifacts a change still needs')
    .argument('<change>', 'change ID')
    .action((id: string) => {
      const ws = workspace();
      const change = loadChange(ws, id);
      const status = changeStatus(change);
      emit(
        { status },
        () => {
          if (!status) return '';
          const rows = status.artifacts.map((a) => {
            const extra = a.state === 'blocked' ? ` (needs ${a.missing.join(', ')})` : '';
            return `  ${a.state.padEnd(12)} ${a.id.padEnd(14)} ${a.generates}${extra}`;
          });
          return [
            `${status.changeId} · ${status.schema} · tier ${status.tier}`,
            ...rows,
            status.next ? `Next: ${status.next}` : 'Planning complete.',
          ].join('\n');
        },
        change.diagnostics,
      );
    });

  program
    .command('show')
    .description('show a capability spec or a change')
    .argument('<id>', 'capability ID (payments.retries) or change ID (PROJ-123)')
    .action((id: string) => {
      const ws = workspace();
      const spec = listSpecs(ws).find((s) => s.id === id);
      if (spec) {
        const parsed = parseSpec(readFileSync(spec.file, 'utf8'), rel(ws, spec.file), spec.id);
        const requirements = parsed.requirements.map((r) => ({
          id: r.id,
          name: r.name,
          text: r.description,
          scenarios: r.scenarios.map((s) => ({ id: s.id, name: s.name })),
        }));
        emit({ type: 'spec', id, title: parsed.title, purpose: parsed.purpose, requirements }, () =>
          [
            `${parsed.title ?? id}`,
            parsed.purpose ? `\n${parsed.purpose}\n` : '',
            ...requirements.map((r) => `  ${r.id}  ${r.name} (${r.scenarios.length} scenarios)`),
          ].join('\n'),
        );
        return;
      }
      const change = loadChange(ws, id);
      const status = changeStatus(change);
      emit(
        {
          type: 'change',
          id,
          status,
          deltas: change.deltas.map((d) => ({ capability: d.capabilityId, path: rel(ws, d.file) })),
        },
        () =>
          [
            `${id} · ${status?.schema ?? '?'} · tier ${status?.tier ?? '?'}`,
            ...change.deltas.map((d) => `  delta  ${d.capabilityId}  ${rel(ws, d.file)}`),
          ].join('\n'),
        change.diagnostics,
      );
    });

  program
    .command('validate')
    .description('validate one change or spec, or everything')
    .argument('[target]', 'change ID or capability ID; omit to validate all')
    .option('--strict', 'treat warnings as errors')
    .action((target: string | undefined, o: { strict?: boolean }) => {
      const ws = workspace();
      const specs = listSpecs(ws);
      const changeIds = listChangeIds(ws);
      const items: { id: string; type: 'spec' | 'change'; valid: boolean; diagnostics: Diagnostic[] }[] = [];
      const add = (id: string, type: 'spec' | 'change', diags: Diagnostic[]) => {
        const diagnostics = applyStrict(diags, Boolean(o.strict));
        items.push({ id, type, valid: !hasErrors(diagnostics), diagnostics });
      };
      if (target) {
        const spec = specs.find((s) => s.id === target);
        if (spec) add(spec.id, 'spec', validateSpec(ws, spec));
        else add(target, 'change', validateChange(ws, target).diagnostics);
      } else {
        for (const s of specs) add(s.id, 'spec', validateSpec(ws, s));
        for (const id of changeIds) add(id, 'change', validateChange(ws, id).diagnostics);
      }
      const all = items.flatMap((i) => i.diagnostics);
      const passed = items.filter((i) => i.valid).length;
      emit(
        { items, summary: { total: items.length, passed, failed: items.length - passed } },
        () =>
          [
            ...items.map((i) => `${i.valid ? 'pass' : 'FAIL'}  ${i.type.padEnd(6)} ${i.id}`),
            items.length ? '' : 'Nothing to validate.',
          ].join('\n'),
        all,
      );
    });

  program
    .command('rebase')
    .description('pin the main-spec hashes a change is based on')
    .argument('<change>', 'change ID')
    .action((id: string) => {
      const ws = workspace();
      const { base, diagnostics } = rebaseChange(ws, id);
      emit({ change: id, base }, () => `Based ${Object.keys(base).length} requirement(s) for ${id}.`, diagnostics);
    });

  program
    .command('archive')
    .description('merge a change into the main specs and move it to archive/')
    .argument('<change>', 'change ID')
    .option('--date <yyyy-mm-dd>', 'archive date (default: today)')
    .option('--ci', 'non-interactive; for the CI pipeline step')
    .action((id: string, o: { date?: string }) => {
      const ws = workspace();
      const result = archiveChange(ws, id, o.date ? { date: o.date } : {});
      emit(
        {
          archive: result.archivedAs
            ? {
                change: id,
                archivedAs: result.archivedAs,
                path: result.path,
                specsUpdated: result.specsUpdated,
                retired: result.retired,
              }
            : null,
        },
        () =>
          result.archivedAs
            ? [
                `Archived ${id} to ${result.path}`,
                ...result.specsUpdated.map((s) => `  updated ${s}`),
                ...result.retired.map((r) => `  retired ${r}`),
              ].join('\n')
            : `Did not archive ${id}.`,
        result.diagnostics,
      );
    });

  program
    .command('trace')
    .description('check every new or changed scenario is cited by a test')
    .argument('<change>', 'change ID')
    .action((id: string) => {
      const ws = workspace();
      const { rows, diagnostics } = traceChange(ws, id);
      emit(
        { change: id, rows },
        () =>
          rows.length
            ? rows
                .map(
                  (r) =>
                    `  ${r.citations.length ? 'cited ' : 'MISSING'} ${r.scenarioId}${r.citations.map((c) => `  ${c.file}:${c.line}`).join('')}`,
                )
                .join('\n')
            : 'No new or changed scenarios.',
        diagnostics,
      );
    });

  registerAppCommands(program, {
    io,
    opts,
    workspace,
    emit,
    context,
    keepAlive: async (close, o) => {
      const waits = [(deps.wait ?? waitForSignal)()];
      if (o?.untilStdinEnds && !deps.wait)
        waits.push(new Promise<void>((resolve) => process.stdin.once('end', () => resolve())));
      await Promise.race(waits);
      await close();
    },
    setExit: (code) => {
      exitCode = code;
    },
  });

  try {
    await program.parseAsync([...argv], { from: 'user' });
  } catch (e) {
    if (e instanceof CommanderError) return e.exitCode;
    if (e instanceof OrgSpecError) {
      emit({}, () => '', e.diagnostics);
      return 1;
    }
    emit({}, () => '', [{ severity: 'error', code: 'command_failed', message: (e as Error).message }]);
    return 1;
  } finally {
    await ctx?.close();
  }
  return exitCode;
}
