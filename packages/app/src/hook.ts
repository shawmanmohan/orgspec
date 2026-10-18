import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { Rule } from '@orgspec/constitution';
import { evaluateFileWrite, evaluateGitCommand, type HookDecision } from '@orgspec/constitution/hook';
import { findSessionFolder, logAction, readHookRules, readSession, type TicketSession } from './session.js';

// `orgspec hook pre-tool-use` runs on every Bash and file-write tool call. p99 budget: 100 ms.
// Imports stay light; anything slow (gh, spec parsing) runs only for the rare calls that need it.

export interface HookInput {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: { command?: string; file_path?: string; notebook_path?: string; [k: string]: unknown };
}

export interface HookOutput {
  hookSpecificOutput?: {
    hookEventName: string;
    permissionDecision?: 'allow' | 'deny' | 'ask';
    permissionDecisionReason?: string;
    additionalContext?: string;
  };
  systemMessage?: string;
}

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** Text of the change's proposal, design and deltas: paths named there may be touched. */
function namedInSpec(s: TicketSession): string {
  if (!s.change) return '';
  const primary = s.repos[0];
  if (!primary) return '';
  const dir = join(primary.path, 'orgspec', 'changes', s.change);
  if (!existsSync(dir)) return '';
  const parts: string[] = [];
  const visit = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.session') continue;
      const p = join(d, e.name);
      if (e.isDirectory()) visit(p);
      else if (e.name.endsWith('.md')) parts.push(readFileSync(p, 'utf8'));
    }
  };
  visit(dir);
  return parts.join('\n');
}

function repoFor(s: TicketSession, absolute: string) {
  return s.repos.find((r) => absolute === r.path || absolute.startsWith(r.path + sep));
}

/** The gh account currently active for a host, read only for push and pr commands. */
function activeGhAccount(host: string): string | undefined {
  const r = spawnSync(process.env.ORGSPEC_GH_BIN ?? 'gh', ['auth', 'status', '--json', 'hosts'], {
    encoding: 'utf8',
    timeout: 3000,
  });
  try {
    const data = JSON.parse(r.stdout) as { hosts?: Record<string, { login: string; active: boolean }[]> };
    return data.hosts?.[host]?.find((a) => a.active)?.login;
  } catch {
    return undefined;
  }
}

const NEEDS_ACCOUNT = /\b(git\s+(push|fetch|pull|clone)|gh\s+(pr|api|repo|issue|release))\b/;

export function preToolUse(
  input: HookInput,
  env: { ghAccount?: (host: string) => string | undefined } = {},
): HookOutput | undefined {
  const cwd = input.cwd ?? process.cwd();
  const folder = findSessionFolder(cwd);
  if (!folder) return undefined;
  const s = readSession(folder);
  const rules = (readHookRules(folder)?.rules ?? []) as Rule[];
  const tool = input.tool_name ?? '';
  let d: HookDecision = { decision: 'allow' };

  if (tool === 'Bash') {
    const command = String(input.tool_input?.command ?? '');
    const repo = repoFor(s, resolve(cwd));
    d = evaluateGitCommand(rules, command, {
      tier: s.tier,
      ...(repo ? { currentBranch: repo.branch } : {}),
      protectedBranches: s.protectedBranches,
    });
    if (d.decision !== 'deny' && repo?.ghAccount && NEEDS_ACCOUNT.test(command)) {
      const active = (env.ghAccount ?? activeGhAccount)(repo.host);
      if (active && active !== repo.ghAccount) {
        d = {
          decision: 'deny',
          reason: `gh is signed in as ${active}, but ${repo.owner} uses ${repo.ghAccount}. Run: gh auth switch --hostname ${repo.host} --user ${repo.ghAccount}`,
        };
      }
    }
    if (d.decision !== 'allow' || NEEDS_ACCOUNT.test(command)) {
      logAction(folder, {
        kind: 'tool',
        tool,
        decision: d.decision,
        ...(d.ruleId ? { ruleId: d.ruleId } : {}),
        summary: command.slice(0, 300),
      });
    }
  } else if (WRITE_TOOLS.has(tool)) {
    const target = String(input.tool_input?.file_path ?? input.tool_input?.notebook_path ?? '');
    if (!target) return undefined;
    const absolute = resolve(cwd, target);
    const repo = repoFor(s, absolute);
    const repoRelative = repo ? relative(repo.path, absolute).split(sep).join('/') : undefined;
    const needsSpec = rules.some((r) => r.check?.kind === 'file-scope');
    d = evaluateFileWrite(
      rules,
      { absolute, ...(repoRelative ? { repoRelative } : {}) },
      { tier: s.tier, ticketFolder: s.folder, namedInSpec: needsSpec && repoRelative ? namedInSpec(s) : '' },
    );
    if (d.decision !== 'allow')
      logAction(folder, {
        kind: 'tool',
        tool,
        decision: d.decision,
        ...(d.ruleId ? { ruleId: d.ruleId } : {}),
        summary: absolute,
      });
  }

  if (d.decision === 'allow') return undefined;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: d.decision,
      permissionDecisionReason: `OrgSpec${d.ruleId ? ` (${d.ruleId})` : ''}: ${d.reason ?? 'blocked by policy'}`,
    },
  };
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Entry for `orgspec hook <event>`. Fails closed for pre-tool-use inside an OrgSpec session when the
 * session files are unreadable; outside a session it never interferes.
 */
export async function runHook(
  event: string,
  args: string[],
  io: { out: (s: string) => void; err: (s: string) => void },
): Promise<number> {
  let input: HookInput = {};
  try {
    const raw = await readStdin();
    input = raw.trim() ? (JSON.parse(raw) as HookInput) : {};
  } catch {
    input = {};
  }
  try {
    let out: HookOutput | undefined;
    if (event === 'pre-tool-use') out = preToolUse(input);
    else {
      const { checkpointHook } = await import('./checkpoint.js');
      const reason = args[args.indexOf('--reason') + 1] ?? event;
      out = await checkpointHook(event, args.includes('--reason') ? reason : event, input);
    }
    if (out) io.out(`${JSON.stringify(out)}\n`);
    return 0;
  } catch (e) {
    if (event === 'pre-tool-use' && findSessionFolder(input.cwd ?? process.cwd())) {
      io.out(
        `${JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: `OrgSpec hook error: ${(e as Error).message}`,
          },
        })}\n`,
      );
      return 0;
    }
    io.err(`orgspec hook ${event}: ${(e as Error).message}\n`);
    return 0;
  }
}
