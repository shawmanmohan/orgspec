import { join } from 'node:path';
import { Document, parseDocument } from 'yaml';
import { z } from 'zod';
import { type Diagnostic, error, OrgSpecError } from './diagnostics.js';
import { exists, readText, walkFiles, writeText } from './fsutil.js';
import { CHANGE_ID, capabilityIdFromPath, JIRA_KEY, slugify } from './ids.js';
import { resolveSchema, TIERS, type Tier, type WorkflowSchema } from './schema.js';
import { TEMPLATES } from './templates.js';
import { customSchemas, type Workspace } from './workspace.js';

export const ChangeMetaSchema = z
  .object({
    id: z.string().regex(CHANGE_ID, 'id must look like PROJ-123 or PROJ-123-short-slug'),
    jira: z.string().regex(JIRA_KEY, 'jira must be a Jira key such as PROJ-123'),
    schema: z.string().regex(/^[a-z][a-z0-9-]*(@\d+)?$/, 'schema must look like feature or feature@1'),
    tier: z.enum(TIERS),
    constitution: z
      .string()
      .regex(/^sha256:[0-9a-f]{6,}$/)
      .optional(),
    /** Content hash of each MODIFIED/REMOVED/RENAMED requirement in the main spec when the change was based. */
    base: z.record(z.string(), z.string().regex(/^sha256:[0-9a-f]+$/)).default({}),
    skip_specs: z.boolean().default(false),
    retire_capabilities: z.boolean().default(false),
  })
  .passthrough();

export type ChangeMeta = z.infer<typeof ChangeMetaSchema>;

export interface DeltaRef {
  capabilityPath: string;
  capabilityId: string;
  file: string;
}

export interface LoadedChange {
  id: string;
  dir: string;
  metaFile: string;
  meta?: ChangeMeta;
  schema?: WorkflowSchema;
  deltas: DeltaRef[];
  diagnostics: Diagnostic[];
}

export const changeDir = (ws: Workspace, id: string): string => join(ws.changesDir, id);

export function listDeltas(dir: string): DeltaRef[] {
  return walkFiles(join(dir, 'specs'))
    .filter((f) => f.endsWith('/spec.md'))
    .map((f) => {
      const capabilityPath = f.slice(0, -'/spec.md'.length);
      return { capabilityPath, capabilityId: capabilityIdFromPath(capabilityPath), file: join(dir, 'specs', f) };
    });
}

export function loadChange(ws: Workspace, id: string): LoadedChange {
  const dir = changeDir(ws, id);
  const metaFile = join(dir, 'change.yaml');
  if (!exists(metaFile)) {
    throw new OrgSpecError([
      error('change_not_found', `No change "${id}" in ${ws.changesDir}`, {
        fix: 'Run "orgspec list" to see active changes',
      }),
    ]);
  }
  const diagnostics: Diagnostic[] = [];
  const doc = parseDocument(readText(metaFile));
  const parsed = ChangeMetaSchema.safeParse(doc.toJS());
  const result: LoadedChange = { id, dir, metaFile, deltas: listDeltas(dir), diagnostics };
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      diagnostics.push(
        error('change_meta_invalid', `change.yaml: ${issue.path.join('.') || '(root)'}: ${issue.message}`, {
          path: metaFile,
        }),
      );
    }
    return result;
  }
  result.meta = parsed.data;
  if (parsed.data.id !== id) {
    diagnostics.push(
      error('change_id_mismatch', `change.yaml id "${parsed.data.id}" does not match folder "${id}"`, {
        path: metaFile,
      }),
    );
  }
  const resolved = resolveSchema(parsed.data.schema, customSchemas(ws));
  diagnostics.push(...resolved.diagnostics.map((d) => ({ ...d, path: metaFile })));
  if (resolved.schema) result.schema = resolved.schema;
  return result;
}

/** Updates keys in change.yaml while keeping comments, order and unknown keys. */
export function updateChangeMeta(metaFile: string, update: (doc: Document) => void): void {
  const doc = parseDocument(readText(metaFile));
  update(doc);
  writeText(metaFile, String(doc));
}

export interface NewChangeOptions {
  jira: string;
  slug?: string;
  title?: string;
  schema?: string;
  tier?: Tier;
}

export function newChange(ws: Workspace, opts: NewChangeOptions): { id: string; dir: string; files: string[] } {
  if (!JIRA_KEY.test(opts.jira)) {
    throw new OrgSpecError([error('jira_key_invalid', `"${opts.jira}" is not a Jira key such as PROJ-123`)]);
  }
  const slug = opts.slug ? slugify(opts.slug) : undefined;
  const id = slug ? `${opts.jira}-${slug}` : opts.jira;
  const dir = changeDir(ws, id);
  if (exists(dir)) throw new OrgSpecError([error('change_exists', `Change "${id}" already exists`, { path: dir })]);

  const schemaRef = opts.schema ?? ws.settings.defaultSchema;
  const resolved = resolveSchema(schemaRef, customSchemas(ws));
  if (!resolved.schema) throw new OrgSpecError(resolved.diagnostics);
  const tier = opts.tier ?? 'medium';

  const doc = new Document({
    id,
    jira: opts.jira,
    schema: `${resolved.schema.name}@${resolved.schema.version}`,
    tier,
    base: {},
    skip_specs: false,
  });
  doc.commentBefore = ' OrgSpec change metadata. Tier is proposed here and confirmed in the Jira tier field.';
  const files = [join(dir, 'change.yaml')];
  writeText(files[0] as string, String(doc));

  const title = opts.title ?? (slug ? slug.replace(/-/g, ' ') : opts.jira);
  const proposal = join(dir, 'proposal.md');
  writeText(proposal, (TEMPLATES.proposal as (t: string) => string)(title));
  files.push(proposal);
  return { id, dir, files };
}
