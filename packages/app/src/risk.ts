import { randomUUID } from 'node:crypto';
import { nowIso } from '@orgspec/core';
import { pendingActions } from '@orgspec/gateway';
import type { AppContext } from './context.js';

export interface RiskSignals {
  key: string;
  status: string;
  statusCategory?: string;
  assignee?: string;
  due?: string;
  updated: string;
  labels: string[];
  ciFailing?: boolean;
  prAwaitingReviewDays?: number;
  tier?: string;
  specInvalid?: boolean;
}

export interface RiskDriver {
  signal: string;
  weight: number;
  detail: string;
}

export interface RiskScore {
  key: string;
  score: number;
  band: 'low' | 'medium' | 'high';
  drivers: RiskDriver[];
}

const DAY = 86_400_000;

/** Deterministic delivery risk from cached signals; Claude only explains it, never computes it. */
export function scoreRisk(s: RiskSignals, now = Date.now()): RiskScore {
  const drivers: RiskDriver[] = [];
  const add = (signal: string, weight: number, detail: string) => drivers.push({ signal, weight, detail });
  const done = s.statusCategory === 'done' || /^(done|closed|resolved)$/i.test(s.status);
  if (!done) {
    const idle = Math.floor((now - Date.parse(s.updated)) / DAY);
    if (idle >= 10) add('stale', 25, `No update in ${idle} days`);
    else if (idle >= 5) add('stale', 12, `No update in ${idle} days`);
    if (s.due) {
      const left = Math.ceil((Date.parse(s.due) - now) / DAY);
      if (left < 0) add('overdue', 35, `Due ${-left} day(s) ago`);
      else if (left <= 3 && s.statusCategory !== 'indeterminate')
        add('due-soon', 20, `Due in ${left} day(s) and not started`);
      else if (left <= 3) add('due-soon', 10, `Due in ${left} day(s)`);
    }
    if (!s.assignee) add('unassigned', 15, 'Nobody is assigned');
    if (s.labels.some((l) => /block/i.test(l)) || /block/i.test(s.status)) add('blocked', 25, 'Marked blocked');
    if (s.ciFailing) add('ci', 15, 'CI is failing on the branch');
    if ((s.prAwaitingReviewDays ?? 0) >= 2)
      add('review', 10, `Pull request waiting for review ${s.prAwaitingReviewDays} days`);
    if (s.specInvalid) add('spec', 10, 'Change folder does not validate');
    if (s.tier === 'high' && drivers.length) add('tier', 5, 'High-tier change');
  }
  const score = Math.min(
    100,
    drivers.reduce((n, d) => n + d.weight, 0),
  );
  drivers.sort((a, b) => b.weight - a.weight);
  return { key: s.key, score, band: score >= 50 ? 'high' : score >= 25 ? 'medium' : 'low', drivers };
}

interface IssueRow {
  key: string;
  status: string;
  assignee: string | null;
  labels: string | null;
  source_updated_at: string;
  tier: string | null;
  gate_fields: string | null;
  epic: string | null;
}

/** Scores every cached issue (optionally one epic/program) and records the scores. */
export function scoreCachedIssues(ctx: AppContext, program?: string): RiskScore[] {
  const db = ctx.db();
  const rows = (program
    ? db.prepare('select * from cache_jira_issues where epic = ? or key = ?').all(program, program)
    : db.prepare('select * from cache_jira_issues').all()) as unknown as IssueRow[];
  const at = nowIso();
  const ins = db.prepare(
    'insert or replace into risk_scores (program_id, score, band, drivers, computed_at) values (?, ?, ?, ?, ?)',
  );
  return rows.map((r) => {
    const gates = r.gate_fields ? (JSON.parse(r.gate_fields) as Record<string, string>) : {};
    const extra = r.labels
      ? (JSON.parse(r.labels) as { labels?: string[]; due?: string; statusCategory?: string })
      : {};
    const ci = db
      .prepare('select status, conclusion from cache_ci_runs where branch = ? order by source_updated_at desc limit 1')
      .get(r.key.toLowerCase()) as { status: string; conclusion: string | null } | undefined;
    const score = scoreRisk({
      key: r.key,
      status: r.status,
      ...(extra.statusCategory ? { statusCategory: extra.statusCategory } : {}),
      ...(r.assignee ? { assignee: r.assignee } : {}),
      ...(extra.due ? { due: extra.due } : {}),
      updated: r.source_updated_at,
      labels: extra.labels ?? [],
      ciFailing: (ci?.conclusion ?? ci?.status) === 'failed',
      ...(r.tier ? { tier: r.tier } : {}),
      specInvalid: Object.values(gates).includes('invalid'),
    });
    ins.run(r.key, score.score, score.band, JSON.stringify(score.drivers), at);
    return score;
  });
}

/**
 * Proposes nudges for high-risk tickets. Each nudge is a pending Slack action the person approves;
 * the same ticket and recipient are not nudged twice within `quiet`.
 */
export function proposeNudges(
  ctx: AppContext,
  scores: readonly RiskScore[],
  o: { recipients: Record<string, string>; quietMs?: number },
): string[] {
  const db = ctx.db();
  const pending = pendingActions(db);
  const quiet = o.quietMs ?? DAY;
  const out: string[] = [];
  for (const s of scores.filter((x) => x.band === 'high')) {
    const recipient = o.recipients[s.key];
    if (!recipient) continue;
    const last = db
      .prepare('select sent_at from nudges where ticket = ? and recipient = ? order by sent_at desc limit 1')
      .get(s.key, recipient) as { sent_at: string } | undefined;
    if (last && Date.now() - Date.parse(last.sent_at) < quiet) continue;
    const text = `${s.key} looks at risk: ${s.drivers
      .slice(0, 2)
      .map((d) => d.detail.toLowerCase())
      .join('; ')}. Anything I can help unblock?`;
    const a = pending.create({
      server: 'slack',
      tool: 'chat_post_message',
      args: { channel: recipient, text },
      summary: `Nudge ${recipient} about ${s.key}\n${text}`,
      ticket: s.key,
    });
    db.prepare('insert into nudges (id, ticket, recipient, channel, sent_at) values (?, ?, ?, ?, ?)').run(
      `ndg_${randomUUID().slice(0, 8)}`,
      s.key,
      recipient,
      'slack',
      nowIso(),
    );
    out.push(a.id);
  }
  return out;
}

/** Runs an approved pending action through the upstream pool (dashboard and CLI approvals). */
export async function executePending(ctx: AppContext, id: string): Promise<{ ok: boolean; result: string }> {
  const pending = pendingActions(ctx.db());
  const a = pending.get(id);
  if (!a) throw new Error(`No pending action ${id}`);
  if (a.state !== 'approved') throw new Error(`${id} is ${a.state}, not approved`);
  try {
    const r = await ctx.pool().callTool(`${a.server}__${a.tool}`, a.args);
    const result = JSON.stringify(r.content ?? []);
    pending.finish(id, !r.isError, result);
    return { ok: !r.isError, result };
  } catch (e) {
    pending.finish(id, false, (e as Error).message);
    return { ok: false, result: (e as Error).message };
  }
}
