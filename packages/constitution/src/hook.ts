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
export function parseInvocations(command: string): GitInvocation[] {
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
    else if (ch === ';' || ch === '|' || ch === '&') {
      flush();
      if (command[i + 1] === ch) i++;
      tokens.push(';');
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
    seg = [];
  };
  for (const t of tokens) {
    if (t === ';') end();
    else seg.push(t);
  }
  end();
  return out;
}

const branchMatches = (branch: string, patterns: readonly string[]) =>
  patterns.some((p) => (p.endsWith('/*') ? branch.startsWith(p.slice(0, -1)) : branch === p));

/** Turns a git/gh invocation into the operation names git-op checks use. */
export function operationsOf(inv: GitInvocation, currentBranch?: string): string[] {
  const [sub, ...rest] = inv.args.filter((a) => !a.startsWith('-C'));
  const ops: string[] = [];
  if (inv.tool === 'git') {
    if (sub === 'push') {
      if (rest.some((a) => a === '--force' || a === '-f' || a.startsWith('--force-with-lease') || a.startsWith('+')))
        ops.push('force-push');
      const positional = rest.filter((a) => !a.startsWith('-'));
      const refspec = positional[1];
      const target = refspec ? (refspec.includes(':') ? refspec.split(':')[1] : refspec) : currentBranch;
      if (target) ops.push(`push:${target.replace(/^\+/, '')}`);
      if (rest.includes('--delete') || (refspec?.startsWith(':') ?? false)) ops.push('delete-branch');
    }
    if (sub === 'merge') ops.push('merge');
    if (sub === 'rebase' || (sub === 'reset' && rest.includes('--hard')) || sub === 'filter-branch')
      ops.push('rewrite-history');
  } else {
    if (sub === 'pr' && rest[0] === 'merge') ops.push('merge');
    if (sub === 'pr' && rest[0] === 'create' && !rest.includes('--draft') && !rest.includes('-d')) ops.push('pr-ready');
    if (sub === 'pr' && rest[0] === 'ready') ops.push('pr-ready');
    if (sub === 'repo' && rest[0] === 'delete') ops.push('delete-repo');
  }
  return ops;
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
