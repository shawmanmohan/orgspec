import { randomUUID } from 'node:crypto';
import { nowIso } from '@orgspec/core';
import { z } from 'zod';
import type { AppContext } from './context.js';
import { promptWith, runAgentJob } from './jobs.js';
import { loadPeople } from './oneonone.js';
import { workingDaysBetween } from './reminder-rules.js';

// Programs for project managers: risk built from Jira, PRs and CI. Scores are about the work, never people.

export const WEIGHTS_VERSION = '1.1';

interface IssueRow {
  key: string;
  project: string;
  type: string | null;
  status: string;
  summary: string;
  assignee: string | null;
  labels: string | null;
  epic: string | null;
  links: string | null;
  created_at: string | null;
  source_updated_at: string;
}

export interface ProgramTicket {
  key: string;
  summary: string;
  status: string;
  done: boolean;
  inProgress: boolean;
  assignee?: string;
  project: string;
  updated: string;
  created?: string;
  due?: string;
  blocks: string[];
  blockedBy: string[];
}

export interface Driver {
  category: 'Dependencies' | 'Schedule' | 'Activity vs plan' | 'Review wait' | 'Scope';
  points: number;
  text: string;
  tickets: string[];
}

export interface Program {
  key: string;
  title: string;
  teams: string[];
  target?: string;
  stories: number;
  done: number;
  score: number;
  status: 'on track' | 'at risk' | 'off track';
  drivers: Driver[];
  chance?: number;
  tickets: ProgramTicket[];
}

const parseExtra = (r: IssueRow) => {
  try {
    return r.labels ? (JSON.parse(r.labels) as { labels?: string[]; due?: string; statusCategory?: string }) : {};
  } catch {
    return {};
  }
};

function toTicket(r: IssueRow): ProgramTicket {
  const extra = parseExtra(r);
  let links: { blocks?: string[]; blockedBy?: string[] } = {};
  try {
    links = r.links ? (JSON.parse(r.links) as typeof links) : {};
  } catch {
    links = {};
  }
  const cat = extra.statusCategory ?? '';
  return {
    key: r.key,
    summary: r.summary,
    status: r.status,
    done: cat === 'done' || /^(done|closed|resolved)$/i.test(r.status),
    inProgress: cat === 'indeterminate' || /progress|review/i.test(r.status),
    project: r.project,
    updated: r.source_updated_at,
    blocks: links.blocks ?? [],
    blockedBy: links.blockedBy ?? [],
    ...(r.assignee ? { assignee: r.assignee } : {}),
    ...(r.created_at ? { created: r.created_at } : {}),
    ...(extra.due ? { due: extra.due } : {}),
  };
}

/**
 * Chance of finishing the remaining stories by the target, by resampling the last six weeks' weekly
 * throughput 2,000 times. Deterministic seed so the number does not jitter between refreshes.
 */
export function forecastChance(weekly: number[], remaining: number, weeksLeft: number): number {
  if (remaining <= 0) return 1;
  if (weeksLeft <= 0) return 0;
  const sample = weekly.length ? weekly : [0];
  if (sample.every((w) => w === 0)) return 0;
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  let hits = 0;
  const runs = 2000;
  for (let i = 0; i < runs; i++) {
    let doneCount = 0;
    for (let w = 0; w < Math.floor(weeksLeft); w++) doneCount += sample[Math.floor(rand() * sample.length)] ?? 0;
    if (doneCount >= remaining) hits++;
  }
  return hits / runs;
}

