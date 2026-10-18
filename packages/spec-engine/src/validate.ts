import { join, relative } from 'node:path';
import { type LoadedChange, loadChange } from './change.js';
import { deltaTouchedIds, type ParsedDelta, parseDelta } from './delta.js';
import { type Diagnostic, error, warning } from './diagnostics.js';
import { exists, readText, toPosix } from './fsutil.js';
import { hashText } from './hash.js';
import { isKebabSegment } from './ids.js';
import { SPECS_GLOB } from './schema.js';
import { type ParsedSpec, PURPOSE_MIN, parseSpec, type Requirement } from './spec.js';
import { changeStatus, taskProgress } from './status.js';
import { TODO_MARKER } from './templates.js';
import { type SpecRef, specFile, type Workspace } from './workspace.js';

export const rel = (ws: Workspace, p: string): string => toPosix(relative(ws.repoRoot, p));

export function validateSpec(ws: Workspace, ref: SpecRef): Diagnostic[] {
  return parseSpec(readText(ref.file), rel(ws, ref.file), ref.id).diagnostics;
}

/** Main spec for a capability, parsed without reporting its own problems. */
export function loadMainSpec(ws: Workspace, capabilityPath: string, capabilityId: string): ParsedSpec | undefined {
  const file = specFile(ws, capabilityPath);
  return exists(file) ? parseSpec(readText(file), rel(ws, file), capabilityId) : undefined;
}

export interface CheckedDelta {
  capabilityPath: string;
  capabilityId: string;
  file: string;
  delta: ParsedDelta;
  main?: ParsedSpec;
}

/** Parses every delta in a change and checks it against the current main specs. */
export function checkDeltas(
  ws: Workspace,
  change: LoadedChange,
): { deltas: CheckedDelta[]; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const deltas: CheckedDelta[] = [];
  const base = change.meta?.base ?? {};

  for (const ref of change.deltas) {
    const path = rel(ws, ref.file);
    const segments = ref.capabilityPath.split('/');
    if (!segments.every(isKebabSegment)) {
      diagnostics.push(
        error('capability_path_invalid', `Capability path "${ref.capabilityPath}" must be kebab-case`, { path }),
      );
    }
    const delta = parseDelta(readText(ref.file), path, ref.capabilityId);
    diagnostics.push(...delta.diagnostics);
    const main = loadMainSpec(ws, ref.capabilityPath, ref.capabilityId);
    const mainById = new Map<string, Requirement>((main?.requirements ?? []).flatMap((r) => (r.id ? [[r.id, r]] : [])));

    if (!main) {
      if (!delta.purpose) {
        diagnostics.push(
          warning(
            'delta_new_capability_no_purpose',
            `New capability "${ref.capabilityId}" has no "## Purpose" section`,
            {
              path,
            },
          ),
        );
      } else if (delta.purpose.length < PURPOSE_MIN) {
        diagnostics.push(warning('spec_purpose_too_short', `Purpose is under ${PURPOSE_MIN} characters`, { path }));
      }
    }

    for (const r of delta.added) {
      if (r.id && mainById.has(r.id)) {
        diagnostics.push(
          error('delta_added_exists', `"${r.id}" already exists in the main spec; use MODIFIED`, {
            path,
            line: r.line,
          }),
        );
      }
    }

    for (const id of deltaTouchedIds(delta)) {
      const target = mainById.get(id);
      if (!target) {
        diagnostics.push(
          error('delta_target_missing', `"${id}" is not in the main spec for ${ref.capabilityId}`, {
            path,
            fix: `Check the ID with "orgspec show ${ref.capabilityId}"`,
          }),
        );
        continue;
      }
      const pinned = base[id];
      if (!pinned) {
        diagnostics.push(
          warning('delta_base_missing', `No base hash for "${id}"`, { path, fix: `Run "orgspec rebase ${change.id}"` }),
        );
      } else if (pinned !== hashText(target.text)) {
        diagnostics.push(
          error('delta_base_conflict', `"${id}" changed in the main spec since this change was based on it`, {
            path,
            fix: `Review the main spec, update the delta, then run "orgspec rebase ${change.id}"`,
          }),
        );
      }
    }

    for (const r of delta.modified) {
      const target = r.id ? mainById.get(r.id) : undefined;
      if (!target) continue;
      const kept = new Set(r.scenarios.flatMap((s) => (s.id ? [s.id] : [])));
      for (const s of target.scenarios) {
        if (s.id && !kept.has(s.id)) {
          diagnostics.push(
            warning('delta_scenario_dropped', `MODIFIED "${r.id}" drops scenario "${s.id}"`, {
              path,
              line: r.line,
              fix: 'Keep every existing scenario, or remove it deliberately and say why in the proposal',
            }),
          );
        }
      }
    }

    deltas.push({ ...ref, delta, ...(main ? { main } : {}) });
  }
  return { deltas, diagnostics };
}

export function validateChange(ws: Workspace, id: string): { change: LoadedChange; diagnostics: Diagnostic[] } {
  const change = loadChange(ws, id);
  const diagnostics = [...change.diagnostics];
  const status = changeStatus(change);
  if (!change.meta || !status) return { change, diagnostics };

  const metaPath = rel(ws, change.metaFile);
  for (const a of status.artifacts) {
    if (a.required && (a.state === 'ready' || a.state === 'blocked')) {
      if (a.generates === SPECS_GLOB) {
        diagnostics.push(
          error('change_no_deltas', `Tier ${status.tier} needs at least one delta spec`, {
            path: metaPath,
            fix: 'Add specs/<capability>/spec.md, or set skip_specs: true if no behaviour changes',
          }),
        );
      } else {
        diagnostics.push(
          error('artifact_required_missing', `Tier ${status.tier} requires ${a.generates} (${a.id})`, {
            path: metaPath,
          }),
        );
      }
    }
    if (a.generates === SPECS_GLOB) continue;
    for (const f of a.files) {
      const full = join(change.dir, f);
      const text = readText(full);
      if (!text.trim()) diagnostics.push(error('artifact_empty', `${f} is empty`, { path: rel(ws, full) }));
      else if (text.includes(TODO_MARKER)) {
        diagnostics.push(warning('artifact_unfilled', `${f} still has template placeholders`, { path: rel(ws, full) }));
      }
      if (a.id === 'tasks' && taskProgress(text).total === 0) {
        diagnostics.push(warning('tasks_empty', 'tasks.md has no "- [ ]" tasks', { path: rel(ws, full) }));
      }
    }
  }

  if (change.meta.skip_specs && change.deltas.length > 0) {
    diagnostics.push(
      warning('skip_specs_with_deltas', 'skip_specs is true but the change has delta specs', { path: metaPath }),
    );
  }

  diagnostics.push(...checkDeltas(ws, change).diagnostics);
  return { change, diagnostics };
}
