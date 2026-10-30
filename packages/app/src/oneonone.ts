import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { appendAudit, exists, nowIso, openJson, readText, sealJson } from '@orgspec/core';
import { pendingActions } from '@orgspec/gateway';
import type { CalendarEvent, Person } from '@orgspec/integrations';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { AppContext } from './context.js';
import { promptWith, runAgentJob } from './jobs.js';
import { remind } from './reminders.js';

/** `orgspec-config/people.yaml`: identities across tools, keyed by work email. */
export const PeopleSchema = z.object({
  people: z
    .record(
      z.string(),
      z.object({ github: z.string().optional(), slack: z.string().optional(), jiraAccountId: z.string().optional() }),
    )
    .default({}),
  oneOnOne: z
    .object({
      spaceId: z.string().optional(),
      parentId: z.string().optional(),
      /** Confluence page with the career framework briefs refer to. */
      careerPageId: z.string().optional(),
    })
    .default({}),
  teamLeads: z.record(z.string(), z.string()).default({}),
  /** Work channels whose messages may count as 1:1 evidence. Never DMs or private channels. */
  evidenceChannels: z.array(z.string()).default([]),
});
export type People = z.infer<typeof PeopleSchema>;
// teamLeads: Jira project or team → lead's work email, for nudges about unassigned tickets.

export function loadPeople(configDir?: string): People {
  const f = configDir ? join(configDir, 'people.yaml') : '';
  return PeopleSchema.parse(f && exists(f) ? (parseYaml(readText(f)) ?? {}) : {});
}

export const CADENCES = {
  weekly: { label: 'Weekly, 30 min', minutes: 30, rrule: 'FREQ=WEEKLY' },
  biweekly: { label: 'Every 2 weeks, 45 min', minutes: 45, rrule: 'FREQ=WEEKLY;INTERVAL=2' },
} as const;
export type Cadence = keyof typeof CADENCES;

export interface RosterEntry extends Person {
  pageId?: string;
  github?: string;
  cadence?: Cadence;
  nextOneOnOne?: CalendarEvent;
  openActions: number;
  /** When the latest brief was built, if any. */
  briefAt?: string;
}

const kvGet = (ctx: AppContext, key: string) =>
  (ctx.db().prepare('select value from kv where key = ?').get(key) as { value: string } | undefined)?.value;
const kvSet = (ctx: AppContext, key: string, value: string) =>
  ctx.db().prepare('insert or replace into kv (key, value) values (?, ?)').run(key, value);

const isOneOnOneWith = (e: CalendarEvent, email: string) =>
  e.attendees.some((a) => a.toLowerCase() === email.toLowerCase()) && /\b1\s*:\s*1\b|one[- ]on[- ]one/i.test(e.title);

/**
 * Direct reports from the HR directory only (nobody can be added by hand), with cadence, next 1:1,
 * open agreed actions and brief status.
 */
export async function roster(ctx: AppContext): Promise<RosterEntry[]> {
  const me = ctx.settings.identity.email;
  if (!me) throw new Error('Set your work email: orgspec settings identity --email you@company.com');
  const people = loadPeople(ctx.configDir);
  const w = ctx.workplace();
  const reports = await w.hr.reports(me);
  ctx.db().prepare("insert or replace into kv (key, value) values ('hr:reports', ?)").run(JSON.stringify(reports));
  purgeFormerReports(ctx, reports);
  const now = new Date();
  const events = await w.calendar
    .events(now.toISOString(), new Date(now.getTime() + 21 * 86_400_000).toISOString(), '1:1')
    .catch(() => [] as CalendarEvent[]);
  const pdb = ctx.privateDb();
  return reports.map((p) => {
    const pageId = kvGet(ctx, `oneonone:${p.email}`);
    const cadence = kvGet(ctx, `cadence:${p.email}`) as Cadence | undefined;
    const github = people.people[p.email]?.github;
    const next = events.filter((e) => isOneOnOneWith(e, p.email)).sort((a, b) => a.start.localeCompare(b.start))[0];
    const open = (
      pdb.prepare("select count(*) as n from oneonone_actions where report = ? and state = 'open'").get(p.email) as {
        n: number;
      }
    ).n;
    const brief = pdb
      .prepare('select created_at from briefs where report = ? order by created_at desc limit 1')
      .get(p.email) as { created_at: string } | undefined;
    return {
      ...p,
      openActions: open,
      ...(pageId ? { pageId } : {}),
      ...(github ? { github } : {}),
      ...(cadence ? { cadence } : {}),
      ...(next ? { nextOneOnOne: next } : {}),
      ...(brief ? { briefAt: brief.created_at } : {}),
    };
  });
}

