import { randomUUID } from 'node:crypto';
import { nowIso, openJson, sealJson } from '@orgspec/core';
import type { SlackMessage } from '@orgspec/integrations';
import { z } from 'zod';
import type { AppContext } from './context.js';
import { promptWith, runAgentJob } from './jobs.js';
import { slackName } from './oneonone.js';

export const TASK_KINDS = ['request', 'saved', 'commitment', 'question', 'fyi'] as const;

export const TriageSchema = z.object({
  tasks: z.array(
    z.object({
      title: z.string(),
      from: z.string().default(''),
      due: z.string().optional(),
      ts: z.string(),
      conversation: z.string(),
      kind: z
        .enum([...TASK_KINDS, 'ask', 'review', 'decision'])
        .default('request')
        .transform((k): (typeof TASK_KINDS)[number] =>
          k === 'ask' || k === 'review' || k === 'decision' ? 'request' : k,
        ),
      excerpt: z.string().default(''),
      /** Short reason this task is ranked where it is ("due tomorrow; Priya is blocked"). */
      why: z.string().default(''),
      /** 1 = do first … 5 = whenever. */
      priority: z.number().int().min(1).max(5).default(3),
      /** Theme or Jira epic key for grouping. */
      group: z.string().default(''),
      jira: z.string().optional(),
    }),
  ),
});
export type TriagedTask = z.infer<typeof TriageSchema>['tasks'][number];

export interface InboxTask extends TriagedTask {
  id: string;
  state: 'open' | 'done' | 'snoozed' | 'dismissed';
  pinned: boolean;
  createdAt: string;
  /** Other messages merged into this task (the same commitment seen twice). */
  sources: { conversation: string; ts: string }[];
  /** You replied in the conversation after this message. */
  repliedAt?: string;
}

const REPLIED = 'replied:';

const groupName = (ctx: AppContext, key: string) =>
  (ctx.db().prepare('select value from kv where key = ?').get(`inbox:group:${key}`) as { value: string } | undefined)
    ?.value ?? key;

/**
 * Pulls new direct messages (and saved messages when the Slack server offers them), asks Claude which
 * ones need something from this person, and stores the tasks encrypted in the private DB. Message text
 * never leaves this machine except to the local `claude -p` run.
 */
