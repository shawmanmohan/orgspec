import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { archiveChange, rebaseChange } from '../src/archive.js';
import { loadChange, newChange } from '../src/change.js';
import { exists } from '../src/fsutil.js';
import { parseSpec } from '../src/spec.js';
import { changeStatus } from '../src/status.js';
import { traceChange } from '../src/trace.js';
import { validateChange } from '../src/validate.js';
import { FILLED_PROPOSAL, FILLED_TASKS, RETRIES_SPEC, tempRepo, write } from './helpers.js';

const codes = (d: { code: string }[]) => d.map((x) => x.code);

const DELTA = `## ADDED Requirements

### Requirement: Backoff {#payments.retries.backoff}
The system SHALL wait 2s, 4s and 8s between attempts.

#### Scenario: Schedule {#payments.retries.backoff/schedule}
- **WHEN** a capture fails
- **THEN** the next attempt waits 2s

## MODIFIED Requirements

### Requirement: Retry failed captures {#payments.retries.capture}
The system SHALL retry a failed card capture up to 3 times.

#### Scenario: Transient gateway error {#payments.retries.capture/transient}
- **WHEN** the gateway returns a 503 on capture
- **THEN** the capture is retried at most 3 times

## REMOVED Requirements

### Requirement: Remember me {#payments.retries.remember}
**Reason**: attempts now live in the ledger. **Migration**: read them from the ledger.

## RENAMED Requirements

- {#payments.retries.alerting} → Alert on exhausted retries
`;

function setup(tier: 'low' | 'medium' | 'high' = 'medium') {
  const ws = tempRepo();
  write(ws, 'orgspec/specs/payments/retries/spec.md', RETRIES_SPEC);
  const { id } = newChange(ws, { jira: 'PROJ-123', slug: 'retry logic', tier });
  const base = `orgspec/changes/${id}`;
  write(ws, `${base}/proposal.md`, FILLED_PROPOSAL);
  write(ws, `${base}/tasks.md`, FILLED_TASKS);
  return { ws, id, base };
}

describe('newChange', () => {
  it('creates change.yaml and a proposal template', () => {
    const ws = tempRepo();
    const { id, dir } = newChange(ws, { jira: 'PROJ-9', slug: 'Dark Mode', schema: 'feature', tier: 'low' });
    expect(id).toBe('PROJ-9-dark-mode');
    const change = loadChange(ws, id);
    expect(change.diagnostics).toEqual([]);
    expect(change.meta?.schema).toBe('feature@1');
    expect(exists(join(dir, 'proposal.md'))).toBe(true);
    expect(() => newChange(ws, { jira: 'PROJ-9', slug: 'Dark Mode' })).toThrow(/already exists/);
    expect(() => newChange(ws, { jira: 'proj-9' })).toThrow(/Jira key/);
  });
});

describe('changeStatus', () => {
  it('requires more artifacts as the tier rises', () => {
    const ws = tempRepo();
    const low = changeStatus(loadChange(ws, newChange(ws, { jira: 'AB-1', tier: 'low' }).id));
    const high = changeStatus(loadChange(ws, newChange(ws, { jira: 'AB-2', tier: 'high' }).id));
    const required = (s: typeof low) => s?.artifacts.filter((a) => a.required).map((a) => a.id);
    expect(required(low)).toEqual(['proposal', 'tasks']);
    expect(required(high)).toEqual(['proposal', 'specs', 'design', 'threat-model', 'tasks']);
    expect(high?.next).toBe('specs');
    expect(high?.artifacts.find((a) => a.id === 'threat-model')).toMatchObject({
      state: 'blocked',
      missing: ['design'],
    });
    expect(low?.artifacts.find((a) => a.id === 'tasks')?.state).toBe('ready');
  });
});

