import { describe, expect, it } from 'vitest';
import { parseDelta } from '../src/delta.js';
import { hashText } from '../src/hash.js';
import { parseSpec } from '../src/spec.js';
import { RETRIES_SPEC } from './helpers.js';

const codes = (d: { code: string }[]) => d.map((x) => x.code);

describe('parseSpec', () => {
  it('parses requirements, scenarios and IDs from a valid spec', () => {
    const spec = parseSpec(RETRIES_SPEC, 'spec.md', 'payments.retries');
    expect(spec.diagnostics).toEqual([]);
    expect(spec.title).toBe('Payments retries');
    expect(spec.requirements.map((r) => r.id)).toEqual([
      'payments.retries.capture',
      'payments.retries.remember',
      'payments.retries.alerting',
    ]);
    const first = spec.requirements[0];
    expect(first?.description).toBe('The system SHALL retry a failed card capture up to 5 times.');
    expect(first?.scenarios[0]?.id).toBe('payments.retries.capture/transient');
    expect(first?.text.startsWith('### Requirement: Retry failed captures')).toBe(true);
  });

  it('reports structural problems with stable codes', () => {
    const src = `# X

## Purpose

Short.

## Requirements

### Requirement: No id
The system does things.

### Scenario: wrong level

### Requirement: Bad id {#other.thing}
The system SHALL work.

#### Scenario: no id
- WHEN a
- THEN b

### Requirement: Twice {#payments.retries.twice}
The system SHALL x.

#### Scenario: A {#payments.retries.twice/a}
- WHEN a
- THEN b

### Requirement: Twice again {#payments.retries.twice}
The system SHALL y.

#### Scenario: B {#payments.retries.twice/b}
- WHEN a
- THEN b
`;
    const got = codes(parseSpec(src, 'spec.md', 'payments.retries').diagnostics);
    expect(got).toEqual(
      expect.arrayContaining([
        'spec_purpose_too_short',
        'scenario_wrong_level',
        'requirement_missing_id',
        'requirement_missing_normative',
        'requirement_missing_scenario',
        'requirement_id_invalid',
        'scenario_missing_id',
        'requirement_duplicate_id',
      ]),
    );
  });

  it('requires a Requirements section', () => {
    expect(codes(parseSpec('# X\n\n## Purpose\n\nx\n', 'spec.md', 'a').diagnostics)).toContain(
      'spec_missing_requirements',
    );
  });

  it('ignores headings inside code blocks', () => {
    const src = `${RETRIES_SPEC}\n### Requirement: Fenced {#payments.retries.fenced}\nThe system SHALL show code.\n\n#### Scenario: Shows {#payments.retries.fenced/shows}\n- WHEN x\n- THEN y\n\n\`\`\`md\n### Requirement: not real\n\`\`\`\n`;
    expect(parseSpec(src, 'spec.md', 'payments.retries').requirements).toHaveLength(4);
  });
});

describe('parseDelta', () => {
  it('reads all four sections', () => {
    const src = `## ADDED Requirements

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
    const delta = parseDelta(src, 'delta.md', 'payments.retries');
    expect(delta.diagnostics).toEqual([]);
    expect(delta.added.map((r) => r.id)).toEqual(['payments.retries.backoff']);
    expect(delta.modified.map((r) => r.id)).toEqual(['payments.retries.capture']);
    expect(delta.removed.map((r) => r.id)).toEqual(['payments.retries.remember']);
    expect(delta.renamed).toEqual([
      { id: 'payments.retries.alerting', newName: 'Alert on exhausted retries', line: 26 },
    ]);
  });

  it('flags unknown sections, bad renames, missing reasons and conflicting sections', () => {
    const src = `## CHANGED Requirements

## REMOVED Requirements

### Requirement: Remember me {#payments.retries.remember}
Gone.

## ADDED Requirements

### Requirement: Remember me {#payments.retries.remember}
The system SHALL x.

#### Scenario: S {#payments.retries.remember/s}
- WHEN a
- THEN b

## RENAMED Requirements

- payments.retries.alerting to New
`;
    expect(codes(parseDelta(src, 'delta.md', 'payments.retries').diagnostics)).toEqual(
      expect.arrayContaining([
        'delta_unknown_section',
        'delta_removed_missing_reason',
        'delta_conflicting_sections',
        'delta_rename_invalid',
      ]),
    );
  });
});

describe('hashText', () => {
  it('ignores line endings and trailing whitespace', () => {
    expect(hashText('a  \r\nb\n\n')).toBe(hashText('a\nb'));
    expect(hashText('a\nb')).not.toBe(hashText('a\nc'));
  });
});
