import { randomUUID } from 'node:crypto';
import { inWindow, nowIso } from '@orgspec/core';
import type { AppContext } from './context.js';

export interface Reminder {
  id: string;
  kind: string;
  subject: string;
  title: string;
  url?: string;
  dueAt: string;
  snoozedUntil?: string;
  done: boolean;
  deliveredAt?: string;
}

const toReminder = (r: Record<string, string | number | null>): Reminder => ({
  id: String(r.id),
  kind: String(r.kind),
  subject: String(r.subject),
  title: String(r.title),
  dueAt: String(r.due_at),
  done: r.done === 1,
  ...(r.url ? { url: String(r.url) } : {}),
  ...(r.snoozed_until ? { snoozedUntil: String(r.snoozed_until) } : {}),
  ...(r.delivered_at ? { deliveredAt: String(r.delivered_at) } : {}),
});

/** Adds a reminder unless an open one for the same kind and subject exists. */
export function remind(
  ctx: AppContext,
  r: { kind: string; subject: string; title: string; url?: string; dueAt?: string },
): string | undefined {
  const db = ctx.db();
  const open = db
    .prepare('select id from reminders where kind = ? and subject = ? and done = 0')
    .get(r.kind, r.subject);
  if (open) return undefined;
  const id = `rem_${randomUUID().slice(0, 10)}`;
  db.prepare('insert into reminders (id, kind, subject, title, url, due_at) values (?, ?, ?, ?, ?, ?)').run(
    id,
    r.kind,
    r.subject,
    r.title,
    r.url ?? null,
    r.dueAt ?? nowIso(),
  );
  return id;
}

export function listReminders(ctx: AppContext, includeDone = false): Reminder[] {
  const rows = ctx
    .db()
    .prepare(`select * from reminders ${includeDone ? '' : 'where done = 0'} order by due_at`)
    .all() as Record<string, string | number | null>[];
  return rows.map(toReminder);
}

export function completeReminder(ctx: AppContext, id: string): void {
  ctx.db().prepare('update reminders set done = 1 where id = ?').run(id);
}

export function snoozeReminder(ctx: AppContext, id: string, until: string): void {
  ctx.db().prepare('update reminders set snoozed_until = ?, delivered_at = null where id = ?').run(until, id);
}

/** Reminders to deliver now: due, not snoozed, not yet delivered, and outside quiet hours. */
export function dueReminders(ctx: AppContext, now = new Date()): Reminder[] {
  const q = ctx.settings.quietHours;
  if (inWindow(now, q.start, q.end)) return [];
  const iso = now.toISOString();
  return listReminders(ctx).filter(
    (r) => r.dueAt <= iso && !r.deliveredAt && (!r.snoozedUntil || r.snoozedUntil <= iso),
  );
}

/** Shows a desktop notification (macOS `osascript`, Linux `notify-send`). */
export async function notify(ctx: AppContext, title: string, body: string): Promise<void> {
  const clean = (s: string) => s.replace(/["\\]/g, '').slice(0, 200);
  if (process.platform === 'darwin') {
    await ctx.runner('osascript', ['-e', `display notification "${clean(body)}" with title "${clean(title)}"`]);
  } else {
    await ctx.runner('notify-send', [clean(title), clean(body)]);
  }
}

/**
 * Delivers due reminders: one digest notification at the person's digest time, or one notification
 * each in `dm` mode. Delivered reminders stay on the dashboard until done.
 */
/** Where reminders go: your own Slack DM when Slack is configured and your Slack ID is known, else a desktop notification. */
async function slackToSelf(ctx: AppContext, text: string): Promise<boolean> {
  const me = ctx.settings.identity.slackUserId;
  if (!me || !ctx.config()?.integrations.servers.slack) return false;
  try {
    await ctx.workplace().slack.post(me, text);
    return true;
  } catch {
    return false;
  }
}

const line = (r: Reminder, base?: string) => `• ${r.title}${r.url && base ? ` <${base}${r.url}|Open>` : ''}`;

/**
 * Delivers due reminders: one daily digest at the person's digest time, or each as it happens in
 * \`dm\` mode. Sent as a DM to yourself through the Slack MCP server (posted by your own OrgSpec), or as
 * a desktop notification without Slack. Each link opens the item in the dashboard, where snoozing and
 * handing off happen. Delivered reminders stay on the dashboard until done.
 */
export async function deliverReminders(
  ctx: AppContext,
  now = new Date(),
  o: { baseUrl?: string } = {},
): Promise<number> {
  const due = dueReminders(ctx, now);
  if (!due.length) return 0;
  const { mode, digestAt } = ctx.settings.reminders;
  const db = ctx.db();
  const mark = db.prepare('update reminders set delivered_at = ? where id = ?');
  if (mode === 'digest') {
    const hhmm = now.toTimeString().slice(0, 5);
    const today = now.toISOString().slice(0, 10);
    const last = (
      db.prepare("select value from kv where key = 'reminders:digest'").get() as { value: string } | undefined
    )?.value;
    if (hhmm < digestAt || last === today) return 0;
    const text = `*Your daily digest · ${due.length} item${due.length === 1 ? '' : 's'}*\n${due.map((r) => line(r, o.baseUrl)).join('\n')}`;
    if (!(await slackToSelf(ctx, text)))
      await notify(
        ctx,
        `OrgSpec: ${due.length} reminder(s)`,
        due
          .slice(0, 3)
          .map((r) => r.title)
          .join(' · '),
      );
    db.prepare("insert or replace into kv (key, value) values ('reminders:digest', ?)").run(today);
  } else {
    for (const r of due) if (!(await slackToSelf(ctx, line(r, o.baseUrl)))) await notify(ctx, 'OrgSpec', r.title);
  }
  for (const r of due) mark.run(nowIso(), r.id);
  return due.length;
}
