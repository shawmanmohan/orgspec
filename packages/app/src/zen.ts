import { randomUUID } from 'node:crypto';
import { nowIso, openJson, sealJson, type ZenConfig, ZenConfigSchema } from '@orgspec/core';
import { z } from 'zod';
import type { AppContext } from './context.js';
import { listInbox } from './inbox.js';
import { promptWith, runAgentJob } from './jobs.js';
import { listReminders, notify, type Reminder, slackToSelf } from './reminders.js';
import { myIssues, mySessions } from './work.js';

/**
 * Zen mode: a private focus session that runs entirely on this machine. It suggests up to three focus
 * items, holds notifications until the end, sets the person's Slack status and Do Not Disturb, and can
 * freeze other agents. Nothing about a session is synced, reported or used as a metric.
 */

export type FocusCategory = ZenConfig['priorityOrder'][number];

export interface FocusItem {
  /** `ticket:PROJ-1`, `task:inb_…` or `reminder:rem_…`. */
  id: string;
  kind: 'ticket' | 'task' | 'reminder';
  title: string;
  /** Dashboard link. */
  url?: string;
  category: FocusCategory;
  reason: string;
  done?: boolean;
}

export interface ZenSession {
  id: string;
  startedAt: string;
  endsAt: string;
  endedAt?: string;
  focus: FocusItem[];
  options: { slackStatus: boolean; autoReply: boolean; freeze: boolean };
  /** Slack status before the session, restored at the end. */
  presence?: { set: boolean; previous?: { text: string; emoji: string; expiration: number }; error?: string };
  /** Agent sessions stopped by "freeze", restarted at the end. */
  frozen: string[];
  /** DM conversations already auto-replied to in this session. */
  replied: string[];
}

export interface HeldItem {
  id: string;
  kind: string;
  title: string;
  url?: string;
  createdAt: string;
}

const MAX_FOCUS = 3;

export function zenConfig(ctx: AppContext): ZenConfig {
  return ctx.config()?.zen ?? ZenConfigSchema.parse({});
}

const hhmm = (iso: string) => new Date(iso).toTimeString().slice(0, 5);
const today = (now: Date) => now.toISOString().slice(0, 10);

const INCIDENT = /\b(incident|sev[ -]?[0-2]|outage|on-?call|page)\b/i;
const SECURITY = /\b(security|vulnerab|cve-\d|secret|leak)/i;

/** Reminders that always reach you during a session: incidents, on-call pages and the org's own list. */
export function breaksThrough(r: Pick<Reminder, 'kind' | 'title'>, cfg: ZenConfig): boolean {
  return INCIDENT.test(r.kind) || INCIDENT.test(r.title) || cfg.breakThrough.includes(r.kind);
}

/** Persona weighting inside a category: managers see reviews and 1:1s first, PMs programs, ICs tickets. */
function personaBonus(ctx: AppContext, item: Pick<FocusItem, 'kind' | 'title'>): number {
  const id = ctx.settings.persona ?? '';
  if (/manager|lead|em\b/i.test(id)) return /review|prd|design|1:1|approval/i.test(item.title) ? 1 : 0;
  if (/project|program|pm\b/i.test(id)) return /risk|program|blocked|unassigned/i.test(item.title) ? 1 : 0;
  return item.kind === 'ticket' ? 1 : 0;
}

/**
 * Ranks candidate focus items: the org's category order first (incidents, security, blocking others,
 * due today, current work), then persona weighting, then each source's own ranking. Deterministic.
 */
