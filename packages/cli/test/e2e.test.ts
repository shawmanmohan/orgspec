import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AppContext } from '@orgspec/app';
import { fakeJobs } from '@orgspec/claude';
import { RuleSchema, writeBundle } from '@orgspec/constitution';
import { type CommandRunner, runCommand } from '@orgspec/core';
import { memoryConnector } from '@orgspec/gateway';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/run.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
const put = (root: string, rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();

const PAGE =
  '<h1>Engineering handbook</h1><p>Never force-push a shared branch.</p><p>Database migrations need the high tier.</p>';

/** A git-backed orgspec-config with a base overlay, one persona and an eval. */
function orgConfig() {
  const dir = tmp('e2e-config-');
  const rules = [
    RuleSchema.parse({
      id: 'eng.git.no-force',
      title: 'No force pushes',
      statement: 'Never force-push.',
      enforcement: 'hook',
      severity: 'blocking',
      check: { kind: 'git-op', deny: ['force-push'] },
      source: { pageId: '42', version: 1, quote: 'Never force-push a shared branch' },
    }),
  ];
  const m = writeBundle(join(dir, 'compiled/engineer/1.0.0'), {
    persona: 'engineer',
    version: '1.0.0',
    rules,
    sources: [],
    compiler: { version: 't', model: 't' },
  });
  put(
    dir,
    'personas/engineer.yaml',
    `# Engineers\napiVersion: orgspec/v1\nkind: Persona\nmetadata: { id: engineer, name: Engineer, version: 1.0.0 }\nspec:\n  constitution: { bundle: compiled/engineer/1.0.0, sha256: "${m.sha256}" }\n`,
  );
  put(
    dir,
    'constitution/base.yaml',
    'apiVersion: orgspec/v1\nkind: ConstitutionOverlay\nmetadata: { id: base, version: 1.0.0 }\nspec:\n  layer: base\n  sources:\n    - confluence: { space: ENG, title: Handbook, pageId: "42" }\n',
  );
  put(
    dir,
    'integrations.yaml',
    'servers:\n  atlassian: { transport: stdio, command: x }\nconstants: { cloudId: c1 }\n',
  );
  put(
    dir,
    'evals/git.yaml',
    '- { name: force push denied, persona: engineer, bash: "git push --force", expect: deny, rule: eng.git.no-force }\n',
  );
  git(dir, 'init', '-q', '-b', 'main');
  return dir;
}

/** A product repo with an `origin` remote, so packets can add worktrees. */
function productRepo() {
  const origin = tmp('e2e-origin-');
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  const dir = tmp('e2e-repo-');
  git(dir, 'init', '-q', '-b', 'main');
  for (const [k, v] of [
    ['user.email', 'alice@users.noreply.github.com'],
    ['user.name', 'alice'],
    ['commit.gpgsign', 'false'],
  ])
    git(dir, 'config', k as string, v as string);
  put(dir, 'README.md', '# pay');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  git(dir, 'remote', 'add', 'origin', origin);
  git(dir, 'push', '-q', 'origin', 'main');
  git(dir, 'remote', 'set-url', 'origin', 'https://github.com/acme/pay.git');
  git(dir, 'remote', 'set-url', '--push', 'origin', origin);
  git(dir, 'config', `url.${origin}.insteadOf`, 'https://github.com/acme/pay.git');
  return dir;
}

/** Real git; a fake gh with two accounts. */
const runner: CommandRunner = async (cmd, args, opts) => {
  if (cmd === 'gh' || cmd.endsWith('/gh')) {
    if (args[0] === 'auth' && args[1] === 'status') {
      return {
        code: 0,
        stdout: JSON.stringify({
          hosts: {
            'github.com': [
              { login: 'alice', active: true, state: 'success', host: 'github.com' },
              { login: 'alice-work', active: false, state: 'success', host: 'github.com' },
            ],
          },
        }),
        stderr: '',
      };
    }
    return { code: 0, stdout: '[]', stderr: '' };
  }
  return runCommand(cmd, args, opts);
};

describe('orgspec end to end', () => {
  it('runs setup, packet, hook, change, approval, check, decisions and admin', async () => {
    const home = tmp('e2e-home-');
    const config = orgConfig();
    const repo = productRepo();
    const connector = memoryConnector({
      atlassian: {
        tools: [
          { name: 'getConfluencePage', inputSchema: { type: 'object' } },
          { name: 'getJiraIssue', inputSchema: { type: 'object' } },
        ],
        handle: (tool) =>
          tool === 'getJiraIssue'
            ? { key: 'PAY-9', fields: { summary: 'Add ledger index', status: { name: 'In Progress' } } }
            : { id: '42', title: 'Engineering handbook', version: { number: 2 }, body: { storage: { value: PAGE } } },
      },
    });
    const jobs = fakeJobs({
      'constitution-compiler': {
        rules: [
          {
            id: 'eng.git.no-force',
            title: 'No force pushes',
            statement: 'Never force-push.',
            quote: 'Never force-push a shared branch',
            enforcement: 'hook',
            severity: 'blocking',
            check: { kind: 'git-op', deny: ['force-push'] },
          },
          {
            id: 'eng.tier.db',
            title: 'Migrations are high tier',
            statement: 'Use the high tier.',
            quote: 'Database migrations need the high tier',
            enforcement: 'ci',
            severity: 'blocking',
            check: { kind: 'path-rule', paths: ['db/migrations/**'], minTier: 'high' },
          },
        ],
      },
    });
    const makeCtx = () =>
      new AppContext({
        env: { ...process.env, ORGSPEC_HOME: home, ORGSPEC_KEYSTORE: 'file' },
        runner,
        connector,
        jobs,
      });
    const orgspec = async (cwd: string, ...args: string[]) => {
      let out = '';
      const code = await run(['--json', ...args], { out: (s) => (out += s), err: () => {}, cwd }, { context: makeCtx });
      return {
        code,
        json: () => {
          try {
            // biome-ignore lint/suspicious/noExplicitAny: test reads loosely shaped JSON reports
            return JSON.parse(out) as Record<string, any>;
          } catch {
            throw new Error(`not JSON from ${args.join(' ')}: ${out.slice(0, 400)}`);
          }
        },
        out,
      };
    };

    // setup: existing config checkout, identity from gh, only persona selected automatically
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ workRoot: join(home, 'tickets') }));
    const s = await orgspec(home, 'setup', '--config-dir', config, '--email', 'alice@acme.io');
    expect(s.code).toBe(0);
    expect(s.json().persona).toBe('engineer');
    expect((await orgspec(home, 'settings', 'repo', 'add', 'acme/pay', '--path', repo)).code).toBe(0);
    expect((await orgspec(home, 'github', 'map', 'acme', 'alice-work')).json().orgAccounts).toEqual({
      'github.com/acme': 'alice-work',
    });
    expect((await orgspec(home, 'github', 'auto-switch', 'off')).code).toBe(0);

    // the repo is initialised (and pushed) before the packet, so worktrees carry orgspec/
    expect((await orgspec(repo, 'init', '--team', 'payments')).code).toBe(0);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'orgspec init');
    git(repo, 'push', '-q', 'origin', 'main');

    // packet: worktree, session files, agents, rules, gateway entry
    const p = await orgspec(home, 'packet', 'PAY-9', '--launch', 'none', '--base', 'main');
    expect(p.code).toBe(0);
    const folder = p.json().folder as string;
    const wt = join(folder, 'repos', 'pay');
    expect(existsSync(join(wt, 'README.md'))).toBe(true);
    expect(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('pay-9');
    expect(readFileSync(join(folder, 'packet.md'), 'utf8')).toContain('PAY-9: Add ledger index');
    expect(JSON.parse(readFileSync(join(folder, '.mcp.json'), 'utf8')).mcpServers.orgspec.args[0]).toBe('gateway');
    expect(existsSync(join(folder, '.claude/agents/orgspec-engineer.md'))).toBe(true);
    expect(p.json().warnings.join(' ')).toContain('alice-work');

    // hook inside the ticket folder (in-process, same code path as `orgspec hook pre-tool-use`)
    const { preToolUse } = await import('@orgspec/app');
    expect(
      preToolUse({ cwd: wt, tool_name: 'Bash', tool_input: { command: 'git push --force origin pay-9' } })
        ?.hookSpecificOutput?.permissionDecision,
    ).toBe('deny');
    expect(
      preToolUse({ cwd: wt, tool_name: 'Write', tool_input: { file_path: '/tmp/outside.txt' } })?.hookSpecificOutput
        ?.permissionDecision,
    ).toBe('deny');

    // change in the worktree, approval, check
    const n = await orgspec(wt, 'new', 'PAY-9', '--slug', 'ledger index', '--tier', 'low');
    expect(n.code).toBe(0);
    const id = n.json().change.id as string;
    put(
      wt,
      `orgspec/changes/${id}/proposal.md`,
      '# Proposal\n\n## Why\nLookups on the ledger are slow.\n\n## What changes\n- Add an index.\n',
    );
    put(wt, 'db/migrations/001.sql', 'create index ledger_ix on ledger(order_id);');
    git(wt, 'add', '-A');
    git(wt, 'commit', '-qm', 'ledger index');
    const a = await orgspec(wt, 'approve', id, 'proposal.md');
    expect(a.out).toContain('"approver": "alice"');

    const compiled = await orgspec(home, 'admin', 'compile');
    expect(compiled.code).toBe(0);
    expect(compiled.json().diffs[0]).toMatchObject({ persona: 'engineer', from: '1.0.0', to: '1.0.1' });
    expect(compiled.json().diffs[0].summary).toContain('Added eng.tier.db');
    const ev = await orgspec(home, 'admin', 'eval', '--bundle', 'engineer=1.0.1');
    expect(ev.json()).toMatchObject({ passed: 1, failed: [] });
    expect((await orgspec(home, 'admin', 'diff', 'engineer')).json().diff.added[0].id).toBe('eng.tier.db');

    // check against the new bundle: the migration needs a high-tier change
    const { pinPersona } = await import('@orgspec/app');
    const { loadBundle } = await import('@orgspec/constitution');
    const nb = loadBundle(join(config, 'compiled/engineer/1.0.1')).bundle;
    pinPersona(config, 'engineer', 'compiled/engineer/1.0.1', nb?.manifest.sha256 ?? '');
    expect(readFileSync(join(config, 'personas/engineer.yaml'), 'utf8')).toMatch(/^# Engineers/);
    const c = await orgspec(wt, 'check', '--base', 'main', '--config', config, '--repo', 'acme/pay');
    expect(c.code).toBe(1);
    const codes = (c.json().report.changes[0].diagnostics as { code: string }[]).map((d) => d.code);
    expect(codes).toContain('check_tier_floor');

    // decisions
    expect((await orgspec(wt, 'decision', 'new', 'Index the ledger by order', '--path', 'db/**')).code).toBe(0);
    expect((await orgspec(wt, 'decision', 'index')).json().indexed).toBe(1);
    expect((await orgspec(home, 'decision', 'search', 'ledger')).json().hits[0].adrId).toBe('ADR-0001');

    // errors are reported, not thrown
    const bad = await orgspec(home, 'settings', 'persona', 'nobody');
    expect(bad.code).toBe(1);
    expect(bad.json().diagnostics[0].message).toContain('nobody');

    // cleanup refuses uncommitted work
    put(wt, 'scratch.txt', 'wip');
    expect((await orgspec(home, 'cleanup', 'PAY-9')).code).toBe(1);
    expect((await orgspec(home, 'cleanup', 'PAY-9', '--force')).code).toBe(0);
    expect(existsSync(folder)).toBe(false);
  }, 30_000);
});
