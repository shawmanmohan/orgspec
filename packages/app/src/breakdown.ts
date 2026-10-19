import { storageToText } from '@orgspec/constitution';
import { nowIso } from '@orgspec/core';
import { z } from 'zod';
import type { AppContext } from './context.js';
import { loadJiraConfig } from './gates.js';
import { promptWith, runAgentJob } from './jobs.js';
import { prdDecision, prdReview } from './prd.js';

// Approved PRD → epics and stories → Jira, created as the person after their click.

export const BreakdownSchema = z.object({
  epics: z
    .array(
      z.object({
        title: z.string(),
        team: z.string().default(''),
        stories: z.array(
          z.object({
            order: z.string(),
            title: z.string(),
            size: z.enum(['S', 'M', 'L']).default('M'),
            tier: z.enum(['low', 'medium', 'high']).default('medium'),
            after: z.array(z.string()).default([]),
            team: z.string().default(''),
          }),
        ),
      }),
    )
    .min(1),
});
export type Breakdown = z.infer<typeof BreakdownSchema> & {
  pageId: string;
  version: number;
  createdAt: string;
  created?: Record<string, string>;
};

const key = (pageId: string) => `breakdown:${pageId}`;

export function getBreakdown(ctx: AppContext, pageId: string): Breakdown | undefined {
  const v = (ctx.db().prepare('select value from kv where key = ?').get(key(pageId)) as { value: string } | undefined)
    ?.value;
  return v ? (JSON.parse(v) as Breakdown) : undefined;
}

export function saveBreakdown(ctx: AppContext, b: Breakdown): void {
  ctx.db().prepare('insert or replace into kv (key, value) values (?, ?)').run(key(b.pageId), JSON.stringify(b));
}

/** Drafts a breakdown with the task planner. Only approved PRDs (this version) can be broken down. */
export async function draftBreakdown(ctx: AppContext, pageId: string): Promise<Breakdown> {
  const d = prdDecision(ctx, pageId);
  const r = prdReview(ctx, pageId);
  if (d?.decision !== 'approved') throw Object.assign(new Error('Approve the PRD first'), { statusCode: 409 });
  const page = await ctx.workplace().confluence.get(pageId);
  const teams = Object.keys(loadJiraConfig(ctx.configDir).teams);
  const job = await runAgentJob(ctx, {
    kind: 'breakdown',
    agent: 'task-planner',
    prompt: promptWith(
      `Break this approved PRD into epics and stories for Jira. Return {"epics": [{"title","team","stories": [{"order":"1.1","title","size":"S"|"M"|"L","tier":"low"|"medium"|"high","after":["1.1"],"team"}]}]}.
Each story fits one pull request. "after" lists story orders it depends on. Suggest "high" tier for data migrations, money movement, auth or cross-team schemas. ${teams.length ? `Teams: ${teams.join(', ')}. Set a story's team when it belongs to a different team than its epic.` : ''}`,
      {
        prd: `# ${page.title} (v${page.version})\n\n${storageToText(page.storage)}`,
        dependencies: JSON.stringify(r?.dependencies ?? []),
      },
    ),
    schema: BreakdownSchema,
    input: { pageId },
  });
  const b: Breakdown = { ...job.data, pageId, version: page.version, createdAt: nowIso() };
  saveBreakdown(ctx, b);
  return b;
}

export interface CreatePlanItem {
  order: string;
  project: string;
  summary: string;
  duplicateOf?: string;
  epic: number;
  crossTeam?: string;
}

/** Where each story goes and which already exist, before anything is created. */
export async function planBreakdown(ctx: AppContext, b: Breakdown, project: string): Promise<CreatePlanItem[]> {
  const teams = loadJiraConfig(ctx.configDir).teams;
  const items: CreatePlanItem[] = [];
  for (const [ei, e] of b.epics.entries()) {
    for (const s of e.stories) {
      const team = s.team || e.team;
      const proj = (team && teams[team]) || project;
      const words = s.title.replace(/["\\]/g, '').split(/\s+/).slice(0, 6).join(' ');
      const hit = (
        await ctx
          .workplace()
          .jira.search(`project = ${proj} AND summary ~ "${words}"`, { limit: 1 })
          .catch(() => [])
      )[0];
      items.push({
        order: s.order,
        project: proj,
        summary: s.title,
        epic: ei,
        ...(hit ? { duplicateOf: hit.key } : {}),
        ...(proj !== project ? { crossTeam: team } : {}),
      });
    }
  }
  return items;
}

/** Creates epics, stories and "is blocked by" links in Jira, as the person, linked to the PRD. */
export async function createBreakdown(
  ctx: AppContext,
  pageId: string,
  project: string,
): Promise<Record<string, string>> {
  const b = getBreakdown(ctx, pageId);
  if (!b) throw new Error('Draft a breakdown first');
  const review = prdReview(ctx, pageId);
  const jira = ctx.workplace().jira;
  const plan = await planBreakdown(ctx, b, project);
  const created: Record<string, string> = { ...(b.created ?? {}) };
  const epicKeys: string[] = [];
  for (const [ei, e] of b.epics.entries()) {
    const ek =
      created[`epic:${ei}`] ??
      (await jira.create({
        project,
        type: 'Epic',
        summary: e.title,
        description: `From PRD “${review?.title ?? pageId}” v${b.version}${review?.epic ? ` (${review.epic})` : ''}.`,
      }));
    created[`epic:${ei}`] = ek;
    epicKeys.push(ek);
  }
  for (const item of plan) {
    if (created[item.order]) continue;
    if (item.duplicateOf) {
      created[item.order] = item.duplicateOf;
      continue;
    }
    const story = b.epics[item.epic]?.stories.find((s) => s.order === item.order);
    created[item.order] = await jira.create({
      project: item.project,
      type: 'Story',
      summary: item.summary,
      description: `From PRD “${review?.title ?? pageId}” v${b.version}. Suggested tier: ${story?.tier ?? 'medium'}; size ${story?.size ?? 'M'}. Owners confirm the tier.${item.crossTeam ? ` Belongs to the ${item.crossTeam} team; its lead is asked to accept it.` : ''}`,
      fields: item.crossTeam ? {} : { parent: { key: epicKeys[item.epic] } },
    });
  }
  for (const e of b.epics) {
    for (const s of e.stories) {
      for (const dep of s.after) {
        const a = created[s.order];
        const d = created[dep];
        if (a && d) await jira.link(a, d).catch(() => undefined);
      }
    }
  }
  saveBreakdown(ctx, { ...b, created });
  return created;
}