/**
 * When the HR directory shows a manager change (the report has moved, or is no longer listed), the
 * former manager's briefs, private notes and agreed actions about that person are deleted from this
 * machine. Nothing is handed over: the new manager's machine builds fresh briefs from the same sources.
 */
export function purgeFormerReports(
  ctx: AppContext,
  reports: readonly { email: string; moveOn?: string }[],
  now = new Date(),
): string[] {
  const day = now.toISOString().slice(0, 10);
  const current = new Set(
    reports.filter((r) => !r.moveOn || r.moveOn.slice(0, 10) > day).map((r) => r.email.toLowerCase()),
  );
  const pdb = ctx.privateDb();
  const known = new Set(
    [
      ...(pdb.prepare('select distinct report as e from briefs').all() as { e: string }[]),
      ...(pdb.prepare('select distinct report as e from oneonone_actions').all() as { e: string }[]),
      ...(pdb.prepare("select distinct subject as e from notes where subject like '%@%'").all() as { e: string }[]),
    ].map((r) => r.e),
  );
  const gone = [...known].filter((e) => !current.has(e.toLowerCase()));
  for (const e of gone) {
    pdb.prepare('delete from briefs where report = ?').run(e);
    pdb.prepare('delete from oneonone_actions where report = ?').run(e);
    pdb.prepare('delete from notes where subject = ?').run(e);
    ctx.db().prepare('delete from kv where key in (?, ?)').run(`oneonone:${e}`, `cadence:${e}`);
  }
  return gone;
}

/** One report, checked against the HR directory: access to someone else's briefs ends when they move. */
export async function findReport(ctx: AppContext, email: string): Promise<RosterEntry> {
  const r = (await roster(ctx)).find((x) => x.email.toLowerCase() === email.toLowerCase());
  if (!r)
    throw Object.assign(new Error(`${email} is not one of your direct reports in the HR directory`), {
      statusCode: 404,
    });
  if (r.moveOn && r.moveOn.slice(0, 10) <= new Date().toISOString().slice(0, 10)) {
    throw Object.assign(
      new Error(
        `${r.name} moved to ${r.moveTo ?? 'another manager'} on ${r.moveOn.slice(0, 10)}; your access to their briefs ended that day`,
      ),
      {
        statusCode: 403,
      },
    );
  }
  return r;
}

const AGENDA = '<h2>Agenda</h2>';
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The shared agenda page for a manager and report: a Confluence page restricted to the two of them.
 * Created on first use; the page ID is remembered locally.
 */
export async function ensureOneOnOnePage(ctx: AppContext, report: Person): Promise<string> {
  const known = kvGet(ctx, `oneonone:${report.email}`);
  if (known) return known;
  const people = loadPeople(ctx.configDir);
  const { spaceId, parentId } = people.oneOnOne;
  if (!spaceId) throw new Error('Set oneOnOne.spaceId in orgspec-config/people.yaml');
  const meName = ctx.settings.identity.email ?? 'me';
  const page = await ctx.workplace().confluence.create({
    spaceId,
    ...(parentId ? { parentId } : {}),
    title: `1:1 ${meName} / ${report.email}`,
    body: `<p>Shared agenda for ${esc(report.name)} and their manager. Only the two of you can see this page.</p>${AGENDA}<ul></ul><h2>Goals</h2><ul></ul><h2>Context from ${esc(report.name)}</h2><p></p>`,
  });
  const users = [ctx.settings.identity.jiraAccountId, people.people[report.email]?.jiraAccountId].filter(
    (x): x is string => Boolean(x),
  );
  if (users.length === 2) await ctx.workplace().confluence.restrict(page.id, users);
  kvSet(ctx, `oneonone:${report.email}`, page.id);
  return page.id;
}

/** Items in a page section (`<h2>Title</h2><ul><li>…</li></ul>` or paragraphs), as plain text. */
export function sectionItems(storage: string, heading: RegExp): string[] {
  const parts = storage.split(/<h[1-3][^>]*>/i);
  for (const part of parts) {
    const [title = '', body = ''] = part.split(/<\/h[1-3]>/i);
    if (!heading.test(title.replace(/<[^>]+>/g, ''))) continue;
    const items = [...body.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => m[1] ?? '');
    const paras = items.length ? items : [...body.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => m[1] ?? '');
    return paras
      .map((t) =>
        t
          .replace(/<[^>]+>/g, '')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .trim(),
      )
      .filter(Boolean);
  }
  return [];
}

