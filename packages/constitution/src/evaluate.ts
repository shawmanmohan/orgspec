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

export * from './hook.js';