export function scoreProgram(
  ctx: AppContext,
  epic: IssueRow | undefined,
  epicKey: string,
  children: ProgramTicket[],
  now = new Date(),
): Program {
  const drivers: Driver[] = [];
  const stories = children.length;
  const done = children.filter((c) => c.done).length;
  const db = ctx.db();
  const target = epic ? parseExtra(epic).due : undefined;

  // Dependencies: unassigned tickets that block others.
  const blocking = children.filter((c) => !c.done && !c.assignee && c.blocks.length);
  for (const b of blocking) {
    const idle = workingDaysBetween(new Date(b.updated), now);
    drivers.push({
      category: 'Dependencies',
      points: Math.min(35, 10 + idle * 2 + b.blocks.length * 2),
      text: `${b.key} unassigned ${idle} working days; blocks ${b.blocks.join(', ')}`,
      tickets: [b.key, ...b.blocks],
    });
  }

  // Schedule: chance of finishing by the target at the last six weeks' pace.
  let chance: number | undefined;
  if (target) {
    const weekly = Array.from({ length: 6 }, (_, i) => {
      const end = now.getTime() - i * 7 * 86_400_000;
      return children.filter(
        (c) => c.done && Date.parse(c.updated) <= end && Date.parse(c.updated) > end - 7 * 86_400_000,
      ).length;
    });
    const weeksLeft = (Date.parse(target) - now.getTime()) / (7 * 86_400_000);
    chance = forecastChance(weekly, stories - done, weeksLeft);
    if (chance < 0.85)
      drivers.push({
        category: 'Schedule',
        points: Math.round((1 - chance) * 30),
        text: `${Math.round(chance * 100)}% chance of finishing by ${target.slice(0, 10)} at the last 6 weeks’ pace`,
        tickets: [],
      });
  }

  // Activity vs plan: in progress with no PR for 5 working days.
  const prs = db.prepare('select branch, state, updated_at from cache_github_prs').all() as {
    branch: string;
    state: string;
    updated_at: string | null;
  }[];
  const quiet = children.filter(
    (c) =>
      c.inProgress &&
      !prs.some((p) => p.branch.toLowerCase().startsWith(c.key.toLowerCase())) &&
      workingDaysBetween(new Date(c.updated), now) >= 5,
  );
  if (quiet.length)
    drivers.push({
      category: 'Activity vs plan',
      points: Math.min(15, quiet.length * 5),
      text: `${quiet.length} ticket${quiet.length === 1 ? '' : 's'} in progress with no commit or PR for 5 working days`,
      tickets: quiet.map((q) => q.key),
    });

  // Review wait: open PRs waiting more than two days.
  const waiting = children.flatMap((c) =>
    prs
      .filter(
        (p) =>
          p.branch.toLowerCase().startsWith(c.key.toLowerCase()) &&
          /open|draft/i.test(p.state) &&
          p.updated_at &&
          workingDaysBetween(new Date(p.updated_at), now) >= 2,
      )
      .map(() => c.key),
  );
  if (waiting.length)
    drivers.push({
      category: 'Review wait',
      points: Math.min(15, waiting.length * 5),
      text: `${waiting.length} PR${waiting.length === 1 ? '' : 's'} waiting for review over 2 days`,
      tickets: waiting,
    });

  // Scope: stories added after the first snapshot (the plan baseline).
  const base = db
    .prepare('select data from cache_jira_snapshots where program = ? order by day limit 1')
    .get(epicKey) as { data: string } | undefined;
  const baseline = base ? (JSON.parse(base.data) as { total?: number }).total : undefined;
  if (baseline !== undefined && stories > baseline)
    drivers.push({
      category: 'Scope',
      points: Math.min(15, (stories - baseline) * 4),
      text: `${stories - baseline} stor${stories - baseline === 1 ? 'y' : 'ies'} added after plan baseline`,
      tickets: [],
    });

  drivers.sort((a, b) => b.points - a.points);
  const score = Math.min(
    100,
    drivers.reduce((n, d) => n + d.points, 0),
  );
  return {
    key: epicKey,
    title: epic?.summary ?? epicKey,
    teams: [...new Set(children.map((c) => c.project))],
    stories,
    done,
    score,
    status: score > 70 ? 'off track' : score >= 40 ? 'at risk' : 'on track',
    drivers,
    tickets: children,
    ...(target ? { target } : {}),
    ...(chance !== undefined ? { chance } : {}),
  };
}

/** Every program (epic) in the cache with its score, recorded for history. */
export function programs(ctx: AppContext): Program[] {
  const rows = ctx.db().prepare('select * from cache_jira_issues').all() as unknown as IssueRow[];
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const epics = new Map<string, ProgramTicket[]>();
  for (const r of rows) if (r.epic) epics.set(r.epic, [...(epics.get(r.epic) ?? []), toTicket(r)]);
  const out = [...epics].map(([k, children]) => scoreProgram(ctx, byKey.get(k), k, children));
  const ins = ctx
    .db()
    .prepare(
      'insert or replace into risk_scores (program_id, score, band, drivers, computed_at) values (?, ?, ?, ?, ?)',
    );
  const at = nowIso().slice(0, 13);
  for (const p of out) ins.run(p.key, p.score, p.status, JSON.stringify(p.drivers), at);
  return out.sort((a, b) => b.score - a.score);
}