export interface SharedPage {
  pageId: string;
  agenda: string[];
  goals: string[];
  context: string[];
}

export async function sharedPage(ctx: AppContext, report: RosterEntry): Promise<SharedPage | undefined> {
  if (!report.pageId) return undefined;
  const page = await ctx
    .workplace()
    .confluence.get(report.pageId)
    .catch(() => undefined);
  if (!page) return undefined;
  return {
    pageId: report.pageId,
    agenda: sectionItems(page.storage, /^agenda$/i),
    goals: sectionItems(page.storage, /^goals$/i),
    context: sectionItems(page.storage, /^context from/i),
  };
}

/** Adds an item to the shared agenda (a new page version). */
export async function addAgendaItem(ctx: AppContext, report: Person, item: string): Promise<number> {
  const pageId = await ensureOneOnOnePage(ctx, report);
  const c = ctx.workplace().confluence;
  const page = await c.get(pageId);
  const who = ctx.settings.identity.email?.split('@')[0] ?? 'manager';
  const li = `<li>${esc(item)} <em>· ${esc(who)}</em></li>`;
  const body = page.storage.includes(`${AGENDA}<ul>`)
    ? page.storage.replace(`${AGENDA}<ul>`, `${AGENDA}<ul>${li}`)
    : `${page.storage}${AGENDA}<ul>${li}</ul>`;
  const updated = await c.update({ pageId, title: page.title, body, message: 'Agenda item added by OrgSpec' });
  return updated.version;
}

/** Private notes about a report: encrypted, local only, never synced anywhere. */
export async function savePrivateNote(ctx: AppContext, reportEmail: string, text: string): Promise<string> {
  const id = `note_${randomUUID().slice(0, 10)}`;
  ctx
    .privateDb()
    .prepare('insert into notes (id, subject, payload, updated_at) values (?, ?, ?, ?)')
    .run(id, reportEmail, sealJson(await ctx.key(), { text }), nowIso());
  return id;
}

export async function privateNotes(
  ctx: AppContext,
  reportEmail: string,
): Promise<{ id: string; text: string; updatedAt: string }[]> {
  const key = await ctx.key();
  const rows = ctx
    .privateDb()
    .prepare('select * from notes where subject = ? order by updated_at desc')
    .all(reportEmail) as { id: string; payload: string; updated_at: string }[];
  return rows.map((r) => ({
    id: r.id,
    text: openJson<{ text: string }>(key, r.payload).text,
    updatedAt: r.updated_at,
  }));
}

export interface AgreedAction {
  id: string;
  text: string;
  owner: 'manager' | 'report';
  state: 'open' | 'done';
  createdAt: string;
}

/** Agreed actions from a 1:1: encrypted locally, each with a reminder, shown in the next brief. */
export async function addAction(
  ctx: AppContext,
  report: RosterEntry,
  text: string,
  owner: AgreedAction['owner'] = 'manager',
): Promise<string> {
  const id = `act1_${randomUUID().slice(0, 8)}`;
  ctx
    .privateDb()
    .prepare('insert into oneonone_actions (id, report, payload, created_at) values (?, ?, ?, ?)')
    .run(id, report.email, sealJson(await ctx.key(), { text, owner }), nowIso());
  remind(ctx, {
    kind: 'oneonone-action',
    subject: id,
    title: `${owner === 'manager' ? 'You' : report.name}: ${text} (1:1 with ${report.name})`,
    ...(report.nextOneOnOne ? { dueAt: report.nextOneOnOne.start } : {}),
  });
  return id;
}

export async function listActions(ctx: AppContext, reportEmail: string, includeDone = false): Promise<AgreedAction[]> {
  const key = await ctx.key();
  const rows = ctx
    .privateDb()
    .prepare(
      `select * from oneonone_actions where report = ? ${includeDone ? '' : "and state = 'open'"} order by created_at`,
    )
    .all(reportEmail) as { id: string; payload: string; state: AgreedAction['state']; created_at: string }[];
  return rows.map((r) => ({
    id: r.id,
    ...openJson<{ text: string; owner: AgreedAction['owner'] }>(key, r.payload),
    state: r.state,
    createdAt: r.created_at,
  }));
}

