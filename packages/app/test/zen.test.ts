import { fakeJobs } from '@orgspec/claude';
import { memoryConnector } from '@orgspec/gateway';
import type { JiraIssue } from '@orgspec/integrations';
import { initWorkspace, newChange } from '@orgspec/spec-engine';
import { describe, expect, it } from 'vitest';
import {
  activeZen,
  deliverReminders,
  endZen,
  extendZen,
  lastVerification,
  purgeFormerReports,
  rankFocus,
  remind,
  renderVerificationMd,
  setFocusDone,
  startDaemon,
  startZen,
  suggestFocus,
  upsertIssues,
  verifyChange,
  zenAutoReply,
  zenEndsAt,
} from '../src/index.js';
import { gitRepo, makeContext, orgConfig, put, RULES, sh } from './helpers.js';

const tool = (name: string) => ({ name, inputSchema: { type: 'object' as const } });

/** A Slack MCP server that records status, Do Not Disturb and posts. */
function slackServer() {
  const state = {
    status: { status_text: 'In meetings', status_emoji: ':calendar:', status_expiration: 0 },
    snooze: 0 as number | null,
    posted: [] as { channel: string; text: string }[],
  };
  const connector = memoryConnector({
    slack: {
      tools: ['users_profile_get', 'users_profile_set', 'dnd_set_snooze', 'dnd_end_snooze', 'chat_post_message'].map(
        tool,
      ),
      handle: (t, a) => {
        if (t === 'users_profile_get') return { profile: state.status };
        if (t === 'users_profile_set') {
          state.status = {
            status_text: String(a.status_text ?? ''),
            status_emoji: String(a.status_emoji ?? ''),
            status_expiration: Number(a.status_expiration ?? 0),
          };
          return { ok: true };
        }
        if (t === 'dnd_set_snooze') state.snooze = Number(a.num_minutes);
        if (t === 'dnd_end_snooze') state.snooze = null;
        if (t === 'chat_post_message') state.posted.push({ channel: String(a.channel), text: String(a.text) });
        return { ok: true, ts: '1.1' };
      },
    },
  });
  return { state, connector };
}

const issue = (key: string, summary: string, status: string, type = 'Story'): JiraIssue => ({
  key,
  summary,
  status,
  type,
  project: key.split('-')[0] ?? '',
  assignee: { email: 'asha@acme.io' },
  updated: new Date().toISOString(),
  labels: [],
  blocks: [],
  blockedBy: [],
});

function zenContext(
  o: { zenYaml?: string; settings?: Record<string, unknown>; jobs?: ReturnType<typeof fakeJobs> } = {},
) {
  const { dir } = orgConfig(RULES, {
    'integrations.yaml': 'servers:\n  slack: { transport: stdio, command: x }\n',
    ...(o.zenYaml ? { 'zen.yaml': o.zenYaml } : {}),
  });
  const slack = slackServer();
  const ctx = makeContext({
    configDir: dir,
    connector: slack.connector,
    jobs: o.jobs ?? fakeJobs({}),
    // No quiet hours, so the test behaves the same at any time of day.
    settings: {
      identity: { email: 'asha@acme.io', slackUserId: 'UME' },
      quietHours: { start: '00:00', end: '00:00' },
      reminders: { mode: 'dm', digestAt: '09:30' },
      ...o.settings,
    },
  });
  return { ctx, slack };
}

