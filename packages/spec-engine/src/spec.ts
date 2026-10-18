import { type Diagnostic, error, warning } from './diagnostics.js';
import {
  isValidRequirementId,
  isValidScenarioId,
  REQUIREMENT_HEADER,
  REQUIREMENT_HEADER_NO_ID,
  SCENARIO_HEADER,
  SCENARIO_HEADER_NO_ID,
  slugify,
} from './ids.js';
import { type HeadingInfo, type Region, regionOf, sliceLines, splitLines, topLevelHeadings } from './markdown.js';

export interface Scenario {
  id?: string;
  name: string;
  /** Full source of the scenario, header included. */
  text: string;
  line: number;
}

export interface Requirement {
  id?: string;
  name: string;
  /** Text between the requirement header and its first scenario. */
  description: string;
  scenarios: Scenario[];
  /** Full source of the requirement block, header and scenarios included. */
  text: string;
  line: number;
}

export interface ParsedSpec {
  title?: string;
  purpose?: string;
  requirements: Requirement[];
  /** Region of the `## Requirements` section, if present. */
  requirementsRegion?: Region;
  lines: string[];
  diagnostics: Diagnostic[];
}

export const DESCRIPTION_LIMIT = 500;
export const PURPOSE_MIN = 50;

const NORMATIVE = /\b(SHALL|MUST)\b/;

/**
 * Parses `### Requirement:` blocks and their `#### Scenario:` children inside a region
 * (a `## ...` section). Shared by main specs and delta specs.
 */
export function parseRequirementsInRegion(
  lines: readonly string[],
  headings: readonly HeadingInfo[],
  region: Region,
  path: string,
): { requirements: Requirement[]; diagnostics: Diagnostic[] } {
  const inside = headings.filter((h) => h.line > region.start && h.line < region.end);
  const requirements: Requirement[] = [];
  const diagnostics: Diagnostic[] = [];
  const level3 = inside.filter((h) => h.depth === 3);

  for (const h of inside) {
    if (h.depth === 4 && !level3.some((r) => r.line < h.line)) {
      diagnostics.push(
        error('heading_outside_requirement', `"${h.text}" is not inside a requirement`, { path, line: h.line }),
      );
    }
  }

  for (const [index, h] of level3.entries()) {
    const blockEnd = level3[index + 1]?.line ?? region.end;
    if (/^Scenario:/i.test(h.text)) {
      diagnostics.push(
        error('scenario_wrong_level', 'Scenarios use exactly 4 hashes (####), not 3', { path, line: h.line }),
      );
      continue;
    }
    if (!/^Requirement:/.test(h.text)) {
      diagnostics.push(
        error('unexpected_heading', `Expected "### Requirement: <name> {#id}", found "### ${h.text}"`, {
          path,
          line: h.line,
        }),
      );
      continue;
    }

    const withId = REQUIREMENT_HEADER.exec(h.text);
    const name = withId?.[1] ?? REQUIREMENT_HEADER_NO_ID.exec(h.text)?.[1] ?? h.text;
    const scenarioHeads = inside.filter((s) => s.depth === 4 && s.line > h.line && s.line < blockEnd);
    const scenarios: Scenario[] = [];

    for (const [si, s] of scenarioHeads.entries()) {
      const scenarioEnd = scenarioHeads[si + 1]?.line ?? blockEnd;
      if (!/^Scenario:/.test(s.text)) {
        diagnostics.push(
          warning('unexpected_heading', `Expected "#### Scenario: <name> {#id}", found "#### ${s.text}"`, {
            path,
            line: s.line,
          }),
        );
        continue;
      }
      const sid = SCENARIO_HEADER.exec(s.text);
      scenarios.push({
        ...(sid?.[2] ? { id: sid[2] } : {}),
        name: sid?.[1] ?? SCENARIO_HEADER_NO_ID.exec(s.text)?.[1] ?? s.text,
        text: sliceLines(lines, s.line, scenarioEnd).trimEnd(),
        line: s.line,
      });
    }

    const descriptionEnd = scenarioHeads[0]?.line ?? blockEnd;
    requirements.push({
      ...(withId?.[2] ? { id: withId[2] } : {}),
      name,
      description: sliceLines(lines, h.line + 1, descriptionEnd).trim(),
      scenarios,
      text: sliceLines(lines, h.line, blockEnd).trimEnd(),
      line: h.line,
    });
  }

  return { requirements, diagnostics };
}

export interface RequirementCheckOptions {
  /** Removed requirements need no scenarios or normative wording. */
  kind: 'spec' | 'added' | 'modified' | 'removed';
}