export function completeAction(ctx: AppContext, id: string): void {
  ctx.privateDb().prepare("update oneonone_actions set state = 'done', done_at = ? where id = ?").run(nowIso(), id);
  ctx.db().prepare("update reminders set done = 1 where kind = 'oneonone-action' and subject = ?").run(id);
}

export function setCadence(ctx: AppContext, reportEmail: string, cadence: Cadence): void {
  kvSet(ctx, `cadence:${reportEmail}`, cadence);
}

const sourced = z.object({ text: z.string(), source: z.string() });
export const BriefSchema = z.object({
  workSince: z.string(),
  strengths: z.array(sourced).default([]),
  growth: z.array(sourced).default([]),
  goals: z.array(z.object({ goal: z.string(), progress: z.string() })).default([]),
  feedback: z.object({ situation: z.string(), behaviour: z.string(), impact: z.string(), ask: z.string() }).optional(),
  questions: z.array(z.string()).max(4).default([]),
});
export type Brief = z.infer<typeof BriefSchema>;

export interface StoredBrief extends Brief {
  id: string;
  report: string;
  createdAt: string;
  since: string;
  sources: string[];
  dropped: number;
  /** The career framework page the brief referred to, if configured. */
  career?: string;
}

/** Keeps only strengths and growth areas whose source is one of the signals the brief was built from. */
export function groundBrief(b: Brief, sources: readonly string[]): { brief: Brief; dropped: number } {
  const ok = (s: { source: string }) => sources.some((src) => s.source.includes(src) || src.includes(s.source));
  const strengths = b.strengths.filter(ok);
  const growth = b.growth.filter(ok);
  return {
    brief: { ...b, strengths, growth },
    dropped: b.strengths.length - strengths.length + b.growth.length - growth.length,
  };
}

/**
 * Prepares a 1:1 brief from work signals only: Jira, pull requests, the shared page (agenda, goals,
 * the report's own context) and open agreed actions. A preparation aid, never an evaluation; every
 * strength or growth area cites its source, and the brief is stored encrypted on this machine.
 */
export async function prepareBrief(
  ctx: AppContext,
  report: RosterEntry,
  o: { sinceDays?: number } = {},
): Promise<StoredBrief> {
  const w = ctx.workplace();
  const since = new Date(Date.now() - (o.sinceDays ?? 14) * 86_400_000).toISOString().slice(0, 10);
  const signals: Record<string, string> = {};
  const sources: string[] = [];
  const issues = await w.jira
    .search(`assignee = "${report.email.replace(/"/g, '')}" AND updated >= "${since}" ORDER BY updated DESC`, {
      limit: 30,
    })
    .catch(() => []);
  sources.push(...issues.map((i) => i.key));
  signals.jira =
    issues.map((i) => `${i.key} [${i.status}] ${i.summary} (updated ${i.updated.slice(0, 10)})`).join('\n') || 'none';
  if (report.github) {
    const prs = (
      await Promise.all(
        ctx.settings.repos.map((r) =>
          ctx.gh.prList(r.slug, { author: report.github, state: 'all', limit: 10 }).catch(() => []),
        ),
      )
    ).flat();
    sources.push(...prs.map((p) => `${p.repo}#${p.number}`));
    signals.pullRequests =
      prs
        .map((p) => `${p.repo}#${p.number} ${p.title} [${p.state}${p.reviewDecision ? `, ${p.reviewDecision}` : ''}]`)
        .join('\n') || 'none';
  }
  const page = await sharedPage(ctx, report);
  if (page) {
    sources.push('agenda', 'goals', 'context');
    signals.sharedPage = `Agenda:\n${page.agenda.map((a) => `- ${a}`).join('\n') || '- none'}\n\nGoals:\n${page.goals.map((g) => `- ${g}`).join('\n') || '- none'}\n\nContext from ${report.name}:\n${page.context.join('\n') || 'none'}`;
  }
  const actions = await listActions(ctx, report.email);
  if (actions.length) signals.openActions = actions.map((a) => `- (${a.owner}) ${a.text}`).join('\n');
  const talk = await discussionEvidence(ctx, report.email, since).catch(() => []);
  if (talk.length) {
    sources.push(...talk.map((t) => `#${t.channel}`));
    signals.discussions = talk.map((t) => `#${t.channel} ${t.ts}: ${t.text}`).join('\n');
  }
  const careerId = loadPeople(ctx.configDir).oneOnOne.careerPageId;
  let career: string | undefined;
  if (careerId) {
    const cp = await w.confluence.get(careerId).catch(() => undefined);
    if (cp) {
      career = `${cp.title} v${cp.version}`;
      signals.careerFramework = cp.storage
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .slice(0, 6000);
      sources.push('career framework');
    }
  }

  const job = await runAgentJob(ctx, {
    kind: 'brief',
    agent: 'brief-writer',
    prompt: promptWith(
      `Prepare a 1:1 brief for ${report.name}${report.title ? ` (${report.title})` : ''}, covering work since ${since}. This is a preparation aid for a conversation, not an evaluation: no scores, rankings or judgements about the person, nothing about health, family or private life.
Return {"workSince": string, "strengths": [{"text","source"}], "growth": [{"text","source"}], "goals": [{"goal","progress"}], "feedback": {"situation","behaviour","impact","ask"}, "questions": [string]}.
Every strength and growth area cites one source exactly as it appears in the signals (a Jira key, a repo#number pull request, or "agenda", "goals", "context", "career framework"). When a career framework is given, relate growth areas to its expectations for the person's level. Say "no evidence in these sources" rather than guessing. Goals come only from the shared page. Feedback is a draft in situation-behaviour-impact form, only when the signals support it. At most four questions.`,
      signals,
    ),
    schema: BriefSchema,
    input: { report: report.email, since },
  });
  const { brief, dropped } = groundBrief(job.data, sources);
  const stored: StoredBrief = {
    ...brief,
    id: `brf_${randomUUID().slice(0, 10)}`,
    report: report.email,
    createdAt: nowIso(),
    since,
    sources,
    dropped,
    ...(career ? { career } : {}),
  };
  ctx
    .privateDb()
    .prepare('insert into briefs (id, report, payload, created_at) values (?, ?, ?, ?)')
    .run(stored.id, report.email, sealJson(await ctx.key(), stored), stored.createdAt);
  return stored;
}