export async function syncDmInbox(
  ctx: AppContext,
): Promise<{ conversations: number; messages: number; tasks: number }> {
  const s = ctx.settings;
  if (!s.dmInbox.enabled) return { conversations: 0, messages: 0, tasks: 0 };
  const w = ctx.workplace();
  const db = ctx.privateDb();
  const key = await ctx.key();
  const me = s.identity.slackUserId;
  const convos = (await w.slack.directConversations()).filter(
    (c) => !s.dmInbox.excluded.includes(c.id) && !(c.user && s.dmInbox.excluded.includes(c.user)),
  );
  const fresh: (SlackMessage & { mine: boolean })[] = [];
  const cursors = new Map<string, string>();
  const myReplies = new Map<string, string>();
  for (const c of convos) {
    const cur = (
      db.prepare('select last_ts from inbox_cursor where conversation = ?').get(c.id) as { last_ts: string } | undefined
    )?.last_ts;
    const msgs = (await w.slack.history(c.id, cur)).filter((m) => !cur || Number(m.ts) > Number(cur));
    if (!msgs.length) continue;
    for (const m of msgs) {
      const mine = Boolean(me && m.user === me);
      fresh.push({ ...m, mine });
      if (mine && Number(m.ts) > Number(myReplies.get(c.id) ?? 0)) myReplies.set(c.id, m.ts);
    }
    cursors.set(
      c.id,
      msgs
        .map((m) => m.ts)
        .sort((a, b) => Number(a) - Number(b))
        .at(-1) as string,
    );
  }
  let saved: SlackMessage[] = [];
  if (w.ops.has('slack.saved')) {
    const res = await w.ops.run('slack.saved', {}).catch(() => undefined);
    const items =
      (res as { items?: { channel?: string; message?: { ts?: string; text?: string; user?: string } }[] } | undefined)
        ?.items ?? [];
    saved = items.flatMap((i) =>
      i.message?.ts
        ? [
            {
              channel: i.channel ?? '',
              ts: i.message.ts,
              text: i.message.text ?? '',
              ...(i.message.user ? { user: i.message.user } : {}),
            },
          ]
        : [],
    );
  }

  let added = 0;
  const lines = [
    ...fresh.map((m) =>
      JSON.stringify({
        conversation: m.channel,
        ts: m.ts,
        from: m.mine ? 'ME' : slackName(ctx, m.user ?? ''),
        text: m.text,
      }),
    ),
    ...saved.map((m) =>
      JSON.stringify({
        conversation: m.channel,
        ts: m.ts,
        from: slackName(ctx, m.user ?? ''),
        text: m.text,
        saved: true,
      }),
    ),
  ];
  if (lines.length) {
    const job = await runAgentJob(ctx, {
      kind: 'dm-inbox',
      agent: 'inbox-triage',
      prompt: promptWith(
        `Turn these Slack messages into tasks for the person whose messages are marked from "ME". Return {"tasks": [{"title","from","due","ts","conversation","kind","excerpt","why","priority","group","jira"}]}.
kind: "request" (someone asks them for something), "saved" (a message they saved), "commitment" (they promised something, e.g. "I'll send it tomorrow"), "question" (someone waits for their answer), "fyi" (no action needed).
excerpt: a short quote of the message. why: one short reason for the priority. priority: 1 only when it is due within two days, overdue, or someone says they are blocked; 2 when someone is waiting on an answer; 3 for other requests and commitments; 4–5 for saved messages without a deadline. group: a short theme, or a Jira epic key when the message names one. jira: a ticket key the message names, if any. Skip chit-chat entirely.`,
        { messages: lines.join('\n') },
      ),
      schema: TriageSchema,
      input: { messages: lines.length },
    });
    const known = new Set([...fresh, ...saved].map((m) => `${m.channel}:${m.ts}`));
    const existing = await listInbox(ctx, true);
    const ins = db.prepare(
      'insert into inbox_tasks (id, conversation, kind, payload, group_key, rank, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const t of job.data.tasks) {
      if (!known.has(`${t.conversation}:${t.ts}`)) continue;
      // The same commitment seen in two places becomes one task with two sources.
      const dup = existing.find(
        (e) => e.state === 'open' && e.kind === t.kind && e.title.toLowerCase() === t.title.toLowerCase(),
      );
      if (dup) {
        dup.sources = [...dup.sources, { conversation: t.conversation, ts: t.ts }];
        db.prepare('update inbox_tasks set payload = ?, updated_at = ? where id = ?').run(
          sealJson(key, stripMeta(dup)),
          nowIso(),
          dup.id,
        );
        continue;
      }
      const id = `inb_${randomUUID().slice(0, 10)}`;
      const sources = [{ conversation: t.conversation, ts: t.ts }];
      ins.run(
        id,
        t.conversation,
        t.kind,
        sealJson(key, { ...t, sources }),
        t.group || t.jira || '',
        6 - t.priority,
        nowIso(),
        nowIso(),
      );
      // Later tasks in this batch can merge into this one.
      existing.push({ ...t, sources, id, state: 'open', pinned: false, createdAt: nowIso() });
      added++;
    }
  }
  const up = db.prepare('insert or replace into inbox_cursor (conversation, last_ts) values (?, ?)');
  for (const [c, ts] of cursors) up.run(c, ts);
  for (const [c, ts] of myReplies) up.run(`${REPLIED}${c}`, ts);
  return { conversations: convos.length, messages: fresh.length + saved.length, tasks: added };
}

const stripMeta = (t: InboxTask) => {
  const { id: _i, state: _s, pinned: _p, createdAt: _c, repliedAt: _r, ...rest } = t;
  return rest;
};

