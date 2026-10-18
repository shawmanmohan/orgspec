import { join } from 'node:path';
import { exists, nowIso, readText } from '@orgspec/core';
import type { CiRun } from '@orgspec/integrations';
import { changeStatus, hasErrors, loadChange, traceChange, validateChange, type Workspace } from '@orgspec/spec-engine';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { artifactHashes, readApprovals } from './approvals.js';
import type { AppContext } from './context.js';

/** `orgspec-config/jira.yaml`: which Jira fields hold OrgSpec's gate values. The gates themselves live in Jira workflows. */
export const JiraConfigSchema = z.object({
  gates: z
    .object({
      spec: z.string().optional(),
      design: z.string().optional(),
      approvals: z.string().optional(),
      trace: z.string().optional(),
      ci: z.string().optional(),
      tier: z.string().optional(),
      change: z.string().optional(),
    })
    .default({}),
  /** Field holding the PRD review result for PM tickets. */
  prdReview: z.string().optional(),
  storyPoints: z.string().optional(),
  epicLink: z.string().optional(),
});
export type JiraConfig = z.infer<typeof JiraConfigSchema>;

export function loadJiraConfig(configDir?: string): JiraConfig {
  const f = configDir ? join(configDir, 'jira.yaml') : '';
  return JiraConfigSchema.parse(f && exists(f) ? (parseYaml(readText(f)) ?? {}) : {});
}

export interface GateValues {
  spec: 'valid' | 'invalid' | 'missing';
  design: 'approved' | 'pending' | 'not-required';
  approvals: string;
  trace: string;
  ci: 'passed' | 'failed' | 'running' | 'none';
  tier: string;
  change: string;
}

/** Computes a change's gate values from the repo and the latest CI run. */
export function computeGates(ws: Workspace, changeId: string, ci?: CiRun): GateValues {
  const { change, diagnostics } = validateChange(ws, changeId);
  const st = changeStatus(change);
  const hashes = artifactHashes(change);
  const { entries } = readApprovals(change.dir);
  const current = entries.filter((e) => hashes[e.artifact] === e.sha256);
  const designRequired =
    st?.artifacts.find((a) => a.id === 'design')?.state !== 'not-required' && exists(join(change.dir, 'design.md'));
  const trace = traceChange(ws, changeId).rows;
  const cited = trace.filter((r) => r.citations.length > 0).length;
  return {
    spec: hasErrors(diagnostics) ? 'invalid' : 'valid',
    design: !designRequired ? 'not-required' : current.some((e) => e.artifact === 'design.md') ? 'approved' : 'pending',
    approvals: current.map((e) => `${e.artifact}:${e.approver}`).join(', ') || 'none',
    trace: trace.length ? `${cited}/${trace.length}` : 'n/a',
    ci: !ci ? 'none' : ci.state === 'passed' ? 'passed' : ci.state === 'failed' ? 'failed' : 'running',
    tier: change.meta?.tier ?? 'unknown',
    change: changeId,
  };
}

/** Jira field payload for the gate values the org mapped. */
export function gateFields(cfg: JiraConfig, v: GateValues): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, field] of Object.entries(cfg.gates)) if (field) out[field] = v[k as keyof GateValues];
  return out;
}

/**
 * Keeps gate fields current for every active change in the person's repos. Writes only when a value
 * changed since the last write, so polling does not churn Jira history.
 */
export async function syncGates(
  ctx: AppContext,
  repos: { ws: Workspace; slug: string; changes: string[] }[],
): Promise<{ updated: string[]; errors: string[] }> {
  const cfg = loadJiraConfig(ctx.configDir);
  const updated: string[] = [];
  const errors: string[] = [];
  if (!Object.values(cfg.gates).some(Boolean)) return { updated, errors };
  const db = ctx.db();
  for (const r of repos) {
    for (const id of r.changes) {
      const jira = loadChange(r.ws, id).meta?.jira;
      if (!jira) continue;
      const run = db
        .prepare(
          'select status, conclusion from cache_ci_runs where repo = ? and branch = ? order by source_updated_at desc limit 1',
        )
        .get(r.slug, jira.toLowerCase()) as { status: string; conclusion: string | null } | undefined;
      const ci = run
        ? ({ id: '', repo: r.slug, state: (run.conclusion ?? run.status) as CiRun['state'], steps: [] } satisfies CiRun)
        : undefined;
      const fields = gateFields(cfg, computeGates(r.ws, id, ci));
      const key = `gates:${jira}`;
      const prev = (db.prepare('select value from kv where key = ?').get(key) as { value: string } | undefined)?.value;
      const next = JSON.stringify(fields);
      if (prev === next) continue;
      try {
        await ctx.workplace().jira.setFields(jira, fields);
        db.prepare('insert or replace into kv (key, value) values (?, ?)').run(key, next);
        db.prepare('update cache_jira_issues set gate_fields = ?, fetched_at = ? where key = ?').run(
          next,
          nowIso(),
          jira,
        );
        updated.push(jira);
      } catch (e) {
        errors.push(`${jira}: ${(e as Error).message}`);
      }
    }
  }
  return { updated, errors };
}