export function checkRequirement(
  req: Requirement,
  capabilityId: string,
  path: string,
  { kind }: RequirementCheckOptions,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const at = { path, line: req.line };
  const suggested = `${capabilityId}.${slugify(req.name)}`;

  if (!req.id) {
    out.push(
      error('requirement_missing_id', `Requirement "${req.name}" has no ID`, {
        ...at,
        fix: `Add an ID to the header: "### Requirement: ${req.name} {#${suggested}}"`,
      }),
    );
  } else if (!isValidRequirementId(capabilityId, req.id)) {
    out.push(
      error('requirement_id_invalid', `ID "${req.id}" must be "${capabilityId}.<kebab-slug>"`, {
        ...at,
        fix: `For example {#${suggested}}`,
      }),
    );
  }

  if (kind === 'removed') return out;

  if (!NORMATIVE.test(req.description)) {
    out.push(error('requirement_missing_normative', `Requirement "${req.name}" needs SHALL or MUST`, at));
  }
  if (kind !== 'modified' && req.description.length > DESCRIPTION_LIMIT) {
    out.push(
      warning(
        'requirement_description_too_long',
        `Description is ${req.description.length} characters; keep it to ${DESCRIPTION_LIMIT} and move detail into scenarios`,
        at,
      ),
    );
  }
  if (req.scenarios.length === 0) {
    out.push(error('requirement_missing_scenario', `Requirement "${req.name}" has no "#### Scenario:"`, at));
  }

  const seen = new Set<string>();
  for (const s of req.scenarios) {
    const sat = { path, line: s.line };
    if (!s.id) {
      out.push(
        error('scenario_missing_id', `Scenario "${s.name}" has no ID`, {
          ...sat,
          fix: req.id ? `Add {#${req.id}/${slugify(s.name)}}` : 'Give the requirement an ID first',
        }),
      );
    } else {
      if (req.id && !isValidScenarioId(req.id, s.id)) {
        out.push(error('scenario_id_invalid', `Scenario ID "${s.id}" must be "${req.id}/<kebab-slug>"`, sat));
      }
      if (seen.has(s.id)) out.push(error('scenario_duplicate_id', `Scenario ID "${s.id}" is used twice`, sat));
      seen.add(s.id);
    }
    if (!/\bWHEN\b/.test(s.text) || !/\bTHEN\b/.test(s.text)) {
      out.push(warning('scenario_missing_when_then', `Scenario "${s.name}" should use WHEN and THEN`, sat));
    }
  }
  return out;
}

export function checkDuplicateRequirementIds(requirements: readonly Requirement[], path: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  const seen = new Set<string>();
  for (const r of requirements) {
    if (!r.id) continue;
    if (seen.has(r.id)) {
      out.push(error('requirement_duplicate_id', `Requirement ID "${r.id}" is used twice`, { path, line: r.line }));
    }
    seen.add(r.id);
  }
  return out;
}

/** Parses and checks a main spec (`orgspec/specs/<capability>/spec.md`). */
export function parseSpec(src: string, path: string, capabilityId: string): ParsedSpec {
  const lines = splitLines(src);
  const headings = topLevelHeadings(src);
  const diagnostics: Diagnostic[] = [];

  const title = headings.find((h) => h.depth === 1)?.text;
  const level2 = headings.filter((h) => h.depth === 2);

  const purposeHeading = level2.find((h) => /^purpose$/i.test(h.text));
  let purpose: string | undefined;
  if (purposeHeading) {
    const r = regionOf(purposeHeading, headings, lines.length);
    purpose = sliceLines(lines, r.start + 1, r.end).trim();
    if (purpose.length < PURPOSE_MIN) {
      diagnostics.push(
        warning('spec_purpose_too_short', `Purpose is under ${PURPOSE_MIN} characters`, {
          path,
          line: purposeHeading.line,
        }),
      );
    }
  } else {
    diagnostics.push(warning('spec_missing_purpose', 'Spec has no "## Purpose" section', { path }));
  }

  const reqHeading = level2.find((h) => /^requirements$/i.test(h.text));
  if (!reqHeading) {
    diagnostics.push(error('spec_missing_requirements', 'Spec has no "## Requirements" section', { path }));
    return { ...(title ? { title } : {}), ...(purpose ? { purpose } : {}), requirements: [], lines, diagnostics };
  }

  const requirementsRegion = regionOf(reqHeading, headings, lines.length);
  const parsed = parseRequirementsInRegion(lines, headings, requirementsRegion, path);
  diagnostics.push(...parsed.diagnostics);
  for (const r of parsed.requirements) diagnostics.push(...checkRequirement(r, capabilityId, path, { kind: 'spec' }));
  diagnostics.push(...checkDuplicateRequirementIds(parsed.requirements, path));

  return {
    ...(title ? { title } : {}),
    ...(purpose ? { purpose } : {}),
    requirements: parsed.requirements,
    requirementsRegion,
    lines,
    diagnostics,
  };
}
