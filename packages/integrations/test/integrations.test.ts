import { fakeRunner } from '@orgspec/core';
import { describe, expect, it } from 'vitest';
import { ensureAccount, fillTemplate, gh, remoteOwner, type ToolCaller, workplace } from '../src/index.js';

const text = (v: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(v) }] });

function stubCaller(
  handlers: Record<string, (args: Record<string, unknown>) => unknown>,
): ToolCaller & { calls: [string, Record<string, unknown>][] } {
  const calls: [string, Record<string, unknown>][] = [];
  return {
    calls,
    async callTool(name, args) {
      calls.push([name, args]);
      const h = handlers[name];
      if (!h) return { isError: true, content: [{ type: 'text', text: `unknown tool ${name}` }] };
      return text(h(args));
    },
  };
}

describe('operation templates', () => {
  it('fills variables and drops missing ones', () => {
    expect(fillTemplate({ a: '$x', b: '$missing', c: 'id-${x}', d: ['$x', '$nope'] }, { x: 1 })).toEqual({
      a: 1,
      c: 'id-1',
      d: [1],
    });
  });
});

describe('Atlassian adapters', () => {
  it('searches Jira with paging and normalises issues', async () => {
    const caller = stubCaller({
      atlassian__searchJiraIssuesUsingJql: (a) =>
        a.nextPageToken
          ? { issues: [{ key: 'PAY-2', fields: { summary: 'B', status: { name: 'Done' }, updated: '2026-10-02' } }] }
          : {
              issues: [
                {
                  key: 'PAY-1',
                  fields: { summary: 'A', status: { name: 'In Progress' }, labels: ['x'], updated: '2026-10-01' },
                },
              ],
              nextPageToken: 't',
            },
    });
    const w = workplace(caller, { operations: {}, constants: { cloudId: 'c-1' } });
    const issues = await w.jira.search('project = PAY');
    expect(issues.map((i) => i.key)).toEqual(['PAY-1', 'PAY-2']);
    expect(issues[0]?.project).toBe('PAY');
    expect(caller.calls[0]?.[1].cloudId).toBe('c-1');
  });
  it('reports tool errors with the operation name', async () => {
    const w = workplace(stubCaller({}));
    await expect(w.jira.get('PAY-1')).rejects.toThrow('jira.getIssue');
  });
  it('reads Confluence storage and versions', async () => {
    const w = workplace(
      stubCaller({
        atlassian__getConfluencePage: () => ({
          id: '42',
          title: 'Git',
          version: { number: 7 },
          body: { storage: { value: '<p>x</p>' } },
        }),
      }),
    );
    expect(await w.confluence.get('42')).toMatchObject({ id: '42', version: 7, storage: '<p>x</p>' });
  });
  it('lets the org remap an operation', async () => {
    const caller = stubCaller({ ci2__builds: () => ({ builds: [{ id: 9, status: 'SUCCESS', branch: 'feat' }] }) });
    const w = workplace(caller, {
      operations: { 'ci.listRuns': { tool: 'ci2__builds', args: { project: '$repo' } } },
      constants: {},
    });
    const runs = await w.ci.runs('acme/pay');
    expect(runs[0]).toMatchObject({ id: '9', state: 'passed', branch: 'feat', repo: 'acme/pay' });
    expect(caller.calls[0]?.[1]).toEqual({ project: 'acme/pay' });
  });
});

describe('gh', () => {
  const status = {
    hosts: {
      'github.com': [
        { state: 'success', active: true, host: 'github.com', login: 'me-personal', tokenSource: 'keyring' },
        { state: 'success', active: false, host: 'github.com', login: 'me-work', tokenSource: 'keyring' },
      ],
    },
  };
  it('reads accounts and switches to the mapped one', async () => {
    const runner = fakeRunner([
      {
        match: (_c, a) => a[0] === 'auth' && a[1] === 'status',
        result: { code: 0, stdout: JSON.stringify(status), stderr: '' },
      },
      { match: (_c, a) => a[0] === 'auth' && a[1] === 'switch', result: { code: 0, stdout: '', stderr: '' } },
    ]);
    const g = gh(runner);
    expect((await g.accounts()).map((a) => a.login)).toEqual(['me-personal', 'me-work']);
    const r = await ensureAccount(
      g,
      { autoSwitch: true, orgAccounts: { 'github.com/acme': 'me-work' } },
      { host: 'github.com', owner: 'acme' },
    );
    expect(r).toEqual({ login: 'me-work', switched: true });
    expect(runner.calls.at(-1)?.args).toEqual(['auth', 'switch', '--hostname', 'github.com', '--user', 'me-work']);
    const off = await ensureAccount(
      g,
      { autoSwitch: false, orgAccounts: { acme: 'me-work' } },
      { host: 'github.com', owner: 'acme' },
    );
    expect(off.mismatch).toContain('me-work');
  });
  it('parses remotes', () => {
    expect(remoteOwner('git@github.com:acme/pay.git')).toEqual({ host: 'github.com', owner: 'acme', repo: 'pay' });
    expect(remoteOwner('https://ghe.acme.io/acme/pay')).toEqual({ host: 'ghe.acme.io', owner: 'acme', repo: 'pay' });
  });
  it('creates draft PRs with the body on stdin', async () => {
    const runner = fakeRunner([
      { match: () => true, result: { code: 0, stdout: 'https://github.com/acme/pay/pull/5\n', stderr: '' } },
    ]);
    const url = await gh(runner).prCreate({ cwd: '/r', title: 'T', body: 'B' });
    expect(url).toBe('https://github.com/acme/pay/pull/5');
    expect(runner.calls[0]?.args).toContain('--draft');
    expect(runner.calls[0]?.options?.input).toBe('B');
  });
});
