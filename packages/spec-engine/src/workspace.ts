import { readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { error, OrgSpecError } from './diagnostics.js';
import { exists, isDir, readText, toPosix, walkFiles, writeText } from './fsutil.js';
import { capabilityIdFromPath } from './ids.js';
import { REPO_YAML } from './templates.js';

export interface Workspace {
  /** The repository root (parent of `orgspec/`). */
  repoRoot: string;
  /** The `orgspec/` folder. */
  root: string;
  specsDir: string;
  changesDir: string;
  archiveDir: string;
  decisionsDir: string;
  schemasDir: string;
  settings: RepoSettings;
}

export interface RepoSettings {
  team?: string;
  defaultSchema: string;
}

export const ORGSPEC_DIR = 'orgspec';

function makeWorkspace(repoRoot: string): Workspace {
  const root = join(repoRoot, ORGSPEC_DIR);
  const settingsPath = join(root, 'repo.yaml');
  const raw = exists(settingsPath) ? (parseYaml(readText(settingsPath)) as Partial<RepoSettings> | null) : null;
  return {
    repoRoot,
    root,
    specsDir: join(root, 'specs'),
    changesDir: join(root, 'changes'),
    archiveDir: join(root, 'changes', 'archive'),
    decisionsDir: join(root, 'decisions'),
    schemasDir: join(root, 'schemas'),
    settings: { defaultSchema: raw?.defaultSchema ?? 'feature', ...(raw?.team ? { team: raw.team } : {}) },
  };
}

/** Finds the nearest ancestor of `cwd` that contains an `orgspec/` folder. */
export function findWorkspace(cwd: string): Workspace {
  let dir = resolve(cwd);
  for (;;) {
    if (isDir(join(dir, ORGSPEC_DIR))) return makeWorkspace(dir);
    const parent = dirname(dir);
    if (parent === dir) {
      throw new OrgSpecError([
        error('no_orgspec_root', `No ${ORGSPEC_DIR}/ folder found from ${cwd}`, {
          fix: 'Run "orgspec init" in the repository root',
        }),
      ]);
    }
    dir = parent;
  }
}

export function initWorkspace(repoRoot: string, team = 'unassigned'): { workspace: Workspace; created: string[] } {
  const ws = makeWorkspace(resolve(repoRoot));
  const created: string[] = [];
  for (const d of [ws.specsDir, ws.archiveDir, ws.decisionsDir]) {
    if (!exists(d)) {
      writeText(join(d, '.gitkeep'), '');
      created.push(toPosix(relative(ws.repoRoot, d)));
    }
  }
  const settingsPath = join(ws.root, 'repo.yaml');
  if (!exists(settingsPath)) {
    writeText(settingsPath, REPO_YAML(team));
    created.push(toPosix(relative(ws.repoRoot, settingsPath)));
  }
  return { workspace: makeWorkspace(ws.repoRoot), created };
}

export interface SpecRef {
  /** `payments.retries` */
  id: string;
  /** `payments/retries` */
  path: string;
  file: string;
}

export function listSpecs(ws: Workspace): SpecRef[] {
  return walkFiles(ws.specsDir)
    .filter((f) => f.endsWith('/spec.md'))
    .map((f) => {
      const path = f.slice(0, -'/spec.md'.length);
      return { id: capabilityIdFromPath(path), path, file: join(ws.specsDir, f) };
    });
}

export function specFile(ws: Workspace, capabilityPath: string): string {
  return join(ws.specsDir, capabilityPath, 'spec.md');
}

export function listChangeIds(ws: Workspace): string[] {
  if (!isDir(ws.changesDir)) return [];
  return readdirSync(ws.changesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== 'archive' && exists(join(ws.changesDir, e.name, 'change.yaml')))
    .map((e) => e.name)
    .sort();
}

export function customSchemas(ws: Workspace): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of walkFiles(ws.schemasDir)) {
    if (/^[a-z][a-z0-9-]*\.ya?ml$/.test(f)) out[f.replace(/\.ya?ml$/, '')] = readText(join(ws.schemasDir, f));
  }
  return out;
}