export const program = (ctx: AppContext, key: string) => programs(ctx).find((p) => p.key === key);

// ---- Nudges ----

export interface NudgeTarget {
  ticket: string;
  to: string;
  name: string;
  why: string;
  slackId?: string;
  timezone?: string;
}

/** Who to nudge about a ticket: its assignee, or the owning team's lead when it is unassigned. */
export async function nudgeTarget(ctx: AppContext, p: Program, ticket: string): Promise<NudgeTarget | undefined> {
  const t = p.tickets.find((x) => x.key === ticket);
  if (!t) return undefined;
  const people = loadPeople(ctx.configDir);
  const leads = people.teamLeads;
  const email = t.assignee?.includes('@') ? t.assignee : (leads[t.project] ?? leads[t.project.toLowerCase()]);
  if (!email) return undefined;
  const person = await ctx
    .workplace()
    .hr.person(email)
    .catch(() => undefined);
  const slackId = people.people[email]?.slack;
  return {
    ticket,
    to: email,
    name: person?.name ?? email,
    why: t.assignee ? 'assignee' : `${t.project} team lead (ticket is unassigned)`,
    ...(slackId ? { slackId } : {}),
    ...(person?.timezone ? { timezone: person.timezone } : {}),
  };
}

export function nudgeDraft(p: Program, ticket: string, target: NudgeTarget): string {
  const t = p.tickets.find((x) => x.key === ticket);
  const driver = p.drivers.find((d) => d.tickets.includes(ticket));
  const first = target.name.split(' ')[0];
  return `Hi ${first}, ${ticket} (${t?.summary ?? ''}) ${driver ? driver.text.replace(new RegExp(`^${ticket}\\s*`), '') : 'needs attention'}. Could someone pick it up this week, or tell me if it needs re-planning?`;
}

/** Local time for someone, and whether quiet hours (19:00–09:00 their time) apply. */
export function recipientClock(timezone?: string, now = new Date()): { local?: string; quiet: boolean } {
  if (!timezone) return { quiet: false };
  const local = now.toLocaleTimeString('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit' });
  return { local, quiet: local >= '19:00' || local < '09:00' };
}

export function lastNudge(ctx: AppContext, ticket: string): string | undefined {
  return (
    ctx.db().prepare('select sent_at from nudges where ticket = ? order by sent_at desc limit 1').get(ticket) as
      | { sent_at?: string }
      | undefined
  )?.sent_at;
}

/**
 * Sends a nudge as the person, after their click: a Slack DM or a Jira comment. At most one per ticket
 * per 24 hours; logged on the ticket so the team sees it.
 */
export async function sendNudge(
  ctx: AppContext,
  o: { ticket: string; to: string; slackId?: string; via: 'slack' | 'jira'; text: string },
): Promise<void> {
  const last = lastNudge(ctx, o.ticket);
  if (last && Date.now() - Date.parse(last) < 86_400_000)
    throw Object.assign(new Error(`${o.ticket} was nudged ${new Date(last).toLocaleString()}; wait 24 hours`), {
      statusCode: 409,
    });
  const w = ctx.workplace();
  if (o.via === 'slack') {
    if (!o.slackId) throw new Error(`No Slack ID for ${o.to} in people.yaml`);
    await w.slack.post(o.slackId, o.text);
    await w.jira.comment(o.ticket, `Nudged ${o.to} on Slack via OrgSpec: ${o.text}`).catch(() => undefined);
  } else {
    await w.jira.comment(o.ticket, o.text);
  }
  ctx
    .db()
    .prepare('insert into nudges (id, ticket, recipient, channel, sent_at) values (?, ?, ?, ?, ?)')
    .run(`ndg_${randomUUID().slice(0, 8)}`, o.ticket, o.to, o.via, nowIso());
}

// ---- Status updates ----

export const StatusSchema = z.object({
  statusLine: z.string(),
  progress: z.string(),
  risks: z.array(z.string()).default([]),
  asks: z.array(z.string()).default([]),
  milestones: z.array(z.string()).default([]),
  sources: z.array(z.string()).default([]),
});
export type StatusDraft = z.infer<typeof StatusSchema>;

