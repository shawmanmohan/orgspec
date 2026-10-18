import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/run.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'orgspec-cli-'));
  dirs.push(dir);
  return dir;
}

async function orgspec(cwd: string, ...args: string[]) {
  let out = '';
  let err = '';
  const code = await run(args, {
    out: (s) => {
      out = out + s;
    },
    err: (s) => {
      err = err + s;
    },
    cwd,
  });
  return { code, out, err, json: () => JSON.parse(out) };
}

function write(root: string, rel: string, text: string) {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

const SPEC = `# Payments retries

## Purpose

Retries keep card captures succeeding through short gateway outages without double charging.

## Requirements

### Requirement: Retry failed captures {#payments.retries.capture}
The system SHALL retry a failed card capture up to 5 times.

#### Scenario: Transient gateway error {#payments.retries.capture/transient}
- **WHEN** the gateway returns a 503 on capture
- **THEN** the capture is retried
`;

const DELTA = `## MODIFIED Requirements

### Requirement: Retry failed captures {#payments.retries.capture}
The system SHALL retry a failed card capture up to 3 times.

#### Scenario: Transient gateway error {#payments.retries.capture/transient}
- **WHEN** the gateway returns a 503 on capture
- **THEN** the capture is retried at most 3 times
`;

describe('orgspec CLI', () => {
  it('runs a change from init to archive', async () => {
    const root = repo();
    expect((await orgspec(root, 'init', '--team', 'payments')).code).toBe(0);
    write(root, 'orgspec/specs/payments/retries/spec.md', SPEC);

    const created = await orgspec(root, '--json', 'new', 'PROJ-123', '--slug', 'retry logic', '--tier', 'medium');
    expect(created.code).toBe(0);
    expect(created.json().change.id).toBe('PROJ-123-retry-logic');
    expect(created.json().status.next).toBe('specs');

    const id = 'PROJ-123-retry-logic';
    const dir = `orgspec/changes/${id}`;
    write(root, `${dir}/proposal.md`, '# Proposal\n\n## Why\nRate limits.\n');
    write(root, `${dir}/tasks.md`, '# Tasks\n\n- [ ] 1.1 Cap at 3\n');
    write(root, `${dir}/specs/payments/retries/spec.md`, DELTA);

    const unbased = await orgspec(root, '--json', 'validate', id, '--strict');
    expect(unbased.code).toBe(1);
    expect(unbased.json().items[0].diagnostics.map((d: { code: string }) => d.code)).toEqual(['delta_base_missing']);

    expect((await orgspec(root, 'rebase', id)).code).toBe(0);
    const valid = await orgspec(root, '--json', 'validate');
    expect(valid.code).toBe(0);
    expect(valid.json().summary).toEqual({ total: 2, passed: 2, failed: 0 });

    const trace = await orgspec(root, 'trace', id);
    expect(trace.code).toBe(1);
    expect(trace.out).toContain('MISSING payments.retries.capture/transient');
    write(root, 'test/retry.test.ts', '// @scenario payments.retries.capture/transient\n');
    expect((await orgspec(root, 'trace', id)).code).toBe(0);

    const archived = await orgspec(root, '--json', 'archive', id, '--date', '2026-10-19', '--ci');
    expect(archived.code).toBe(0);
    expect(archived.json().archive.archivedAs).toBe('2026-10-19-PROJ-123-retry-logic');
    expect(readFileSync(join(root, 'orgspec/specs/payments/retries/spec.md'), 'utf8')).toContain('up to 3 times');

    const list = await orgspec(root, '--json', 'list');
    expect(list.json().changes).toEqual([]);
    const show = await orgspec(root, '--json', 'show', 'payments.retries');
    expect(show.json().requirements[0].id).toBe('payments.retries.capture');
  });

  it('explains a missing orgspec folder with a fix', async () => {
    const result = await orgspec(repo(), 'list');
    expect(result.code).toBe(1);
    expect(result.out).toContain('no_orgspec_root');
    expect(result.out).toContain('fix: Run "orgspec init"');
  });

  it('prints one JSON document for errors', async () => {
    const root = repo();
    await orgspec(root, 'init');
    const result = await orgspec(root, '--json', 'status', 'NOPE-1');
    expect(result.code).toBe(1);
    expect(result.json()).toMatchObject({ ok: false, diagnostics: [{ code: 'change_not_found' }] });
  });
});