export async function listInbox(ctx: AppContext, includeClosed = false): Promise<InboxTask[]> {
  const key = await ctx.key();
  const pdb = ctx.privateDb();
  const rows = pdb
    .prepare(
      `select * from inbox_tasks ${includeClosed ? '' : "where state in ('open', 'snoozed')"} order by pinned desc, rank desc, created_at desc`,
    )
    .all() as {
    id: string;
    conversation: string;
    payload: string;
    state: InboxTask['state'];
    pinned: number;
    created_at: string;
    group_key: string | null;
  }[];
  const replied = new Map(
    (
      pdb.prepare('select conversation, last_ts from inbox_cursor where conversation like ?').all(`${REPLIED}%`) as {
        conversation: string;
        last_ts: string;
      }[]
    ).map((r) => [r.conversation.slice(REPLIED.length), r.last_ts]),
  );
  return rows.map((r) => {
    const t = openJson<TriagedTask & { sources?: InboxTask['sources'] }>(key, r.payload);
    const rep = replied.get(r.conversation);
    return {
      ...t,
      group: r.group_key ? groupName(ctx, r.group_key) : t.group,
      sources: t.sources ?? [{ conversation: t.conversation, ts: t.ts }],
      id: r.id,
      state: r.state,
      pinned: r.pinned === 1,
      createdAt: r.created_at,
      ...(rep && Number(rep) > Number(t.ts) ? { repliedAt: rep } : {}),
    };
  });
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

export function renameGroup(ctx: AppContext, groupKey: string, name: string): void {
  ctx.db().prepare('insert or replace into kv (key, value) values (?, ?)').run(`inbox:group:${groupKey}`, name);
}

/** Removes closed tasks 14 days after they were closed (the retention the privacy table promises). */
export function pruneInbox(ctx: AppContext): number {
  const cutoff = new Date(Date.now() - 14 * 86_400_000).toISOString();
  return Number(
    ctx
      .privateDb()
      .prepare("delete from inbox_tasks where state in ('done', 'dismissed') and closed_at < ?")
      .run(cutoff).changes,
  );
}

export interface JiraPlan {
  project: string;
  shape: 'epic' | 'story-subtasks' | 'separate';
  epic?: string;
  items: { taskId: string; summary: string; duplicateOf?: string }[];
}

/** Preview of sending tasks to Jira, with existing issues found by summary so nothing is duplicated. */
export async function planJira(
  ctx: AppContext,
  taskIds: string[],
  o: { project: string; shape: JiraPlan['shape']; epic?: string },
): Promise<JiraPlan> {
  const tasks = (await listInbox(ctx)).filter((t) => taskIds.includes(t.id));
  const jira = ctx.workplace().jira;
  const items: JiraPlan['items'] = [];
  for (const t of tasks) {
    const words = t.title.replace(/["\\]/g, '').split(/\s+/).slice(0, 6).join(' ');
    const hit = t.jira
      ? { key: t.jira }
      : (
          await jira
            .search(`project = ${o.project} AND summary ~ "${words}" AND statusCategory != Done`, { limit: 1 })
            .catch(() => [])
        )[0];
    items.push({ taskId: t.id, summary: t.title, ...(hit ? { duplicateOf: hit.key } : {}) });
  }
  return { project: o.project, shape: o.shape, ...(o.epic ? { epic: o.epic } : {}), items };
}

/**
 * Creates the planned issues as the person, after their click. Duplicates are linked instead of
 * created; optionally replies in each Slack thread with the new link.
 */
export async function sendToJira(
  ctx: AppContext,
  plan: JiraPlan,
  o: { replyInSlack?: boolean } = {},
): Promise<{ created: string[]; linked: string[] }> {
  const w = ctx.workplace();
  const tasks = new Map((await listInbox(ctx)).map((t) => [t.id, t]));
  const created: string[] = [];
  const linked: string[] = [];
  let parent: string | undefined;
  const fresh = plan.items.filter((i) => !i.duplicateOf);
  if (plan.shape !== 'separate' && fresh.length > 1) {
    parent = await w.jira.create({
      project: plan.project,
      type: plan.shape === 'epic' ? 'Epic' : 'Story',
      summary: plan.epic || `Follow-ups from Slack (${new Date().toISOString().slice(0, 10)})`,
      description: 'Created by OrgSpec from the task inbox.',
    });
    created.push(parent);
  }
  for (const i of plan.items) {
    const t = tasks.get(i.taskId);
    let issueKey = i.duplicateOf;
    if (issueKey) linked.push(issueKey);
    else {
      issueKey = await w.jira.create({
        project: plan.project,
        type: parent && plan.shape === 'story-subtasks' ? 'Sub-task' : 'Story',
        summary: i.summary,
        description: `From Slack${t?.from ? ` (${t.from})` : ''}: ${t?.excerpt ?? ''}\n\nCreated by OrgSpec from the task inbox.`,
        ...(parent ? { fields: { parent: { key: parent } } } : {}),
      });
      created.push(issueKey);
    }
    if (o.replyInSlack && t)
      await w.slack.post(t.conversation, `Tracked in Jira: ${issueKey}`, t.ts).catch(() => undefined);
    if (t) updateInboxTask(ctx, t.id, { state: 'done' });
  }
  return { created, linked };
}
