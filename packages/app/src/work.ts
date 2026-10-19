import { join } from 'node:path';
import type { Rule } from '@orgspec/constitution';
import { exists, openJson, readText } from '@orgspec/core';
import type { JiraIssue } from '@orgspec/integrations';
import {
  changeStatus,
  findWorkspace,
  listChangeIds,
  loadChange,
  type Tier,
  type Workspace,
} from '@orgspec/spec-engine';
import { artifactHashes, readApprovals } from './approvals.js';
import type { AppContext } from './context.js';
import { overlap, searchDecisions } from './decisions.js';
import { listPackets } from './packet.js';
import { currentSession, type TicketSession } from './session.js';

// What an individual contributor sees: their tickets, each ticket's spec and agent state, and their sessions.

export interface IssueRow {
  key: string;
  summary: string;
  status: string;
  type?: string;
  priority?: string;
  assignee?: string;
  updated: string;
}

export function myIssues(ctx: AppContext): IssueRow[] {
  const me = (ctx.settings.identity.email ?? '').toLowerCase();
  const login = (ctx.settings.identity.githubLogin ?? '').toLowerCase();
  const rows = ctx
    .db()
    .prepare(
      'select key, summary, status, type, priority, assignee, source_updated_at from cache_jira_issues order by source_updated_at desc',
    )
    .all() as Record<string, string | null>[];
  return rows
    .filter((r) => {
      const a = (r.assignee ?? '').toLowerCase();
      return !me || a === me || (login && a === login) || a === me.split('@')[0];
    })
    .map((r) => ({
      key: String(r.key),
      summary: String(r.summary ?? ''),
      status: String(r.status ?? ''),
      ...(r.type ? { type: r.type } : {}),
      ...(r.priority ? { priority: r.priority } : {}),
      ...(r.assignee ? { assignee: r.assignee } : {}),
      updated: String(r.source_updated_at ?? ''),
    }));
}

/** Local repos with an orgspec/ folder: configured clones and packet worktrees. */
export function localWorkspaces(ctx: AppContext): { slug: string; ws: Workspace }[] {
  const out: { slug: string; ws: Workspace }[] = [];
  const seen = new Set<string>();
  const add = (slug: string, path?: string) => {
    if (!path || seen.has(path) || !exists(join(path, 'orgspec', 'repo.yaml'))) return;
    seen.add(path);
    out.push({ slug, ws: findWorkspace(path) });
  };
  for (const p of listPackets(ctx)) for (const r of p.repos) add(r.slug, r.path);
  for (const r of ctx.settings.repos) add(r.slug, r.path);
  return out;
}

export const SCHEMA_FOR_TYPE: Record<string, string> = {
  bug: 'bugfix',
  story: 'feature',
  spike: 'spike',
  task: 'chore',
  chore: 'chore',
  epic: 'feature',
};
export const schemaForType = (type?: string) => SCHEMA_FOR_TYPE[(type ?? 'story').toLowerCase()] ?? 'feature';

export interface SpecState {
  label: string;
  kind: '' | 'ok' | 'warn' | 'bad' | 'info';
  changeId?: string;
  tier?: Tier;
  ws?: Workspace;
}

/** Whether a ticket's spec is approved, in review, missing or not needed (bugs, spikes and chores need none). */
export function specState(ctx: AppContext, key: string, type: string | undefined, rules: readonly Rule[]): SpecState {
  for (const { ws } of localWorkspaces(ctx)) {
    const id = listChangeIds(ws).find((c) => c === key || c.startsWith(`${key}-`));
    if (!id) continue;
    const change = loadChange(ws, id);
    const tier = change.meta?.tier;
    const st = changeStatus(change);
    const hashes = artifactHashes(change);
    const current = readApprovals(change.dir).entries.filter((e) => hashes[e.artifact] === e.sha256);
    const needed = Math.max(
      1,
      ...rules
        .filter((r) => r.check?.kind === 'approval' && (!tier || r.appliesTo.tiers.includes(tier)))
        .map((r) => (r.check?.kind === 'approval' ? r.check.count : 1)),
    );
    const base = { changeId: id, ws, ...(tier ? { tier } : {}) };
    if (!st?.planningComplete) return { ...base, label: `Drafting · next ${st?.next ?? 'artifact'}`, kind: 'warn' };
    if (current.length >= needed) return { ...base, label: 'Approved', kind: 'ok' };
    return { ...base, label: `In review · ${current.length} of ${needed} approvals`, kind: 'info' };
  }
  const schema = schemaForType(type);
  if (schema !== 'feature') return { label: `Not needed (${(type ?? schema).toLowerCase()})`, kind: '' };
  return { label: 'No spec yet', kind: 'warn' };
}