/** The latest brief for a report. Every view is written to the audit log. */
export async function latestBrief(ctx: AppContext, reportEmail: string): Promise<StoredBrief | undefined> {
  const row = ctx
    .privateDb()
    .prepare('select payload from briefs where report = ? order by created_at desc limit 1')
    .get(reportEmail) as { payload: string } | undefined;
  if (!row) return undefined;
  appendAudit(ctx.db(), { kind: 'brief-view', report: reportEmail, viewer: ctx.settings.identity.email ?? 'me' });
  return openJson<StoredBrief>(await ctx.key(), row.payload);
}

export interface Slot {
  start: string;
  end: string;
}

/**
 * Free slots in both calendars over the next two weeks, within working hours: up to three, on
 * different weekdays, starting on the hour or half hour.
 */
export function freeSlots(
  busy: Record<string, { start: string; end: string }[]>,
  o: { from: Date; minutes: number; workingHours: { start: string; end: string; days: number[] }; count?: number },
): Slot[] {
  const all = Object.values(busy)
    .flat()
    .map((b) => [Date.parse(b.start), Date.parse(b.end)] as const);
  const [sh = 9, sm = 0] = o.workingHours.start.split(':').map(Number);
  const [eh = 18, em = 0] = o.workingHours.end.split(':').map(Number);
  const out: Slot[] = [];
  const usedDays = new Set<number>();
  for (let d = 1; d <= 14 && out.length < (o.count ?? 3); d++) {
    const day = new Date(o.from);
    day.setDate(day.getDate() + d);
    if (!o.workingHours.days.includes(day.getDay()) || usedDays.has(day.getDay())) continue;
    for (let mins = sh * 60 + sm; mins + o.minutes <= eh * 60 + em; mins += 30) {
      const start = new Date(day);
      start.setHours(Math.floor(mins / 60), mins % 60, 0, 0);
      const s = start.getTime();
      const e = s + o.minutes * 60_000;
      // Skip lunch and the first half hour of the day.
      if (mins < sh * 60 + sm + 60 || (mins >= 12 * 60 && mins < 13 * 60)) continue;
      if (all.some(([bs, be]) => s < be && e > bs)) continue;
      out.push({ start: new Date(s).toISOString(), end: new Date(e).toISOString() });
      usedDays.add(day.getDay());
      break;
    }
  }
  return out;
}

export async function suggestSlots(ctx: AppContext, report: RosterEntry, cadence: Cadence): Promise<Slot[]> {
  const me = ctx.settings.identity.email;
  if (!me) throw new Error('Set your work email first');
  const from = new Date();
  const to = new Date(from.getTime() + 15 * 86_400_000);
  const busy = await ctx.workplace().calendar.busy([me, report.email], from.toISOString(), to.toISOString());
  const wh = ctx.config()?.sync.workingHours ?? { start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5] };
  return freeSlots(busy, { from, minutes: CADENCES[cadence].minutes, workingHours: wh });
}

