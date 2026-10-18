import { mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadChange, updateChangeMeta } from './change.js';
import { deltaTouchedIds } from './delta.js';
import { type Diagnostic, error, hasErrors } from './diagnostics.js';
import { exists, writeText } from './fsutil.js';
import { hashText } from './hash.js';
import { capabilityPathFromId } from './ids.js';
import { type Region, splitLines } from './markdown.js';
import { parseSpec } from './spec.js';
import { NEW_SPEC } from './templates.js';
import { checkDeltas, rel, validateChange } from './validate.js';
import { specFile, type Workspace } from './workspace.js';

const titleFor = (capabilityId: string): string => {
  const words = capabilityId.split('.').join(' ').replace(/-/g, ' ');
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
};

function renderSpec(lines: readonly string[], region: Region, blocks: readonly string[]): string {
  const before = lines.slice(0, region.start).join('\n').trimEnd();
  const after = lines
    .slice(region.end - 1)
    .join('\n')
    .trim();
  const body = blocks.map((b) => b.trim()).join('\n\n');
  return `${before}\n\n${body}${after ? `\n\n${after}` : ''}\n`;
}

const renameHeader = (text: string, id: string, newName: string): string => {
  const [, ...rest] = text.split('\n');
  return [`### Requirement: ${newName} {#${id}}`, ...rest].join('\n');
};

export interface ArchivePlan {
  writes: { file: string; text: string }[];
  retire: string[];
  specsUpdated: string[];
}

/** Computes every main-spec write without touching the disk. */
export function planArchive(ws: Workspace, id: string): { plan?: ArchivePlan; diagnostics: Diagnostic[] } {
  const { change, diagnostics } = validateChange(ws, id);
  if (hasErrors(diagnostics) || !change.meta) return { diagnostics };

  const plan: ArchivePlan = { writes: [], retire: [], specsUpdated: [] };
  const { deltas } = checkDeltas(ws, change);

  for (const { capabilityId, capabilityPath, delta, main } of deltas) {
    const file = specFile(ws, capabilityPath);
    const source = main
      ? main.lines.join('\n')
      : NEW_SPEC(titleFor(capabilityId), delta.purpose ?? 'TBD: update Purpose after archive.');
    const parsed = main ?? parseSpec(source, rel(ws, file), capabilityId);
    const region = parsed.requirementsRegion;
    if (!region) {
      diagnostics.push(
        error('spec_missing_requirements', 'Main spec has no "## Requirements" section', { path: rel(ws, file) }),
      );
      continue;
    }

    let blocks = parsed.requirements.map((r) => ({ id: r.id, text: r.text }));
    const removed = new Set(delta.removed.flatMap((r) => (r.id ? [r.id] : [])));
    blocks = blocks.filter((b) => !b.id || !removed.has(b.id));
    for (const rn of delta.renamed) {
      blocks = blocks.map((b) => (b.id === rn.id ? { ...b, text: renameHeader(b.text, rn.id, rn.newName) } : b));
    }
    for (const r of delta.modified) blocks = blocks.map((b) => (b.id === r.id ? { id: r.id, text: r.text } : b));
    for (const r of delta.added) blocks.push({ id: r.id, text: r.text });

    if (blocks.length === 0) {
      if (change.meta.retire_capabilities && main) {
        plan.retire.push(file);
        plan.specsUpdated.push(capabilityId);
        continue;
      }
      diagnostics.push(
        error('delta_would_empty_spec', `Archiving would remove every requirement from ${capabilityId}`, {
          path: rel(ws, file),
          fix: 'Set retire_capabilities: true in change.yaml to retire the capability',
        }),
      );
      continue;
    }

    plan.writes.push({
      file,
      text: renderSpec(
        splitLines(source),
        region,
        blocks.map((b) => b.text),
      ),
    });
    plan.specsUpdated.push(capabilityId);
  }

  return hasErrors(diagnostics) ? { diagnostics } : { plan, diagnostics };
}

export interface ArchiveResult {
  archivedAs?: string;
  path?: string;
  specsUpdated: string[];
  retired: string[];
  diagnostics: Diagnostic[];
}

export function archiveChange(ws: Workspace, id: string, options: { date?: string } = {}): ArchiveResult {
  const { plan, diagnostics } = planArchive(ws, id);
  if (!plan) return { specsUpdated: [], retired: [], diagnostics };

  const date = options.date ?? new Date().toISOString().slice(0, 10);
  const archivedAs = `${date}-${id}`;
  const dest = join(ws.archiveDir, archivedAs);
  if (exists(dest)) {
    return {
      specsUpdated: [],
      retired: [],
      diagnostics: [...diagnostics, error('archive_exists', `${rel(ws, dest)} already exists`)],
    };
  }

  for (const w of plan.writes) writeText(w.file, w.text);
  for (const f of plan.retire) rmSync(f);
  mkdirSync(ws.archiveDir, { recursive: true });
  renameSync(join(ws.changesDir, id), dest);
  // Agent checkpoints are working state, not part of the record.
  rmSync(join(dest, '.session'), { recursive: true, force: true });

  return {
    archivedAs,
    path: rel(ws, dest),
    specsUpdated: plan.specsUpdated,
    retired: plan.retire.map((f) => rel(ws, f)),
    diagnostics,
  };
}

/** Pins the current main-spec hash of every requirement the change modifies, removes or renames. */
export function rebaseChange(ws: Workspace, id: string): { base: Record<string, string>; diagnostics: Diagnostic[] } {
  const change = loadChange(ws, id);
  const diagnostics = [...change.diagnostics];
  if (!change.meta) return { base: {}, diagnostics };

  const base: Record<string, string> = {};
  const { deltas } = checkDeltas(ws, change);
  for (const { capabilityId, delta, main, file } of deltas) {
    const byId = new Map((main?.requirements ?? []).flatMap((r) => (r.id ? [[r.id, r] as const] : [])));
    for (const target of deltaTouchedIds(delta)) {
      const req = byId.get(target);
      if (!req) {
        diagnostics.push(
          error('delta_target_missing', `"${target}" is not in the main spec for ${capabilityId}`, {
            path: rel(ws, file),
            fix: `Expected it in orgspec/specs/${capabilityPathFromId(capabilityId)}/spec.md`,
          }),
        );
        continue;
      }
      base[target] = hashText(req.text);
    }
  }
  if (!hasErrors(diagnostics)) updateChangeMeta(change.metaFile, (doc) => doc.set('base', base));
  return { base, diagnostics };
}
