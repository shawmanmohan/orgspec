import { matchesAny } from '@orgspec/core/glob';
import type { Tier } from '@orgspec/spec-engine';
import type { Rule } from './rules.js';

// Kept free of heavy runtime imports: `orgspec hook` loads only this module on every tool call.

export interface HookDecision {
  decision: 'allow' | 'deny' | 'ask';
  ruleId?: string;
  reason?: string;
}

const PROTECTED_DEFAULT = ['main', 'master', 'release/*'];

interface GitInvocation {
  tool: 'git' | 'gh';
  args: string[];
}

/** Splits a shell command line into git/gh invocations (quotes respected; `&&`, `||`, `;`, `|` separate). */
export function parseInvocations(command: string, depth = 0): GitInvocation[] {
  const tokens: string[] = [];
  let cur = '';
  let quote: string | null = null;
  const flush = () => {
    if (cur) tokens.push(cur);
    cur = '';
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string;
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (/\s/.test(ch)) flush();
    else if (ch === ';' || ch === '|' || ch === '&' || ch === '(' || ch === ')' || ch === '`' || ch === '\n') {
      // Command separators, subshells and command substitution all start a new segment.
      flush();
      if ((ch === '|' || ch === '&') && command[i + 1] === ch) i++;
      tokens.push(';');
    } else if (ch === '$' && command[i + 1] === '(') {
      flush();
      tokens.push(';');
      i++;
    } else cur += ch;
  }
  flush();
  const out: GitInvocation[] = [];
  let seg: string[] = [];
  const end = () => {
    const i = seg.findIndex((t) => t === 'git' || t === 'gh' || t.endsWith('/git') || t.endsWith('/gh'));
    if (i >= 0) {
      const tool = (seg[i] as string).endsWith('gh') ? 'gh' : 'git';
      out.push({ tool, args: seg.slice(i + 1) });
    }
    // A quoted argument that runs as a command (`sh -c "git push -f"`, `bash -lc '…'`, `eval '…'`) is parsed
    // too; other quoted text (commit messages, echo) is left alone.
    if (depth < 3) {
      seg.forEach((t, k) => {
        const prev = seg[k - 1] ?? '';
        const runsAsCommand = /^-[a-z]*c$/.test(prev) || prev === 'eval' || prev.endsWith('/eval');
        if (runsAsCommand && /\b(git|gh)\b/.test(t)) out.push(...parseInvocations(t, depth + 1));
      });
    }
    seg = [];
  };
  for (const t of tokens) {
    if (t === ';') end();
    else seg.push(t);
  }
  end();
  return out;
}

/** git options that come before the subcommand and take a separate value. */
const GIT_VALUE_OPTIONS = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
  '--super-prefix',
  '--config-env',
]);

/** The git or gh subcommand and its arguments, with global options (`git -C dir -c k=v push`) removed. */
export function subcommandOf(inv: GitInvocation): { sub?: string; rest: string[] } {
  const a = inv.args;
  let i = 0;
  if (inv.tool === 'git') {
    while (i < a.length && (a[i] as string).startsWith('-')) {
      const opt = a[i] as string;
      i += GIT_VALUE_OPTIONS.has(opt) ? 2 : 1;
    }
  }
  const sub = a[i];
  return { ...(sub !== undefined ? { sub } : {}), rest: a.slice(i + 1) };
}

const branchMatches = (branch: string, patterns: readonly string[]) =>
  patterns.some((p) => (p.endsWith('/*') ? branch.startsWith(p.slice(0, -1)) : branch === p));

const isForceFlag = (a: string) =>
  a === '--force' || a.startsWith('--force-with-lease') || a.startsWith('+') || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a);

