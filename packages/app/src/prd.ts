import { isGrounded, storageToText } from '@orgspec/constitution';
import { nowIso } from '@orgspec/core';
import { z } from 'zod';
import type { AppContext } from './context.js';
import { searchDecisions } from './decisions.js';
import { loadJiraConfig } from './gates.js';
import { promptWith, runAgentJob } from './jobs.js';
import {
  FindingSchema,
  groundFindings,
  listFindings,
  rubricFor,
  type StoredFinding,
  setFindingStatus,
  storeFindings,
} from './reviews.js';

// PRD review for engineering managers: rubric findings, dependencies, feasibility, and a decision
// that applies to one page version only.

export const PrdReviewSchema = z.object({
  summary: z.string(),
  completeness: z.number().min(0).max(100).default(0),
  findings: z.array(FindingSchema.extend({ severity: z.enum(['major', 'minor']).default('minor') })),
  dependencies: z
    .array(
      z.object({
        touches: z.string(),
        owner: z.string().default(''),
        consulted: z.boolean().default(false),
        note: z.string().default(''),
      }),
    )
    .default([]),
  feasibility: z
    .array(z.object({ kind: z.enum(['blocker', 'spike', 'note']), text: z.string(), adr: z.string().optional() }))
    .default([]),
});

export interface PrdReview {
  pageId: string;
  title: string;
  version: number;
  author?: string;
  epic?: string;
  reviewedAt: string;
  rubricVersion?: string;
  summary: string;
  completeness: number;
  dependencies: z.infer<typeof PrdReviewSchema>['dependencies'];
  feasibility: (z.infer<typeof PrdReviewSchema>['feasibility'][number] & { verified?: boolean })[];
  dropped: number;
}

export interface PrdDecision {
  decision: 'approved' | 'returned';
  version: number;
  by: string;
  at: string;
  notes?: string;
}

const kv = (ctx: AppContext) => ({
  get: <T>(k: string): T | undefined => {
    const v = (ctx.db().prepare('select value from kv where key = ?').get(k) as { value: string } | undefined)?.value;
    return v ? (JSON.parse(v) as T) : undefined;
  },
  set: (k: string, v: unknown) =>
    ctx.db().prepare('insert or replace into kv (key, value) values (?, ?)').run(k, JSON.stringify(v)),
});

/** The epic a PRD belongs to: an "Epic: KEY" line on the page, else the first Jira key in its title. */
export const epicOf = (title: string, text: string) =>
  /\bepic\s*:?\s*([A-Z][A-Z0-9]+-\d+)/i.exec(text)?.[1] ?? /\b([A-Z][A-Z0-9]+-\d+)\b/.exec(title)?.[1];

