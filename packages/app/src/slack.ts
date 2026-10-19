import { randomUUID } from 'node:crypto';
import { nowIso, openJson, sealJson } from '@orgspec/core';
import type { SlackMessage } from '@orgspec/integrations';
import { z } from 'zod';
import type { AppContext } from './context.js';
import { searchDecisions } from './decisions.js';
import { promptWith, runAgentJob } from './jobs.js';
import { remind } from './reminders.js';

export const WINDOWS = { '24h': 1, '7d': 7, '30d': 30 } as const;
export type SummaryWindow = keyof typeof WINDOWS;

export const SummarySchema = z.object({
  summary: z
    .array(z.object({ topic: z.string(), text: z.string(), messages: z.number().int().default(0) }))
    .default([]),
  tasks: z
    .array(
      z.object({
        text: z.string(),
        owner: z.string().default(''),
        due: z.string().default(''),
        ts: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  decisions: z
    .array(
      z.object({
        text: z.string(),
        by: z.string().default(''),
        date: z.string().default(''),
        ts: z.string().default(''),
      }),
    )
    .default([]),
  questions: z.array(z.object({ text: z.string(), askedOf: z.string().default('') })).default([]),
  nextSteps: z.array(z.string()).default([]),
});
export type SlackSummary = z.infer<typeof SummarySchema>;

export interface StoredSummary extends SlackSummary {
  id: string;
  createdAt: string;
  channels: string[];
  links: string[];
  window: SummaryWindow;
  messages: number;
  range: { from: string; to: string };
  tasksExisting: Record<number, string>;
  decisionConflicts: Record<number, { adrId: string; title: string }>;
  decisionState: Record<number, 'confirmed' | 'rejected'>;
}

/** Channel and ts from a Slack permalink (`…/archives/C01/p1729000000123456`). */
export function parsePermalink(url: string): { channel: string; ts: string } | undefined {
  const m = /archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})/.exec(url);
  return m ? { channel: m[1] as string, ts: `${m[2]}.${m[3]}` } : undefined;
}

/**
 * Summarises up to five channels and twenty threads over a window, as the person (it reads only what
 * they can read). Kept 30 days, encrypted, visible only to them.
 */
export async function summarizeSlack(
  ctx: AppContext,
  o: { channels: string[]; links?: string[]; window?: SummaryWindow },
): Promise<StoredSummary> {
  const channels = o.channels
    .map((c) => c.trim().replace(/^#/, ''))
    .filter(Boolean)
    .slice(0, 5);
  const links = (o.links ?? [])
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 20);
  if (!channels.length && !links.length) throw new Error('Pick at least one channel or thread link');
  const window: SummaryWindow = o.window ?? '7d';
  const oldest = String(Math.floor((Date.now() - WINDOWS[window] * 86_400_000) / 1000));
  const w = ctx.workplace();
  const all: SlackMessage[] = [];
  for (const c of channels) all.push(...(await w.slack.history(c, oldest, 500)));
  for (const l of links) {
    const p = parsePermalink(l);
    if (p) all.push(...(await w.slack.replies(p.channel, p.ts)));
  }
  if (!all.length) throw new Error('No messages in that window');
  const persona = ctx.persona()?.metadata.name ?? 'Individual contributor';
  const me = ctx.settings.identity.slackUserId;
  const job = await runAgentJob(ctx, {
    kind: 'slack-summary',
    agent: 'slack-summarizer',
    prompt: promptWith(
      `Summarise these Slack messages for a ${persona}${me ? ` whose user id is ${me}` : ''}; action items for them come first.
Return {"summary": [{"topic","text","messages"}], "tasks": [{"text","owner","due","ts"}], "decisions": [{"text","by","date","ts"}], "questions": [{"text","askedOf"}], "nextSteps": [string]}.
A decision is only something people explicitly agreed; name who agreed. Say "owner not stated" or leave due empty rather than guessing.`,
      {
        slack: all.map((m) => JSON.stringify({ channel: m.channel, ts: m.ts, from: m.user, text: m.text })).join('\n'),
      },
    ),
    schema: SummarySchema,
    input: { channels, links: links.length, messages: all.length },
  });
  const s = job.data;
  const tasksExisting: Record<number, string> = {};
  const jira = w.jira;
  for (const [i, t] of s.tasks.entries()) {
    const words = t.text.replace(/["\\]/g, '').split(/\s+/).slice(0, 5).join(' ');
    const hit = (await jira.search(`summary ~ "${words}" AND statusCategory != Done`, { limit: 1 }).catch(() => []))[0];
    if (hit) tasksExisting[i] = hit.key;
  }
  const decisionConflicts: Record<number, { adrId: string; title: string }> = {};
  for (const [i, d] of s.decisions.entries()) {
    const words = d.text
      .split(/\W+/)
      .filter((x) => x.length > 4)
      .slice(0, 4)
      .join(' ');
    const hit = words ? searchDecisions(ctx.db(), words, 1).find((h) => h.status !== 'superseded') : undefined;
    if (hit) decisionConflicts[i] = { adrId: hit.adrId, title: hit.title };
  }
  const ts = all.map((m) => Number(m.ts)).sort((a, b) => a - b);
  const stored: StoredSummary = {
    ...s,
    id: `sum_${randomUUID().slice(0, 10)}`,
    createdAt: nowIso(),
    channels,
    links,
    window,
    messages: all.length,
    range: { from: new Date((ts[0] ?? 0) * 1000).toISOString(), to: new Date((ts.at(-1) ?? 0) * 1000).toISOString() },
    tasksExisting,
    decisionConflicts,
    decisionState: {},
  };
  ctx
    .privateDb()
    .prepare('insert into summaries (id, payload, created_at) values (?, ?, ?)')
    .run(stored.id, sealJson(await ctx.key(), stored), stored.createdAt);
  pruneSummaries(ctx);
  return stored;
}

export function pruneSummaries(ctx: AppContext): void {
  ctx
    .privateDb()
    .prepare('delete from summaries where created_at < ?')
    .run(new Date(Date.now() - 30 * 86_400_000).toISOString());
}

export async function listSummaries(ctx: AppContext): Promise<StoredSummary[]> {
  const key = await ctx.key();
  return (
    ctx.privateDb().prepare('select payload from summaries order by created_at desc limit 30').all() as {
      payload: string;
    }[]
  )
    .map((r) => openJson<StoredSummary>(key, r.payload))
    .filter((s) => Array.isArray((s as Partial<StoredSummary>).channels));
}

export async function getSummary(ctx: AppContext, id: string): Promise<StoredSummary> {
  const row = ctx.privateDb().prepare('select payload from summaries where id = ?').get(id) as
    | { payload: string }
    | undefined;
  if (!row) throw Object.assign(new Error('No such summary'), { statusCode: 404 });
  return openJson<StoredSummary>(await ctx.key(), row.payload);
}

async function saveSummary(ctx: AppContext, s: StoredSummary) {
  ctx
    .privateDb()
    .prepare('update summaries set payload = ? where id = ?')
    .run(sealJson(await ctx.key(), s), s.id);
}

export async function markDecision(
  ctx: AppContext,
  id: string,
  index: number,
  state: 'confirmed' | 'rejected',
): Promise<StoredSummary> {
  const s = await getSummary(ctx, id);
  s.decisionState[index] = state;
  await saveSummary(ctx, s);
  return s;
}

/** Creates the summary's tasks in Jira as the person (existing issues are skipped). */
export async function createSummaryTasks(
  ctx: AppContext,
  id: string,
  project: string,
  indexes?: number[],
): Promise<string[]> {
  const s = await getSummary(ctx, id);
  const created: string[] = [];
  for (const [i, t] of s.tasks.entries()) {
    if (indexes && !indexes.includes(i)) continue;
    if (s.tasksExisting[i]) continue;
    const key = await ctx.workplace().jira.create({
      project,
      type: 'Task',
      summary: t.text,
      description: `From a Slack summary of ${s.channels.map((c) => `#${c}`).join(', ')}${t.owner ? `. Owner mentioned: ${t.owner}` : ''}${t.due ? `. Due: ${t.due}` : ''}.`,
    });
    s.tasksExisting[i] = key;
    created.push(key);
  }
  await saveSummary(ctx, s);
  return created;
}

export function renderSummaryText(s: SlackSummary): string {
  const parts = [
    ...s.summary.map((x) => `*${x.topic}.* ${x.text}`),
    s.decisions.length ? `*Decisions:* ${s.decisions.map((d) => d.text).join('; ')}` : '',
    s.questions.length ? `*Open questions:* ${s.questions.map((q) => q.text).join('; ')}` : '',
    s.nextSteps.length ? `*Next steps:* ${s.nextSteps.join('; ')}` : '',
  ];
  return parts.filter(Boolean).join('\n');
}

/** Posts the summary to a thread (the first linked thread, or a channel) as the person. */
export async function postSummary(ctx: AppContext, id: string, target?: string): Promise<string> {
  const s = await getSummary(ctx, id);
  const link = s.links[0] ? parsePermalink(s.links[0]) : undefined;
  const channel = target ?? link?.channel ?? s.channels[0];
  if (!channel) throw new Error('Nowhere to post');
  return ctx
    .workplace()
    .slack.post(channel, `Summary (${s.messages} messages):\n${renderSummaryText(s)}`, target ? undefined : link?.ts);
}

export function remindQuestion(ctx: AppContext, s: StoredSummary, index: number): string | undefined {
  const q = s.questions[index];
  if (!q) return undefined;
  return remind(ctx, {
    kind: 'slack-question',
    subject: `${s.id}:${index}`,
    title: `Open question${q.askedOf ? ` for ${q.askedOf}` : ''}: ${q.text}`,
    dueAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
  });
}
