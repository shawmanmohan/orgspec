import { type Diagnostic, error, warning } from './diagnostics.js';
import { regionOf, sliceLines, splitLines, topLevelHeadings } from './markdown.js';
import { checkDuplicateRequirementIds, checkRequirement, parseRequirementsInRegion, type Requirement } from './spec.js';

export interface Rename {
  id: string;
  newName: string;
  line: number;
}

export interface ParsedDelta {
  purpose?: string;
  added: Requirement[];
  modified: Requirement[];
  removed: Requirement[];
  renamed: Rename[];
  diagnostics: Diagnostic[];
}

const SECTION = {
  PURPOSE: 'PURPOSE',
  ADDED: 'ADDED REQUIREMENTS',
  MODIFIED: 'MODIFIED REQUIREMENTS',
  REMOVED: 'REMOVED REQUIREMENTS',
  RENAMED: 'RENAMED REQUIREMENTS',
} as const;

const KNOWN = new Set<string>(Object.values(SECTION));

/** `- {#payments.retries.capture} → Retry card captures` (or `->`). */
const RENAME_LINE = /^\s*[-*]\s*`?\{#([^}\s]+)\}`?\s*(?:→|->)\s*(.+?)\s*$/;

/** Parses a delta spec in a change folder (`changes/<id>/specs/<capability>/spec.md`). */
export function parseDelta(src: string, path: string, capabilityId: string): ParsedDelta {
  const lines = splitLines(src);
  const headings = topLevelHeadings(src);
  const result: ParsedDelta = { added: [], modified: [], removed: [], renamed: [], diagnostics: [] };
  const d = result.diagnostics;
  const level2 = headings.filter((h) => h.depth === 2);

  if (level2.length === 0) {
    d.push(
      error('delta_empty', 'Delta spec has no "## ADDED/MODIFIED/REMOVED/RENAMED Requirements" sections', { path }),
    );
  }

  for (const h of level2) {
    const key = h.text.toUpperCase().replace(/\s+/g, ' ').trim();
    const region = regionOf(h, headings, lines.length);
    if (!KNOWN.has(key)) {
      d.push(
        error('delta_unknown_section', `Unknown delta section "## ${h.text}"`, {
          path,
          line: h.line,
          fix: 'Use ## ADDED Requirements, ## MODIFIED Requirements, ## REMOVED Requirements or ## RENAMED Requirements',
        }),
      );
      continue;
    }
    if (key === SECTION.PURPOSE) {
      const purpose = sliceLines(lines, region.start + 1, region.end).trim();
      if (purpose) result.purpose = purpose;
      continue;
    }
    if (key === SECTION.RENAMED) {
      for (let line = region.start + 1; line < region.end; line++) {
        const text = lines[line - 1] ?? '';
        if (!text.trim()) continue;
        const m = RENAME_LINE.exec(text);
        if (m?.[1] && m[2]) result.renamed.push({ id: m[1], newName: m[2], line });
        else {
          d.push(
            error('delta_rename_invalid', 'Rename lines look like "- {#<requirement id>} → <new name>"', {
              path,
              line,
            }),
          );
        }
      }
      continue;
    }

    const parsed = parseRequirementsInRegion(lines, headings, region, path);
    d.push(...parsed.diagnostics);
    const kind = key === SECTION.ADDED ? 'added' : key === SECTION.MODIFIED ? 'modified' : 'removed';
    for (const r of parsed.requirements) {
      d.push(...checkRequirement(r, capabilityId, path, { kind }));
      if (kind === 'removed' && (!/\*\*Reason\*\*/i.test(r.description) || !/\*\*Migration\*\*/i.test(r.description))) {
        d.push(
          warning(
            'delta_removed_missing_reason',
            `Removed requirement "${r.name}" should state **Reason** and **Migration**`,
            {
              path,
              line: r.line,
            },
          ),
        );
      }
    }
    result[kind].push(...parsed.requirements);
  }

  // An ID may appear in RENAMED and MODIFIED together, but in no other two sections.
  const sections: [string, Requirement[]][] = [
    ['ADDED', result.added],
    ['MODIFIED', result.modified],
    ['REMOVED', result.removed],
  ];
  const owner = new Map<string, string>();
  for (const [name, reqs] of sections) {
    d.push(...checkDuplicateRequirementIds(reqs, path));
    for (const r of reqs) {
      if (!r.id) continue;
      const prev = owner.get(r.id);
      if (prev && prev !== name) {
        d.push(
          error('delta_conflicting_sections', `"${r.id}" appears in both ${prev} and ${name}`, { path, line: r.line }),
        );
      }
      owner.set(r.id, name);
    }
  }
  for (const r of result.renamed) {
    const prev = owner.get(r.id);
    if (prev === 'ADDED' || prev === 'REMOVED') {
      d.push(error('delta_conflicting_sections', `"${r.id}" is renamed and also ${prev}`, { path, line: r.line }));
    }
  }

  return result;
}

export const deltaTouchedIds = (delta: ParsedDelta): string[] => [
  ...delta.modified.flatMap((r) => (r.id ? [r.id] : [])),
  ...delta.removed.flatMap((r) => (r.id ? [r.id] : [])),
  ...delta.renamed.map((r) => r.id),
];
