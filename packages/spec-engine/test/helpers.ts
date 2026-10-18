import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { writeText } from '../src/fsutil.js';
import { initWorkspace, type Workspace } from '../src/workspace.js';

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

export function tempRepo(): Workspace {
  const dir = mkdtempSync(join(tmpdir(), 'orgspec-'));
  created.push(dir);
  return initWorkspace(dir, 'payments').workspace;
}

export function write(ws: Workspace, relPath: string, text: string): string {
  const file = join(ws.repoRoot, relPath);
  writeText(file, text);
  return file;
}

export const RETRIES_SPEC = `# Payments retries

## Purpose

Retries keep card captures succeeding through short gateway outages without double charging.

## Requirements

### Requirement: Retry failed captures {#payments.retries.capture}
The system SHALL retry a failed card capture up to 5 times.

#### Scenario: Transient gateway error {#payments.retries.capture/transient}
- **WHEN** the gateway returns a 503 on capture
- **THEN** the capture is retried

### Requirement: Remember me {#payments.retries.remember}
The system MUST remember the last retry attempt per order.

#### Scenario: Attempt stored {#payments.retries.remember/stored}
- **WHEN** a retry runs
- **THEN** the attempt number is stored

### Requirement: Old naming {#payments.retries.alerting}
The system SHALL alert when retries are exhausted.

#### Scenario: Exhausted {#payments.retries.alerting/exhausted}
- **WHEN** the last retry fails
- **THEN** an alert is raised
`;

export const FILLED_PROPOSAL = `# Proposal: retry logic

## Why
Five attempts hit the gateway rate limit during the 14 Oct incident.

## What changes
- Cap retries at 3 attempts with exponential backoff.

## Capabilities
- Modified: payments/retries

## Impact
Payments service only.
`;

export const FILLED_TASKS = `# Tasks

## 1. Retry policy
- [ ] 1.1 Cap attempts at 3 (payments.retries.capture), verified by unit test
- [x] 1.2 Add backoff schedule
`;