export interface AgentSession {
  id: string;
  ticket?: string;
  name?: string;
  status: string;
  state: 'needs-input' | 'working' | 'ready' | 'idle' | 'stopped';
  startedAt?: string;
  cwd?: string;
  packet?: TicketSession;
  pr?: { number: number; url: string; state: string };
}

const STATE: [RegExp, AgentSession['state']][] = [
  [/wait|input|permission|blocked|ask/i, 'needs-input'],
  [/run|work|busy|think|active/i, 'working'],
  [/exit|stop|kill|dead|done|complete/i, 'stopped'],
];

/** OrgSpec's Claude sessions (only those under the ticket root), joined with their packets and PRs. */
export async function mySessions(ctx: AppContext): Promise<AgentSession[]> {
  const sessions = await ctx.sessions.list(ctx.workRoot).catch(() => []);
  const packets = listPackets(ctx);
  const prs = ctx.db().prepare('select repo, number, branch, url, state from cache_github_prs').all() as {
    repo: string;
    number: number;
    branch: string;
    url: string;
    state: string;
  }[];
  return sessions
    .filter((s) => !s.cwd || s.cwd.startsWith(ctx.workRoot))
    .map((s) => {
      const packet = packets.find((p) => s.cwd && (s.cwd === p.folder || s.cwd.startsWith(`${p.folder}/`)));
      const ticket = packet?.ticket ?? /([A-Z][A-Z0-9]+-\d+)/.exec(s.name ?? '')?.[1];
      const pr = ticket ? prs.find((p) => p.branch.toLowerCase().startsWith(ticket.toLowerCase())) : undefined;
      // The CLI's lifecycle state wins: blocked = waiting on you, done = finished its work.
      let state: AgentSession['state'] =
        s.state === 'blocked'
          ? 'needs-input'
          : s.state === 'stopped'
            ? 'stopped'
            : s.state === 'done'
              ? 'ready'
              : (STATE.find(([re]) => re.test(s.status))?.[1] ?? 'idle');
      if (state === 'idle' && pr) state = 'ready';
      return {
        id: s.id,
        status: s.status,
        state,
        ...(ticket ? { ticket } : {}),
        ...(s.name ? { name: s.name } : {}),
        ...(s.startedAt ? { startedAt: s.startedAt } : {}),
        ...(s.cwd ? { cwd: s.cwd } : {}),
        ...(packet ? { packet: currentSession(packet.folder) } : {}),
        ...(pr ? { pr: { number: pr.number, url: pr.url, state: pr.state } } : {}),
      };
    });
}

/** Readable tail of a background session's terminal output (ANSI and spinner noise removed). */
export function cleanLogs(raw: string, lines = 14): string[] {
  const ESC = String.fromCharCode(27);
  const BEL = String.fromCharCode(7);
  const text = raw
    .replace(new RegExp(`${ESC}\\][^${BEL}]*${BEL}`, 'g'), '')
    .replace(new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, 'g'), ' ')
    .replace(/[⠀-⣿✢✳✶✻✽·⏺⎿]/g, ' ');
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 2 && !/^[─━]+$/.test(l) && !/(…|thinking|esc to interrupt|tokens\))/i.test(l))
    .slice(-lines);
}

export interface TicketDetail {
  issue: JiraIssue;
  description: string;
  acceptance: string[];
  schema: string;
  playbook: { step: string; detail: string }[];
  stopsIf: string;
  spec: SpecState;
  decisions: { adrId: string; title: string; status: string; file: string }[];
  slack: string[];
  may: string[];
  mayNot: string[];
  packet?: TicketSession;
}

export const PLAYBOOKS: Record<string, { steps: [string, string][]; stopsIf: string }> = {
  bugfix: {
    steps: [
      ['Reproduce', 'Confirm the problem locally'],
      ['Failing test', 'Write it before the fix'],
      ['Fix', 'Smallest change that passes'],
      ['Verify', 'Full suite and checks'],
    ],
    stopsIf:
      "it can't reproduce, the fix needs files outside the ticket's scope, or a check fails that it can't explain.",
  },
  feature: {
    steps: [
      ['Specify', 'Proposal and delta specs, validated'],
      ['Design', 'design.md (and threat model at high tier)'],
      ['Plan', 'tasks.md in merge order'],
      ['Implement', 'Tests cite each scenario'],
      ['Verify', 'orgspec validate --strict and trace'],
      ['Draft PR', 'Ready for a person to review'],
    ],
    stopsIf:
      'the spec is not approved, a change needs files the spec does not name, or a check fails it cannot explain.',
  },
  spike: {
    steps: [
      ['Question', 'State what the spike must answer'],
      ['Investigate', 'Prototype in a throwaway branch'],
      ['Findings', 'findings.md with evidence'],
      ['Recommend', 'Next step and a rough size'],
    ],
    stopsIf: 'the timebox runs out; it reports what it learned so far.',
  },
  chore: {
    steps: [
      ['Change', 'Mechanical change only'],
      ['Verify', 'Full suite and checks'],
    ],
    stopsIf: 'the change turns out to alter behaviour.',
  },
};

