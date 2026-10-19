import { exists, nowIso } from '@orgspec/core';
import type { JiraIssue } from '@orgspec/integrations';
import { findWorkspace, listChangeIds } from '@orgspec/spec-engine';
import type { AppContext } from './context.js';
import { indexDecisions, listDecisions } from './decisions.js';
import { syncGates } from './gates.js';
import { pruneInbox, syncDmInbox } from './inbox.js';
import { listPackets } from './packet.js';
import { remind } from './reminders.js';
import { reviewPrd } from './reviews.js';
import { proposeNudges, scoreCachedIssues } from './risk.js';
import type { SyncJob } from './scheduler.js';

export function upsertIssues(ctx: AppContext, issues: readonly JiraIssue[]): void {
  const db = ctx.db();
  const ins = db.prepare(
    `insert into cache_jira_issues (key, project, type, status, summary, assignee, priority, labels, epic, created_at, source_updated_at, fetched_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(key) do update set project = excluded.project, type = excluded.type, status = excluded.status,
       summary = excluded.summary, assignee = excluded.assignee, priority = excluded.priority, labels = excluded.labels,
       epic = excluded.epic, source_updated_at = excluded.source_updated_at, fetched_at = excluded.fetched_at`,
  );
  const at = nowIso();
  for (const i of issues) {
    ins.run(
      i.key,
      i.project,
      i.type ?? null,
      i.status,
      i.summary,
      i.assignee?.email ?? i.assignee?.name ?? null,
      i.priority ?? null,
      JSON.stringify({
        labels: i.labels,
        ...(i.due ? { due: i.due } : {}),
        ...(i.statusCategory ? { statusCategory: i.statusCategory } : {}),
      }),
      i.parent ?? null,
      i.created ?? null,
      i.updated,
      at,
    );
  }
}

/** Repos with a local checkout and an orgspec/ folder (configured paths and packet worktrees). */
function localRepos(ctx: AppContext) {
  const out: { slug: string; path: string }[] = [];
  for (const r of ctx.settings.repos) if (r.path && exists(r.path)) out.push({ slug: r.slug, path: r.path });
  for (const p of listPackets(ctx))
    for (const r of p.repos) if (exists(r.path)) out.push({ slug: r.slug, path: r.path });
  return out.filter((r) => exists(`${r.path}/orgspec`));
}

