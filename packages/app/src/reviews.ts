import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { isGrounded, type Rule, storageToText } from '@orgspec/constitution';
import { exists, nowIso, readText, writeFileAtomic } from '@orgspec/core';
import { loadChange, TODO_MARKER, type Workspace } from '@orgspec/spec-engine';
import { z } from 'zod';
import type { AppContext } from './context.js';
import { promptWith, runAgentJob } from './jobs.js';

export const FindingSchema = z.object({
  rubricId: z.string(),
  verdict: z.enum(['pass', 'concern', 'fail']),
  quote: z.string().default(''),
  finding: z.string(),
  suggestion: z.string().default(''),
  confidence: z.number().min(0).max(1).default(0.7),
  /** Set when the problem is something the document lacks; `missing` names it in a few words. */
  absent: z.boolean().default(false),
  missing: z.string().default(''),
});
export type Finding = z.infer<typeof FindingSchema>;
export const ReviewSchema = z.object({ summary: z.string(), findings: z.array(FindingSchema) });

export interface StoredFinding extends Finding {
  id: string;
  subject: string;
  severity: string;
  status: 'open' | 'accepted' | 'dismissed' | 'resolved';
}

export interface ReviewResult {
  subject: string;
  summary: string;
  findings: StoredFinding[];
  dropped: { finding: Finding; reason: string }[];
  jobId: string;
}

/** Rubric questions for an artifact from the persona's bundle (`rubric` checks). */
export function rubricFor(
  rules: readonly Rule[],
  artifact: string,
): { id: string; question: string; severity: string }[] {
  return rules.flatMap((r) =>
    r.check?.kind === 'rubric' && r.check.artifact === artifact
      ? [{ id: r.id, question: r.check.question, severity: r.severity }]
      : [],
  );
}

/**
 * Grounds findings: a concern or fail must quote the document verbatim and name a rubric rule.
 * Anything else is dropped and reported, never shown as a finding.
 */
export function groundFindings(findings: readonly Finding[], text: string, rubricIds: readonly string[]) {
  const kept: Finding[] = [];
  const dropped: { finding: Finding; reason: string }[] = [];
  for (const f of findings) {
    if (!rubricIds.includes(f.rubricId)) dropped.push({ finding: f, reason: `unknown rubric rule ${f.rubricId}` });
    else if (f.verdict === 'pass') kept.push(f);
    else if (f.absent) {
      // Nothing to quote for an omission; instead the named thing must really be missing from the document.
      const words = f.missing
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 3);
      const lower = text.toLowerCase();
      if (!words.length) dropped.push({ finding: f, reason: 'absence finding does not name what is missing' });
      else if (words.every((w) => lower.includes(w)))
        dropped.push({ finding: f, reason: `the document does mention "${f.missing}"` });
      else kept.push(f);
    } else if (!isGrounded(f.quote, text)) dropped.push({ finding: f, reason: 'quote not found in the document' });
    else kept.push(f);
  }
  return { kept, dropped };
}

function storeFindings(
  ctx: AppContext,
  subject: string,
  findings: readonly Finding[],
  rubric: { id: string; severity: string }[],
): StoredFinding[] {
  const db = ctx.db();
  db.prepare("delete from findings where subject = ? and status = 'open'").run(subject);
  const ins = db.prepare(
    'insert into findings (id, subject, rubric_id, severity, confidence, quote, finding, question, status, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  return findings.map((f) => {
    const severity =
      f.verdict === 'pass'
        ? 'pass'
        : f.verdict === 'fail'
          ? (rubric.find((r) => r.id === f.rubricId)?.severity ?? 'warning')
          : 'advisory';
    const row: StoredFinding = { ...f, id: `fnd_${randomUUID().slice(0, 10)}`, subject, severity, status: 'open' };
    ins.run(row.id, subject, f.rubricId, severity, f.confidence, f.quote, f.finding, f.suggestion, 'open', nowIso());
    return row;
  });
}

export function listFindings(ctx: AppContext, subject?: string): StoredFinding[] {
  const rows = (
    subject
      ? ctx.db().prepare('select * from findings where subject = ? order by created_at').all(subject)
      : ctx.db().prepare("select * from findings where status = 'open' order by created_at desc limit 500").all()
  ) as Record<string, string | number>[];
  return rows.map((r) => ({
    id: String(r.id),
    subject: String(r.subject),
    rubricId: String(r.rubric_id),
    severity: String(r.severity),
    verdict: r.severity === 'pass' ? 'pass' : r.severity === 'advisory' ? 'concern' : 'fail',
    quote: String(r.quote ?? ''),
    finding: String(r.finding),
    suggestion: String(r.question ?? ''),
    confidence: Number(r.confidence ?? 0),
    absent: !r.quote,
    missing: '',
    status: String(r.status) as StoredFinding['status'],
  }));
}

export function setFindingStatus(ctx: AppContext, id: string, status: StoredFinding['status']): void {
  ctx.db().prepare('update findings set status = ? where id = ?').run(status, id);
}

const rulesOrThrow = (ctx: AppContext): Rule[] => {
  const { bundle, diagnostics } = ctx.bundle();
  if (!bundle)
    throw new Error(
      `No usable constitution bundle: ${diagnostics.map((d) => d.message).join('; ') || 'select a persona first'}`,
    );
  return bundle.rules;
};