export interface StatusRecord {
  id: string;
  program: string;
  at: string;
  status: string;
  score: number;
  text: string;
  sharedTo: string[];
}

export async function draftStatus(ctx: AppContext, p: Program): Promise<StatusDraft & { at: string }> {
  const runs = ctx
    .db()
    .prepare('select branch, status from cache_ci_runs order by source_updated_at desc limit 50')
    .all() as { branch: string; status: string }[];
  const job = await runAgentJob(ctx, {
    kind: 'status-update',
    agent: 'status-writer',
    prompt: promptWith(
      `Draft a status update for program ${p.key} "${p.title}". Return {"statusLine","progress","risks":[string],"asks":[string],"milestones":[string],"sources":[ticket keys or "forecast"]}.
Every claim names its source ticket key; no claims about individuals' performance. Plain and short.`,
      {
        program: JSON.stringify({
          target: p.target,
          stories: p.stories,
          done: p.done,
          score: p.score,
          status: p.status,
          chance: p.chance,
          drivers: p.drivers,
        }),
        tickets: p.tickets
          .map((t) => `${t.key} [${t.status}] ${t.summary}${t.assignee ? '' : ' (unassigned)'}`)
          .join('\n'),
        ci:
          runs
            .filter((r) => p.tickets.some((t) => r.branch.toLowerCase().startsWith(t.key.toLowerCase())))
            .map((r) => `${r.branch}: ${r.status}`)
            .join('\n') || 'none',
      },
    ),
    schema: StatusSchema,
    input: { program: p.key },
  });
  return { ...job.data, at: nowIso() };
}

export const renderStatus = (p: Program, d: StatusDraft) =>
  [
    `Status: ${d.statusLine} (${p.status}, ${p.score})`,
    `Progress: ${d.progress}`,
    d.risks.length ? `Risks:\n${d.risks.map((r) => `- ${r}`).join('\n')}` : '',
    d.asks.length ? `Asks:\n${d.asks.map((a) => `- ${a}`).join('\n')}` : '',
    d.milestones.length ? `Next milestones:\n${d.milestones.map((m) => `- ${m}`).join('\n')}` : '',
    d.sources.length ? `Sources: ${d.sources.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');

export function statusHistory(ctx: AppContext, programKey: string): StatusRecord[] {
  const v = (
    ctx.db().prepare('select value from kv where key = ?').get(`status:${programKey}`) as { value: string } | undefined
  )?.value;
  return v ? (JSON.parse(v) as StatusRecord[]) : [];
}

/** Shares a status update as the person: a Slack channel, a dated section on the program page, a comment on the epic. */
export async function shareStatus(
  ctx: AppContext,
  p: Program,
  text: string,
  to: { slackChannel?: string; confluencePageId?: string; epicComment?: boolean },
): Promise<StatusRecord> {
  const w = ctx.workplace();
  const shared: string[] = [];
  if (to.slackChannel) {
    await w.slack.post(to.slackChannel.replace(/^#/, ''), text);
    shared.push(`#${to.slackChannel.replace(/^#/, '')}`);
  }
  if (to.confluencePageId) {
    const page = await w.confluence.get(to.confluencePageId);
    const section = `<h2>Status ${new Date().toISOString().slice(0, 10)}</h2>${text
      .split('\n')
      .map((l) => `<p>${l.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>`)
      .join('')}`;
    await w.confluence.update({
      pageId: page.id,
      title: page.title,
      body: `${section}${page.storage}`,
      message: 'Status update from OrgSpec',
    });
    shared.push('Confluence');
  }
  if (to.epicComment) {
    await w.jira.comment(p.key, text);
    shared.push(`comment on ${p.key}`);
  }
  const rec: StatusRecord = {
    id: `st_${randomUUID().slice(0, 8)}`,
    program: p.key,
    at: nowIso(),
    status: p.status,
    score: p.score,
    text,
    sharedTo: shared,
  };
  ctx
    .db()
    .prepare('insert or replace into kv (key, value) values (?, ?)')
    .run(`status:${p.key}`, JSON.stringify([rec, ...statusHistory(ctx, p.key)].slice(0, 20)));
  return rec;
}
