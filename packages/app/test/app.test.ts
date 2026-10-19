import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fakeJobs } from '@orgspec/claude';
import { loadBundle } from '@orgspec/constitution';
import { CORE_MIGRATIONS, openDb } from '@orgspec/core';
import { memoryConnector, pendingActions } from '@orgspec/gateway';
import { git as gitCli } from '@orgspec/integrations';
import { findWorkspace, initWorkspace, newChange } from '@orgspec/spec-engine';
import { describe, expect, it } from 'vitest';
import {
  addApproval,
  checkpointHook,
  effectiveInterval,
  groundFindings,
  indexDecisions,
  listDecisions,
  listInbox,
  newDecision,
  preToolUse,
  reviewPrd,
  rolesDirectory,
  runCheck,
  Scheduler,
  scoreRisk,
  searchDecisions,
  startDaemon,
  syncDmInbox,
  type TicketSession,
  writeHookRules,
  writeSession,
} from '../src/index.js';
import { gitRepo, makeContext, orgConfig, put, RULES, rule, sh, tmp } from './helpers.js';

function ticketFolder(o: { ghAccount?: string; change?: string } = {}) {
  const folder = tmp('orgspec-ticket-');
  const repo = join(folder, 'repos', 'pay');
  const s: TicketSession = {
    id: 'sess_1',
    ticket: 'PAY-1',
    persona: 'engineer',
    tier: 'medium',
    folder,
    repos: [
      {
        slug: 'acme/pay',
        host: 'github.com',
        owner: 'acme',
        name: 'pay',
        path: repo,
        branch: 'pay-1',
        base: 'origin/main',
        ...(o.ghAccount ? { ghAccount: o.ghAccount } : {}),
      },
    ],
    ...(o.change ? { change: o.change } : {}),
    bundle: { persona: 'engineer', version: '1.0.0', sha256: 'sha256:x' },
    protectedBranches: ['main', 'release/*'],
    state: 'active',
    createdAt: '2026-10-19T00:00:00Z',
    updatedAt: '2026-10-19T00:00:00Z',
  };
  writeSession(s);
  writeHookRules(folder, { bundle: 'sha256:x', rules: RULES.filter((r) => r.enforcement === 'hook') });
  return { folder, repo, s };
}

describe('policy hook', () => {
  const bash = (cwd: string, command: string, ghAccount?: (h: string) => string | undefined) =>
    preToolUse({ cwd, tool_name: 'Bash', tool_input: { command } }, ghAccount ? { ghAccount } : {})?.hookSpecificOutput;

  it('does nothing outside a ticket folder', () => {
    expect(bash(tmp(), 'git push --force origin main')).toBeUndefined();
  });
  it('denies protected pushes and force pushes, asks on ready PRs', () => {
    const { repo } = ticketFolder();
    expect(bash(repo, 'git push origin main')?.permissionDecision).toBe('deny');
    expect(bash(repo, 'git push -f')?.permissionDecisionReason).toContain('eng.git.no-force');
    expect(bash(repo, 'gh pr create --fill', () => undefined)?.permissionDecision).toBe('ask');
    expect(bash(repo, 'npm test')).toBeUndefined();
  });
  it('blocks gh commands under the wrong account', () => {
    const { repo } = ticketFolder({ ghAccount: 'me-work' });
    const out = bash(repo, 'git push origin pay-1', () => 'me-personal');
    expect(out?.permissionDecision).toBe('deny');
    expect(out?.permissionDecisionReason).toContain('gh auth switch --hostname github.com --user me-work');
    expect(bash(repo, 'git push origin pay-1', () => 'me-work')).toBeUndefined();
  });
  it('limits writes to the folder and protected paths to what the spec names', () => {
    const { folder, repo } = ticketFolder();
    const write = (file_path: string) =>
      preToolUse({ cwd: repo, tool_name: 'Write', tool_input: { file_path } })?.hookSpecificOutput?.permissionDecision;
    expect(write('/etc/passwd')).toBe('deny');
    expect(write(join(repo, 'src/a.ts'))).toBeUndefined();
    expect(write(join(repo, '.github/workflows/ci.yml'))).toBe('deny');
    expect(readFileSync(join(folder, '.orgspec/actions.jsonl'), 'utf8')).toContain('ci.yml');
  });
  it('checkpoints and restores', async () => {
    const { repo } = ticketFolder();
    mkdirSync(repo, { recursive: true });
    sh(repo, 'init', '-q');
    await checkpointHook('checkpoint', 'compact', { cwd: repo, session_id: 'c-1' });
    const out = await checkpointHook('restore', 'restore', { cwd: repo });
    expect(out?.hookSpecificOutput?.additionalContext).toContain('# Checkpoint: PAY-1');
    expect(out?.hookSpecificOutput?.additionalContext).toContain('Reason: compact');
  });
});

