import { join } from 'node:path';
import { exists, matchesAny, readText, type Waiver } from '@orgspec/core';
import {
  type Diagnostic,
  error,
  type LoadedChange,
  type Tier,
  traceChange,
  type Workspace,
  warning,
} from '@orgspec/spec-engine';
import { waivedRuleIds } from './layering.js';
import { appliesToTier, type Rule, TIER_RANK } from './rules.js';

const ruleDiag = (
  r: Rule,
  message: string,
  extra: Omit<Diagnostic, 'severity' | 'code' | 'message'> = {},
): Diagnostic => {
  const text = `${message} [${r.id}; source page ${r.source.pageId} v${r.source.version}]`;
  return r.severity === 'blocking' ? error(`rule:${r.id}`, text, extra) : warning(`rule:${r.id}`, text, extra);
};

/** The minimum tier the changed paths demand, from `path-rule` checks. */
export function tierFloor(
  rules: readonly Rule[],
  paths: readonly string[],
): { tier: Tier; because: { rule: Rule; paths: string[] }[] } {
  let tier: Tier = 'low';
  const because: { rule: Rule; paths: string[] }[] = [];
  for (const r of rules) {
    if (r.check?.kind !== 'path-rule') continue;
    const hit = paths.filter((p) => matchesAny(p, r.check?.kind === 'path-rule' ? r.check.paths : []));
    if (!hit.length) continue;
    because.push({ rule: r, paths: hit });
    if (TIER_RANK[r.check.minTier] > TIER_RANK[tier]) tier = r.check.minTier;
  }
  return { tier, because };
}

export interface ApprovalRecord {
  artifact: string;
  sha256: string;
  approver: string;
  role?: string;
  teams?: string[];
  /** True when the entry was committed by the approver it names. */
  verified: boolean;
}

export interface CiContext {
  ws: Workspace;
  change: LoadedChange;
  tier: Tier;
  /** Repo-relative paths changed by the PR. */
  diffPaths: string[];
  approvals: ApprovalRecord[];
  /** Current content hash per artifact path in the change folder. */
  artifactHashes: Record<string, string>;
  author?: string;
  waivers?: Waiver[];
  team?: string;
  repo?: string;
}

/** Runs every compiled `ci` check. Waived rules report an info line instead. */
export function evaluateCiChecks(rules: readonly Rule[], ctx: CiContext): Diagnostic[] {
  const out: Diagnostic[] = [];
  const waived = waivedRuleIds(ctx.waivers ?? [], {
    ...(ctx.team ? { team: ctx.team } : {}),
    ...(ctx.repo ? { repo: ctx.repo } : {}),
    change: ctx.change.id,
    paths: ctx.diffPaths,
  });
  const changeText = (): string => {
    const parts: string[] = [];
    for (const f of ['proposal.md', 'design.md'])
      if (exists(join(ctx.change.dir, f))) parts.push(readText(join(ctx.change.dir, f)));
    for (const d of ctx.change.deltas) parts.push(readText(d.file));
    return parts.join('\n');
  };

  for (const r of rules) {
    if (!r.check || r.enforcement !== 'ci' || !appliesToTier(r, ctx.tier)) continue;
    const w = waived.get(r.id);
    if (w) {
      out.push({
        severity: 'info',
        code: `waived:${r.id}`,
        message: `${r.id} waived by ${w.id} until ${w.expires} (${w.approver})`,
      });
      continue;
    }
    const c = r.check;
    switch (c.kind) {
      case 'artifact-required':
        if (c.tiers.includes(ctx.tier)) {
          for (const a of c.artifacts) {
            if (!exists(join(ctx.change.dir, a))) out.push(ruleDiag(r, `${a} is required at tier ${ctx.tier}`));
          }
        }
        break;
      case 'section-required': {
        const file = join(ctx.change.dir, c.artifact);
        if (!exists(file)) break;
        const heading = new RegExp(`^#{1,6}\\s+${c.heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'im');
        if (!heading.test(readText(file))) out.push(ruleDiag(r, `${c.artifact} needs a "${c.heading}" section`));
        break;
      }
      case 'path-rule': {
        const hit = ctx.diffPaths.filter((p) => matchesAny(p, c.paths));
        if (hit.length && TIER_RANK[ctx.tier] < TIER_RANK[c.minTier]) {
          out.push(
            ruleDiag(
              { ...r, severity: 'blocking' },
              `Changes to ${hit.slice(0, 3).join(', ')} need tier ${c.minTier}; this change is ${ctx.tier}`,
            ),
          );
        }
        break;
      }
      case 'approval': {
        const current = ctx.artifactHashes[c.artifact];
        if (!current) break;
        const valid = ctx.approvals.filter(
          (a) =>
            a.artifact === c.artifact &&
            a.sha256 === current &&
            a.verified &&
            a.approver !== ctx.author &&
            (!c.role || a.role === c.role) &&
            (!c.team || (a.teams ?? []).includes(c.team)),
        );
        const stale = ctx.approvals.filter((a) => a.artifact === c.artifact && a.sha256 !== current);
        if (valid.length < c.count) {
          const who = c.role ? `${c.role}` : c.team ? `${c.team}` : 'an eligible approver';
          out.push(
            ruleDiag(
              r,
              `${c.artifact} needs ${c.count} approval(s) from ${who} for its current content; has ${valid.length}${stale.length ? ` (${stale.length} stale)` : ''}`,
            ),
          );
        }
        break;
      }
      case 'trace-coverage':
        if (c.tiers.includes(ctx.tier)) {
          for (const d of traceChange(ctx.ws, ctx.change.id).diagnostics) {
            if (d.code === 'trace_uncited_scenario')
              out.push(
                ruleDiag(r, d.message, { ...(d.path ? { path: d.path } : {}), ...(d.line ? { line: d.line } : {}) }),
              );
          }
        }
        break;
      case 'pattern-forbid': {
        const re = new RegExp(c.pattern, c.flags);
        for (const p of ctx.diffPaths.filter((x) => matchesAny(x, c.paths))) {
          const file = join(ctx.ws.repoRoot, p);
          if (!exists(file)) continue;
          readText(file)
            .split(/\r?\n/)
            .forEach((line, i) => {
              if (re.test(line)) out.push(ruleDiag(r, `Forbidden pattern /${c.pattern}/`, { path: p, line: i + 1 }));
            });
        }
        break;
      }
      case 'file-scope': {
        const named = c.allowWhenNamedInSpec ? changeText() : '';
        for (const p of ctx.diffPaths.filter((x) => matchesAny(x, c.deny))) {
          if (named && (named.includes(p) || c.deny.some((g) => named.includes(g)))) continue;
          out.push(ruleDiag(r, `${p} may only change when the spec names it`, { path: p }));
        }
        break;
      }
      default:
        break;
    }
  }
  return out;
}

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
