import { fakeJobs } from '@orgspec/claude';
import { memoryConnector } from '@orgspec/gateway';
import { initWorkspace } from '@orgspec/spec-engine';
import { describe, expect, it } from 'vitest';
import {
  agentPermissions,
  cleanLogs,
  computeReminders,
  createBreakdown,
  decidePrd,
  forecastChance,
  indexDecisions,
  listInbox,
  newDecision,
  parsePermalink,
  planJira,
  programs,
  reviewPrdFull,
  saveBreakdown,
  summarizeSlack,
  syncDmInbox,
  upsertIssues,
  workingDaysBetween,
} from '../src/index.js';
import { makeContext, orgConfig, put, RULES, tmp } from './helpers.js';

const tool = (name: string) => ({ name, inputSchema: { type: 'object' as const } });

describe('calculations', () => {
  it('forecasts the chance of finishing from resampled throughput', () => {
    expect(forecastChance([2, 2, 2], 0, 1)).toBe(1);
    expect(forecastChance([2, 2, 2], 5, 0)).toBe(0);
    expect(forecastChance([2, 2, 2, 2], 4, 4)).toBe(1);
    expect(forecastChance([0, 0, 0], 4, 4)).toBe(0);
    const mid = forecastChance([0, 1, 2, 3], 6, 4);
    expect(mid).toBeGreaterThan(0.2);
    expect(mid).toBeLessThan(0.9);
  });
  it('counts working days and parses Slack permalinks', () => {
    expect(workingDaysBetween(new Date('2026-10-16T10:00:00'), new Date('2026-10-19T10:00:00'))).toBe(1); // Fri → Mon
    expect(parsePermalink('https://acme.slack.com/archives/C01ABC/p1729000000123456')).toEqual({
      channel: 'C01ABC',
      ts: '1729000000.123456',
    });
    expect(parsePermalink('https://example.com')).toBeUndefined();
  });
  it('cleans terminal noise from session logs', () => {
    const esc = String.fromCharCode(27);
    expect(cleanLogs(`${esc}[31m✻ Thinking…${esc}[0m\nRan the tests: 12 passed\n──────\n`)).toEqual([
      'Ran the tests: 12 passed',
    ]);
  });
  it('derives what an agent may do from hook rules', () => {
    const p = agentPermissions(RULES, 'medium');
    expect(p.may).toContain('Open a draft PR (you mark it ready)');
    expect(p.mayNot).toContain('Force-push');
    expect(p.mayNot.some((m) => m.includes('.github/workflows/**'))).toBe(true);
  });
});

describe('programs', () => {
  it('scores dependencies, schedule and activity, and never names people in drivers', () => {
    const ctx = makeContext({ configDir: orgConfig().dir });
    const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
    const target = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
    upsertIssues(ctx, [
      {
        key: 'PAY-240',
        summary: 'Regional card tokens',
        status: 'In Progress',
        labels: [],
        updated: day(1),
        project: 'PAY',
        due: target,
        fields: {},
        blocks: [],
        blockedBy: [],
      },
      {
        key: 'LED-58',
        summary: 'Replicate token index',
        status: 'To Do',
        labels: [],
        updated: day(14),
        project: 'LED',
        parent: 'PAY-240',
        fields: {},
        blocks: ['PAY-246', 'PAY-247'],
        blockedBy: [],
      },
      {
        key: 'PAY-246',
        summary: 'EU write path',
        status: 'In Progress',
        statusCategory: 'indeterminate',
        labels: [],
        updated: day(9),
        project: 'PAY',
        parent: 'PAY-240',
        assignee: { email: 'asha@x' },
        fields: {},
        blocks: [],
        blockedBy: ['LED-58'],
      },
      {
        key: 'PAY-241',
        summary: 'Token API',
        status: 'Done',
        statusCategory: 'done',
        labels: [],
        updated: day(3),
        project: 'PAY',
        parent: 'PAY-240',
        fields: {},
        blocks: [],
        blockedBy: [],
      },
    ]);
    const [p] = programs(ctx);
    expect(p?.key).toBe('PAY-240');
    expect(p?.stories).toBe(3);
    expect(p?.drivers.map((d) => d.category)).toEqual(
      expect.arrayContaining(['Dependencies', 'Schedule', 'Activity vs plan']),
    );
    expect(p?.drivers.find((d) => d.category === 'Dependencies')?.text).toContain('LED-58 unassigned');
    expect(JSON.stringify(p?.drivers)).not.toContain('asha');
    expect(['at risk', 'off track']).toContain(p?.status);
  });
});