/** One job per sync source. Each returns a short status line for the Sync screen. */
export function syncJobs(ctx: AppContext): Record<string, SyncJob> {
  const w = () => ctx.workplace();
  return {
    'jira.active': async () => {
      const projects = ctx.settings.jira.projects;
      const jql = `(assignee = currentUser()${projects.length ? ` OR project in (${projects.join(', ')})` : ''}) AND statusCategory != Done ORDER BY updated DESC`;
      const issues = await w().jira.search(jql, { limit: 300 });
      upsertIssues(ctx, issues);
      return `${issues.length} active issues`;
    },
    'jira.programs': async () => {
      const jql = ctx.settings.jira.programJql;
      if (!jql) return 'no program JQL set';
      const issues = await w().jira.search(jql, { limit: 1000 });
      upsertIssues(ctx, issues);
      const day = nowIso().slice(0, 10);
      const byEpic = new Map<string, JiraIssue[]>();
      for (const i of issues) if (i.parent) byEpic.set(i.parent, [...(byEpic.get(i.parent) ?? []), i]);
      const snap = ctx
        .db()
        .prepare('insert or replace into cache_jira_snapshots (program, day, data) values (?, ?, ?)');
      for (const [epic, list] of byEpic) {
        const counts: Record<string, number> = {};
        for (const i of list) counts[i.statusCategory ?? i.status] = (counts[i.statusCategory ?? i.status] ?? 0) + 1;
        snap.run(epic, day, JSON.stringify({ total: list.length, counts }));
      }
      const scores = scoreCachedIssues(ctx);
      const recipients: Record<string, string> = {};
      const people = ctx.config() ? (await import('./oneonone.js')).loadPeople(ctx.configDir) : undefined;
      for (const i of issues) {
        const slack = i.assignee?.email ? people?.people[i.assignee.email]?.slack : undefined;
        if (slack) recipients[i.key] = slack;
      }
      const nudges = proposeNudges(ctx, scores, { recipients });
      return `${issues.length} program issues, ${byEpic.size} epics, ${scores.filter((s) => s.band === 'high').length} high risk, ${nudges.length} nudge(s) proposed`;
    },
    'confluence.sources': async () => {
      const cfg = ctx.config();
      if (!cfg) return 'no orgspec-config';
      const db = ctx.db();
      let changed = 0;
      for (const o of cfg.overlays) {
        for (const s of o.spec.sources) {
          const page = await w().confluence.get(s.confluence.pageId);
          const prev = db.prepare('select version from cache_confluence_pages where page_id = ?').get(page.id) as
            | { version: number }
            | undefined;
          db.prepare(
            'insert or replace into cache_confluence_pages (page_id, title, space, version, source_updated_at, fetched_at) values (?, ?, ?, ?, ?, ?)',
          ).run(page.id, page.title, s.confluence.space, page.version, page.updated ?? null, nowIso());
          if (prev && prev.version !== page.version) {
            changed++;
            remind(ctx, {
              kind: 'constitution-source',
              subject: page.id,
              title: `“${page.title}” changed (v${prev.version} → v${page.version}); recompile the constitution`,
            });
          }
        }
      }
      return changed ? `${changed} source page(s) changed` : 'sources unchanged';
    },
    'confluence.reviews': async () => {
      const label = ctx.settings.jira.prdLabel;
      const pages = await w().confluence.search(`label = "${label}" AND type = page ORDER BY lastmodified DESC`, 25);
      const db = ctx.db();
      const auto = ctx.persona()?.spec.views.includes('prd-reviews') ?? false;
      let reviewed = 0;
      for (const p of pages) {
        const prev = db.prepare('select version from cache_confluence_pages where page_id = ?').get(p.id) as
          | { version: number | null }
          | undefined;
        if (prev && p.version !== undefined && prev.version === p.version) continue;
        if (auto) {
          await reviewPrd(ctx, p.id);
          reviewed++;
        } else remind(ctx, { kind: 'prd-review', subject: p.id, title: `PRD “${p.title}” is ready for review` });
      }
      return `${pages.length} PRD page(s), ${reviewed} reviewed`;
    },
    'slack.dms': async () => {
      const r = await syncDmInbox(ctx);
      pruneInbox(ctx);
      return `${r.messages} new message(s), ${r.tasks} task(s)`;
    },
    'github.prs': async () => {
      const login = ctx.settings.identity.githubLogin ?? '@me';
      const db = ctx.db();
      const ins = db.prepare(
        'insert or replace into cache_github_prs (repo, number, branch, title, state, author, review_decision, url, updated_at, fetched_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      );
      let n = 0;
      for (const r of ctx.settings.repos) {
        for (const p of await ctx.gh.prList(r.slug, { author: login, limit: 30 })) {
          ins.run(
            r.slug,
            p.number,
            p.headRefName,
            p.title,
            p.isDraft ? 'draft' : p.state,
            p.author ?? null,
            p.reviewDecision ?? null,
            p.url,
            p.updatedAt ?? null,
            nowIso(),
          );
          n++;
        }
      }
      return `${n} open pull request(s)`;
    },
    'ci.runs': async () => {
      const db = ctx.db();
      const ins = db.prepare(
        'insert or replace into cache_ci_runs (id, repo, branch, sha, status, conclusion, steps, url, source_updated_at, fetched_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      );
      let n = 0;
      for (const p of listPackets(ctx).filter((x) => x.state === 'active')) {
        for (const r of p.repos) {
          for (const run of await w().ci.runs(r.slug, { branch: r.branch, limit: 3 })) {
            ins.run(
              `${r.slug}:${run.id}`,
              r.slug,
              run.branch ?? r.branch,
              run.commit ?? null,
              run.state,
              run.state,
              JSON.stringify(run.steps),
              run.url ?? null,
              run.finishedAt ?? run.startedAt ?? nowIso(),
              nowIso(),
            );
            if (run.state === 'failed')
              remind(ctx, {
                kind: 'ci-failed',
                subject: `${r.slug}:${run.id}`,
                title: `CI failed for ${p.ticket} in ${r.slug}`,
                ...(run.url ? { url: run.url } : {}),
              });
            n++;
          }
        }
      }
      const repos = localRepos(ctx).map((r) => {
        const ws = findWorkspace(r.path);
        return { ws, slug: r.slug, changes: listChangeIds(ws) };
      });
      const gates = await syncGates(ctx, repos);
      return `${n} CI run(s); gates updated for ${gates.updated.length} ticket(s)${gates.errors.length ? `; ${gates.errors.length} error(s)` : ''}`;
    },
    'hr.directory': async () => {
      if (!ctx.settings.identity.email) return 'no identity email';
      const reports = await w().hr.reports(ctx.settings.identity.email);
      ctx.db().prepare("insert or replace into kv (key, value) values ('hr:reports', ?)").run(JSON.stringify(reports));
      return `${reports.length} direct report(s)`;
    },
    'config.pull': async () => {
      const dir = ctx.configDir;
      if (!dir) return 'no orgspec-config';
      await ctx.git.pull(dir);
      const db = ctx.db();
      let indexed = 0;
      for (const r of localRepos(ctx))
        indexed += indexDecisions(db, r.slug, listDecisions(findWorkspace(r.path), r.slug));
      return `config up to date; ${indexed} decision record(s) indexed`;
    },
  };
}
