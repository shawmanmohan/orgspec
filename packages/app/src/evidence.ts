import type { CalendarEvent, JiraIssue, PullRequest } from '@orgspec/integrations';
import type { AppContext } from './context.js';
import { sectionItems } from './oneonone.js';

// The report's side of 1:1s: the same evidence the manager's brief draws on, and a way to add context.

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export interface MyEvidence {
  since: string;
  manager?: { email: string; name?: string };
  nextOneOnOne?: CalendarEvent;
  issues: JiraIssue[];
  prs: PullRequest[];
  page?: { id: string; agenda: string[]; goals: string[]; context: string[] };
  errors: string[];
}

/** Finds the restricted 1:1 page your manager created (its title names your email). */
export async function findMyOneOnOnePage(ctx: AppContext): Promise<string | undefined> {
  const db = ctx.db();
  const known = (
    db.prepare("select value from kv where key = 'myoneonone:page'").get() as { value: string } | undefined
  )?.value;
  if (known) return known;
  const me = ctx.settings.identity.email;
  if (!me) return undefined;
  const hits = await ctx.workplace().confluence.search(`type = page AND title ~ "${me.replace(/"/g, '')}"`, 10);
  const page = hits.find((h) => h.title.startsWith('1:1') && h.title.includes(me));
  if (page) db.prepare("insert or replace into kv (key, value) values ('myoneonone:page', ?)").run(page.id);
  return page?.id;
}

export async function myEvidence(ctx: AppContext): Promise<MyEvidence> {
  const me = ctx.settings.identity.email;
  if (!me) throw new Error('Set your work email in Settings first');
  const w = ctx.workplace();
  const errors: string[] = [];
  const person = await w.hr.person(me).catch((e: Error) => {
    errors.push(`HR directory: ${e.message}`);
    return undefined;
  });
  const managerEmail = person?.managerEmail;
  const manager = managerEmail
    ? await w.hr.person(managerEmail).catch(() => ({ email: managerEmail, name: managerEmail }))
    : undefined;
  const now = Date.now();
  const events = await w.calendar
    .events(new Date(now - 30 * 86_400_000).toISOString(), new Date(now + 21 * 86_400_000).toISOString(), '1:1')
    .catch(() => [] as CalendarEvent[]);
  const withManager = events
    .filter((e) => managerEmail && e.attendees.includes(managerEmail) && e.attendees.includes(me))
    .sort((a, b) => a.start.localeCompare(b.start));
  const last = withManager.filter((e) => Date.parse(e.start) < now).at(-1);
  const next = withManager.find((e) => Date.parse(e.start) >= now);
  const since = (last?.start ?? new Date(now - 14 * 86_400_000).toISOString()).slice(0, 10);
  const issues = await w.jira
    .search(`assignee = "${me}" AND updated >= "${since}" ORDER BY updated DESC`, { limit: 30 })
    .catch((e: Error) => {
      errors.push(`Jira: ${e.message}`);
      return [] as JiraIssue[];
    });
  const login = ctx.settings.identity.githubLogin;
  const prs = login
    ? (
        await Promise.all(
          ctx.settings.repos.map((r) =>
            ctx.gh.prList(r.slug, { author: login, state: 'all', limit: 15 }).catch(() => [] as PullRequest[]),
          ),
        )
      )
        .flat()
        .filter((p) => !p.updatedAt || p.updatedAt.slice(0, 10) >= since)
    : [];
  let page: MyEvidence['page'];
  const pageId = await findMyOneOnOnePage(ctx).catch(() => undefined);
  if (pageId) {
    const p = await w.confluence.get(pageId).catch(() => undefined);
    if (p)
      page = {
        id: pageId,
        agenda: sectionItems(p.storage, /^agenda$/i),
        goals: sectionItems(p.storage, /^goals$/i),
        context: sectionItems(p.storage, /^context from/i),
      };
  }
  return {
    since,
    issues,
    prs,
    errors,
    ...(manager ? { manager: { email: manager.email, ...(manager.name ? { name: manager.name } : {}) } } : {}),
    ...(next ? { nextOneOnOne: next } : {}),
    ...(page ? { page } : {}),
  };
}

/**
 * Adds your context (or a correction) to the shared page's "Context from …" section. The next brief
 * your manager builds includes it.
 */
export async function addMyContext(
  ctx: AppContext,
  text: string,
  o: { about?: string; correction?: boolean } = {},
): Promise<number> {
  const pageId = await findMyOneOnOnePage(ctx);
  if (!pageId) throw new Error('No shared 1:1 page yet; your manager creates it when they schedule your 1:1');
  const c = ctx.workplace().confluence;
  const page = await c.get(pageId);
  const label = o.correction ? 'Correction' : 'Context';
  const para = `<p><strong>${label}${o.about ? ` on ${esc(o.about)}` : ''}:</strong> ${esc(text)} <em>(${new Date().toISOString().slice(0, 10)})</em></p>`;
  const m = /(<h[1-3][^>]*>\s*Context from[^<]*<\/h[1-3]>)([\s\S]*?)(?=<h[1-3]|$)/i.exec(page.storage);
  const body = m
    ? page.storage.replace(m[0], `${m[1]}${m[2]?.replace(/<p>\s*<\/p>/g, '') ?? ''}${para}`)
    : `${page.storage}<h2>Context from ${esc(ctx.settings.identity.email ?? 'me')}</h2>${para}`;
  return (await c.update({ pageId, title: page.title, body, message: `${label} added by the report` })).version;
}

export async function addMyAgendaItem(ctx: AppContext, item: string): Promise<number> {
  const pageId = await findMyOneOnOnePage(ctx);
  if (!pageId) throw new Error('No shared 1:1 page yet');
  const c = ctx.workplace().confluence;
  const page = await c.get(pageId);
  const who = ctx.settings.identity.email?.split('@')[0] ?? 'me';
  const li = `<li>${esc(item)} <em>· ${esc(who)}</em></li>`;
  const body = /<h2>Agenda<\/h2><ul>/i.test(page.storage)
    ? page.storage.replace(/<h2>Agenda<\/h2><ul>/i, `<h2>Agenda</h2><ul>${li}`)
    : `${page.storage}<h2>Agenda</h2><ul>${li}</ul>`;
  return (await c.update({ pageId, title: page.title, body, message: 'Agenda item added' })).version;
}