describe('task inbox', () => {
  it('finds commitments, merges duplicates, notices your replies and detects Jira duplicates', async () => {
    const { dir } = orgConfig(RULES, {
      'integrations.yaml':
        'servers:\n  slack: { transport: stdio, command: x }\n  atlassian: { transport: stdio, command: x }\n',
    });
    const connector = memoryConnector({
      slack: {
        tools: [],
        handle: (t, a) =>
          t === 'conversations_list'
            ? { channels: [{ id: 'D1', user: 'U2' }, { id: 'G1' }] }
            : a.channel === 'D1'
              ? {
                  messages: [
                    { ts: '100.1', user: 'U2', text: 'Can you send the runbook?' },
                    { ts: '100.2', user: 'U1', text: "I'll send it tomorrow" },
                  ],
                }
              : { messages: [{ ts: '200.1', user: 'U1', text: "I'll send the runbook tomorrow" }] },
      },
      atlassian: {
        tools: [tool('searchJiraIssuesUsingJql')],
        handle: (_t, a) => ({
          issues: String(a.jql).includes('runbook') ? [{ key: 'PAY-212', fields: { summary: 'Send runbook' } }] : [],
        }),
      },
    });
    const jobs = fakeJobs({
      'inbox-triage': {
        tasks: [
          {
            title: 'Send the runbook link',
            from: 'ME',
            ts: '100.2',
            conversation: 'D1',
            kind: 'commitment',
            why: 'you promised it for tomorrow',
            priority: 1,
            group: 'Payment retries',
          },
          {
            title: 'Send the runbook link',
            from: 'ME',
            ts: '200.1',
            conversation: 'G1',
            kind: 'commitment',
            priority: 1,
          },
        ],
      },
    });
    const ctx = makeContext({ configDir: dir, connector, jobs, settings: { identity: { slackUserId: 'U1' } } });
    const r = await syncDmInbox(ctx);
    expect(r.tasks).toBe(1);
    const [t] = await listInbox(ctx);
    expect(t).toMatchObject({ kind: 'commitment', why: 'you promised it for tomorrow', group: 'Payment retries' });
    expect(t?.sources).toHaveLength(2);
    expect(t?.repliedAt).toBeUndefined(); // your own message is the task, not a reply after it
    const plan = await planJira(ctx, [t?.id ?? ''], { project: 'PAY', shape: 'separate' });
    expect(plan.items[0]?.duplicateOf).toBe('PAY-212');
  });
});

