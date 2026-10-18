import { randomUUID } from 'node:crypto';
import { nowIso, openJson, sealJson } from '@orgspec/core';
import type { SlackMessage } from '@orgspec/integrations';
import { z } from 'zod';
import type { AppContext } from './context.js';
import { promptWith, runAgentJob } from './jobs.js';

export const TriageSchema = z.object({
  tasks: z.array(
    z.object({
      title: z.string(),
      from: z.string().default(''),
      due: z.string().optional(),
      ts: z.string(),
      conversation: z.string(),
      kind: z.enum(['ask', 'review', 'decision', 'fyi']).default('ask'),
    }),
  ),
});
export type TriagedTask = z.infer<typeof TriageSchema>['tasks'][number];

export interface InboxTask extends TriagedTask {
  id: string;
  state: 'open' | 'done' | 'snoozed' | 'dismissed';
  pinned: boolean;
  createdAt: string;
}

/**
 * Pulls new direct messages, asks Claude which ones ask something of this person, and stores the
 * resulting tasks encrypted in the private DB. Message text never leaves this machine except to
 * the local `claude -p` run.
 */
export async function syncDmInbox(
  ctx: AppContext,
): Promise<{ conversations: number; messages: number; tasks: number }> {
  const s = ctx.settings;
  if (!s.dmInbox.enabled) return { conversations: 0, messages: 0, tasks: 0 };
  const slack = ctx.workplace().slack;
  const db = ctx.privateDb();
  const key = await ctx.key();
  const convos = (await slack.directConversations()).filter(
    (c) => !s.dmInbox.excluded.includes(c.id) && !(c.user && s.dmInbox.excluded.includes(c.user)),
  );
  const fresh: SlackMessage[] = [];
  const cursors = new Map<string, string>();
  for (const c of convos) {
    const cur = (
      db.prepare('select last_ts from inbox_cursor where conversation = ?').get(c.id) as { last_ts: string } | undefined
    )?.last_ts;
    const msgs = (await slack.history(c.id, cur)).filter(
      (m) => (!cur || Number(m.ts) > Number(cur)) && m.user !== s.identity.slackUserId,
    );
    if (!msgs.length) continue;
    fresh.push(...msgs);
    cursors.set(
      c.id,
      msgs
        .map((m) => m.ts)
        .sort()
        .at(-1) as string,
    );
  }
  let added = 0;
  if (fresh.length) {
    const job = await runAgentJob(ctx, {
      kind: 'dm-inbox',
      agent: 'inbox-triage',
      prompt: promptWith(
        'Return {"tasks": [{"title", "from", "due", "ts", "conversation", "kind"}]}. Only messages that ask this person for something.',
        {
          messages: fresh
            .map((m) => JSON.stringify({ conversation: m.channel, ts: m.ts, from: m.user, text: m.text }))
            .join('\n'),
        },
      ),
      schema: TriageSchema,
      input: { messages: fresh.length },
    });
    const known = new Set(fresh.map((m) => `${m.channel}:${m.ts}`));
    const ins = db.prepare(
      'insert into inbox_tasks (id, conversation, kind, payload, group_key, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)',
    );
    for (const t of job.data.tasks) {
      if (!known.has(`${t.conversation}:${t.ts}`)) continue;
      ins.run(
        `inb_${randomUUID().slice(0, 10)}`,
        t.conversation,
        t.kind,
        sealJson(key, t),
        t.from || t.conversation,
        nowIso(),
        nowIso(),
      );
      added++;
    }
  }
  const up = db.prepare('insert or replace into inbox_cursor (conversation, last_ts) values (?, ?)');
  for (const [c, ts] of cursors) up.run(c, ts);
  return { conversations: convos.length, messages: fresh.length, tasks: added };
}

export async function listInbox(ctx: AppContext, includeClosed = false): Promise<InboxTask[]> {
  const key = await ctx.key();
  const rows = ctx
    .privateDb()
    .prepare(
      `select * from inbox_tasks ${includeClosed ? '' : "where state in ('open', 'snoozed')"} order by pinned desc, created_at desc`,
    )
    .all() as { id: string; payload: string; state: InboxTask['state']; pinned: number; created_at: string }[];
  return rows.map((r) => ({
    ...openJson<TriagedTask>(key, r.payload),
    id: r.id,
    state: r.state,
    pinned: r.pinned === 1,
    createdAt: r.created_at,
  }));
}

export function updateInboxTask(
  ctx: AppContext,
  id: string,
  patch: { state?: InboxTask['state']; pinned?: boolean },
): void {
  const db = ctx.privateDb();
  if (patch.state)
    db.prepare('update inbox_tasks set state = ?, updated_at = ?, closed_at = ? where id = ?').run(
      patch.state,
      nowIso(),
      patch.state === 'done' || patch.state === 'dismissed' ? nowIso() : null,
      id,
    );
  if (patch.pinned !== undefined)
    db.prepare('update inbox_tasks set pinned = ?, updated_at = ? where id = ?').run(
      patch.pinned ? 1 : 0,
      nowIso(),
      id,
    );
}

export const SummarySchema = z.object({
  decisions: z.array(z.object({ text: z.string(), by: z.string().default(''), ts: z.string() })).default([]),
  questions: z.array(z.object({ text: z.string(), from: z.string().default(''), ts: z.string() })).default([]),
  followUps: z.array(z.object({ text: z.string(), owner: z.string().default(''), ts: z.string() })).default([]),
  summary: z.string(),
});
export type SlackSummary = z.infer<typeof SummarySchema>;

/** Summarises a channel or thread since a timestamp; the summary is stored encrypted. */
export async function summarizeSlack(
  ctx: AppContext,
  o: { channel: string; since?: string; thread?: string },
): Promise<SlackSummary & { id: string; messages: number }> {
  const slack = ctx.workplace().slack;
  const msgs = o.thread ? await slack.replies(o.channel, o.thread) : await slack.history(o.channel, o.since);
  if (!msgs.length)
    return { id: '', messages: 0, decisions: [], questions: [], followUps: [], summary: 'No messages in that window.' };
  const job = await runAgentJob(ctx, {
    kind: 'slack-summary',
    agent: 'slack-summarizer',
    prompt: promptWith(
      'Return {"summary", "decisions": [{"text","by","ts"}], "questions": [{"text","from","ts"}], "followUps": [{"text","owner","ts"}]}.',
      {
        slack: msgs.map((m) => JSON.stringify({ ts: m.ts, from: m.user, text: m.text })).join('\n'),
      },
    ),
    schema: SummarySchema,
    input: { channel: o.channel, messages: msgs.length },
  });
  const id = `sum_${randomUUID().slice(0, 10)}`;
  ctx
    .privateDb()
    .prepare('insert into summaries (id, payload, created_at) values (?, ?, ?)')
    .run(id, sealJson(await ctx.key(), { ...o, ...job.data }), nowIso());
  return { ...job.data, id, messages: msgs.length };
}