/** What an agent may and may not do at a tier, read from the persona's hook rules. */
export function agentPermissions(rules: readonly Rule[], tier: Tier): { may: string[]; mayNot: string[] } {
  const may = ['Branch, commit, run tests', 'Push the ticket branch'];
  const mayNot = ['Push to main or release branches'];
  let readyPr = true;
  for (const r of rules) {
    if (r.enforcement !== 'hook' || !r.check) continue;
    const c = r.check;
    if (c.kind === 'git-op' && c.tiers.includes(tier)) {
      if (c.deny.includes('force-push')) mayNot.push('Force-push');
      if (c.deny.includes('merge')) mayNot.push('Merge');
      if (c.ask.includes('pr-ready') || c.deny.includes('pr-ready')) readyPr = false;
      if (c.ask.includes('merge')) mayNot.push('Merge without asking you');
    }
    if (c.kind === 'file-scope' && c.tiers.includes(tier))
      mayNot.push(`Touch ${c.deny.join(', ')}${c.allowWhenNamedInSpec ? ' unless the spec names it' : ''}`);
  }
  may.push(readyPr ? 'Open a PR ready for review' : 'Open a draft PR (you mark it ready)');
  return { may, mayNot: [...new Set(mayNot)] };
}

export async function ticketDetail(ctx: AppContext, key: string): Promise<TicketDetail> {
  const issue = await ctx
    .workplace()
    .jira.get(key, [
      'summary',
      'status',
      'issuetype',
      'priority',
      'assignee',
      'reporter',
      'description',
      'labels',
      'updated',
      'project',
      'components',
    ]);
  const raw = issue.fields.description;
  const description = typeof raw === 'string' ? raw : raw ? JSON.stringify(raw) : '';
  const acMatch = /acceptance criteria:?\s*([\s\S]*?)(?:\n\s*\n[A-Z][^\n]*:|$)/i.exec(description);
  const acceptance = (acMatch?.[1] ?? '')
    .split('\n')
    .map((l) => l.replace(/^\s*[-*•\d.)]+\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 10);
  const schema = schemaForType(issue.type);
  const pb = PLAYBOOKS[schema] ?? PLAYBOOKS.feature;
  const rules = ctx.bundle().bundle?.rules ?? [];
  const spec = specState(ctx, key, issue.type, rules);
  const tier: Tier = spec.tier ?? (schema === 'feature' ? 'medium' : 'low');
  const decisions = searchDecisions(ctx.db(), issue.summary, 5, { any: true })
    .filter((d) => overlap(issue.summary, `${d.title} ${d.snippet}`) >= 2)
    .slice(0, 3)
    .map((d) => ({ adrId: d.adrId, title: d.title, status: d.status, file: d.file }));
  const pdb = ctx.privateDb();
  const kp = await ctx.key();
  const slack = (
    pdb.prepare('select payload from summaries order by created_at desc limit 50').all() as { payload: string }[]
  )
    .map((r) => openJson<{ summary?: string }>(kp, r.payload))
    .filter((s) => (s.summary ?? '').includes(key))
    .map((s) => s.summary ?? '')
    .slice(0, 2);
  const { may, mayNot } = agentPermissions(rules, tier);
  const packet = listPackets(ctx).find((p) => p.ticket === key);
  return {
    issue,
    description,
    acceptance,
    schema,
    playbook: (pb?.steps ?? []).map(([step, detail]) => ({ step, detail })),
    stopsIf: pb?.stopsIf ?? '',
    spec: { ...spec, tier },
    decisions,
    slack,
    may,
    mayNot,
    ...(packet ? { packet: currentSession(packet.folder) } : {}),
  };
}

/** The change folder's spec summary for the ticket page (capabilities, requirement and scenario counts). */
export function specSummary(spec: SpecState): { capability: string; requirements: number; scenarios: number }[] {
  if (!spec.ws || !spec.changeId) return [];
  const change = loadChange(spec.ws, spec.changeId);
  return change.deltas.map((d) => {
    const text = readText(d.file);
    return {
      capability: d.capabilityId,
      requirements: (text.match(/^### Requirement:/gm) ?? []).length,
      scenarios: (text.match(/^#### Scenario:/gm) ?? []).length,
    };
  });
}