export async function rankFocus(ctx: AppContext, now = new Date()): Promise<FocusItem[]> {
  const cfg = zenConfig(ctx);
  const day = today(now);
  const out: (FocusItem & { order: number })[] = [];
  let order = 0;
  for (const i of myIssues(ctx)) {
    if (/done|closed|resolved|cancel/i.test(i.status)) continue;
    const text = `${i.type ?? ''} ${i.summary}`;
    const category: FocusCategory = INCIDENT.test(text)
      ? 'incident'
      : SECURITY.test(text)
        ? 'security'
        : 'current-work';
    const active = /progress|review/i.test(i.status);
    if (category === 'current-work' && !active) continue;
    out.push({
      id: `ticket:${i.key}`,
      kind: 'ticket',
      title: `${i.key} ${i.summary}`,
      url: `/ticket/${i.key}`,
      category,
      reason: category === 'incident' ? 'Incident ticket assigned to you' : `Your ticket is ${i.status.toLowerCase()}`,
      order: order++,
    });
  }
  const tasks = await listInbox(ctx).catch(() => []);
  for (const t of tasks) {
    if (t.kind === 'fyi') continue;
    const blocking = t.priority === 1 && /block/i.test(`${t.why} ${t.excerpt}`);
    const dueToday = Boolean(t.due && t.due.slice(0, 10) <= day);
    const category: FocusCategory = INCIDENT.test(t.title)
      ? 'incident'
      : blocking
        ? 'blocking-others'
        : dueToday
          ? 'due-today'
          : 'current-work';
    if (category === 'current-work' && t.priority > 2) continue;
    out.push({
      id: `task:${t.id}`,
      kind: 'task',
      title: t.title,
      url: '/inbox',
      category,
      reason: t.why || (t.from ? `${t.from} is waiting on you` : 'Waiting on you'),
      order: order++,
    });
  }
  for (const r of listReminders(ctx)) {
    if (r.dueAt.slice(0, 10) > day) continue;
    out.push({
      id: `reminder:${r.id}`,
      kind: 'reminder',
      title: r.title,
      ...(r.url ? { url: r.url } : {}),
      category: breaksThrough(r, cfg) ? 'incident' : 'due-today',
      reason: 'Due today',
      order: order++,
    });
  }
  const rank = (c: FocusCategory) => {
    const n = cfg.priorityOrder.indexOf(c);
    return n < 0 ? cfg.priorityOrder.length : n;
  };
  return out
    .sort(
      (a, b) => rank(a.category) - rank(b.category) || personaBonus(ctx, b) - personaBonus(ctx, a) || a.order - b.order,
    )
    .map(({ order: _o, ...f }) => f);
}

const ReasonsSchema = z.object({ reasons: z.array(z.string()) });

/** Up to three focus suggestions. A `claude -p` run (Haiku) words the reasons; ranking never depends on it. */
export async function suggestFocus(ctx: AppContext, o: { now?: Date; reasons?: boolean } = {}): Promise<FocusItem[]> {
  const top = (await rankFocus(ctx, o.now)).slice(0, MAX_FOCUS);
  if (!top.length || o.reasons === false) return top;
  try {
    const job = await runAgentJob(ctx, {
      kind: 'zen-reasons',
      agent: 'zen-planner',
      prompt: promptWith('Return {"reasons": [one short reason per item, in the same order]}.', {
        items: top.map((f, n) => `${n + 1}. ${f.title} (${f.category}; ${f.reason})`).join('\n'),
      }),
      schema: ReasonsSchema,
      input: { items: top.length },
    });
    return top.map((f, n) => {
      const r = job.data.reasons[n]?.trim();
      return r ? { ...f, reason: r.slice(0, 120) } : f;
    });
  } catch {
    return top;
  }
}

// ---- storage ----

async function save(ctx: AppContext, s: ZenSession): Promise<void> {
  ctx
    .privateDb()
    .prepare('insert or replace into zen_sessions (id, started_at, ends_at, ended_at, payload) values (?, ?, ?, ?, ?)')
    .run(s.id, s.startedAt, s.endsAt, s.endedAt ?? null, sealJson(await ctx.key(), s));
}

async function latest(ctx: AppContext): Promise<ZenSession | undefined> {
  const row = ctx
    .privateDb()
    .prepare('select payload from zen_sessions where ended_at is null order by started_at desc limit 1')
    .get() as { payload: string } | undefined;
  return row ? openJson<ZenSession>(await ctx.key(), row.payload) : undefined;
}

/** End time of the running session, without decrypting anything (for the header). */
export function zenEndsAt(ctx: AppContext, now = new Date()): string | undefined {
  const row = ctx
    .privateDb()
    .prepare('select ends_at from zen_sessions where ended_at is null order by started_at desc limit 1')
    .get() as { ends_at: string } | undefined;
  return row && row.ends_at > now.toISOString() ? row.ends_at : undefined;
}

/** The running session. One that has run past its end is ended here (status restored, digest sent). */
export async function activeZen(ctx: AppContext, now = new Date()): Promise<ZenSession | undefined> {
  const s = await latest(ctx);
  if (!s) return undefined;
  if (s.endsAt <= now.toISOString()) {
    await endZen(ctx, { now });
    return undefined;
  }
  return s;
}

export function heldItems(ctx: AppContext, session: string, key: Buffer): HeldItem[] {
  const rows = ctx
    .privateDb()
    .prepare('select id, kind, payload, created_at from held_items where session = ? order by created_at')
    .all(session) as { id: string; kind: string; payload: string; created_at: string }[];
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    createdAt: r.created_at,
    ...openJson<{ title: string; url?: string }>(key, r.payload),
  }));
}

