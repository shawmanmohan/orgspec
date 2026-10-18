import { join } from 'node:path';
import {
  evaluateCiChecks,
  type LoadedBundle,
  type Rule,
  TIER_RANK,
  tierFloor,
  waivedRuleIds,
} from '@orgspec/constitution';
import type { Waiver } from '@orgspec/core';
import type { Git } from '@orgspec/integrations';
import {
  applyStrict,
  type Diagnostic,
  error,
  hasErrors,
  listChangeIds,
  ORGSPEC_DIR,
  type Tier,
  traceChange,
  validateChange,
  type Workspace,
  warning,
} from '@orgspec/spec-engine';
import { type ApproverDirectory, artifactHashes, verifyApprovals } from './approvals.js';

export interface CheckOptions {
  ws: Workspace;
  git: Git;
  /** Base ref the PR merges into (`origin/main`). */
  base: string;
  bundle?: LoadedBundle;
  waivers?: Waiver[];
  directory: ApproverDirectory;
  author?: string;
  repo?: string;
  /** Limit to these changes; by default the changes the diff touches. */
  changes?: string[];
  today?: string;
}

export interface ChangeCheck {
  id: string;
  tier?: Tier;
  requiredTier: Tier;
  diagnostics: Diagnostic[];
}

export interface CheckReport {
  ok: boolean;
  diffPaths: string[];
  changes: ChangeCheck[];
  diagnostics: Diagnostic[];
  bundle?: { persona: string; version: string; sha256: string };
}

const changeIdOf = (p: string): string | undefined => {
  const m = new RegExp(`^${ORGSPEC_DIR}/changes/([^/]+)/`).exec(p);
  return m && m[1] !== 'archive' ? m[1] : undefined;
};

/**
 * `orgspec check`, run by the org's CI on every pull request: strict validation, traceability, the
 * path tier floor, verified approvals and every compiled CI rule (minus active waivers).
 */
export async function runCheck(o: CheckOptions): Promise<CheckReport> {
  const diagnostics: Diagnostic[] = [];
  const diffPaths = await o.git.changedFiles(o.ws.repoRoot, o.base).catch((e: Error) => {
    diagnostics.push(
      error('check_diff_failed', `Cannot diff against ${o.base}: ${e.message}`, {
        fix: 'Fetch the base branch in CI (git fetch origin main)',
      }),
    );
    return [] as string[];
  });
  const rules: Rule[] = o.bundle?.rules ?? [];
  if (!o.bundle)
    diagnostics.push(
      warning('check_no_bundle', 'No constitution bundle given; only spec checks ran', {
        fix: 'Pass --config <orgspec-config> and --persona',
      }),
    );

  const touched = new Set(diffPaths.map(changeIdOf).filter((x): x is string => Boolean(x)));
  const active = new Set(listChangeIds(o.ws));
  const ids = o.changes ?? [...touched].filter((id) => active.has(id));
  const codePaths = diffPaths.filter((p) => !p.startsWith(`${ORGSPEC_DIR}/`));
  const floor = tierFloor(rules, codePaths);

  if (!ids.length && codePaths.length) {
    const waived = waivedRuleIds(o.waivers ?? [], {
      ...(o.repo ? { repo: o.repo } : {}),
      paths: codePaths,
      ...(o.today ? { today: o.today } : {}),
    });
    const blocking = floor.because.filter((b) => !waived.has(b.rule.id));
    if (TIER_RANK[floor.tier] > 0 && blocking.length) {
      diagnostics.push(
        error(
          'check_change_required',
          `This PR changes ${blocking[0]?.paths.slice(0, 3).join(', ')}, which needs a ${floor.tier}-tier change folder`,
          {
            fix: 'Run orgspec new <JIRA-KEY> and describe the change',
          },
        ),
      );
    } else if (codePaths.length) {
      diagnostics.push({
        severity: 'info',
        code: 'check_no_change',
        message: 'No change folder in this PR; spec checks skipped',
      });
    }
  }

  const changes: ChangeCheck[] = [];
  for (const id of ids) {
    const d: Diagnostic[] = [];
    const { change, diagnostics: vd } = validateChange(o.ws, id);
    d.push(...applyStrict(vd, true));
    const tier = change.meta?.tier;
    if (tier && TIER_RANK[tier] < TIER_RANK[floor.tier]) {
      const why = floor.because.find(
        (b) => TIER_RANK[b.rule.check?.kind === 'path-rule' ? b.rule.check.minTier : 'low'] > TIER_RANK[tier],
      );
      d.push(
        error(
          'check_tier_floor',
          `${id} is ${tier} tier but the diff needs ${floor.tier}${why ? ` (${why.rule.id}: ${why.paths.slice(0, 2).join(', ')})` : ''}`,
          {
            fix: `Set tier: ${floor.tier} in change.yaml and add the artifacts it requires`,
          },
        ),
      );
    }
    if (!rules.some((r) => r.check?.kind === 'trace-coverage')) d.push(...traceChange(o.ws, id).diagnostics);
    if (o.bundle && change.meta?.constitution && !o.bundle.manifest.sha256.startsWith(change.meta.constitution)) {
      d.push(
        warning(
          'check_constitution_drift',
          `${id} was planned against constitution ${change.meta.constitution.slice(0, 15)}…; CI uses ${o.bundle.manifest.version}`,
        ),
      );
    }
    const { records, diagnostics: ad } = await verifyApprovals(change, o.ws.repoRoot, o.git, o.directory);
    d.push(...ad);
    if (tier && rules.length) {
      d.push(
        ...evaluateCiChecks(rules, {
          ws: o.ws,
          change,
          tier: tier && TIER_RANK[floor.tier] > TIER_RANK[tier] ? floor.tier : tier,
          diffPaths,
          approvals: records,
          artifactHashes: artifactHashes(change),
          ...(o.author ? { author: o.author } : {}),
          waivers: o.waivers ?? [],
          ...(o.repo ? { repo: o.repo } : {}),
          ...(o.ws.settings.team ? { team: o.ws.settings.team } : {}),
        }),
      );
    }
    changes.push({ id, ...(tier ? { tier } : {}), requiredTier: floor.tier, diagnostics: d });
  }

  const all = [...diagnostics, ...changes.flatMap((c) => c.diagnostics)];
  return {
    ok: !hasErrors(all),
    diffPaths,
    changes,
    diagnostics,
    ...(o.bundle
      ? {
          bundle: {
            persona: o.bundle.manifest.persona,
            version: o.bundle.manifest.version,
            sha256: o.bundle.manifest.sha256,
          },
        }
      : {}),
  };
}

export const bundleDir = (configDir: string, persona: string, version: string) =>
  join(configDir, 'compiled', persona, version);