describe('validateChange', () => {
  it('passes a complete medium change once based', () => {
    const { ws, id, base } = setup();
    write(ws, `${base}/specs/payments/retries/spec.md`, DELTA);
    expect(codes(validateChange(ws, id).diagnostics)).toEqual([
      'delta_base_missing',
      'delta_base_missing',
      'delta_base_missing',
    ]);
    expect(rebaseChange(ws, id).diagnostics).toEqual([]);
    expect(validateChange(ws, id).diagnostics).toEqual([]);
  });

  it('needs a delta at medium tier and design and threat model at high tier', () => {
    const medium = setup('medium');
    expect(codes(validateChange(medium.ws, medium.id).diagnostics)).toContain('change_no_deltas');
    const high = setup('high');
    write(high.ws, `${high.base}/specs/payments/retries/spec.md`, DELTA);
    const got = validateChange(high.ws, high.id).diagnostics.filter((d) => d.code === 'artifact_required_missing');
    expect(got.map((d) => d.message)).toEqual([
      'Tier high requires design.md (design)',
      'Tier high requires threat-model.md (threat-model)',
    ]);
  });

  it('warns on template placeholders and rejects unknown targets', () => {
    const ws = tempRepo();
    write(ws, 'orgspec/specs/payments/retries/spec.md', RETRIES_SPEC);
    const { id } = newChange(ws, { jira: 'PROJ-5', tier: 'medium' });
    write(
      ws,
      `orgspec/changes/${id}/specs/payments/retries/spec.md`,
      '## REMOVED Requirements\n\n### Requirement: Ghost {#payments.retries.ghost}\n**Reason**: x **Migration**: y\n',
    );
    expect(codes(validateChange(ws, id).diagnostics)).toEqual(
      expect.arrayContaining(['artifact_unfilled', 'delta_target_missing', 'artifact_required_missing']),
    );
  });

  it('detects a main spec that moved after the change was based', () => {
    const { ws, id, base } = setup();
    write(ws, `${base}/specs/payments/retries/spec.md`, DELTA);
    rebaseChange(ws, id);
    write(ws, 'orgspec/specs/payments/retries/spec.md', RETRIES_SPEC.replace('up to 5 times', 'up to 6 times'));
    expect(codes(validateChange(ws, id).diagnostics)).toEqual(['delta_base_conflict']);
  });
});

