import { join, relative } from 'node:path';
import { type LoadedChange, listDeltas } from './change.js';
import { exists, toPosix } from './fsutil.js';
import { type ArtifactDef, SPECS_GLOB } from './schema.js';

export type ArtifactState = 'done' | 'ready' | 'blocked' | 'skipped' | 'not-required';

export interface ArtifactStatus {
  id: string;
  generates: string;
  description: string;
  required: boolean;
  state: ArtifactState;
  requires: string[];
  /** Required dependencies not yet done, in schema order (only when blocked). */
  missing: string[];
  files: string[];
}

export interface ChangeStatus {
  changeId: string;
  schema: string;
  tier: string;
  artifacts: ArtifactStatus[];
  /** First required artifact that can be written now. */
  next?: string;
  planningComplete: boolean;
}

export function artifactFiles(changeDir: string, def: ArtifactDef): string[] {
  if (def.generates === SPECS_GLOB) return listDeltas(changeDir).map((d) => toPosix(relative(changeDir, d.file)));
  return exists(join(changeDir, def.generates)) ? [def.generates] : [];
}

export function changeStatus(change: LoadedChange): ChangeStatus | undefined {
  const { meta, schema } = change;
  if (!meta || !schema) return undefined;

  const base = schema.artifacts.map((def) => {
    const files = artifactFiles(change.dir, def);
    const required = def.requiredAt.includes(meta.tier);
    const skipped = meta.skip_specs && def.generates === SPECS_GLOB;
    return { def, files, required, skipped };
  });
  const byId = new Map(base.map((b) => [b.def.id, b]));
  const satisfied = (id: string): boolean => {
    const b = byId.get(id);
    return !b || !b.required || b.skipped || b.files.length > 0;
  };

  const artifacts: ArtifactStatus[] = base.map(({ def, files, required, skipped }) => {
    let state: ArtifactState;
    let missing: string[] = [];
    if (skipped) state = 'skipped';
    else if (files.length > 0) state = 'done';
    else if (!required) state = 'not-required';
    else {
      missing = def.requires.filter((r) => !satisfied(r));
      state = missing.length ? 'blocked' : 'ready';
    }
    return {
      id: def.id,
      generates: def.generates,
      description: def.description,
      required,
      state,
      requires: def.requires,
      missing,
      files,
    };
  });

  const next = artifacts.find((a) => a.required && a.state === 'ready')?.id;
  return {
    changeId: change.id,
    schema: `${schema.name}@${schema.version}`,
    tier: meta.tier,
    artifacts,
    ...(next ? { next } : {}),
    planningComplete: artifacts.every((a) => !a.required || a.state === 'done' || a.state === 'skipped'),
  };
}

export interface TaskProgress {
  total: number;
  done: number;
}

/** Counts `- [ ]` / `- [x]` lines in tasks.md. */
export function taskProgress(src: string): TaskProgress {
  let total = 0;
  let done = 0;
  for (const line of src.split(/\r?\n/)) {
    const m = /^\s*[-*]\s+\[([ xX])\]\s+\S/.exec(line);
    if (!m) continue;
    total++;
    if (m[1] !== ' ') done++;
  }
  return { total, done };
}