describe('orgspec check', () => {
  it('enforces the tier floor and verified approvals', async () => {
    const repo = gitRepo();
    const ws0 = initWorkspace(repo, 'payments').workspace;
    put(repo, 'README.md', 'x');
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-qm', 'base');
    const base = sh(repo, 'rev-parse', 'HEAD');
    const { id } = newChange(ws0, { jira: 'PAY-7', slug: 'migration', tier: 'low' });
    put(
      repo,
      `orgspec/changes/${id}/proposal.md`,
      '# Proposal\n\n## Why\nThe ledger needs an index.\n\n## What changes\n- Add an index.\n',
    );
    put(repo, 'db/migrations/001.sql', 'create index x on y(z);');
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-qm', 'change');

    const ws = findWorkspace(repo);
    const { bundle } = loadBundle(join(orgConfig().dir, 'compiled/engineer/1.0.0'));
    const directory = rolesDirectory({ roles: { staff: ['alice'] }, teams: {} }, async () => undefined);
    const r1 = await runCheck({ ws, git: gitCli(), base, ...(bundle ? { bundle } : {}), directory, author: 'bob' });
    const codes = r1.changes[0]?.diagnostics.map((d) => d.code) ?? [];
    expect(r1.ok).toBe(false);
    expect(codes).toContain('check_tier_floor');
    expect(codes).toContain('rule:eng.approve.proposal');

    // A forged approval: bob commits an entry naming alice.
    const { loadChange } = await import('@orgspec/spec-engine');
    addApproval(loadChange(ws, id), { artifact: 'proposal.md', approver: 'alice', role: 'staff' });
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-qm', 'approve');
    const r2 = await runCheck({ ws, git: gitCli(), base, ...(bundle ? { bundle } : {}), directory, author: 'bob' });
    expect(r2.changes[0]?.diagnostics.map((d) => d.code)).toContain('approval_forged');
  });
});

describe('decisions', () => {
  it('creates, indexes and searches ADRs', () => {
    const repo = tmp();
    const ws = initWorkspace(repo).workspace;
    newDecision(ws, { title: 'Use idempotency keys for captures', paths: ['src/payments/**'] });
    const db = openDb(':memory:', CORE_MIGRATIONS);
    expect(indexDecisions(db, 'acme/pay', listDecisions(ws, 'acme/pay'))).toBe(1);
    const hits = searchDecisions(db, 'idempot');
    expect(hits[0]?.adrId).toBe('ADR-0001');
    expect(searchDecisions(db, '"; drop')).toEqual([]);
  });
});

describe('scheduler', () => {
  const wh = { start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5] };
  const src = { every: '2m', min: '1m', max: '15m', offHours: 'slow' as const, offHoursEvery: '15m', personal: true };
  it('applies personal intervals, off hours and back-off', () => {
    const mon10 = new Date('2026-10-19T10:00:00');
    expect(effectiveInterval(src, { failures: 0, now: mon10, workingHours: wh })).toBe(120_000);
    expect(effectiveInterval(src, { personal: '10s', failures: 0, now: mon10, workingHours: wh })).toBe(60_000);
    expect(effectiveInterval(src, { failures: 0, now: new Date('2026-10-18T10:00:00'), workingHours: wh })).toBe(
      900_000,
    );
    expect(
      effectiveInterval(
        { ...src, offHours: 'pause' },
        { failures: 0, now: new Date('2026-10-19T22:00:00'), workingHours: wh },
      ),
    ).toBeUndefined();
    expect(effectiveInterval(src, { failures: 2, now: mon10, workingHours: wh })).toBe(480_000);
  });
  it('runs due sources and records failures', async () => {
    const db = openDb(':memory:', CORE_MIGRATIONS);
    let calls = 0;
    const s = new Scheduler({
      db,
      sync: { workingHours: { ...wh, days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '23:59' }, sources: {} },
      personal: {},
      jobs: {
        'jira.active': async () => `ok ${++calls}`,
        'slack.dms': async () => {
          throw new Error('slack down');
        },
      },
    });
    await s.tick();
    expect(s.state('jira.active')).toMatchObject({ status: 'ok', message: 'ok 1', failures: 0 });
    expect(s.state('slack.dms')).toMatchObject({ status: 'error', failures: 1 });
    expect(s.due()).toEqual([]);
  });
});

describe('risk', () => {
  it('scores signals deterministically', () => {
    const now = Date.parse('2026-10-19T00:00:00Z');
    const r = scoreRisk(
      {
        key: 'PAY-1',
        status: 'In Progress',
        updated: '2026-10-01T00:00:00Z',
        due: '2026-10-17',
        labels: ['blocked'],
        ciFailing: true,
      },
      now,
    );
    expect(r.band).toBe('high');
    expect(r.drivers[0]?.signal).toBe('overdue');
    expect(scoreRisk({ key: 'PAY-2', status: 'Done', updated: '2026-01-01', labels: [] }, now).score).toBe(0);
  });
});