describe('PRD review', () => {
  const page = {
    id: '77',
    title: 'Regional card tokens PAY-240',
    version: { number: 12 },
    body: { storage: { value: '<p>Epic: PAY-240. Lookups should feel instant for merchants.</p>' } },
  };
  const setup = (blocker: boolean) => {
    const { dir } = orgConfig(RULES, {
      'integrations.yaml': 'servers:\n  atlassian: { transport: stdio, command: x }\n',
    });
    const comments: string[] = [];
    const connector = memoryConnector({
      atlassian: {
        tools: [tool('getConfluenceContent'), tool('createConfluenceComment')],
        handle: (t, a) => {
          if (t === 'createConfluenceComment') comments.push(String(a.body));
          return t === 'getConfluenceContent' ? page : { ok: true };
        },
      },
    });
    const jobs = fakeJobs({
      'prd-reviewer': {
        summary: 'Needs a latency target',
        completeness: 64,
        findings: [
          {
            rubricId: 'pm.prd.metrics',
            verdict: 'fail',
            severity: 'major',
            quote: 'Lookups should feel instant',
            finding: 'No latency target',
            suggestion: 'What p95 must a lookup meet?',
            confidence: 0.9,
          },
        ],
        dependencies: [{ touches: 'ledger.replication', owner: 'Ledger team', consulted: false }],
        feasibility: blocker
          ? [{ kind: 'blocker', text: 'Conflicts with a single-region vault decision', adr: 'ADR-0023' }]
          : [{ kind: 'spike', text: 'Replication lag unknown' }],
      },
    });
    return { ctx: makeContext({ configDir: dir, connector, jobs }), comments };
  };
  it('records the review, refuses approval while blockers are open, and approves only the reviewed version', async () => {
    const { ctx } = setup(true);
    const r = await reviewPrdFull(ctx, '77');
    expect(r).toMatchObject({ epic: 'PAY-240', completeness: 64, version: 12 });
    // ADR-0023 is not an indexed decision: the blocker stays (it may be real) but is marked unverified.
    expect(r.feasibility[0]).toMatchObject({ kind: 'blocker', verified: false });
    await expect(decidePrd(ctx, '77', 'approved')).rejects.toThrow('blockers are open');
    const { ctx: ctx2 } = setup(false);
    await reviewPrdFull(ctx2, '77');
    const d = await decidePrd(ctx2, '77', 'approved', 'Looks good');
    expect(d).toMatchObject({ decision: 'approved', version: 12 });
  });
  it('blocks approval when a feasibility blocker cites a real decision', async () => {
    const { ctx } = setup(true);
    const repo = tmp();
    const ws = initWorkspace(repo).workspace;
    newDecision(ws, { title: 'Single token vault in us-east' });
    const { listDecisions } = await import('../src/index.js');
    indexDecisions(
      ctx.db(),
      'acme/pay',
      listDecisions(ws, 'acme/pay').map((x) => ({ ...x, adrId: 'ADR-0023' })),
    );
    const r = await reviewPrdFull(ctx, '77');
    expect(r.feasibility[0]).toMatchObject({ kind: 'blocker', adr: 'ADR-0023', verified: true });
    await expect(decidePrd(ctx, '77', 'approved')).rejects.toThrow('blockers are open');
  });
});

describe('task breakdown', () => {
  it('creates epics, stories, cross-team stories and blocked-by links in Jira', async () => {
    const { dir } = orgConfig(RULES, {
      'integrations.yaml': 'servers:\n  atlassian: { transport: stdio, command: x }\n',
      'jira.yaml': 'teams:\n  ledger: LED\n',
    });
    const created: { project: string; type: string; summary: string }[] = [];
    const links: [string, string][] = [];
    let n = 0;
    const connector = memoryConnector({
      atlassian: {
        tools: [],
        handle: (t, a) => {
          if (t === 'searchJiraIssuesUsingJql') return { issues: [] };
          if (t === 'createJiraIssue') {
            created.push({ project: String(a.projectKey), type: String(a.issueTypeName), summary: String(a.summary) });
            return { key: `${a.projectKey}-${++n}` };
          }
          if (t === 'createJiraIssueLink') links.push([String(a.inwardIssue), String(a.outwardIssue)]);
          return { ok: true };
        },
      },
    });
    const ctx = makeContext({ configDir: dir, connector });
    saveBreakdown(ctx, {
      pageId: '77',
      version: 4,
      createdAt: new Date().toISOString(),
      epics: [
        {
          title: 'Refund API supports partial amounts',
          team: 'payments',
          stories: [
            {
              order: '1.1',
              title: 'Accept an amount on POST /refunds',
              size: 'M',
              tier: 'medium',
              after: [],
              team: '',
            },
            {
              order: '1.3',
              title: 'Ledger entries for partial refunds',
              size: 'L',
              tier: 'high',
              after: ['1.1'],
              team: 'ledger',
            },
          ],
        },
      ],
    });
    const out = await createBreakdown(ctx, '77', 'WEB');
    expect(created.map((c) => `${c.project}:${c.type}`)).toEqual(['WEB:Epic', 'WEB:Story', 'LED:Story']);
    expect(links).toEqual([[out['1.3'], out['1.1']]]);
  });
});

describe('reminder rules', () => {
  it('reminds about decision reviews coming due', async () => {
    const repo = tmp();
    const ws = initWorkspace(repo).workspace;
    const file = newDecision(ws, {
      title: 'Retry webhooks with jitter',
      owner: 'me@x',
      review: new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10),
    });
    put(
      repo,
      file.slice(repo.length + 1),
      (await import('node:fs')).readFileSync(file, 'utf8').replace('status: proposed', 'status: accepted'),
    );
    const ctx = makeContext({
      configDir: orgConfig().dir,
      settings: { identity: { email: 'me@x' }, repos: [{ slug: 'acme/pay', path: repo }] },
    });
    const r = await computeReminders(ctx);
    expect(r.kinds['decision-review']).toBe(1);
    expect((await computeReminders(ctx)).added).toBe(0);
  });
});