export async function reviewPrdFull(ctx: AppContext, pageId: string): Promise<PrdReview> {
  const page = await ctx.workplace().confluence.get(pageId);
  const text = storageToText(page.storage);
  const { bundle } = ctx.bundle();
  if (!bundle) throw new Error('No usable constitution bundle; choose a persona first');
  const rubric = rubricFor(bundle.rules, 'prd');
  if (!rubric.length) throw new Error('The constitution has no PRD rubric');
  const headings = [...text.matchAll(/^#{1,3}\s+(.+)$/gm)].map((m) => m[1]).join(' ');
  const decisions = searchDecisions(ctx.db(), `${page.title} ${headings} ${text.slice(0, 400)}`, 10, { any: true });
  const author = /\b(?:author|owner)\s*:?\s*([A-Z][a-z]+(?: [A-Z][a-z]+)?)/.exec(text)?.[1];
  const job = await runAgentJob(ctx, {
    kind: 'review:prd',
    agent: 'prd-reviewer',
    prompt: promptWith(
      `Review this PRD against each rubric question, then map its dependencies and check feasibility against the decision records given.
Return {"summary", "completeness": 0-100, "findings": [{"rubricId","verdict","severity":"major"|"minor","quote","finding","suggestion","confidence","absent","missing"}], "dependencies": [{"touches","owner","consulted","note"}], "feasibility": [{"kind":"blocker"|"spike"|"note","text","adr"}]}.
A concern or fail about text in the PRD quotes it exactly; one about something missing sets "absent": true and names it in "missing". "suggestion" is a question for the author. A dependency is "consulted" only if the PRD shows that owner commented or agreed. A blocker that conflicts with a decision names its ADR id.

Rubric:
${rubric.map((r) => `- ${r.id}: ${r.question}`).join('\n')}`,
      {
        prd: `# ${page.title} (v${page.version})\n\n${text}`,
        decisions:
          decisions.map((d) => `${d.adrId} [${d.status}] ${d.title}: ${d.snippet}`).join('\n') || 'none indexed',
      },
    ),
    schema: PrdReviewSchema,
    input: { pageId, version: page.version },
  });
  const { kept, dropped } = groundFindings(
    job.data.findings,
    text,
    rubric.map((r) => r.id),
  );
  const sev = new Map(job.data.findings.map((f) => [f.rubricId + f.finding, f.severity]));
  storeFindings(
    ctx,
    `prd:${pageId}`,
    kept.map((f) => ({ ...f, confidence: f.confidence })),
    rubric.map((r) => ({ id: r.id, severity: sev.get(r.id) === 'major' ? 'blocking' : r.severity })),
  );
  // A blocker that cites a decision OrgSpec can't find stays a blocker (dropping it could hide a real
  // concern) but is marked unverified so the reviewer checks it.
  const known = new Set(decisions.map((d) => d.adrId));
  const feasibility = job.data.feasibility.map((f) => ({
    ...f,
    verified: !f.adr || known.has(f.adr) || isGrounded(f.adr, text),
  }));
  const epic = epicOf(page.title, text);
  const review: PrdReview = {
    pageId,
    title: page.title,
    version: page.version,
    reviewedAt: nowIso(),
    summary: job.data.summary,
    completeness: job.data.completeness,
    dependencies: job.data.dependencies,
    feasibility,
    dropped: dropped.length,
    rubricVersion: bundle.manifest.version,
    ...(author ? { author } : {}),
    ...(epic ? { epic } : {}),
  };
  kv(ctx).set(`prd:review:${pageId}`, review);
  ctx
    .db()
    .prepare('insert or replace into cache_confluence_pages (page_id, title, version, fetched_at) values (?, ?, ?, ?)')
    .run(pageId, page.title, page.version, nowIso());
  if (!kv(ctx).get(`prd:seen:${pageId}`))
    ctx.db().prepare('insert or replace into kv (key, value) values (?, ?)').run(`prd:seen:${pageId}`, nowIso());
  return review;
}

export const prdReview = (ctx: AppContext, pageId: string) => kv(ctx).get<PrdReview>(`prd:review:${pageId}`);
export const prdDecision = (ctx: AppContext, pageId: string) => kv(ctx).get<PrdDecision>(`prd:decision:${pageId}`);
export const prdFindings = (ctx: AppContext, pageId: string): StoredFinding[] =>
  listFindings(ctx, `prd:${pageId}`).filter((f) => f.verdict !== 'pass');

export function decideFinding(
  ctx: AppContext,
  id: string,
  decision: 'accepted' | 'rejected' | 'edited',
  text?: string,
): void {
  setFindingStatus(ctx, id, decision === 'rejected' ? 'dismissed' : 'accepted', text);
}

/** Posts accepted findings (in the reviewer's wording when edited) as Confluence comments, as the reviewer. */
export async function postFindings(ctx: AppContext, pageId: string): Promise<number> {
  const accepted = prdFindings(ctx, pageId).filter((f) => f.status === 'accepted');
  const c = ctx.workplace().confluence;
  for (const f of accepted) {
    const body = `<p><strong>${f.rubricId}</strong>${f.quote ? `: “${f.quote}”` : ''}</p><p>${f.edited ?? `${f.finding}${f.suggestion ? ` Question for the author: ${f.suggestion}` : ''}`}</p>`;
    await c.comment(pageId, body);
  }
  return accepted.length;
}

/**
 * Approves or returns a PRD. Approval is refused while feasibility blockers are open and applies to the
 * reviewed version only; a new version needs a fresh look. The Jira PRD-review field is kept current.
 */
export async function decidePrd(
  ctx: AppContext,
  pageId: string,
  decision: PrdDecision['decision'],
  notes?: string,
): Promise<PrdDecision> {
  const review = prdReview(ctx, pageId);
  if (!review) throw new Error('Review the PRD first');
  if (decision === 'approved' && review.feasibility.some((f) => f.kind === 'blocker'))
    throw Object.assign(new Error('Approve is off while blockers are open'), { statusCode: 409 });
  const page = await ctx.workplace().confluence.get(pageId);
  if (page.version !== review.version)
    throw Object.assign(new Error(`The PRD is now v${page.version}; review it again first`), { statusCode: 409 });
  const d: PrdDecision = {
    decision,
    version: review.version,
    by: ctx.settings.identity.email ?? 'me',
    at: nowIso(),
    ...(notes ? { notes } : {}),
  };
  kv(ctx).set(`prd:decision:${pageId}`, d);
  if (notes)
    await ctx
      .workplace()
      .confluence.comment(
        pageId,
        `<p><strong>${decision === 'approved' ? 'Approved' : 'Returned to the author'} (v${review.version}).</strong> ${notes.replace(/</g, '&lt;')}</p>`,
      );
  const field = loadJiraConfig(ctx.configDir).prdReview;
  if (field && review.epic)
    await ctx
      .workplace()
      .jira.setFields(review.epic, { [field]: `${decision} v${review.version}` })
      .catch(() => undefined);
  ctx.db().prepare("update reminders set done = 1 where kind = 'prd-review-wait' and subject = ?").run(pageId);
  return d;
}

export interface QueuedPrd {
  pageId: string;
  title: string;
  version: number;
  epic?: string;
  author?: string;
  waitingDays: number;
  review?: PrdReview;
  decision?: PrdDecision;
  running: boolean;
  blockers: number;
  gaps: number;
  dependencies: number;
  notConsulted: number;
}

export function prdQueue(ctx: AppContext): QueuedPrd[] {
  const db = ctx.db();
  const seen = db.prepare("select key, value from kv where key like 'prd:seen:%'").all() as {
    key: string;
    value: string;
  }[];
  const running = new Set(
    (
      db.prepare("select input from jobs where kind = 'review:prd' and state = 'running'").all() as {
        input: string | null;
      }[]
    ).map((r) => (r.input ? (JSON.parse(r.input) as { pageId?: string }).pageId : undefined)),
  );
  return seen.map((s) => {
    const pageId = s.key.slice('prd:seen:'.length);
    const page = db.prepare('select title, version from cache_confluence_pages where page_id = ?').get(pageId) as
      | { title?: string; version?: number }
      | undefined;
    const review = prdReview(ctx, pageId);
    const decision = prdDecision(ctx, pageId);
    const findings = prdFindings(ctx, pageId);
    const days = Math.floor((Date.now() - Date.parse(s.value)) / 86_400_000);
    return {
      pageId,
      title: review?.title ?? page?.title ?? pageId,
      version: page?.version ?? review?.version ?? 0,
      waitingDays: days,
      running: running.has(pageId),
      blockers: review?.feasibility.filter((f) => f.kind === 'blocker').length ?? 0,
      gaps: findings.filter((f) => f.status === 'open').length,
      dependencies: review?.dependencies.length ?? 0,
      notConsulted: review?.dependencies.filter((d) => !d.consulted).length ?? 0,
      ...(review?.epic ? { epic: review.epic } : {}),
      ...(review?.author ? { author: review.author } : {}),
      ...(review ? { review } : {}),
      ...(decision ? { decision } : {}),
    };
  });
}

/** Rubric items whose findings reviewers keep rejecting: acceptance below 70% goes to the process owner. */
export function processHealth(ctx: AppContext): { rubricId: string; accepted: number; total: number; rate: number }[] {
  const rows = ctx
    .db()
    .prepare("select rubric_id, status from findings where severity != 'pass' and status in ('accepted', 'dismissed')")
    .all() as { rubric_id: string; status: string }[];
  const by = new Map<string, { a: number; t: number }>();
  for (const r of rows) {
    const x = by.get(r.rubric_id) ?? { a: 0, t: 0 };
    x.t++;
    if (r.status === 'accepted') x.a++;
    by.set(r.rubric_id, x);
  }
  return [...by]
    .map(([rubricId, x]) => ({ rubricId, accepted: x.a, total: x.t, rate: x.t ? x.a / x.t : 0 }))
    .sort((a, b) => a.rate - b.rate);
}
