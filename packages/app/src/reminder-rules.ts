import { join } from 'node:path';
import { exists, matchesAny, readText } from '@orgspec/core';
import { listChangeIds, loadChange } from '@orgspec/spec-engine';
import { parse as parseYaml } from 'yaml';
import { artifactHashes, readApprovals } from './approvals.js';
import type { AppContext } from './context.js';
import { listDecisions } from './decisions.js';
import { remind } from './reminders.js';
import { localWorkspaces } from './work.js';

/** Working days between two dates (Mon–Fri). */
export function workingDaysBetween(from: Date, to: Date): number {
  let n = 0;
  const d = new Date(from);
  d.setHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setHours(0, 0, 0, 0);
  while (d < end) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) n++;
  }
  return n;
}

/** The PRD review SLA in working days, from a compiled rule mentioning it, else 5. */
export function prdSla(ctx: AppContext): number {
  const rule = ctx.bundle().bundle?.rules.find((r) => /prd\.review\.sla/.test(r.id));
  const n = rule ? /(\d+)\s*(working )?days?/i.exec(rule.statement)?.[1] : undefined;
  return n ? Number(n) : 5;
}

/** `capabilities:` in orgspec/repo.yaml maps capability IDs to the code paths they describe. */
export function capabilityPaths(repoRoot: string): Record<string, string[]> {
  const f = join(repoRoot, 'orgspec', 'repo.yaml');
  if (!exists(f)) return {};
  const raw = (parseYaml(readText(f)) ?? {}) as { capabilities?: Record<string, string[] | string> };
  return Object.fromEntries(Object.entries(raw.capabilities ?? {}).map(([k, v]) => [k, Array.isArray(v) ? v : [v]]));
}

export interface ComputeResult {
  added: number;
  kinds: Record<string, number>;
}

/** Creates reminders for everything that is waiting on this person. Idempotent: one open reminder per item. */
export async function computeReminders(ctx: AppContext, now = new Date()): Promise<ComputeResult> {
  const kinds: Record<string, number> = {};
  const add = (kind: string, subject: string, title: string, url?: string) => {
    if (remind(ctx, { kind, subject, title, ...(url ? { url } : {}) })) kinds[kind] = (kinds[kind] ?? 0) + 1;
  };
  const db = ctx.db();
  const views = ctx.persona()?.spec.views ?? [];

  // PRDs waiting for review against the SLA (engineering managers).
  if (views.includes('review-queue')) {
    const sla = prdSla(ctx);
    const seen = db.prepare("select key, value from kv where key like 'prd:seen:%'").all() as {
      key: string;
      value: string;
    }[];
    for (const s of seen) {
      const pageId = s.key.slice('prd:seen:'.length);
      const decided = db.prepare('select value from kv where key = ?').get(`prd:decision:${pageId}`);
      if (decided) continue;
      const waited = workingDaysBetween(new Date(s.value), now);
      if (waited >= sla - 1) {
        const title =
          (
            db.prepare('select title from cache_confluence_pages where page_id = ?').get(pageId) as
              | { title?: string }
              | undefined
          )?.title ?? pageId;
        add(
          'prd-review-wait',
          pageId,
          `PRD “${title}” has waited ${waited} of ${sla} working days for your review`,
          `/reviews/prd/${pageId}`,
        );
      }
    }
  }

  const me = ctx.settings.identity.githubLogin?.toLowerCase();
  const soon = new Date(now.getTime() + 7 * 86_400_000).toISOString().slice(0, 10);
  for (const { slug, ws } of localWorkspaces(ctx)) {
    // Decision reviews coming due.
    for (const d of listDecisions(ws, slug)) {
      if (
        d.review &&
        d.review <= soon &&
        d.status === 'accepted' &&
        (!d.owner || !me || d.owner.toLowerCase().includes(me) || d.owner === ctx.settings.identity.email)
      )
        add(
          'decision-review',
          `${slug}:${d.adrId}`,
          `Decision review due ${d.review} · ${d.adrId} ${d.title}`,
          `/decisions?id=${d.adrId}`,
        );
    }
    // Approvals of yours that went stale.
    if (me) {
      for (const id of listChangeIds(ws)) {
        const change = loadChange(ws, id);
        const hashes = artifactHashes(change);
        for (const e of readApprovals(change.dir).entries) {
          if (e.approver.toLowerCase() === me && hashes[e.artifact] && hashes[e.artifact] !== e.sha256)
            add(
              'stale-approval',
              `${id}:${e.artifact}`,
              `Stale approval · ${e.artifact} for ${id} changed after you approved it`,
              `/reviews?tab=approvals`,
            );
        }
      }
    }
    // Spec drift: code under a capability changed in the last 7 days without a change folder.
    const caps = capabilityPaths(ws.repoRoot);
    if (Object.keys(caps).length) {
      const log = await ctx.git
        .call(ws.repoRoot, ['log', '--since=7.days', '--name-only', '--format=@@%H %s'])
        .catch(() => '');
      for (const commit of log.split('@@').filter(Boolean)) {
        const [head = '', ...files] = commit.split('\n').filter(Boolean);
        if (files.some((f) => f.startsWith('orgspec/changes/'))) continue;
        for (const [cap, globs] of Object.entries(caps)) {
          const hit = files.filter((f) => matchesAny(f, globs));
          if (hit.length)
            add(
              'spec-drift',
              `${slug}:${head.slice(0, 12)}:${cap}`,
              `Spec drift · ${hit[0]} changed in “${head.slice(41, 120)}” with no change to ${cap}`,
              `/decisions`,
            );
        }
      }
    }
  }

  // Findings left unanswered for five working days.
  const old = db
    .prepare(
      "select subject, count(*) as n, min(created_at) as at from findings where status = 'open' and severity != 'pass' group by subject",
    )
    .all() as { subject: string; n: number; at: string }[];
  for (const f of old) {
    if (workingDaysBetween(new Date(f.at), now) >= 5)
      add(
        'findings-unanswered',
        f.subject,
        `${f.n} finding${f.n === 1 ? '' : 's'} unanswered for 5 working days on ${f.subject}`,
        f.subject.startsWith('prd:') ? `/reviews/prd/${f.subject.slice(4)}` : '/reviews',
      );
  }

  // Waivers expiring within 14 days (process owners see them in admin mode too).
  const in14 = new Date(now.getTime() + 14 * 86_400_000).toISOString().slice(0, 10);
  const today = now.toISOString().slice(0, 10);
  for (const w of ctx.config()?.waivers ?? []) {
    if (w.expires >= today && w.expires <= in14)
      add('waiver-expiring', w.id, `Waiver ${w.id} (${w.rule}) expires ${w.expires}`, '/admin/waivers');
  }
  return { added: Object.values(kinds).reduce((a, b) => a + b, 0), kinds };
}
