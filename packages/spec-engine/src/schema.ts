import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { type Diagnostic, error, warning } from './diagnostics.js';

export const TIERS = ['low', 'medium', 'high'] as const;
export type Tier = (typeof TIERS)[number];

const ArtifactSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  /** A file name, or `specs/**\/spec.md` for delta specs. */
  generates: z.string().min(1),
  description: z.string().default(''),
  requires: z.array(z.string()).default([]),
  requiredAt: z.array(z.enum(TIERS)).default([...TIERS]),
  /** Key into TEMPLATES; defaults to the artifact ID. */
  template: z.string().optional(),
});

export const WorkflowSchemaSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/),
  version: z.number().int().positive(),
  description: z.string().default(''),
  artifacts: z.array(ArtifactSchema).min(1),
});

export type ArtifactDef = z.infer<typeof ArtifactSchema>;
export type WorkflowSchema = z.infer<typeof WorkflowSchemaSchema>;

export const SPECS_GLOB = 'specs/**/spec.md';

const art = (
  id: string,
  generates: string,
  requires: string[],
  requiredAt: Tier[],
  description: string,
): ArtifactDef => ({ id, generates, requires, requiredAt, description });

const ALL: Tier[] = ['low', 'medium', 'high'];
const MID_UP: Tier[] = ['medium', 'high'];
const HIGH: Tier[] = ['high'];

export const BUILTIN_SCHEMAS: Record<string, WorkflowSchema> = {
  feature: {
    name: 'feature',
    version: 1,
    description: 'New or changed product behaviour',
    artifacts: [
      art('proposal', 'proposal.md', [], ALL, 'Why, what changes, capabilities, impact'),
      art('specs', SPECS_GLOB, ['proposal'], MID_UP, 'Delta specs per capability'),
      art('design', 'design.md', ['proposal'], HIGH, 'Technical approach and decisions'),
      art('threat-model', 'threat-model.md', ['design'], HIGH, 'Threats and mitigations'),
      art('tasks', 'tasks.md', ['specs', 'design'], ALL, 'Implementation checklist'),
    ],
  },
  'api-change': {
    name: 'api-change',
    version: 1,
    description: 'Changes to a public or internal API contract',
    artifacts: [
      art('proposal', 'proposal.md', [], ALL, 'Why, what changes, capabilities, impact'),
      art('specs', SPECS_GLOB, ['proposal'], ALL, 'Delta specs for the contract'),
      art('design', 'design.md', ['proposal'], MID_UP, 'Compatibility and versioning approach'),
      art('threat-model', 'threat-model.md', ['design'], HIGH, 'Threats and mitigations'),
      art('tasks', 'tasks.md', ['specs', 'design'], ALL, 'Implementation checklist'),
    ],
  },
  migration: {
    name: 'migration',
    version: 1,
    description: 'Data or infrastructure migration',
    artifacts: [
      art('proposal', 'proposal.md', [], ALL, 'Why, what changes, impact'),
      art('specs', SPECS_GLOB, ['proposal'], MID_UP, 'Behaviour that must hold during and after'),
      art('design', 'design.md', ['proposal'], MID_UP, 'Migration approach'),
      art('rollout', 'rollout.md', ['design'], MID_UP, 'Steps, monitoring, rollback'),
      art('tasks', 'tasks.md', ['specs', 'design'], ALL, 'Implementation checklist'),
    ],
  },
  bugfix: {
    name: 'bugfix',
    version: 1,
    description: 'Fixing behaviour that does not match the spec',
    artifacts: [
      art('proposal', 'proposal.md', [], ALL, 'What is broken and the fix'),
      art('specs', SPECS_GLOB, ['proposal'], HIGH, 'Delta specs when behaviour changes'),
      art('tasks', 'tasks.md', ['proposal', 'specs'], ALL, 'Reproduce, failing test, fix, verify'),
    ],
  },
  spike: {
    name: 'spike',
    version: 1,
    description: 'Time-boxed investigation; no production code',
    artifacts: [
      art('proposal', 'proposal.md', [], ALL, 'Question to answer and time box'),
      art('findings', 'findings.md', ['proposal'], ALL, 'What was learned and the recommendation'),
    ],
  },
  chore: {
    name: 'chore',
    version: 1,
    description: 'Refactor, tooling or docs with no behaviour change',
    artifacts: [
      art('proposal', 'proposal.md', [], ALL, 'What and why'),
      art('tasks', 'tasks.md', ['proposal'], ALL, 'Checklist'),
    ],
  },
};

export function parseSchemaRef(ref: string): { name: string; version?: number } {
  const [name = '', version] = ref.split('@');
  return version ? { name, version: Number(version) } : { name };
}

/** Resolves a schema reference such as `feature@1` against custom schemas, then built-ins. */
export function resolveSchema(
  ref: string,
  custom: Record<string, string>,
): { schema?: WorkflowSchema; diagnostics: Diagnostic[] } {
  const { name, version } = parseSchemaRef(ref);
  const diagnostics: Diagnostic[] = [];
  let schema: WorkflowSchema | undefined;

  const customSrc = custom[name];
  if (customSrc !== undefined) {
    const parsed = WorkflowSchemaSchema.safeParse(parseYaml(customSrc));
    if (!parsed.success) {
      diagnostics.push(
        error(
          'schema_invalid',
          `Custom schema "${name}" is invalid: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
        ),
      );
      return { diagnostics };
    }
    schema = parsed.data;
  } else {
    schema = BUILTIN_SCHEMAS[name];
  }

  if (!schema) {
    diagnostics.push(
      error('schema_unknown', `Unknown schema "${name}"`, {
        fix: `Use one of: ${Object.keys(BUILTIN_SCHEMAS).join(', ')}, or add orgspec/schemas/${name}.yaml`,
      }),
    );
    return { diagnostics };
  }
  if (version !== undefined && version !== schema.version) {
    diagnostics.push(
      warning(
        'schema_version_mismatch',
        `Change pins ${name}@${version}; the current schema is ${name}@${schema.version}`,
      ),
    );
  }
  return { schema, diagnostics };
}