describe('zen mode', () => {
  it('ranks incidents first, then current work, and suggests at most three items', async () => {
    const jobs = fakeJobs({ 'zen-planner': { reasons: ['Customers are affected', 'Your current ticket'] } });
    const { ctx } = zenContext({ jobs });
    upsertIssues(ctx, [
      issue('PAY-1', 'Tidy the README', 'In Progress'),
      issue('PAY-2', 'EU captures failing', 'Open', 'Incident'),
      issue('PAY-3', 'Old idea', 'Backlog'),
    ]);
    const ranked = await rankFocus(ctx);
    expect(ranked.map((f) => f.id)).toEqual(['ticket:PAY-2', 'ticket:PAY-1']); // backlog work is not suggested
    expect(ranked[0]?.category).toBe('incident');
    const suggested = await suggestFocus(ctx);
    expect(suggested[0]?.reason).toBe('Customers are affected');
    expect(jobs.calls[0]?.agent).toBe('zen-planner');
    // Without the model the deterministic reasons stay.
    const offline = await suggestFocus(makeContext({ jobs: fakeJobs({}) }));
    expect(offline).toEqual([]);
  });

  it('sets Slack presence, holds reminders, and restores everything with one digest at the end', async () => {
    const { ctx, slack } = zenContext();
    const now = new Date();
    const s = await startZen(ctx, {
      focus: [
        { id: 'ticket:PAY-1', kind: 'ticket', title: 'PAY-1 Retry logic', category: 'current-work', reason: 'x' },
      ],
      minutes: 60,
      now,
    });
    expect(slack.state.status.status_text).toMatch(/^Focusing until \d\d:\d\d$/);
    expect(slack.state.snooze).toBe(60);
    expect(zenEndsAt(ctx)).toBe(s.endsAt);
    await expect(startZen(ctx, { focus: s.focus })).rejects.toThrow(/already running/);

    remind(ctx, { kind: 'review-sla', subject: 'prd:1', title: 'PRD waiting on you', url: '/reviews' });
    remind(ctx, { kind: 'incident', subject: 'INC-9', title: 'Incident INC-9: captures failing' });
    const later = new Date(now.getTime() + 60_000);
    await deliverReminders(ctx, later);
    // The incident broke through as a DM to yourself; the review reminder was held.
    expect(slack.state.posted.map((p) => p.text).join('\n')).toContain('Incident INC-9');
    expect(slack.state.posted.map((p) => p.text).join('\n')).not.toContain('PRD waiting on you');

    const end = await endZen(ctx, { now: later });
    expect(end.held).toBe(1);
    expect(end.delivered).toBe('slack');
    expect(end.digest).toContain('PRD waiting on you');
    expect(slack.state.status.status_text).toBe('In meetings');
    expect(slack.state.snooze).toBeNull();
    expect(await activeZen(ctx)).toBeUndefined();
  });

  it('caps length at the org maximum, extends within it, and ends when every focus item is done', async () => {
    const { ctx } = zenContext({ zenYaml: 'maxMinutes: 60\n', settings: { zen: { slackStatus: false } } });
    const s = await startZen(ctx, {
      focus: [
        { id: 'task:a', kind: 'task', title: 'Answer Marco', category: 'blocking-others', reason: 'x' },
        { id: 'task:b', kind: 'task', title: 'Review PR', category: 'current-work', reason: 'y' },
      ],
      minutes: 240,
    });
    expect(Date.parse(s.endsAt) - Date.parse(s.startedAt)).toBe(60 * 60_000);
    const longer = await extendZen(ctx, 30);
    expect(longer.endsAt).toBe(s.endsAt); // already at the cap
    expect((await setFocusDone(ctx, 'task:a')).ended).toBeUndefined();
    const last = await setFocusDone(ctx, 'task:b');
    expect(last.ended?.held).toBe(0);
    expect(zenEndsAt(ctx)).toBeUndefined();
  });

  it('auto-replies once per conversation and never to people on the allowlist', async () => {
    const { ctx, slack } = zenContext({ settings: { zen: { allowlist: ['UBOSS'] } } });
    await startZen(ctx, {
      focus: [{ id: 'task:a', kind: 'task', title: 'Focus', category: 'current-work', reason: 'x' }],
      autoReply: true,
      slackStatus: false,
    });
    const sent = await zenAutoReply(ctx, [
      { conversation: 'D1', user: 'UA' },
      { conversation: 'D2', user: 'UBOSS' },
    ]);
    expect(sent).toBe(1);
    expect(await zenAutoReply(ctx, [{ conversation: 'D1', user: 'UA' }])).toBe(0);
    expect(slack.state.posted).toHaveLength(1);
    expect(slack.state.posted[0]?.channel).toBe('D1');
  });
});