/**
 * Proposes a recurring 1:1: a pending calendar action the manager approves (the event is sent from
 * their calendar only after that click), plus the restricted Confluence page when asked.
 */
export async function scheduleOneOnOne(
  ctx: AppContext,
  report: RosterEntry,
  o: { cadence: Cadence; slot: Slot; createPage?: boolean },
): Promise<{ actionId: string; pageId?: string }> {
  const me = ctx.settings.identity.email;
  if (!me) throw new Error('Set your work email first');
  setCadence(ctx, report.email, o.cadence);
  const pageId = o.createPage ? await ensureOneOnOnePage(ctx, report) : undefined;
  const c = CADENCES[o.cadence];
  const description = `Recurring 1:1. ${pageId ? 'Shared agenda and notes are on a Confluence page only the two of you can see. ' : ''}OrgSpec prepares a brief for ${me.split('@')[0]} from Jira, GitHub and the shared page; ${report.name} can see the same evidence and add context on the page.`;
  const a = pendingActions(ctx.db()).create({
    server: 'calendar',
    tool: 'create_event',
    args: {
      title: `1:1 ${report.name} / ${me.split('@')[0]}`,
      start: o.slot.start,
      end: o.slot.end,
      attendees: [me, report.email],
      recurrence: `RRULE:${c.rrule}`,
      description,
    },
    summary: `Create recurring 1:1 with ${report.name}: ${c.label}, starting ${new Date(o.slot.start).toLocaleString()}`,
  });
  return { actionId: a.id, ...(pageId ? { pageId } : {}) };
}

/**
 * Asks HR to add someone as a report. You can only add people HR lists as your reports, so anything
 * else is a manager-change request, sent only after you approve it.
 */
export function requestManagerChange(ctx: AppContext, email: string, note: string): string {
  const me = ctx.settings.identity.email;
  if (!me) throw new Error('Set your work email first');
  return pendingActions(ctx.db()).create({
    server: 'hr',
    tool: 'request_manager_change',
    args: { email, newManagerEmail: me, note },
    summary: `Ask HR to make you ${email}'s manager${note ? `: ${note}` : ''}`,
  }).id;
}

/** A person's display name for a Slack user ID, from people.yaml and the HR directory; falls back to the ID. */
export function slackName(ctx: AppContext, id: string): string {
  if (!id || id === 'ME') return id === 'ME' ? 'You' : id;
  const people = loadPeople(ctx.configDir).people;
  const email = Object.entries(people).find(([, v]) => v.slack === id)?.[0];
  if (!email) return id;
  const raw = (
    ctx.db().prepare("select value from kv where key = 'hr:reports'").get() as { value?: string } | undefined
  )?.value;
  const hr = raw ? (JSON.parse(raw) as { email: string; name: string }[]) : [];
  const name = hr.find((p) => p.email === email)?.name;
  if (name) return name;
  const local = email.split('@')[0] ?? email;
  return local
    .split(/[._-]/)
    .map((p) => (p[0]?.toUpperCase() ?? '') + p.slice(1))
    .join(' ');
}

export interface Contribution {
  channel: string;
  ts: string;
  text: string;
}

/**
 * Messages a person wrote in the org's allowlisted work channels since a date. These are the only Slack
 * messages 1:1 evidence may use: never DMs, private channels or message counts.
 */
export async function discussionEvidence(ctx: AppContext, email: string, since: string): Promise<Contribution[]> {
  const people = loadPeople(ctx.configDir);
  const slackId =
    people.people[email]?.slack ??
    (email === ctx.settings.identity.email ? ctx.settings.identity.slackUserId : undefined);
  if (!slackId || !people.evidenceChannels.length) return [];
  const oldest = String(Math.floor(Date.parse(since) / 1000));
  const out: Contribution[] = [];
  for (const ch of people.evidenceChannels.slice(0, 10)) {
    const name = ch.replace(/^#/, '');
    const msgs = await ctx
      .workplace()
      .slack.history(name, oldest, 300)
      .catch(() => []);
    for (const m of msgs)
      if (m.user === slackId && m.text.trim()) out.push({ channel: name, ts: m.ts, text: m.text.slice(0, 300) });
  }
  return out.slice(0, 30);
}