describe('archiveChange', () => {
  it('merges ADDED, MODIFIED, REMOVED and RENAMED by ID and moves the folder', () => {
    const { ws, id, base } = setup();
    write(ws, `${base}/specs/payments/retries/spec.md`, DELTA);
    write(ws, `${base}/.session/PROGRESS.md`, 'checkpoint');
    rebaseChange(ws, id);

    const result = archiveChange(ws, id, { date: '2026-10-19' });
    expect(result.diagnostics).toEqual([]);
    expect(result.archivedAs).toBe('2026-10-19-PROJ-123-retry-logic');
    expect(result.specsUpdated).toEqual(['payments.retries']);

    const mainSrc = readFileSync(join(ws.specsDir, 'payments/retries/spec.md'), 'utf8');
    const main = parseSpec(mainSrc, 'spec.md', 'payments.retries');
    expect(main.diagnostics).toEqual([]);
    expect(main.requirements.map((r) => [r.id, r.name])).toEqual([
      ['payments.retries.capture', 'Retry failed captures'],
      ['payments.retries.alerting', 'Alert on exhausted retries'],
      ['payments.retries.backoff', 'Backoff'],
    ]);
    expect(main.requirements[0]?.description).toContain('up to 3 times');
    expect(mainSrc).toContain('## Purpose\n\nRetries keep card captures');
    expect(exists(join(ws.changesDir, id))).toBe(false);
    expect(exists(join(ws.archiveDir, '2026-10-19-PROJ-123-retry-logic/change.yaml'))).toBe(true);
    expect(exists(join(ws.archiveDir, '2026-10-19-PROJ-123-retry-logic/.session'))).toBe(false);
  });

  it('writes nothing when the base is stale', () => {
    const { ws, id, base } = setup();
    write(ws, `${base}/specs/payments/retries/spec.md`, DELTA);
    rebaseChange(ws, id);
    const moved = RETRIES_SPEC.replace('up to 5 times', 'up to 6 times');
    write(ws, 'orgspec/specs/payments/retries/spec.md', moved);
    const result = archiveChange(ws, id);
    expect(codes(result.diagnostics)).toEqual(['delta_base_conflict']);
    expect(readFileSync(join(ws.specsDir, 'payments/retries/spec.md'), 'utf8')).toBe(moved);
    expect(exists(join(ws.changesDir, id))).toBe(true);
  });

  it('creates the main spec for a new capability from the delta purpose', () => {
    const ws = tempRepo();
    const { id } = newChange(ws, { jira: 'PAY-7', slug: 'refunds', tier: 'medium' });
    write(ws, `orgspec/changes/${id}/proposal.md`, FILLED_PROPOSAL);
    write(ws, `orgspec/changes/${id}/tasks.md`, FILLED_TASKS);
    write(
      ws,
      `orgspec/changes/${id}/specs/payments/refunds/spec.md`,
      `## Purpose

Refunds return captured money to the cardholder, in full or in part, exactly once.

## ADDED Requirements

### Requirement: Idempotent refunds {#payments.refunds.idempotent}
The system SHALL create one refund per idempotency key.

#### Scenario: Retried request {#payments.refunds.idempotent/retried}
- **WHEN** a refund request is retried with the same key
- **THEN** the original refund ID is returned
`,
    );
    const result = archiveChange(ws, id, { date: '2026-10-19' });
    expect(result.diagnostics).toEqual([]);
    const main = parseSpec(
      readFileSync(join(ws.specsDir, 'payments/refunds/spec.md'), 'utf8'),
      'spec.md',
      'payments.refunds',
    );
    expect(main.diagnostics).toEqual([]);
    expect(main.title).toBe('Payments refunds');
    expect(main.purpose).toContain('exactly once');
  });

  it('refuses to empty a spec unless the change retires the capability', () => {
    const ws = tempRepo();
    write(
      ws,
      'orgspec/specs/legacy/spec.md',
      '# Legacy\n\n## Purpose\n\nOld behaviour kept for compatibility with the first merchant API version.\n\n## Requirements\n\n### Requirement: Old {#legacy.old}\nThe system SHALL do old things.\n\n#### Scenario: S {#legacy.old/s}\n- WHEN x\n- THEN y\n',
    );
    const { id } = newChange(ws, { jira: 'LEG-1', tier: 'medium' });
    write(ws, `orgspec/changes/${id}/proposal.md`, FILLED_PROPOSAL);
    write(ws, `orgspec/changes/${id}/tasks.md`, FILLED_TASKS);
    write(
      ws,
      `orgspec/changes/${id}/specs/legacy/spec.md`,
      '## REMOVED Requirements\n\n### Requirement: Old {#legacy.old}\n**Reason**: unused. **Migration**: none.\n',
    );
    rebaseChange(ws, id);
    expect(codes(archiveChange(ws, id).diagnostics)).toContain('delta_would_empty_spec');

    const metaFile = join(ws.changesDir, id, 'change.yaml');
    write(ws, `orgspec/changes/${id}/change.yaml`, `${readFileSync(metaFile, 'utf8')}retire_capabilities: true\n`);
    const result = archiveChange(ws, id);
    expect(result.retired).toEqual(['orgspec/specs/legacy/spec.md']);
    expect(exists(join(ws.specsDir, 'legacy/spec.md'))).toBe(false);
  });
});

describe('traceChange', () => {
  it('fails medium-tier changes until every new scenario is cited by a test', () => {
    const { ws, id, base } = setup();
    write(ws, `${base}/specs/payments/retries/spec.md`, DELTA);
    const before = traceChange(ws, id);
    expect(before.rows.map((r) => r.scenarioId)).toEqual([
      'payments.retries.backoff/schedule',
      'payments.retries.capture/transient',
    ]);
    expect(before.diagnostics.filter((d) => d.severity === 'error')).toHaveLength(2);

    write(
      ws,
      'services/payments/test/retry.test.ts',
      '// @scenario payments.retries.backoff/schedule\n// @scenario payments.retries.capture/transient\n',
    );
    const after = traceChange(ws, id);
    expect(after.diagnostics).toEqual([]);
    expect(after.rows[0]?.citations).toEqual([{ file: 'services/payments/test/retry.test.ts', line: 1 }]);
  });
});
