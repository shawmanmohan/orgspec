/** Placeholder marker in templates; validation warns while any remain. */
export const TODO_MARKER = 'orgspec:todo';

const todo = (hint: string) => `<!-- ${TODO_MARKER} ${hint} -->`;

export const TEMPLATES: Record<string, (title: string) => string> = {
  proposal: (title) => `# Proposal: ${title}

## Why
${todo('1-2 sentences: the problem or opportunity, and why now')}

## What changes
${todo('bullets; mark breaking changes with **BREAKING**')}

## Capabilities
- New: ${todo('paths for new capabilities, for example payments/retries')}
- Modified: ${todo('exact existing paths under orgspec/specs')}

## Impact
${todo('code, APIs, dependencies and teams affected')}
`,
  design: (title) => `# Design: ${title}

## Approach
${todo('technical approach')}

## Decisions
${todo('each decision with options considered and why; link ADRs')}

## Rollback
${todo('how this change is turned off or reverted')}
`,
  'threat-model': (title) => `# Threat model: ${title}

## Assets and trust boundaries
${todo('what is protected and where trust changes')}

## Threats
${todo('threat, likelihood, impact, mitigation')}
`,
  tasks: () => `# Tasks

## 1. ${todo('group name')}
- [ ] 1.1 ${todo('task; cite requirement IDs and how it is verified')}
`,
  findings: (title) => `# Findings: ${title}

## Question
${todo('what the spike set out to answer')}

## Findings
${todo('what was learned, with evidence')}

## Recommendation
${todo('next step')}
`,
  rollout: (title) => `# Rollout: ${title}

## Steps
${todo('ordered rollout steps, with flags or regions')}

## Monitoring and rollback
${todo('signals watched and the rollback trigger')}
`,
};

export const NEW_SPEC = (title: string, purpose: string) => `# ${title}

## Purpose

${purpose}

## Requirements
`;

export const REPO_YAML = (team: string) => `# OrgSpec repository settings
team: ${team}
defaultSchema: feature
`;
