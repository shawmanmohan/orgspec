import { checkDeltas, listChangeIds, loadChange, type Workspace } from '@orgspec/spec-engine';
import { z } from 'zod';
import type { AppContext } from './context.js';
import { promptWith, runAgentJob } from './jobs.js';
import { localWorkspaces } from './work.js';

/**
 * The advisory verifier: before a PR is opened or updated, a `claude -p --agent verifier` run on the
 * author's machine judges the branch diff against each scenario the change adds or modifies. Its
 * verdicts go into the PR description. It never blocks anything; the deterministic trace in
 * `orgspec check` (CI) is the only blocking check, and CI makes no model calls.
 */

export const VERDICTS = ['met', 'partial', 'not-met', 'unclear'] as const;
export type Verdict = (typeof VERDICTS)[number];

export const VerifySchema = z.object({
  summary: z.string(),
  scenarios: z.array(
    z.object({
      id: z.string(),
      verdict: z.enum(VERDICTS),
      evidence: z.string().default(''),
      files: z.array(z.string()).default([]),
    }),
  ),
});

export interface ScenarioVerdict {
  id: string;
  requirementId: string;
  name: string;
  verdict: Verdict;
  evidence: string;
  files: string[];
}

export interface Verification {
  changeId: string;
  ranAt: string;
  base: string;
  head: string;
  summary: string;
  scenarios: ScenarioVerdict[];
  /** IDs the agent returned that are not scenarios of this change (dropped). */
  dropped: string[];
  jobId: string;
}

const MAX_DIFF = 120_000;

/** The scenarios a change adds or modifies, with their text. */
export function changeScenarios(
  ws: Workspace,
  changeId: string,
): { id: string; requirementId: string; name: string; text: string }[] {
  const change = loadChange(ws, changeId);
  return checkDeltas(ws, change).deltas.flatMap(({ delta }) =>
    [...delta.added, ...delta.modified].flatMap((req) =>
      req.scenarios.flatMap((s) =>
        req.id && s.id ? [{ id: s.id, requirementId: req.id, name: s.name, text: s.text }] : [],
      ),
    ),
  );
}

/** The local workspace and change folder for a Jira key (a configured clone or a ticket worktree). */
export function findChange(ctx: AppContext, key: string): { ws: Workspace; changeId: string } | undefined {
  for (const { ws } of localWorkspaces(ctx)) {
    const changeId = listChangeIds(ws).find((c) => c === key || c.startsWith(`${key}-`));
    if (changeId) return { ws, changeId };
  }
  return undefined;
}

async function branchDiff(ctx: AppContext, ws: Workspace, base: string): Promise<{ diff: string; base: string }> {
  for (const b of [base, 'origin/main', 'main']) {
    const diff = await ctx.git.call(ws.repoRoot, ['diff', '--no-color', `${b}...HEAD`]).catch(() => undefined);
    if (diff !== undefined) return { diff, base: b };
  }
  return { diff: await ctx.git.call(ws.repoRoot, ['diff', '--no-color', 'HEAD']).catch(() => ''), base: 'HEAD' };
}

export async function verifyChange(
  ctx: AppContext,
  ws: Workspace,
  changeId: string,
  o: { base?: string } = {},
): Promise<Verification> {
  const scenarios = changeScenarios(ws, changeId);
  if (!scenarios.length)
    throw Object.assign(
      new Error(`${changeId} adds or modifies no scenarios with IDs, so there is nothing to verify`),
      {
        statusCode: 400,
      },
    );
  const { diff, base } = await branchDiff(ctx, ws, o.base ?? 'origin/main');
  if (!diff.trim())
    throw Object.assign(new Error(`The branch has no changes against ${base} yet`), { statusCode: 400 });
  const head = await ctx.git.head(ws.repoRoot).catch(() => '');
  const job = await runAgentJob(ctx, {
    kind: 'verify',
    agent: 'verifier',
    prompt: promptWith(
      `For each scenario ID below, judge whether the diff implements it. Return {"summary": string, "scenarios": [{"id", "verdict": "met"|"partial"|"not-met"|"unclear", "evidence", "files": [paths]}]}, one entry per scenario ID, using only these IDs:\n${scenarios.map((s) => `- ${s.id}`).join('\n')}`,
      {
        scenarios: scenarios.map((s) => s.text).join('\n\n'),
        diff: diff.length > MAX_DIFF ? `${diff.slice(0, MAX_DIFF)}\n… (diff truncated)` : diff,
      },
    ),
    schema: VerifySchema,
    input: { changeId, base, scenarios: scenarios.length },
  });
  const known = new Map(scenarios.map((s) => [s.id, s]));
  const got = new Map(job.data.scenarios.filter((s) => known.has(s.id)).map((s) => [s.id, s]));
  const result: Verification = {
    changeId,
    ranAt: new Date().toISOString(),
    base,
    head,
    summary: job.data.summary,
    // A scenario the agent skipped is "unclear", never silently "met".
    scenarios: scenarios.map((s) => {
      const v = got.get(s.id);
      return {
        id: s.id,
        requirementId: s.requirementId,
        name: s.name,
        verdict: v?.verdict ?? 'unclear',
        evidence: v?.evidence ?? 'Not assessed by the verifier.',
        files: v?.files ?? [],
      };
    }),
    dropped: job.data.scenarios.filter((s) => !known.has(s.id)).map((s) => s.id),
    jobId: job.id,
  };
  ctx
    .db()
    .prepare('insert or replace into kv (key, value) values (?, ?)')
    .run(`verify:${changeId}`, JSON.stringify(result));
  return result;
}

export function lastVerification(ctx: AppContext, changeId: string): Verification | undefined {
  const row = ctx.db().prepare('select value from kv where key = ?').get(`verify:${changeId}`) as
    | { value: string }
    | undefined;
  return row ? (JSON.parse(row.value) as Verification) : undefined;
}

const MARK: Record<Verdict, string> = { met: '✅', partial: '🟡', 'not-met': '❌', unclear: '❔' };

/** The section the author pastes into (or `orgspec packet` adds to) the PR description. */
export function renderVerificationMd(v: Verification): string {
  const counts = VERDICTS.map((k) => `${v.scenarios.filter((s) => s.verdict === k).length} ${k}`).join(', ');
  return `### Spec check (advisory) · ${v.changeId}

${v.summary}

${counts} · against \`${v.base}\`${v.head ? ` at \`${v.head.slice(0, 7)}\`` : ''}

| Scenario | Verdict | Evidence |
| --- | --- | --- |
${v.scenarios.map((s) => `| \`${s.id}\` | ${MARK[s.verdict]} ${s.verdict} | ${s.evidence.replace(/\|/g, '\\|').replace(/\n/g, ' ')}${s.files.length ? ` (${s.files.map((f) => `\`${f}\``).join(', ')})` : ''} |`).join('\n')}

_Advisory: written by the verifier on the author's machine. Only the deterministic trace in \`orgspec check\` can block a merge._
`;
}
