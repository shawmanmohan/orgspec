import { fileURLToPath } from 'node:url';
import { loadOrgConfig } from '@orgspec/core';
import { PolicyEngine } from '@orgspec/gateway';
import { describe, expect, it } from 'vitest';
import { adminCheck, adminEval, adminPolicies, loadJiraConfig, loadPeople, loadRoles } from '../src/index.js';
import { makeContext } from './helpers.js';

const dir = fileURLToPath(new URL('../../../examples/orgspec-config', import.meta.url));

describe('examples/orgspec-config', () => {
  it('loads without diagnostics and every bundle verifies', () => {
    const cfg = loadOrgConfig(dir);
    expect(cfg.diagnostics).toEqual([]);
    expect(cfg.personas.map((p) => p.metadata.id).sort()).toEqual([
      'engineer',
      'engineering-manager',
      'project-manager',
    ]);
    expect(cfg.overlays).toHaveLength(3);
    expect(Object.keys(cfg.integrations.servers)).toContain('ci');
    expect(cfg.waivers[0]?.id).toBe('W-1');
    const ctx = makeContext({ configDir: dir });
    expect(adminCheck(ctx)).toEqual([]);
  });
  it('passes its own golden evals', () => {
    const r = adminEval(makeContext({ configDir: dir }));
    expect(r.failed).toEqual([]);
    expect(r.passed).toBe(6);
  });
  it('has valid Cedar, Jira, roles and people files', () => {
    const cfg = loadOrgConfig(dir);
    const eng = cfg.personas.find((p) => p.metadata.id === 'engineer');
    const policy = new PolicyEngine('engineer', eng?.spec.mcp ?? [], adminPolicies(dir));
    expect(
      policy.decide({ persona: 'engineer', server: 'atlassian', tool: 'getJiraIssue', readOnly: true }).decision,
    ).toBe('allow');
    expect(
      policy.decide({ persona: 'engineer', server: 'atlassian', tool: 'addOrEditJiraIssueComment', readOnly: false })
        .decision,
    ).toBe('confirm');
    expect(policy.decide({ persona: 'engineer', server: 'ci', tool: 'delete_run', readOnly: false }).decision).toBe(
      'deny',
    );
    expect(loadJiraConfig(dir).gates.spec).toBe('customfield_10420');
    expect(loadRoles(dir).roles['staff-engineer']).toContain('alice');
    expect(loadPeople(dir).oneOnOne.spaceId).toBe('98765');
  });
});
