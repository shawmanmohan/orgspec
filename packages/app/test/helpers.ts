import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type ClaudeJobs, fakeJobs } from '@orgspec/claude';
import { type Rule, RuleSchema, writeBundle } from '@orgspec/constitution';
import { type Connector, memoryConnector } from '@orgspec/gateway';
import { afterEach } from 'vitest';
import { AppContext } from '../src/index.js';

const dirs: string[] = [];
const contexts: AppContext[] = [];
afterEach(async () => {
  for (const c of contexts.splice(0)) await c.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

export function tmp(prefix = 'orgspec-app-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

export function put(root: string, rel: string, text: string): string {
  const f = join(root, rel);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, text);
  return f;
}

export const rule = (over: Partial<Rule> & { id: string }): Rule =>
  RuleSchema.parse({
    title: over.id,
    statement: 'Follow the rule.',
    enforcement: 'advisory',
    source: { pageId: '1', version: 3, quote: 'quoted from the page' },
    ...over,
  });

export const RULES: Rule[] = [
  rule({
    id: 'eng.git.no-force',
    enforcement: 'hook',
    severity: 'blocking',
    check: { kind: 'git-op', deny: ['force-push'], ask: ['pr-ready'], tiers: ['low', 'medium', 'high'] },
  }),
  rule({
    id: 'eng.fs.workflows',
    enforcement: 'hook',
    severity: 'blocking',
    check: {
      kind: 'file-scope',
      deny: ['.github/workflows/**'],
      allowWhenNamedInSpec: true,
      tiers: ['low', 'medium', 'high'],
    },
  }),
  rule({
    id: 'eng.tier.db',
    enforcement: 'ci',
    severity: 'blocking',
    check: { kind: 'path-rule', paths: ['db/migrations/**'], minTier: 'high' },
  }),
  rule({
    id: 'eng.approve.proposal',
    enforcement: 'ci',
    severity: 'blocking',
    check: { kind: 'approval', artifact: 'proposal.md', role: 'staff', count: 1 },
  }),
  rule({
    id: 'pm.prd.metrics',
    enforcement: 'review',
    check: { kind: 'rubric', artifact: 'prd', question: 'Does the PRD define success metrics?' },
  }),
];

/** An orgspec-config checkout with one persona pinned to a freshly written bundle. */
export function orgConfig(rules: Rule[] = RULES, extra: Record<string, string> = {}): { dir: string; sha256: string } {
  const dir = tmp('orgspec-config-');
  const manifest = writeBundle(join(dir, 'compiled/engineer/1.0.0'), {
    persona: 'engineer',
    version: '1.0.0',
    rules,
    sources: [{ pageId: '1', version: 3, title: 'Engineering handbook', hash: 'sha256:x' }],
    compiler: { version: 'test', model: 'test' },
  });
  put(
    dir,
    'personas/engineer.yaml',
    `apiVersion: orgspec/v1
kind: Persona
metadata: { id: engineer, name: Engineer, version: 1.0.0 }
spec:
  constitution: { bundle: compiled/engineer/1.0.0, sha256: "${manifest.sha256}" }
  mcp:
    - server: atlassian
      tools: ["get*", "search*", "edit*"]
      confirm: ["edit*"]
  views: []
`,
  );
  put(dir, 'roles.yaml', 'roles:\n  staff: [alice]\nteams:\n  payments: [alice, bob]\n');
  for (const [k, v] of Object.entries(extra)) put(dir, k, v);
  return { dir, sha256: manifest.sha256 };
}

export function makeContext(
  o: { jobs?: ClaudeJobs; connector?: Connector; configDir?: string; settings?: Record<string, unknown> } = {},
): AppContext {
  const home = tmp('orgspec-home-');
  const settings = {
    persona: 'engineer',
    workRoot: join(home, 'work'),
    ...(o.configDir ? { configRepo: o.configDir } : {}),
    ...o.settings,
  };
  put(home, 'settings.json', JSON.stringify(settings));
  const ctx = new AppContext({
    env: { ...process.env, ORGSPEC_HOME: home, ORGSPEC_KEYSTORE: 'file' },
    jobs: o.jobs ?? fakeJobs({}),
    connector: o.connector ?? memoryConnector({}),
  });
  contexts.push(ctx);
  return ctx;
}

export function gitRepo(): string {
  const dir = tmp('orgspec-repo-');
  const g = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'bob@users.noreply.github.com');
  g('config', 'user.name', 'bob');
  g('config', 'commit.gpgsign', 'false');
  return dir;
}

export const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