describe('zen pages', () => {
  it('starts a session from the dashboard, shows the focus view and ends it', async () => {
    const { ctx, slack } = zenContext();
    const d = await startDaemon(ctx, { scheduler: false, socket: false, port: 0 });
    try {
      const auth = { authorization: `Bearer ${d.info.token}`, 'content-type': 'application/json' };
      const start = await (await fetch(`${d.url}/zen`, { headers: auth })).text();
      expect(start).toContain('Start a zen session');
      // Nothing ranked yet: starting with no focus items is refused.
      const refused = await fetch(`${d.url}/api/zen/start`, { method: 'POST', headers: auth, body: '{}' });
      expect(refused.status).toBe(400);
      upsertIssues(ctx, [issue('PAY-1', 'Retry logic', 'In Progress')]);
      const ok = await fetch(`${d.url}/api/zen/start`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ ids: ['ticket:PAY-1'], minutes: 45 }),
      });
      expect(ok.status).toBe(200);
      expect(slack.state.snooze).toBe(45);
      const home = await fetch(`${d.url}/`, { headers: auth, redirect: 'manual' });
      expect(home.headers.get('location')).toBe('/zen');
      const view = await (await fetch(`${d.url}/zen`, { headers: auth })).text();
      expect(view).toContain('Zen until');
      expect(view).toContain('PAY-1 Retry logic');
      const end = await fetch(`${d.url}/api/zen/end`, {
        method: 'POST',
        headers: { authorization: auth.authorization },
      });
      expect(end.status).toBe(200);
      expect(slack.state.status.status_text).toBe('In meetings');
    } finally {
      await d.close();
    }
  });
});

describe('advisory verifier', () => {
  const DELTA = `## ADDED Requirements

### Requirement: Refund idempotency {#payments.refunds.idempotent}
The system SHALL create one refund per idempotency key.

#### Scenario: Retried request {#payments.refunds.idempotent/retry}
- **WHEN** a refund request is retried with the same key
- **THEN** one refund exists

#### Scenario: Original ID returned {#payments.refunds.idempotent/original-id}
- **WHEN** a retried request succeeds
- **THEN** it returns the original refund ID
`;

  it('judges each scenario, drops unknown IDs and marks skipped ones unclear', async () => {
    const repo = gitRepo();
    const ws = initWorkspace(repo, 'payments').workspace;
    const { id } = newChange(ws, { jira: 'PAY-131', slug: 'dup refunds', tier: 'low' });
    put(repo, `orgspec/changes/${id}/specs/payments/refunds/spec.md`, DELTA);
    sh(repo, 'add', '.');
    sh(repo, 'commit', '-qm', 'spec');
    sh(repo, 'checkout', '-qb', 'PAY-131-dup-refunds');
    put(repo, 'src/refunds.ts', '// @scenario payments.refunds.idempotent/retry\nexport const once = true;\n');
    sh(repo, 'add', '.');
    sh(repo, 'commit', '-qm', 'fix');
    const jobs = fakeJobs({
      verifier: {
        summary: 'Retries are idempotent; the original ID is not returned yet.',
        scenarios: [
          {
            id: 'payments.refunds.idempotent/retry',
            verdict: 'met',
            evidence: 'Key check in refunds.ts',
            files: ['src/refunds.ts'],
          },
          { id: 'made.up/scenario', verdict: 'met', evidence: 'invented' },
        ],
      },
    });
    const ctx = makeContext({ jobs });
    const v = await verifyChange(ctx, ws, id, { base: 'main' });
    expect(v.base).toBe('main');
    expect(v.scenarios.map((s) => [s.id, s.verdict])).toEqual([
      ['payments.refunds.idempotent/retry', 'met'],
      ['payments.refunds.idempotent/original-id', 'unclear'],
    ]);
    expect(v.dropped).toEqual(['made.up/scenario']);
    expect(jobs.calls[0]?.prompt).toContain('src/refunds.ts');
    expect(lastVerification(ctx, id)?.summary).toBe(v.summary);
    expect(renderVerificationMd(v)).toContain('Only the deterministic trace in `orgspec check` can block a merge');
  });
});

describe('manager change', () => {
  it('deletes briefs, notes and actions about someone who no longer reports to you', async () => {
    const ctx = makeContext();
    const pdb = ctx.privateDb();
    const now = new Date().toISOString();
    for (const e of ['stay@acme.io', 'moved@acme.io', 'gone@acme.io']) {
      pdb
        .prepare('insert into briefs (id, report, payload, created_at) values (?, ?, ?, ?)')
        .run(`b-${e}`, e, 'x', now);
      pdb
        .prepare('insert into notes (id, subject, payload, updated_at) values (?, ?, ?, ?)')
        .run(`n-${e}`, e, 'x', now);
    }
    const gone = purgeFormerReports(ctx, [{ email: 'stay@acme.io' }, { email: 'moved@acme.io', moveOn: '2020-01-01' }]);
    expect(gone.sort()).toEqual(['gone@acme.io', 'moved@acme.io']);
    expect(pdb.prepare('select report from briefs').all()).toEqual([{ report: 'stay@acme.io' }]);
    expect(pdb.prepare('select subject from notes').all()).toEqual([{ subject: 'stay@acme.io' }]);
  });
});