describe('reviews', () => {
  it('drops findings that do not quote the document', () => {
    const { kept, dropped } = groundFindings(
      [
        {
          rubricId: 'pm.prd.metrics',
          verdict: 'fail',
          quote: 'success will be obvious to everyone',
          finding: 'No metric',
          suggestion: '',
          confidence: 0.9,
        },
        {
          rubricId: 'pm.prd.metrics',
          verdict: 'concern',
          quote: 'an invented sentence here',
          finding: 'x',
          suggestion: '',
          confidence: 0.5,
        },
        { rubricId: 'pm.unknown', verdict: 'pass', quote: '', finding: 'x', suggestion: '', confidence: 0.5 },
      ],
      'We think success will be obvious to everyone.',
      ['pm.prd.metrics'],
    );
    expect(kept).toHaveLength(1);
    expect(dropped.map((d) => d.reason)).toEqual(['quote not found in the document', 'unknown rubric rule pm.unknown']);
  });
  it('keeps omissions only when the named thing is really missing', () => {
    const base = {
      rubricId: 'eng.design.rollback',
      verdict: 'fail' as const,
      quote: '',
      finding: 'x',
      suggestion: '',
      confidence: 0.8,
      absent: true,
    };
    const text = '# Design\n\n## Approach\nRetry with backoff.';
    const { kept, dropped } = groundFindings(
      [
        { ...base, missing: 'rollback plan' },
        { ...base, missing: 'retry backoff' },
        { ...base, missing: '' },
      ],
      text,
      ['eng.design.rollback'],
    );
    expect(kept.map((k) => k.missing)).toEqual(['rollback plan']);
    expect(dropped.map((d) => d.reason)).toEqual([
      'the document does mention "retry backoff"',
      'absence finding does not name what is missing',
    ]);
  });
  it('reviews a PRD from Confluence with a claude job', async () => {
    const { dir } = orgConfig(RULES, {
      'integrations.yaml': 'servers:\n  atlassian: { transport: stdio, command: x }\nconstants: { cloudId: c1 }\n',
    });
    const jobs = fakeJobs({
      'prd-reviewer': {
        summary: 'Needs metrics',
        findings: [
          {
            rubricId: 'pm.prd.metrics',
            verdict: 'fail',
            quote: 'Success will be obvious',
            finding: 'No measurable metric',
            suggestion: 'Add a target',
            confidence: 0.9,
          },
        ],
      },
    });
    const connector = memoryConnector({
      atlassian: {
        tools: [{ name: 'getConfluencePage', inputSchema: { type: 'object' } }],
        handle: () => ({
          id: '77',
          title: 'Checkout PRD',
          version: { number: 4 },
          body: { storage: { value: '<p>Success will be obvious.</p>' } },
        }),
      },
    });
    const ctx = makeContext({ jobs, connector, configDir: dir });
    const r = await reviewPrd(ctx, '77');
    expect(r.findings[0]).toMatchObject({ rubricId: 'pm.prd.metrics', severity: 'warning', status: 'open' });
    expect(jobs.calls[0]?.prompt).toContain('<untrusted source="document">');
  });
});

describe('DM inbox', () => {
  it('triages new DMs into encrypted tasks', async () => {
    const { dir } = orgConfig(RULES, { 'integrations.yaml': 'servers:\n  slack: { transport: stdio, command: x }\n' });
    const connector = memoryConnector({
      slack: {
        tools: [],
        handle: (tool) =>
          tool === 'conversations_list'
            ? { channels: [{ id: 'D1', user: 'U2' }] }
            : {
                messages: [
                  { ts: '100.1', user: 'U2', text: 'Can you review my PR by Friday?' },
                  { ts: '100.2', user: 'U2', text: 'thanks!' },
                ],
              },
      },
    });
    const jobs = fakeJobs({
      'inbox-triage': {
        tasks: [{ title: 'Review PR', from: 'U2', due: 'Friday', ts: '100.1', conversation: 'D1', kind: 'review' }],
      },
    });
    const ctx = makeContext({ jobs, connector, configDir: dir, settings: { identity: { slackUserId: 'U1' } } });
    expect(await syncDmInbox(ctx)).toEqual({ conversations: 1, messages: 2, tasks: 1 });
    expect((await listInbox(ctx))[0]?.title).toBe('Review PR');
    const raw = ctx.privateDb().prepare('select payload from inbox_tasks').get() as { payload: string };
    expect(raw.payload).not.toContain('Review PR');
    expect(await syncDmInbox(ctx)).toMatchObject({ messages: 0, tasks: 0 });
  });
});

