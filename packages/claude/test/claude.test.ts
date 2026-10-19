import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuleSchema } from '@orgspec/constitution';
import { fakeRunner } from '@orgspec/core';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import {
  claudeJobs,
  claudeSessions,
  claudeVersion,
  renderClaudeRules,
  renderManagedSettings,
  writeClaudeFolder,
} from '../src/index.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const envelope = (result: string) => ({
  code: 0,
  stdout: JSON.stringify({ type: 'result', result, session_id: 's1', total_cost_usd: 0.01 }),
  stderr: '',
});

describe('claude -p jobs', () => {
  const schema = z.object({ ok: z.boolean() });
  it('extracts and validates JSON from the result', async () => {
    const runner = fakeRunner([
      { match: (c) => c === 'claude', result: envelope('Here:\n```json\n{"ok": true}\n```') },
    ]);
    const r = await claudeJobs(runner).run({ agent: 'prd-reviewer', prompt: 'review', schema, cwd: '/tmp' });
    expect(r.data).toEqual({ ok: true });
    expect(runner.calls[0]?.args).toEqual(['-p', '--agent', 'prd-reviewer', '--output-format', 'json']);
    expect(runner.calls[0]?.options?.input).toBe('review');
  });
  it('retries once with the validation errors', async () => {
    let n = 0;
    const runner = fakeRunner([
      { match: () => true, result: () => envelope(n++ === 0 ? '{"ok": "yes"}' : '{"ok": false}') },
    ]);
    const r = await claudeJobs(runner).run({ agent: 'a', prompt: 'p', schema, cwd: '/tmp' });
    expect(r.attempts).toBe(2);
    expect(r.costUsd).toBeCloseTo(0.02);
    expect(runner.calls[1]?.options?.input).toContain('ok: Expected boolean');
  });
  it('gives up after two invalid answers', async () => {
    const runner = fakeRunner([{ match: () => true, result: envelope('no json here') }]);
    await expect(claudeJobs(runner).run({ agent: 'a', prompt: 'p', schema, cwd: '/tmp' })).rejects.toThrow(
      'invalid output twice',
    );
  });
});

describe('sessions and version', () => {
  it('checks the minimum version', async () => {
    const old = fakeRunner([{ match: () => true, result: { code: 0, stdout: '2.1.278 (Claude Code)', stderr: '' } }]);
    expect((await claudeVersion(old)).ok).toBe(false);
    const ok = fakeRunner([{ match: () => true, result: { code: 0, stdout: '2.2.0 (Claude Code)', stderr: '' } }]);
    expect((await claudeVersion(ok)).ok).toBe(true);
  });
  it('lists background sessions', async () => {
    const runner = fakeRunner([
      {
        match: (_c, a) => a[0] === 'agents',
        result: {
          code: 0,
          stdout: JSON.stringify([
            {
              pid: 1,
              cwd: '/w/PAY-1',
              kind: 'background',
              startedAt: 1792256746911,
              sessionId: 'abc',
              name: 'PAY-1',
              status: 'idle',
            },
          ]),
          stderr: '',
        },
      },
    ]);
    const list = await claudeSessions(runner).list();
    expect(list[0]).toMatchObject({ id: 'abc', kind: 'background', startedAt: '2026-10-17T17:05:46.911Z' });
    expect(runner.calls[0]?.args).toEqual(['agents', '--json', '--all']);
    await claudeSessions(runner).list('/w');
    expect(runner.calls[1]?.args).toEqual(['agents', '--json', '--all', '--cwd', '/w']);
  });
  it('uses the top-level attach, logs, stop and rm commands', async () => {
    const runner = fakeRunner([{ match: () => true, result: { code: 0, stdout: '', stderr: '' } }]);
    const s = claudeSessions(runner);
    await s.logs('a1');
    await s.stop('a1');
    await s.remove('a1');
    expect(runner.calls.map((c) => c.args)).toEqual([
      ['logs', 'a1'],
      ['stop', 'a1'],
      ['rm', 'a1'],
    ]);
    expect(s.attachCommand('a1')).toEqual(['claude', 'attach', 'a1']);
  });
});

describe('generators', () => {
  const rules = [
    RuleSchema.parse({
      id: 'eng.git.no-main',
      title: 'No main',
      statement: 'Use PRs.',
      enforcement: 'hook',
      source: { pageId: '1', version: 1, quote: 'q' },
    }),
    RuleSchema.parse({
      id: 'eng.db.migrations',
      title: 'Migrations',
      statement: 'Migrations are reversible.',
      enforcement: 'advisory',
      appliesTo: { paths: ['db/migrations/**'] },
      source: { pageId: '1', version: 1, quote: 'q' },
    }),
  ];
  it('renders path-scoped rule files', () => {
    const files = renderClaudeRules(rules, { persona: 'engineer', version: '1.0.0' });
    expect(files['orgspec-constitution.md']).toContain('eng.git.no-main');
    const scoped = files['orgspec-eng-db-migrations.md'] ?? '';
    expect(parseYaml(scoped.split('---')[1] ?? '')).toEqual({ paths: ['db/migrations/**'] });
  });
  it('writes agents, rules and the gateway entry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orgspec-claude-'));
    dirs.push(dir);
    const written = writeClaudeFolder({
      dir,
      rules,
      bundle: { persona: 'engineer', version: '1.0.0' },
      sessionId: 'sess-1',
    });
    expect(written).toContain('.claude/agents/orgspec-engineer.md');
    const mcp = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers.orgspec.args).toEqual(['gateway', '--stdio', '--session', 'sess-1']);
    const agent = readFileSync(join(dir, '.claude/agents/prd-reviewer.md'), 'utf8');
    expect(agent).toMatch(/^---\nname: prd-reviewer/);
  });
  it('locks managed settings to OrgSpec hooks and gateway', () => {
    const s = renderManagedSettings();
    expect(s.allowManagedHooksOnly).toBe(true);
    expect(s.allowedMcpServers).toEqual([{ serverName: 'orgspec' }]);
    expect(s.hooks.PreToolUse[0]?.hooks[0]?.command).toBe('orgspec hook pre-tool-use');
  });
});

describe('hook commands', () => {
  it('quotes an executable path that contains spaces', () => {
    const s = renderManagedSettings({ orgspecBin: '/Users/a/Application Support/orgspec' });
    expect(s.hooks.PreToolUse[0]?.hooks[0]?.command).toBe("'/Users/a/Application Support/orgspec' hook pre-tool-use");
  });
});
