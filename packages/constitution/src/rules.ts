import { LAYERS } from '@orgspec/core';
import { TIERS, type Tier } from '@orgspec/spec-engine';
import { z } from 'zod';

const tiers = z.array(z.enum(TIERS));

/** Checks are data interpreted by OrgSpec code; compiled output never contains executable code. */
export const CheckSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('artifact-required'),
    artifacts: z.array(z.string()).min(1),
    tiers: tiers.default([...TIERS]),
  }),
  z.object({ kind: z.literal('section-required'), artifact: z.string(), heading: z.string().min(1) }),
  z.object({ kind: z.literal('path-rule'), paths: z.array(z.string()).min(1), minTier: z.enum(TIERS) }),
  z.object({
    kind: z.literal('approval'),
    artifact: z.string(),
    role: z.string().optional(),
    team: z.string().optional(),
    count: z.number().int().positive().default(1),
  }),
  z.object({ kind: z.literal('trace-coverage'), tiers: tiers.default(['medium', 'high']) }),
  z.object({
    kind: z.literal('git-op'),
    /** `push:<branch glob>`, `force-push`, `merge`, `pr-ready`, `rewrite-history`. */
    deny: z.array(z.string()).default([]),
    ask: z.array(z.string()).default([]),
    tiers: tiers.default([...TIERS]),
  }),
  z.object({
    kind: z.literal('file-scope'),
    deny: z.array(z.string()).min(1),
    /** A denied path is allowed when the change's spec or design names it. */
    allowWhenNamedInSpec: z.boolean().default(true),
    tiers: tiers.default([...TIERS]),
  }),
  z.object({
    kind: z.literal('pattern-forbid'),
    paths: z.array(z.string()).min(1),
    pattern: z.string().min(1),
    flags: z.string().default(''),
  }),
  z.object({ kind: z.literal('rubric'), artifact: z.string(), question: z.string().min(1) }),
]);
export type Check = z.infer<typeof CheckSchema>;
export type CheckKind = Check['kind'];

export const ENFORCEMENTS = ['advisory', 'review', 'ci', 'hook'] as const;
export const SEVERITIES = ['advisory', 'warning', 'blocking'] as const;

export const RuleSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/, 'rule IDs look like eng.git.no-direct-main'),
  title: z.string().min(1),
  statement: z.string().min(1),
  rationale: z.string().default(''),
  appliesTo: z
    .object({
      personas: z.array(z.string()).default([]),
      tiers: tiers.default([...TIERS]),
      artifacts: z.array(z.string()).default([]),
      /** Glob paths in the product repo a rule is about; used to scope `.claude/rules` files. */
      paths: z.array(z.string()).default([]),
    })
    .default({}),
  enforcement: z.enum(ENFORCEMENTS),
  check: CheckSchema.optional(),
  severity: z.enum(SEVERITIES).default('warning'),
  source: z.object({ pageId: z.string(), version: z.number().int().nonnegative(), quote: z.string().min(1) }),
  layer: z.enum(LAYERS).default('base'),
  /** Department, team or repo for scoped layers. */
  scope: z.string().optional(),
});
export type Rule = z.infer<typeof RuleSchema>;

/** Which enforcement levels a check kind can honestly support. */
export const ENFORCEABLE: Record<CheckKind, readonly Rule['enforcement'][]> = {
  'artifact-required': ['ci'],
  'section-required': ['ci'],
  'path-rule': ['ci'],
  approval: ['ci'],
  'trace-coverage': ['ci'],
  'git-op': ['hook'],
  'file-scope': ['hook', 'ci'],
  'pattern-forbid': ['ci'],
  rubric: ['review'],
};

export const ENFORCEMENT_RANK: Record<Rule['enforcement'], number> = { advisory: 0, review: 1, ci: 2, hook: 2 };
export const SEVERITY_RANK: Record<Rule['severity'], number> = { advisory: 0, warning: 1, blocking: 2 };
export const TIER_RANK: Record<Tier, number> = { low: 0, medium: 1, high: 2 };

export const appliesToTier = (rule: Rule, tier: Tier): boolean => rule.appliesTo.tiers.includes(tier);
export const appliesToPersona = (rule: Rule, persona: string): boolean =>
  rule.appliesTo.personas.length === 0 || rule.appliesTo.personas.includes(persona);