async function review(
  ctx: AppContext,
  o: { subject: string; artifact: string; agent: string; text: string; context?: Record<string, string> },
): Promise<ReviewResult> {
  const rubric = rubricFor(rulesOrThrow(ctx), o.artifact);
  if (!rubric.length) throw new Error(`The constitution has no rubric for ${o.artifact}`);
  const prompt = promptWith(
    `Review the document against each rubric question below. Return {"summary": string, "findings": [{"rubricId", "verdict": "pass"|"concern"|"fail", "quote", "finding", "suggestion", "confidence", "absent", "missing"}]}, one finding per rubric question. A concern or fail about text in the document quotes that text exactly. A concern or fail about something the document lacks sets "absent": true and names it in "missing" (a few words, for example "rollback plan"); "quote" may then be empty.\n\nRubric:\n${rubric.map((r) => `- ${r.id}: ${r.question}`).join('\n')}`,
    { document: o.text, ...(o.context ?? {}) },
  );
  const job = await runAgentJob(ctx, {
    kind: `review:${o.artifact}`,
    agent: o.agent,
    prompt,
    schema: ReviewSchema,
    input: { subject: o.subject },
  });
  const { kept, dropped } = groundFindings(
    job.data.findings,
    o.text,
    rubric.map((r) => r.id),
  );
  return {
    subject: o.subject,
    summary: job.data.summary,
    findings: storeFindings(ctx, o.subject, kept, rubric),
    dropped,
    jobId: job.id,
  };
}

/** Reviews a PRD on Confluence against the PM rubric. */
export async function reviewPrd(
  ctx: AppContext,
  pageId: string,
): Promise<ReviewResult & { title: string; version: number }> {
  const page = await ctx.workplace().confluence.get(pageId);
  const r = await review(ctx, {
    subject: `prd:${pageId}`,
    artifact: 'prd',
    agent: 'prd-reviewer',
    text: storageToText(page.storage),
  });
  ctx
    .db()
    .prepare('insert or replace into cache_confluence_pages (page_id, title, version, fetched_at) values (?, ?, ?, ?)')
    .run(pageId, page.title, page.version, nowIso());
  return { ...r, title: page.title, version: page.version };
}

/** Reviews a change's design.md (and threat model) against the engineering rubric; writes findings.md. */
export async function reviewDesign(ctx: AppContext, ws: Workspace, changeId: string): Promise<ReviewResult> {
  const change = loadChange(ws, changeId);
  const designFile = join(change.dir, 'design.md');
  if (!exists(designFile)) throw new Error(`${changeId} has no design.md yet`);
  const design = readText(designFile);
  const threat = join(change.dir, 'threat-model.md');
  const context: Record<string, string> = {};
  for (const d of change.deltas) context[`delta:${d.capabilityId}`] = readText(d.file);
  if (exists(threat)) context['threat-model'] = readText(threat);
  const text = [design, context['threat-model'] ?? ''].join('\n');
  const r = await review(ctx, {
    subject: `design:${changeId}`,
    artifact: 'design',
    agent: 'design-reviewer',
    text,
    context,
  });
  writeFileAtomic(join(change.dir, 'findings.md'), renderFindingsMd(changeId, r));
  return r;
}

export function renderFindingsMd(subject: string, r: Pick<ReviewResult, 'summary' | 'findings'>): string {
  const rows = r.findings.filter((f) => f.verdict !== 'pass');
  return `# Review findings: ${subject}

${r.summary}

${rows.length ? rows.map((f) => `## ${f.verdict === 'fail' ? 'Fail' : 'Concern'}: ${f.rubricId}\n\n> ${f.quote}\n\n${f.finding}\n\nSuggestion: ${f.suggestion || '—'}\n`).join('\n') : 'No concerns.'}
Passed: ${
    r.findings
      .filter((f) => f.verdict === 'pass')
      .map((f) => f.rubricId)
      .join(', ') || 'none'
  }
`;
}

export const TaskPlanSchema = z.object({
  tasks: z
    .array(
      z.object({
        title: z.string(),
        scenarios: z.array(z.string()).default([]),
        files: z.array(z.string()).default([]),
        notes: z.string().default(''),
      }),
    )
    .min(1),
});

/** Breaks a reviewed design into tasks.md. Refuses to overwrite tasks someone already wrote unless forced. */
export async function planTasks(
  ctx: AppContext,
  ws: Workspace,
  changeId: string,
  o: { force?: boolean } = {},
): Promise<{ file: string; count: number }> {
  const change = loadChange(ws, changeId);
  const file = join(change.dir, 'tasks.md');
  if (exists(file) && !readText(file).includes(TODO_MARKER) && !o.force)
    throw new Error('tasks.md is already filled in; use --force to replace it');
  const sections: Record<string, string> = {};
  if (exists(join(change.dir, 'design.md'))) sections.design = readText(join(change.dir, 'design.md'));
  for (const d of change.deltas) sections[`delta:${d.capabilityId}`] = readText(d.file);
  const job = await runAgentJob(ctx, {
    kind: 'plan-tasks',
    agent: 'task-planner',
    prompt: promptWith(
      'Return {"tasks": [{"title", "scenarios": [scenario ids], "files": [paths], "notes"}]} in merge order.',
      sections,
    ),
    schema: TaskPlanSchema,
    input: { changeId },
  });
  const body = job.data.tasks
    .map(
      (t, i) =>
        `## ${i + 1}. ${t.title}\n\n- [ ] ${i + 1}.1 Implement${t.files.length ? ` (${t.files.join(', ')})` : ''}\n- [ ] ${i + 1}.2 Tests citing ${t.scenarios.map((s) => `\`${s}\``).join(', ') || 'the affected scenarios'}${t.notes ? `\n\n${t.notes}` : ''}`,
    )
    .join('\n\n');
  writeFileAtomic(file, `# Tasks: ${changeId}\n\n${body}\n`);
  return { file, count: job.data.tasks.length };
}