describe('daemon', () => {
  it('requires the token and serves the API and dashboard', async () => {
    const { dir } = orgConfig();
    const ctx = makeContext({ configDir: dir });
    const d = await startDaemon(ctx, { scheduler: false, socket: false });
    try {
      expect((await fetch(`${d.url}/api/status`)).status).toBe(401);
      const auth = { authorization: `Bearer ${d.info.token}` };
      const status = (await (await fetch(`${d.url}/api/status`, { headers: auth })).json()) as { persona: string };
      expect(status.persona).toBe('engineer');
      const login = await fetch(`${d.url}/login?token=${d.info.token}`, { redirect: 'manual' });
      const cookie = login.headers.get('set-cookie') ?? '';
      expect(cookie).toContain('HttpOnly');
      const home = await fetch(`${d.url}/admin`, { headers: { cookie: cookie.split(';')[0] ?? '' } });
      expect(await home.text()).toContain('every persona’s bundle verifies');
      const a = pendingActions(ctx.db()).create({
        server: 'slack',
        tool: 'chat_post_message',
        args: {},
        summary: 'x',
        persona: 'engineer',
      });
      const r = await fetch(`${d.url}/api/actions/${a.id}/approve`, { method: 'POST', headers: auth });
      expect(r.status).toBe(200);
      expect(pendingActions(ctx.db()).get(a.id)?.state).toBe('approved');
    } finally {
      await d.close();
    }
  });
});

describe('scheduler recovery', () => {
  it('marks runs interrupted by a crash and reports the next run', () => {
    const db = openDb(':memory:', CORE_MIGRATIONS);
    db.prepare(
      "insert into sync_state (source, last_run_at, status, clean_runs) values ('jira.active', '2026-10-19T02:20:00Z', 'running', 0)",
    ).run();
    const s = new Scheduler({
      db,
      sync: { workingHours: { start: '00:00', end: '23:59', days: [0, 1, 2, 3, 4, 5, 6] }, sources: {} },
      personal: {},
      jobs: { 'jira.active': async () => 'ok' },
      now: () => new Date('2026-10-19T03:00:00Z'),
    });
    expect(s.recoverInterrupted()).toBe(1);
    const st = s.states()[0];
    expect(st).toMatchObject({ status: 'error', message: expect.stringContaining('interrupted') });
    expect(st?.nextRunAt).toBe('2026-10-19T03:00:00.000Z');
    expect(s.due()).toEqual(['jira.active']);
  });
});

describe('live change tier', () => {
  it('enforces the tier in change.yaml, not the tier the packet started with', () => {
    const { folder, repo } = ticketFolder();
    writeHookRules(folder, {
      bundle: 'x',
      rules: [
        rule({
          id: 'eng.git.no-merge-high',
          enforcement: 'hook',
          severity: 'blocking',
          check: { kind: 'git-op', deny: ['merge'], ask: [], tiers: ['high'] },
        }),
      ],
    });
    const merge = () =>
      preToolUse({ cwd: repo, tool_name: 'Bash', tool_input: { command: 'gh pr merge 5' } })?.hookSpecificOutput
        ?.permissionDecision;
    expect(merge()).toBeUndefined();
    put(
      repo,
      'orgspec/changes/PAY-1-retries/change.yaml',
      'id: PAY-1-retries\njira: PAY-1\nschema: feature@1\ntier: medium\n',
    );
    expect(merge()).toBeUndefined();
    put(
      repo,
      'orgspec/changes/PAY-1-retries/change.yaml',
      'id: PAY-1-retries\njira: PAY-1\nschema: feature@1\ntier: high\n',
    );
    expect(merge()).toBe('deny');
  });
});

describe('dashboard buttons', () => {
  it('posts without a body (Approve, Run now) and with one (agenda)', async () => {
    const { dir } = orgConfig();
    const ctx = makeContext({ configDir: dir });
    const d = await startDaemon(ctx, { scheduler: false, socket: false });
    try {
      const a = pendingActions(ctx.db()).create({
        server: 'slack',
        tool: 'chat_post_message',
        args: {},
        summary: 'x',
        persona: 'engineer',
      });
      // Exactly what the dashboard's api() helper sends for a body-less button.
      const r = await fetch(`${d.url}/api/actions/${a.id}/approve`, {
        method: 'POST',
        headers: { authorization: `Bearer ${d.info.token}` },
      });
      expect(r.status).toBe(200);
      const html = await (
        await fetch(`${d.url}/actions`, { headers: { authorization: `Bearer ${d.info.token}` } })
      ).text();
      expect(html).toContain('body === undefined ? {method}');
    } finally {
      await d.close();
    }
  });
});
