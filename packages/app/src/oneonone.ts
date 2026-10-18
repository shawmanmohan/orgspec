import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { exists, nowIso, openJson, readText, sealJson } from '@orgspec/core';
import type { Person } from '@orgspec/integrations';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { AppContext } from './context.js';
import { promptWith, runAgentJob } from './jobs.js';

/** `orgspec-config/people.yaml`: identities across tools, keyed by work email. */
export const PeopleSchema = z.object({
  people: z
    .record(
      z.string(),
      z.object({ github: z.string().optional(), slack: z.string().optional(), jiraAccountId: z.string().optional() }),
    )
    .default({}),
  oneOnOne: z.object({ spaceId: z.string().optional(), parentId: z.string().optional() }).default({}),
});
export type People = z.infer<typeof PeopleSchema>;

export function loadPeople(configDir?: string): People {
  const f = configDir ? join(configDir, 'people.yaml') : '';
  return PeopleSchema.parse(f && exists(f) ? (parseYaml(readText(f)) ?? {}) : {});
}

export interface RosterEntry extends Person {
  pageId?: string;
  github?: string;
}

/** Direct reports from the HR directory, with their 1:1 page if one exists. */
export async function roster(ctx: AppContext): Promise<RosterEntry[]> {
  const me = ctx.settings.identity.email;
  if (!me) throw new Error('Set your work email: orgspec settings identity --email you@company.com');
  const people = loadPeople(ctx.configDir);
  const reports = await ctx.workplace().hr.reports(me);
  const db = ctx.db();
  return reports.map((p) => {
    const pageId = (
      db.prepare('select value from kv where key = ?').get(`oneonone:${p.email}`) as { value: string } | undefined
    )?.value;
    const github = people.people[p.email]?.github;
    return { ...p, ...(pageId ? { pageId } : {}), ...(github ? { github } : {}) };
  });
}

const AGENDA = '<h2>Agenda</h2>';
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The shared agenda page for a manager and report: a Confluence page restricted to the two of them.
 * Created on first use; the page ID is remembered locally.
 */
export async function ensureOneOnOnePage(ctx: AppContext, report: Person): Promise<string> {
  const db = ctx.db();
  const known = (
    db.prepare('select value from kv where key = ?').get(`oneonone:${report.email}`) as { value: string } | undefined
  )?.value;
  if (known) return known;
  const people = loadPeople(ctx.configDir);
  const { spaceId, parentId } = people.oneOnOne;
  if (!spaceId) throw new Error('Set oneOnOne.spaceId in orgspec-config/people.yaml');
  const meName = ctx.settings.identity.email ?? 'me';
  const page = await ctx.workplace().confluence.create({
    spaceId,
    ...(parentId ? { parentId } : {}),
    title: `1:1 ${meName} / ${report.email}`,
    body: `<p>Shared agenda for ${esc(report.name)} and their manager. Only the two of you can see this page.</p>${AGENDA}<ul></ul><h2>Notes</h2>`,
  });
  const users = [ctx.settings.identity.jiraAccountId, people.people[report.email]?.jiraAccountId].filter(
    (x): x is string => Boolean(x),
  );
  if (users.length === 2) await ctx.workplace().confluence.restrict(page.id, users);
  db.prepare('insert or replace into kv (key, value) values (?, ?)').run(`oneonone:${report.email}`, page.id);
  return page.id;
}

/** Adds an item to the shared agenda (a new page version). */
export async function addAgendaItem(ctx: AppContext, report: Person, item: string): Promise<number> {
  const pageId = await ensureOneOnOnePage(ctx, report);
  const c = ctx.workplace().confluence;
  const page = await c.get(pageId);
  const li = `<li>${esc(item)} <em>(${new Date().toISOString().slice(0, 10)})</em></li>`;
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

export const BriefSchema = z.object({
  highlights: z.array(z.object({ text: z.string(), source: z.string() })).default([]),
  blockers: z.array(z.object({ text: z.string(), source: z.string() })).default([]),
  talkingPoints: z.array(z.string()).max(3).default([]),
});
export type Brief = z.infer<typeof BriefSchema>;

/** Prepares a 1:1 brief from work signals only (tickets, PRs, agenda). Stored encrypted. */
export async function prepareBrief(ctx: AppContext, report: RosterEntry): Promise<Brief & { id: string }> {
  const w = ctx.workplace();
  const signals: Record<string, string> = {};
  const issues = await w.jira
    .search(`assignee = "${report.email.replace(/"/g, '')}" AND updated >= -14d ORDER BY updated DESC`, { limit: 30 })
    .catch(() => []);
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
    signals.pullRequests =
      prs
        .map(
          (p) =>
            `${p.repo}#${p.number} ${p.title} [${p.state}${p.isDraft ? ', draft' : ''}${p.reviewDecision ? `, ${p.reviewDecision}` : ''}]`,
        )
        .join('\n') || 'none';
  }
  if (report.pageId) {
    const page = await w.confluence.get(report.pageId).catch(() => undefined);
    if (page) signals.agenda = page.storage.replace(/<[^>]+>/g, ' ').slice(0, 4000);
  }
  const job = await runAgentJob(ctx, {
    kind: 'brief',
    agent: 'brief-writer',
    prompt: promptWith(
      `Prepare a brief for a 1:1 with ${report.name}. Return {"highlights": [{"text","source"}], "blockers": [{"text","source"}], "talkingPoints": [string]}.`,
      signals,
    ),
    schema: BriefSchema,
    input: { report: report.email },
  });
  const id = `brf_${randomUUID().slice(0, 10)}`;
  ctx
    .privateDb()
    .prepare('insert into briefs (id, report, payload, created_at) values (?, ?, ?, ?)')
    .run(id, report.email, sealJson(await ctx.key(), job.data), nowIso());
  return { ...job.data, id };
}
