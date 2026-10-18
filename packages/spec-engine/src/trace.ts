import { join } from 'node:path';
import { loadChange } from './change.js';
import { type Diagnostic, error, warning } from './diagnostics.js';
import { readText, walkFiles } from './fsutil.js';
import { checkDeltas, rel } from './validate.js';
import type { Workspace } from './workspace.js';

/** `// @scenario payments.retries.capture/transient` in any test or source file. */
const CITATION = /@scenario\s+([a-z0-9][a-z0-9.-]*\/[a-z0-9]+(?:-[a-z0-9]+)*)/g;
const SCANNED = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|java|kt|kts|rb|rs|cs|swift|php|scala|feature|sql|sh)$/;
const IGNORED_DIRS = ['node_modules', '.git', 'dist', 'build', 'coverage', 'vendor', 'orgspec', '.orgspec'];
const MAX_BYTES = 1_000_000;

export interface Citation {
  file: string;
  line: number;
}

export function scanCitations(repoRoot: string): Map<string, Citation[]> {
  const found = new Map<string, Citation[]>();
  for (const file of walkFiles(repoRoot, { ignoreDirs: IGNORED_DIRS })) {
    if (!SCANNED.test(file)) continue;
    const text = readText(join(repoRoot, file));
    if (text.length > MAX_BYTES) continue;
    text.split(/\r?\n/).forEach((line, index) => {
      for (const m of line.matchAll(CITATION)) {
        const id = m[1] as string;
        found.set(id, [...(found.get(id) ?? []), { file, line: index + 1 }]);
      }
    });
  }
  return found;
}

export interface TraceRow {
  requirementId: string;
  scenarioId: string;
  citations: Citation[];
}

/** Every scenario the change adds or modifies, and the tests that cite it. */
export function traceChange(ws: Workspace, id: string): { rows: TraceRow[]; diagnostics: Diagnostic[] } {
  const change = loadChange(ws, id);
  const diagnostics = [...change.diagnostics];
  const tier = change.meta?.tier ?? 'medium';
  const citations = scanCitations(ws.repoRoot);
  const rows: TraceRow[] = [];

  for (const { delta, file } of checkDeltas(ws, change).deltas) {
    for (const req of [...delta.added, ...delta.modified]) {
      for (const s of req.scenarios) {
        if (!req.id || !s.id) continue;
        const cited = citations.get(s.id) ?? [];
        rows.push({ requirementId: req.id, scenarioId: s.id, citations: cited });
        if (cited.length === 0) {
          const message = `Scenario "${s.id}" is not cited by any test`;
          const extra = {
            path: rel(ws, file),
            line: s.line,
            fix: `Add "// @scenario ${s.id}" to the test that covers it`,
          };
          diagnostics.push(
            tier === 'low'
              ? warning('trace_uncited_scenario', message, extra)
              : error('trace_uncited_scenario', message, extra),
          );
        }
      }
    }
  }
  return { rows, diagnostics };
}