/** Turns a git/gh invocation into the operation names git-op checks use. */
export function operationsOf(inv: GitInvocation, currentBranch?: string): string[] {
  const { sub, rest } = subcommandOf(inv);
  const ops: string[] = [];
  if (inv.tool === 'git') {
    if (sub === 'push') {
      if (rest.some(isForceFlag)) ops.push('force-push');
      const positional = rest.filter((a) => !a.startsWith('-'));
      const refspecs = positional.slice(1);
      const targets = refspecs.length
        ? refspecs.map((r) => (r.includes(':') ? r.split(':')[1] : r) ?? '')
        : [currentBranch ?? ''];
      for (const t of targets) {
        const target = t.replace(/^\+/, '');
        const resolved = target === 'HEAD' || target === '' ? currentBranch : target.replace(/^refs\/heads\//, '');
        if (resolved) ops.push(`push:${resolved}`);
      }
      if (rest.includes('--delete') || rest.includes('-d') || refspecs.some((r) => r.startsWith(':')))
        ops.push('delete-branch');
      if (rest.includes('--mirror') || rest.includes('--all')) ops.push('force-push');
    }
    if (sub === 'merge') ops.push('merge');
    if (
      sub === 'rebase' ||
      (sub === 'reset' && rest.includes('--hard')) ||
      sub === 'filter-branch' ||
      sub === 'filter-repo'
    )
      ops.push('rewrite-history');
  } else {
    if (sub === 'pr' && rest[0] === 'merge') ops.push('merge');
    if (sub === 'pr' && rest[0] === 'create' && !rest.includes('--draft') && !rest.includes('-d')) ops.push('pr-ready');
    if (sub === 'pr' && rest[0] === 'ready') ops.push('pr-ready');
    if (sub === 'repo' && rest[0] === 'delete') ops.push('delete-repo');
  }
  return ops;
}

/** True when a command line talks to GitHub through git or gh (the gh account must match). */
export function needsGitHubAccount(command: string): boolean {
  return parseInvocations(command).some((inv) => {
    const { sub } = subcommandOf(inv);
    return inv.tool === 'gh'
      ? ['pr', 'api', 'repo', 'issue', 'release', 'run', 'workflow'].includes(sub ?? '')
      : ['push', 'fetch', 'pull', 'clone'].includes(sub ?? '');
  });
}

const opMatches = (op: string, pattern: string): boolean => {
  if (pattern.startsWith('push:') && op.startsWith('push:')) return branchMatches(op.slice(5), [pattern.slice(5)]);
  return op === pattern;
};

/** Decides a Bash tool call against the bundle's `git-op` checks. */
export function evaluateGitCommand(
  rules: readonly Rule[],
  command: string,
  ctx: { tier: Tier; currentBranch?: string; protectedBranches?: string[] },
): HookDecision {
  const invocations = parseInvocations(command);
  if (!invocations.length) return { decision: 'allow' };
  const ops = invocations.flatMap((i) => operationsOf(i, ctx.currentBranch));
  const protectedBranches = ctx.protectedBranches ?? PROTECTED_DEFAULT;
  for (const op of ops) {
    if (op.startsWith('push:') && branchMatches(op.slice(5), protectedBranches)) {
      return { decision: 'deny', reason: `Pushing to protected branch ${op.slice(5)} is never allowed` };
    }
  }
  let ask: HookDecision | undefined;
  for (const r of rules) {
    if (r.check?.kind !== 'git-op' || r.enforcement !== 'hook' || !r.check.tiers.includes(ctx.tier)) continue;
    for (const op of ops) {
      if (r.check.deny.some((p) => opMatches(op, p)))
        return { decision: 'deny', ruleId: r.id, reason: `${r.title}: ${r.statement}` };
      if (!ask && r.check.ask.some((p) => opMatches(op, p)))
        ask = { decision: 'ask', ruleId: r.id, reason: `${r.title}: ${r.statement}` };
    }
  }
  return ask ?? { decision: 'allow' };
}

/** Decides a file write against the ticket folder boundary and `file-scope` checks. */
export function evaluateFileWrite(
  rules: readonly Rule[],
  file: { absolute: string; repoRelative?: string },
  ctx: { tier: Tier; ticketFolder: string; namedInSpec: string },
): HookDecision {
  const folder = ctx.ticketFolder.endsWith('/') ? ctx.ticketFolder : `${ctx.ticketFolder}/`;
  if (!file.absolute.startsWith(folder)) {
    return { decision: 'deny', reason: `Writes are limited to the ticket folder ${ctx.ticketFolder}` };
  }
  if (!file.repoRelative) return { decision: 'allow' };
  for (const r of rules) {
    if (r.check?.kind !== 'file-scope' || !r.check.tiers.includes(ctx.tier)) continue;
    if (!matchesAny(file.repoRelative, r.check.deny)) continue;
    const named =
      r.check.allowWhenNamedInSpec &&
      (ctx.namedInSpec.includes(file.repoRelative) || r.check.deny.some((g) => ctx.namedInSpec.includes(g)));
    if (!named) return { decision: 'deny', ruleId: r.id, reason: `${file.repoRelative}: ${r.statement}` };
  }
  return { decision: 'allow' };
}