/** Queues something for the end-of-session digest. */
export async function holdForDigest(
  ctx: AppContext,
  session: string,
  item: { kind: string; title: string; url?: string },
): Promise<void> {
  ctx
    .privateDb()
    .prepare('insert into held_items (id, session, kind, payload, created_at) values (?, ?, ?, ?, ?)')
    .run(
      `held_${randomUUID().slice(0, 10)}`,
      session,
      item.kind,
      sealJson(await ctx.key(), { title: item.title, ...(item.url ? { url: item.url } : {}) }),
      nowIso(),
    );
}

const slackConfigured = (ctx: AppContext) => Boolean(ctx.config()?.integrations.servers.slack);

// ---- start, extend, end ----

export interface StartOptions {
  focus?: FocusItem[];
  minutes?: number;
  freeze?: boolean;
  slackStatus?: boolean;
  autoReply?: boolean;
  now?: Date;
}

export async function startZen(ctx: AppContext, o: StartOptions = {}): Promise<ZenSession> {
  const now = o.now ?? new Date();
  if (await activeZen(ctx, now))
    throw Object.assign(new Error('A zen session is already running'), { statusCode: 409 });
  const cfg = zenConfig(ctx);
  const prefs = ctx.settings.zen;
  const minutes = Math.min(Math.max(15, Math.round(o.minutes ?? prefs.defaultMinutes)), cfg.maxMinutes);
  const focus = (o.focus ?? (await suggestFocus(ctx, { now }))).slice(0, MAX_FOCUS);
  if (!focus.length) throw Object.assign(new Error('Pick at least one focus item'), { statusCode: 400 });
  const endsAt = new Date(now.getTime() + minutes * 60_000).toISOString();
  const s: ZenSession = {
    id: `zen_${randomUUID().slice(0, 10)}`,
    startedAt: now.toISOString(),
    endsAt,
    focus,
    options: {
      slackStatus: o.slackStatus ?? prefs.slackStatus,
      autoReply: o.autoReply ?? prefs.autoReply,
      freeze: o.freeze ?? false,
    },
    frozen: [],
    replied: [],
  };
  if (s.options.slackStatus && slackConfigured(ctx)) {
    const slack = ctx.workplace().slack;
    try {
      const previous = await slack.status().catch(() => undefined);
      await slack.setStatus(`Focusing until ${hhmm(endsAt)}`, ':headphones:', Math.floor(Date.parse(endsAt) / 1000));
      await slack.snooze(minutes).catch(() => undefined);
      s.presence = { set: true, ...(previous ? { previous } : {}) };
    } catch (e) {
      // The Slack MCP server may not expose status or Do Not Disturb; the session works without them.
      s.presence = { set: false, error: (e as Error).message };
    }
  }
  if (s.options.freeze) {
    const focusTickets = new Set(focus.filter((f) => f.kind === 'ticket').map((f) => f.id.slice('ticket:'.length)));
    for (const a of await mySessions(ctx).catch(() => [])) {
      if ((a.state !== 'working' && a.state !== 'needs-input') || (a.ticket && focusTickets.has(a.ticket))) continue;
      // Stopping fires the Stop hook, which writes the ticket's checkpoint first.
      if ((await ctx.sessions.stop(a.id).catch(() => undefined)) !== undefined) s.frozen.push(a.id);
    }
  }
  await save(ctx, s);
  return s;
}

export async function extendZen(ctx: AppContext, minutes: number, now = new Date()): Promise<ZenSession> {
  const s = await activeZen(ctx, now);
  if (!s) throw Object.assign(new Error('No zen session is running'), { statusCode: 404 });
  const cap = Date.parse(s.startedAt) + zenConfig(ctx).maxMinutes * 60_000;
  s.endsAt = new Date(Math.min(Date.parse(s.endsAt) + minutes * 60_000, cap)).toISOString();
  if (s.presence?.set) {
    const slack = ctx.workplace().slack;
    await slack
      .setStatus(`Focusing until ${hhmm(s.endsAt)}`, ':headphones:', Math.floor(Date.parse(s.endsAt) / 1000))
      .catch(() => undefined);
    await slack.snooze(Math.max(1, Math.round((Date.parse(s.endsAt) - now.getTime()) / 60_000))).catch(() => undefined);
  }
  await save(ctx, s);
  return s;
}