describe('Slack summarizer', () => {
  it('marks tasks that already exist in Jira and decisions that conflict with an ADR', async () => {
    const { dir } = orgConfig(RULES, {
      'integrations.yaml':
        'servers:\n  slack: { transport: stdio, command: x }\n  atlassian: { transport: stdio, command: x }\n',
    });
    const connector = memoryConnector({
      slack: {
        tools: [],
        handle: () => ({ messages: [{ ts: '1729000000.1', user: 'U2', text: 'Cap retries at 3' }] }),
      },
      atlassian: {
        tools: [],
        handle: (_t, a) => ({
          issues: String(a.jql).includes('incident') ? [{ key: 'PAY-219', fields: { summary: 'Incident notes' } }] : [],
        }),
      },
    });
    const jobs = fakeJobs({
      'slack-summarizer': {
        summary: [{ topic: 'Retry policy', text: 'Settled on backoff', messages: 6 }],
        tasks: [{ text: 'Write up incident notes', owner: 'Jonas', due: 'Friday' }],
        decisions: [{ text: 'Cap capture retries at 3 attempts', by: 'Priya and Jonas', date: '16 Oct' }],
        questions: [{ text: 'Root cause of the spike?', askedOf: 'gateway team' }],
        nextSteps: ['Confirm the retry decision'],
      },
    });
    const ctx = makeContext({ configDir: dir, connector, jobs });
    const repo = tmp();
    const ws = initWorkspace(repo).workspace;
    newDecision(ws, { title: 'Retry captures up to 5 attempts' });
    const { listDecisions } = await import('../src/index.js');
    indexDecisions(ctx.db(), 'acme/pay', listDecisions(ws, 'acme/pay'));
    const s = await summarizeSlack(ctx, { channels: ['payments-eng'], window: '7d' });
    expect(s.tasksExisting[0]).toBe('PAY-219');
    expect(s.decisionConflicts[0]?.adrId).toBe('ADR-0001');
    expect(s.messages).toBe(1);
  });
});

describe('My evidence', () => {
  it('finds the 1:1 page where you are the report, not the pages you hold as a manager', async () => {
    const { dir } = orgConfig(RULES, {
      'integrations.yaml': 'servers:\n  atlassian: { transport: stdio, command: x }\n',
    });
    const connector = memoryConnector({
      atlassian: {
        tools: [],
        handle: () => ({
          results: [
            { content: { id: 'p-report', title: '1:1 me@x / asha@x', version: { number: 2 } } },
            { content: { id: 'p-mine', title: '1:1 boss@x / me@x', version: { number: 3 } } },
          ],
        }),
      },
    });
    const ctx = makeContext({ configDir: dir, connector, settings: { identity: { email: 'me@x' } } });
    const { findMyOneOnOnePage } = await import('../src/index.js');
    expect(await findMyOneOnOnePage(ctx, 'boss@x')).toBe('p-mine');
  });
});

describe('discussion evidence', () => {
  it('reads only allowlisted channels and only the person’s own messages', async () => {
    const { dir } = orgConfig(RULES, {
      'integrations.yaml': 'servers:\n  slack: { transport: stdio, command: x }\n',
      'people.yaml': 'people:\n  asha@x: { slack: U3 }\nevidenceChannels: [payments-eng]\n',
    });
    const asked: string[] = [];
    const connector = memoryConnector({
      slack: {
        tools: [],
        handle: (_t, a) => {
          asked.push(String(a.channel));
          return {
            messages: [
              { ts: '1800000000.1', user: 'U3', text: 'Proposal: cap retries at 3' },
              { ts: '1800000000.2', user: 'U9', text: 'agree' },
            ],
          };
        },
      },
    });
    const ctx = makeContext({ configDir: dir, connector });
    const { discussionEvidence } = await import('../src/index.js');
    const got = await discussionEvidence(ctx, 'asha@x', '2026-01-01');
    expect(got).toEqual([{ channel: 'payments-eng', ts: '1800000000.1', text: 'Proposal: cap retries at 3' }]);
    expect(asked).toEqual(['payments-eng']);
    expect(await discussionEvidence(ctx, 'nobody@x', '2026-01-01')).toEqual([]);
  });
});