/** Marks a focus item done (or not). The session ends early once every item is done. */
export async function setFocusDone(
  ctx: AppContext,
  id: string,
  done = true,
): Promise<{ session?: ZenSession; ended?: EndResult }> {
  const s = await activeZen(ctx);
  if (!s) throw Object.assign(new Error('No zen session is running'), { statusCode: 404 });
  const f = s.focus.find((x) => x.id === id);
  if (!f) throw Object.assign(new Error('Not a focus item in this session'), { statusCode: 404 });
  f.done = done;
  await save(ctx, s);
  if (s.focus.every((x) => x.done)) return { ended: await endZen(ctx) };
  return { session: s };
}

export interface EndResult {
  held: number;
  digest: string;
  delivered: 'slack' | 'desktop' | 'none';
}

/** Ends the session: restores Slack status, resumes frozen agents and delivers one digest. */
export async function endZen(ctx: AppContext, o: { now?: Date; baseUrl?: string } = {}): Promise<EndResult> {
  const s = await latest(ctx);
  if (!s) throw Object.assign(new Error('No zen session is running'), { statusCode: 404 });
  const now = o.now ?? new Date();
  if (s.presence?.set && slackConfigured(ctx)) {
    const slack = ctx.workplace().slack;
    await slack.endSnooze().catch(() => undefined);
    const p = s.presence.previous;
    await slack.setStatus(p?.text ?? '', p?.emoji ?? '', p?.expiration ?? 0).catch(() => undefined);
  }
  for (const id of s.frozen) await ctx.sessions.respawn(id).catch(() => undefined);
  const key = await ctx.key();
  const held = heldItems(ctx, s.id, key);
  const done = s.focus.filter((f) => f.done).length;
  const base = o.baseUrl ?? '';
  const digest = [
    `*Zen session ended · ${done} of ${s.focus.length} focus items done*`,
    held.length
      ? `${held.length} held for you:\n${held.map((h) => `• ${h.title}${h.url && base ? ` <${base}${h.url}|Open>` : ''}`).join('\n')}`
      : 'Nothing came in while you focused.',
  ].join('\n');
  let delivered: EndResult['delivered'] = 'none';
  if (held.length || s.frozen.length) {
    if (await slackToSelf(ctx, digest)) delivered = 'slack';
    else {
      await notify(ctx, 'OrgSpec: zen session ended', `${held.length} item(s) held for you`).catch(() => undefined);
      delivered = 'desktop';
    }
  }
  s.endedAt = now.toISOString();
  await save(ctx, s);
  ctx.privateDb().prepare('delete from held_items where session = ?').run(s.id);
  return { held: held.length, digest, delivered };
}

// ---- during a session ----

/** Inbox asks someone has waited on longer than the org's blocker threshold (a quiet line, never a pop-up). */
export async function waitingOnMe(ctx: AppContext, now = new Date()): Promise<{ title: string; from: string }[]> {
  const hours = zenConfig(ctx).blockerHours;
  const cutoff = now.getTime() - hours * 3_600_000;
  return (await listInbox(ctx).catch(() => []))
    .filter((t) => (t.kind === 'request' || t.kind === 'question') && Date.parse(t.createdAt) <= cutoff)
    .slice(0, 3)
    .map((t) => ({ title: t.title, from: t.from }));
}

const inAllowlist = (ctx: AppContext, user?: string) =>
  Boolean(user && ctx.settings.zen.allowlist.some((a) => a.toLowerCase() === user.toLowerCase()));

/**
 * Auto-reply, when the person turned it on: answers each DM conversation once per session, never
 * people on their allowlist. Posted as the person through the Slack MCP server.
 */
export async function zenAutoReply(
  ctx: AppContext,
  messages: { conversation: string; user?: string }[],
  now = new Date(),
): Promise<number> {
  const s = await activeZen(ctx, now);
  if (!s?.options.autoReply || !slackConfigured(ctx)) return 0;
  let sent = 0;
  for (const m of messages) {
    if (s.replied.includes(m.conversation) || inAllowlist(ctx, m.user)) continue;
    await ctx
      .workplace()
      .slack.post(m.conversation, `I'm focusing until ${hhmm(s.endsAt)} and will reply after that.`)
      .then(() => {
        s.replied.push(m.conversation);
        sent++;
      })
      .catch(() => undefined);
  }
  if (sent) await save(ctx, s);
  return sent;
}

/** Private session history for the person's own view: count only, never shown to anyone else. */
export function zenSessionCount(ctx: AppContext): number {
  return (ctx.privateDb().prepare('select count(*) as n from zen_sessions').get() as { n: number }).n;
}
